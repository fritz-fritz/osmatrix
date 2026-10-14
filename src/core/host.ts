import fs from "node:fs";
import os from "node:os";
import { backendFor } from "../backends/index.ts";
import { ContainerBackend } from "../backends/container.ts";
import { dockerBin, dockerHasKvm, imageExists } from "../backends/docker.ts";
import { parityImageTag, runnerRust } from "../backends/linux-image.ts";
import { DEFAULT_LINUX_IMAGE, loadConfig, type GuestConfig } from "./config.ts";
import { ensureDir, paths } from "./paths.ts";
import { run, which } from "./proc.ts";
import { actReport, type ActReport } from "./act.ts";
import { compatibility } from "./compat.ts";
import { checkSizing, requirements } from "./sizing.ts";
import { detectContainerHost, dockerReach, remoteDockerHost, type ContainerHost, type DockerReach } from "./nesting.ts";

export interface DoctorReport {
  /** kvm: KVM for VMs (Linux: /dev/kvm; Windows: inside Docker Desktop); absent where it doesn't apply. */
  host: { platform: string; arch: string; cpus: number; memoryGB: number; freeDiskGB?: number; kvm?: boolean };
  tools: Record<string, string | null>;
  /** Which act CI legs run (osmatrix's patched build, a stock release, or the user's act_path) and whether it's ready. */
  act: ActReport;
  guests: Record<string, { backend: string; os: string; runnable: boolean; reason?: string; compatibility: string; resources?: string }>;
  /** Present when osmatrix runs inside a container or against a remote Docker daemon. */
  nesting?: {
    /** The container osmatrix runs in; absent when only DOCKER_HOST is remote. */
    container?: ContainerHost;
    /** A remote DOCKER_HOST (tcp://, ssh://). */
    dockerHost?: string;
    /** What the daemon shares with this environment, when Docker is available. */
    docker?: DockerReach;
  };
  /**
   * The image Linux CI legs use: `act_linux_image` itself, or with the default, the parity image for the
   * Rust version of GitHub's runner image (`runner`, `rust`) and whether it's `built` yet.
   */
  linuxImage: { configured: string; image?: string; runner?: string; rust?: string; built?: boolean; error?: string };
  notes: string[];
}

async function version(cmd: string | undefined, args: string[]): Promise<string | null> {
  if (!cmd) return null;
  const r = await run(cmd, args, { timeoutMs: 15_000 });
  return r.code === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : null;
}

