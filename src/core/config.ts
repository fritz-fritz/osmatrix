import fs from "node:fs";
import os from "node:os";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDir, paths } from "./paths.ts";

export type OsFamily = "linux" | "windows" | "macos";
export type BackendKind = "container" | "dockur" | "tart" | "qemu" | "ssh";
export type Shell = "posix" | "pwsh" | "cmd";

export interface GuestConfig {
  name: string;
  os: OsFamily;
  backend: BackendKind;
  /** container: base image; tart: OCI image to clone; dockur: override dockurr image. */
  image?: string;
  /** dockur VERSION (e.g. "2025", "11", "15"). */
  version?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
  /** Host port mapped to guest sshd (container/dockur). */
  ssh_port?: number;
  web_port?: number;
  vnc_port?: number;
  /** ssh user inside the guest. */
  user?: string;
  /** ssh backend: remote host/port/identity. */
  host?: string;
  port?: number;
  identity?: string;
  shell?: Shell;
  /** runs-on label globs this guest serves, e.g. ["windows-*"]. */
  labels?: string[];
  /** Guest-side directory (relative to the ssh user's home) for pushed repos. */
  workdir?: string;
  /** Seconds to wait for the guest to become reachable during CI. */
  boot_timeout?: number;
  /** qemu backend: accelerator override ("hvf", "kvm" or "tcg"); defaults to the best the host has. */
  accel?: string;
  /**
   * Windows guests: install the Visual Studio 2022 Build Tools C++ workload (MSVC + Windows SDK) while
   * provisioning, as on GitHub's windows-latest. Default true; false saves several GB and ~10-20 min.
   */
  msvc?: boolean;
}

export interface Config {
  /** Max VM guests running CI legs concurrently. */
  max_vms: number;
  /** Required to run macOS guests on non-Apple hardware (dockur backend). */
  macos_eula_acknowledged: boolean;
  /**
   * act release. The default (PATCHED_ACT_VERSION in act.ts) runs osmatrix's patched build of it; another
   * version downloads that stock release.
   */
  act_version: string;
  /** The user's own act: a path, or a command name looked up on PATH ("act"). Unset: osmatrix's act. */
  act_path?: string;
  /** Image used for ubuntu-* legs run by act on the host. */
  act_linux_image: string;
  guests: Record<string, GuestConfig>;
}

export const DEFAULT_ACT_VERSION = "v0.2.89";
export const DEFAULT_LINUX_IMAGE = "catthehacker/ubuntu:act-24.04";

export const DEFAULT_LABELS: Record<OsFamily, string[]> = {
  linux: ["ubuntu-*", "linux"],
  windows: ["windows-*", "windows"],
  macos: ["macos-*", "macos", "macOS"],
};

export function defaultShell(o: OsFamily): Shell {
  return o === "windows" ? "pwsh" : "posix";
}

/** Default guests depend on what the host can virtualize. */
export function defaultGuests(platform = process.platform, arch = process.arch): Record<string, GuestConfig> {
  const g: Record<string, GuestConfig> = {
    ubuntu: { name: "ubuntu", os: "linux", backend: "container", image: DEFAULT_LINUX_IMAGE, ssh_port: 2221, user: "root" },
  };
  if (platform === "darwin") {
    if (arch === "arm64") {
      // Windows 11 on ARM with the host's QEMU and Hypervisor.framework (tart only runs macOS and Linux).
      g.windows = {
        name: "windows",
        os: "windows",
        backend: "qemu",
        image: "dockurr/windows-arm",
        version: "11",
        cpus: 4,
        memory: "8G",
        disk: "64G",
        ssh_port: 2222,
        vnc_port: 5901,
      };
    }
    g.macos = {
      name: "macos",
      os: "macos",
      backend: "tart",
      image: "ghcr.io/cirruslabs/macos-sequoia-base:latest",
      user: "admin",
      cpus: 4,
      memory: "8G",
    };
    return g;
  }
  g.windows = {
    name: "windows",
    os: "windows",
    backend: "dockur",
    image: arch === "arm64" ? "dockurr/windows-arm" : "dockurr/windows",
    version: arch === "arm64" ? "11" : "2025",
    cpus: 4,
    memory: "8G",
    disk: "64G",
    ssh_port: 2222,
    web_port: 8006,
    vnc_port: 5901,
  };
  if (arch !== "arm64") {
    g.macos = {
      name: "macos",
      os: "macos",
      backend: "dockur",
      image: "dockurr/macos",
      version: "15",
      cpus: 4,
      memory: "8G",
      disk: "64G",
      ssh_port: 2223,
      web_port: 8007,
      vnc_port: 5902,
    };
  }
  return g;
}

