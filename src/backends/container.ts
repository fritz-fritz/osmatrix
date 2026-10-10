import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LINUX_IMAGE, guestShell, type GuestConfig } from "../core/config.ts";
import { assetsDir, resourcePrefix } from "../core/paths.ts";
import { run } from "../core/proc.ts";
import { ensureKey, sshProbe, type Endpoint } from "../core/ssh.ts";
import { containerState, docker, dockerBin, imageExists, isPortConflict, portBinding, publishedPort } from "./docker.ts";
import type { Backend, GuestStatus, Support } from "./types.ts";

/** Linux guest as a long-lived container (same image act uses for ubuntu-* legs) with sshd added. */
export class ContainerBackend implements Backend {
  readonly cfg: GuestConfig;
  constructor(cfg: GuestConfig) {
    this.cfg = cfg;
  }

  private get container() {
    return `${resourcePrefix}-${this.cfg.name}`;
  }
  private get goldenTag() {
    return `${resourcePrefix}/${this.cfg.name}:golden`;
  }
  private get port() {
    return this.cfg.ssh_port ?? 2221;
  }

  private sshImageTag(): string {
    const base = this.cfg.image ?? DEFAULT_LINUX_IMAGE;
    const dir = path.join(assetsDir, "container");
    const h = crypto.createHash("sha256").update(base);
    for (const f of ["Dockerfile", "entrypoint.sh"]) h.update(fs.readFileSync(path.join(dir, f)));
    return `osmatrix/ssh:${h.digest("hex").slice(0, 12)}`;
  }

  async supported(): Promise<Support> {
    const r = await run(dockerBin(), ["version", "--format", "{{.Server.Version}}"]).catch(() => undefined);
    return r && r.code === 0 ? { ok: true } : { ok: false, reason: "docker daemon not reachable" };
  }

  async status(): Promise<GuestStatus> {
    const st = await containerState(this.container);
    const base: GuestStatus = {
      name: this.cfg.name,
      os: this.cfg.os,
      backend: "container",
      state: "absent",
      hasSnapshot: await imageExists(this.goldenTag),
    };
    if (st === "absent") return base;
    if (st === "stopped") return { ...base, state: "stopped" };
    const p = await sshProbe(await this.endpoint());
    const ssh = await publishedPort(this.container, 22);
    return {
      ...base,
      state: p === "ok" ? "ready" : p === "auth" ? "needs-ssh-setup" : "booting",
      ...(ssh ? { ports: { ssh } } : {}),
    };
  }

  private async ensureImage(): Promise<string> {
    const tag = this.sshImageTag();
    if (!(await imageExists(tag))) {
      await docker(
        ["build", "-t", tag, "--build-arg", `BASE=${this.cfg.image ?? DEFAULT_LINUX_IMAGE}`, path.join(assetsDir, "container")],
        60 * 60_000,
      );
    }
    return tag;
  }

  async up(): Promise<void> {
    const st = await containerState(this.container);
    if (st === "running") return;
    let image: string | undefined;
    if (st === "stopped") {
      try {
        await docker(["start", this.container]);
        return;
      } catch (e) {
        if (!isPortConflict(e)) throw e;
        // Its ssh port was taken meanwhile: keep the container's changes and re-run it on a new port.
        image = `${resourcePrefix}/${this.cfg.name}:carry`;
        await docker(["commit", this.container, image]);
        await docker(["rm", "-f", this.container]);
      }
    }
    image ??= (await imageExists(this.goldenTag)) ? this.goldenTag : await this.ensureImage();
    try {
      await this.run(image, await portBinding(this.port, 22));
    } catch (e) {
      if (!isPortConflict(e)) throw e;
      await run(dockerBin(), ["rm", "-f", this.container]);
      await this.run(image, "127.0.0.1::22");
    }
  }

  private async run(image: string, sshBinding: string): Promise<void> {
    const { publicKey } = await ensureKey();
    const args = [
      "run", "-d",
      "--name", this.container,
      "--hostname", this.cfg.name,
      "-p", sshBinding,
      "-e", `AUTHORIZED_KEY=${publicKey}`,
      "--label", "osmatrix.guest=" + this.cfg.name,
    ];
    if (this.cfg.cpus) args.push("--cpus", String(this.cfg.cpus));
    if (this.cfg.memory) args.push("--memory", this.cfg.memory.toLowerCase().replace(/b$/, ""));
    args.push(image);
    await docker(args);
  }

  async down(): Promise<void> {
    if ((await containerState(this.container)) === "running") await docker(["stop", "-t", "10", this.container]);
  }

  async snapshot(): Promise<void> {
    if ((await containerState(this.container)) === "absent") throw new Error(`${this.cfg.name} does not exist; run up first`);
    await docker(["commit", this.container, this.goldenTag]);
  }

  async reset(): Promise<void> {
    await run(dockerBin(), ["rm", "-f", this.container]);
    await this.up();
  }

  async destroy(): Promise<void> {
    await run(dockerBin(), ["rm", "-f", this.container]);
    await run(dockerBin(), ["rmi", this.goldenTag]);
  }

  async endpoint(): Promise<Endpoint> {
    const { privateKey } = await ensureKey();
    return {
      host: "127.0.0.1",
      port: (await publishedPort(this.container, 22)) ?? this.port,
      user: this.cfg.user ?? "root",
      identity: privateKey,
      os: "linux",
      shell: guestShell(this.cfg),
      checkHostKey: false,
    };
  }
}
