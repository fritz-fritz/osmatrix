import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dockerBin, publishedPort } from "../backends/docker.ts";
import { ensureDir, paths } from "./paths.ts";
import { run } from "./proc.ts";
import { canConnect } from "./ssh.ts";

/**
 * Running osmatrix from inside a container (a devcontainer, Codespaces) or against a remote
 * Docker daemon. Local guests are containers that osmatrix reaches on 127.0.0.1 and, for
 * Windows, feeds files through a bind mount. Both assume the Docker daemon shares our
 * loopback and filesystem. With Docker-outside-of-Docker (the host's socket mounted into the
 * devcontainer) or a DOCKER_HOST on another machine, it shares neither: ports land on the
 * daemon host's loopback and bind-mount paths resolve on its filesystem. ssh guests don't
 * use Docker at all, so they work from anywhere.
 */

export type ContainerKind = "codespaces" | "devcontainer" | "container";

export interface ContainerHost {
  kind: ContainerKind;
  evidence: string[];
}

/** Are we inside a container, and what kind? Undefined on a plain host. */
export function detectContainerHost(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
  platform: string = process.platform,
): ContainerHost | undefined {
  if (env.CODESPACES === "true") return { kind: "codespaces", evidence: ["CODESPACES=true"] };
  // VS Code Dev Containers sets REMOTE_CONTAINERS; many devcontainer images and the devcontainer CLI's
  // templates set DEVCONTAINER.
  const dev = ["REMOTE_CONTAINERS", "DEVCONTAINER"].filter((k) => env[k] === "true").map((k) => `${k}=true`);
  if (dev.length) return { kind: "devcontainer", evidence: dev };
  if (platform !== "linux") return undefined;
  const evidence = ["/.dockerenv", "/run/.containerenv"].filter((p) => exists(p));
  if (env.container) evidence.push(`container=${env.container}`);
  return evidence.length ? { kind: "container", evidence } : undefined;
}

/** A DOCKER_HOST that names another machine (tcp://, ssh://) rather than a local socket or pipe. */
export function remoteDockerHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const h = env.DOCKER_HOST?.trim();
  return h && !/^(unix|npipe):/i.test(h) ? h : undefined;
}

export function selinuxEnforcing(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return fs.readFileSync("/sys/fs/selinux/enforce", "utf8").trim() === "1";
  } catch {
    return false;
  }
}

export interface DockerReach {
  /** A path we create is the same path to the daemon (bind mounts work). */
  files: boolean;
  /** A port the daemon publishes on 127.0.0.1 is reachable on our 127.0.0.1. */
  loopback: boolean;
  /** Set when a probe itself failed (no daemon, image pull failed); both flags are then unknown. */
  error?: string;
}

const PROBE_IMAGE = "busybox:latest";

async function probeFiles(docker: string): Promise<boolean> {
  const dir = ensureDir(path.join(paths.dataDir, `probe-${crypto.randomBytes(4).toString("hex")}`));
  const token = crypto.randomBytes(8).toString("hex");
  try {
    fs.writeFileSync(path.join(dir, "marker"), token);
    // --mount (unlike -v) fails instead of creating the path when the daemon's filesystem lacks it.
    const args = ["run", "--rm", "--mount", `type=bind,src=${dir},dst=/probe,readonly`];
    if (selinuxEnforcing()) args.push("--security-opt", "label=disable");
    args.push(PROBE_IMAGE, "cat", "/probe/marker");
    const r = await run(docker, args, { timeoutMs: 120_000 });
    return r.code === 0 && r.stdout.trim() === token;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function probeLoopback(docker: string): Promise<boolean> {
  const name = `osmatrix-probe-${crypto.randomBytes(4).toString("hex")}`;
  const r = await run(docker, ["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::80", PROBE_IMAGE, "httpd", "-f", "-p", "80"], {
    timeoutMs: 120_000,
  });
  if (r.code !== 0) throw new Error(`docker could not start a probe container: ${(r.stderr || r.stdout).trim()}`);
  try {
    const port = await publishedPort(name, 80);
    if (!port) return false;
    for (let i = 0; i < 5; i++) {
      if (await canConnect(port, "127.0.0.1", 1000)) return true;
      await new Promise((res) => setTimeout(res, 300));
    }
    return false;
  } finally {
    await run(docker, ["rm", "-f", name]);
  }
}

let cached: Promise<DockerReach | undefined> | undefined;

/**
 * Probe whether the Docker daemon shares our filesystem and loopback. Only runs inside a container
 * or with a remote DOCKER_HOST (undefined otherwise: a plain host shares both). A definite answer is
 * cached per process; a failed probe (image pull, daemon hiccup) is retried on the next call.
 */
export function dockerReach(): Promise<DockerReach | undefined> {
  const p = (cached ??= (async () => {
    if (!detectContainerHost() && !remoteDockerHost()) return undefined;
    let docker: string;
    try {
      docker = dockerBin();
    } catch (e) {
      return { files: false, loopback: false, error: (e as Error).message };
    }
    try {
      const [files, loopback] = await Promise.all([probeFiles(docker), probeLoopback(docker)]);
      return { files, loopback };
    } catch (e) {
      return { files: false, loopback: false, error: (e as Error).message };
    }
  })());
  void p.then((r) => {
    if (r?.error && cached === p) cached = undefined;
  });
  return p;
}

function where(host: ContainerHost | undefined, remote: string | undefined): string {
  if (remote) return `the Docker daemon is remote (DOCKER_HOST=${remote})`;
  const name = { codespaces: "a GitHub Codespace", devcontainer: "a devcontainer", container: "a container" }[host?.kind ?? "container"];
  return `osmatrix is running inside ${name}`;
}

/**
 * Why local Docker-backed guests (container, dockur) can't work here, or undefined when they can.
 * Fails closed: when the probe couldn't run, reachability is unknown, and starting anyway risks a
 * guest stuck in "booting" or a Windows install without provisioning.
 */
export function localGuestBlockReason(
  reach: DockerReach | undefined,
  os: string,
  host = detectContainerHost(),
  remote = remoteDockerHost(),
): string | undefined {
  if (!reach) return undefined;
  if (reach.error) {
    return (
      `${where(host, remote)}, and osmatrix could not verify that Docker shares this environment's loopback and files (${reach.error}). ` +
      "Fix the error and retry, run osmatrix on the Docker host itself, or configure an ssh guest instead."
    );
  }
  const problems: string[] = [];
  if (!reach.loopback) problems.push("ports Docker publishes on 127.0.0.1 are not reachable from here, so osmatrix can't ssh into the guest");
  // Only Windows guests bind-mount a host directory (the unattended-install OEM folder).
  if (!reach.files && os === "windows") problems.push("bind-mounted paths resolve on the daemon's filesystem, so Windows would install without its provisioning script and never enable ssh");
  if (!problems.length) return undefined;
  const split = remote ? "" : " whose Docker daemon is outside it (Docker-outside-of-Docker)";
  return (
    `${where(host, remote)}${split}: ${problems.join("; ")}. ` +
    "Run osmatrix on the Docker host itself, or configure an ssh guest (any machine reachable over ssh) instead."
  );
}

/** Throw when local Docker-backed guests can't work from here (see localGuestBlockReason). */
export async function assertLocalGuestsReachable(os: string): Promise<void> {
  const reason = localGuestBlockReason(await dockerReach(), os);
  if (reason) throw new Error(reason);
}
