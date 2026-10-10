import fs from "node:fs";
import os from "node:os";
import { backendFor } from "../backends/index.ts";
import { dockerBin } from "../backends/docker.ts";
import { loadConfig } from "./config.ts";
import { ensureDir, paths } from "./paths.ts";
import { run, which } from "./proc.ts";
import { findAct } from "./act.ts";

export interface DoctorReport {
  host: { platform: string; arch: string; cpus: number; memoryGB: number; freeDiskGB?: number };
  tools: Record<string, string | null>;
  guests: Record<string, { backend: string; os: string; runnable: boolean; reason?: string }>;
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
    act: (await findAct()) ?? null,
    tart: process.platform === "darwin" ? await version(which("tart"), ["--version"]) : null,
  };
  const notes: string[] = [];
  if (!tools.docker) notes.push("Docker is required for the ubuntu guest, dockur VMs and Linux CI legs.");
  if (!tools.act) notes.push("act not found; it will be downloaded automatically on first `ci run` (or run `osmatrix install-act`).");
  if (!tools.ssh) notes.push("Install an OpenSSH client (built into Windows 10 1809+, macOS and most Linux distros).");

  const guests: DoctorReport["guests"] = {};
  for (const g of Object.values(cfg.guests)) {
    let s: { ok: boolean; reason?: string };
    try {
      s = await backendFor(g).supported();
    } catch (e) {
      s = { ok: false, reason: (e as Error).message };
    }
    guests[g.name] = { backend: g.backend, os: g.os, runnable: s.ok, reason: s.reason };
  }
  const memGB = Math.round(os.totalmem() / 1024 ** 3);
  const vmMem = Object.values(cfg.guests)
    .filter((g) => g.backend === "dockur" || g.backend === "tart")
    .reduce((a, g) => a + parseInt(g.memory ?? "8", 10), 0);
  if (vmMem > memGB * 0.75) notes.push(`VM guests are configured for ${vmMem}G total but the host has ${memGB}G; keep max_vms low or lower memory per guest.`);
  if (freeDiskGB !== undefined && freeDiskGB < 150) notes.push(`Only ${freeDiskGB}G free; each VM guest needs ~64G (+ golden snapshot).`);

  return {
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, memoryGB: memGB, freeDiskGB },
    tools,
    guests,
    notes,
  };
}