export async function doctor(): Promise<DoctorReport> {
  const cfg = loadConfig();
  let docker: string | undefined;
  try {
    docker = dockerBin();
  } catch {
    docker = undefined;
  }
  // VM disks live in docker volumes, so measure the docker root when it is local (Linux); else the data dir.
  let diskPath = ensureDir(paths.dataDir);
  if (docker && process.platform === "linux") {
    const root = (await run(docker, ["info", "--format", "{{.DockerRootDir}}"])).stdout.trim();
    if (root && fs.existsSync(root)) diskPath = root;
  }
  let freeDiskGB: number | undefined;
  try {
    const st = fs.statfsSync(diskPath);
    freeDiskGB = Math.round((st.bavail * st.bsize) / 1024 ** 3);
  } catch {
    /* not supported */
  }
  const tools: Record<string, string | null> = {
    docker: await version(docker, ["version", "--format", "{{.Server.Version}}"]),
    "docker compose": await version(docker, ["compose", "version", "--short"]),
    ssh: await version(which("ssh"), ["-V"]).then((v) => v ?? (which("ssh") ? "present" : null)),
    "ssh-keygen": which("ssh-keygen") ? "present" : null,
    tar: await version(which("tar"), ["--version"]),
    git: await version(which("git"), ["--version"]),
    act: null,
    tart: process.platform === "darwin" ? await version(which("tart"), ["--version"]) : null,
    "qemu-system-aarch64": await version(which("qemu-system-aarch64"), ["--version"]),
    "qemu-system-x86_64": await version(which("qemu-system-x86_64"), ["--version"]),
  };
  const act = await actReport(cfg);
  tools.act =
    act.source === "user" ? (act.path ?? null) : `${act.version} (${act.source === "patched" ? `osmatrix's patched build, ${act.missing?.length ? "not fully built yet" : "built"}` : "stock release"})`;
  const notes: string[] = [];
  if (!tools.docker) notes.push("Docker is required for the ubuntu guest, dockur VMs and Linux CI legs.");
  if (act.source !== "patched" || act.missing?.length) notes.push(act.note);
  const linuxImage: DoctorReport["linuxImage"] = { configured: cfg.act_linux_image };
  if (cfg.act_linux_image !== DEFAULT_LINUX_IMAGE) {
    linuxImage.image = cfg.act_linux_image;
  } else {
    const { rust, tag, error } = await runnerRust();
    if (!rust) {
      linuxImage.error = error;
      notes.push(`Couldn't look up the Rust version of GitHub's ubuntu24 runner image (${error}); Linux CI legs use the newest local osmatrix/ubuntu image, or build one with the current stable Rust.`);
    } else {
      Object.assign(linuxImage, { image: parityImageTag(rust), runner: tag, rust });
      if (tools.docker) {
        linuxImage.built = await imageExists(linuxImage.image!);
        if (!linuxImage.built) {
          notes.push(`Linux CI legs run in ${linuxImage.image}: act's default image plus Rust ${rust}, as in GitHub's ${tag} runner image. It isn't built yet; the first Linux leg builds it, which takes a few minutes and needs network access.`);
        }
      }
    }
  }
  if (!tools.ssh) notes.push("Install an OpenSSH client (built into Windows 10 1809+, macOS and most Linux distros).");

  const host = detectContainerHost();
  const remote = remoteDockerHost();
  let nesting: DoctorReport["nesting"];
  if (host || remote) {
    const reach = tools.docker ? await dockerReach() : undefined;
    nesting = { ...(host ? { container: host } : {}), ...(remote ? { dockerHost: remote } : {}), ...(reach ? { docker: reach } : {}) };
    notes.push(...nestingNotes(host, remote, tools.docker, reach));
  }

  // Decides the compatibility-matrix row ("Linux x86_64 + KVM", "Windows 11 ... nested virtualization").
  const kvm =
    process.platform === "linux" ? fs.existsSync("/dev/kvm") : process.platform === "win32" && tools.docker ? await dockerHasKvm().catch(() => false) : undefined;
  const guests: DoctorReport["guests"] = {};
  for (const g of Object.values(cfg.guests)) {
    let s: { ok: boolean; reason?: string };
    try {
      s = await backendFor(g).supported();
    } catch (e) {
      s = { ok: false, reason: (e as Error).message };
    }
    const compat = compatibility(g, process.platform, process.arch, kvm);
    guests[g.name] = { backend: g.backend, os: g.os, runnable: s.ok, reason: s.reason, compatibility: compat, resources: describeResources(g) };
    if (s.ok && compat === "untested") {
      notes.push(`${g.name}: supported but not yet tested on this kind of host; whether it works or not, offer the user a compatibility report afterwards (osmatrix report ${g.name} / host_report)`);
    }
    let sz: { errors: string[]; warnings: string[] };
    try {
      sz = checkSizing(g);
    } catch (e) {
      // e.g. a hand-edited size doctor can't parse: report it instead of failing the whole check.
      sz = { errors: [(e as Error).message], warnings: [] };
    }
    for (const m of [...sz.errors, ...sz.warnings]) notes.push(`${g.name}: ${m} (change with env_configure / \`osmatrix configure\`)`);
    const b = backendFor(g);
    if (s.ok && b instanceof ContainerBackend) {
      const stale = await b.staleBase().catch(() => undefined);
      if (stale) notes.push(`${g.name}: ${stale}`);
    }
  }
  const memGB = Math.round(os.totalmem() / 1024 ** 3);
  const vmMem = Object.values(cfg.guests)
    .filter((g) => g.backend === "dockur" || g.backend === "tart" || g.backend === "qemu")
    .reduce((a, g) => a + parseInt(g.memory ?? "8", 10), 0);
  if (vmMem > memGB * 0.75) notes.push(`VM guests are configured for ${vmMem}G total but the host has ${memGB}G; keep max_vms low or lower memory per guest.`);
  if (freeDiskGB !== undefined && freeDiskGB < 150) notes.push(`Only ${freeDiskGB}G free; each VM guest needs ~64G (+ golden snapshot).`);

  return {
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, memoryGB: memGB, freeDiskGB, ...(kvm === undefined ? {} : { kvm }) },
    tools,
    act,
    guests,
    linuxImage,
    ...(nesting ? { nesting } : {}),
    notes,
  };
}