export function defaultConfig(): Config {
  return {
    max_vms: Math.max(1, Math.min(2, Math.floor(os.totalmem() / (12 * 1024 ** 3)))),
    macos_eula_acknowledged: process.platform === "darwin",
    act_version: DEFAULT_ACT_VERSION,
    act_linux_image: DEFAULT_LINUX_IMAGE,
    guests: defaultGuests(),
  };
}

/** Load config.toml merged over defaults. Guests merge per-field; extra guests are added. */
export function loadConfig(file = paths.configFile): Config {
  const cfg = defaultConfig();
  if (!fs.existsSync(file)) return cfg;
  const raw = parseToml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  return mergeConfig(cfg, raw);
}

export function mergeConfig(cfg: Config, raw: Record<string, unknown>): Config {
  for (const k of ["max_vms", "macos_eula_acknowledged", "act_version", "act_path", "act_linux_image"] as const) {
    if (raw[k] !== undefined) (cfg as unknown as Record<string, unknown>)[k] = raw[k];
  }
  const guests = (raw.guests ?? {}) as Record<string, Partial<GuestConfig> & { enabled?: boolean }>;
  for (const [name, over] of Object.entries(guests)) {
    if (over.enabled === false) {
      delete cfg.guests[name];
      continue;
    }
    const base = cfg.guests[name];
    const merged = { ...(base ?? {}), ...over, name } as GuestConfig;
    delete (merged as { enabled?: boolean }).enabled;
    if (!merged.os || !merged.backend) {
      throw new Error(`config: guest "${name}" needs "os" and "backend"`);
    }
    if (merged.msvc !== undefined && typeof merged.msvc !== "boolean") {
      throw new Error(`config: guest "${name}": msvc must be true or false (got ${JSON.stringify(merged.msvc)})`);
    }
    cfg.guests[name] = merged;
  }
  return cfg;
}

export function writeConfig(raw: Record<string, unknown>, file = paths.configFile): void {
  ensureDir(paths.configDir);
  const header =
    "# osmatrix configuration. Values here override built-in defaults.\n" +
    "# See `osmatrix config --defaults` for every guest's default settings.\n\n";
  fs.writeFileSync(file, header + stringifyToml(raw) + "\n");
}

export function readRawConfig(file = paths.configFile): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  return parseToml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function guestLabels(g: GuestConfig): string[] {
  return g.labels ?? DEFAULT_LABELS[g.os];
}

export function guestShell(g: GuestConfig): Shell {
  return g.shell ?? defaultShell(g.os);
}

/** Whether a guest gets the MSVC Build Tools: Windows guests, unless they opt out with msvc = false. */
export function guestMsvc(g: Pick<GuestConfig, "os" | "msvc">): boolean {
  return g.os === "windows" && g.msvc !== false;
}

/** Choices for the Windows unattended install, written as C:\OEM\options.json (read by provision.ps1). */
export function windowsOemOptions(g: GuestConfig): { msvc: boolean } {
  return { msvc: guestMsvc(g) };
}

export function guestWorkdir(g: GuestConfig): string {
  return g.workdir ?? "work";
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export function labelMatches(label: string, g: GuestConfig): boolean {
  return guestLabels(g).some((pat) => globToRegExp(pat).test(label));
}