/** What works from a devcontainer / Codespace / remote daemon, in the user's terms. */
export function nestingNotes(host: ContainerHost | undefined, remote: string | undefined, docker: string | null, reach: DockerReach | undefined): string[] {
  const where = remote ? `Docker is remote (DOCKER_HOST=${remote})` : `Running inside ${host?.kind === "codespaces" ? "a GitHub Codespace" : host?.kind === "devcontainer" ? "a devcontainer" : "a container"}`;
  const ssh = "ssh guests (any Windows, macOS or Linux machine reachable over ssh) work from here; see `ssh` guests in the reference";
  if (!docker) return [`${remote ? `${where} but not reachable` : `${where} without Docker`}: local guests and Linux CI legs are unavailable. ${ssh}.`];
  if (!reach || reach.error) {
    return [
      `${where}; could not check whether Docker shares this environment (${reach?.error ?? "not probed"}). Local guests are refused until that check succeeds. ${ssh}.`,
    ];
  }
  if (reach.files && reach.loopback) {
    return [`${where} with Docker-in-Docker: the daemon shares this environment's files and loopback, so local guests and Linux CI legs work. VM guests also need /dev/kvm passed into this container.`];
  }
  const notes = [
    `${where}, and the Docker daemon ${!reach.loopback && !reach.files ? "shares neither its loopback nor its filesystem" : !reach.loopback ? "doesn't share its loopback" : "doesn't share its filesystem"} with this environment (Docker-outside-of-Docker).`,
  ];
  if (!reach.loopback) notes.push("Local guests (ubuntu container, dockur VMs) are refused: their ssh ports are published on the daemon host's 127.0.0.1, which this environment can't reach.");
  else if (!reach.files) notes.push("Windows dockur guests are refused: their unattended-install folder is a bind mount, which would resolve on the daemon host's filesystem.");
  notes.push("Linux CI legs still run (act copies the checkout into job containers), but artifact/cache steps can fail if job containers can't reach this environment.");
  notes.push(`${ssh}. Or run osmatrix on the Docker host itself.`);
  return notes;
}

/** "cpus 4 (min 2), memory 8G (min 4G), disk 64G (min 40G), ~12G used on the host" */
function describeResources(g: GuestConfig): string | undefined {
  if (g.backend === "ssh") return undefined;
  const r = requirements(g);
  const parts = [
    `cpus ${g.cpus ?? "unlimited"} (min ${r.cpus.min}, recommended ${r.cpus.recommended})`,
    `memory ${g.memory ?? "unlimited"} (min ${r.memoryGB.min}G, recommended ${r.memoryGB.recommended}G)`,
  ];
  if (r.diskGB) parts.push(`disk ${g.disk ?? "64G"} (min ${r.diskGB.min}G)`);
  if (r.footprintGB) parts.push(`~${r.footprintGB}G used on the host once set up, plus its golden snapshot`);
  return parts.join(", ");
}
