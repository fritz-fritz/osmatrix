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
   * macOS guests' Homebrew. Intel: the pinned brew tag and homebrew-core commit (missing fields take
   * DEFAULT_HOMEBREW), or false for none. Apple Silicon: `brew` pins the brew tag; without it brew
   * matches GitHub's arm64 runner image, and false leaves brew as it is.
   */
  homebrew?: false | HomebrewPins;
}

export interface HomebrewPins {
  /** Homebrew/brew release tag. */
  brew?: string;
  /** Full Homebrew/homebrew-core commit SHA the core tap is checked out at. */
  core?: string;
}

export interface Config {
  /** Max VM guests running CI legs concurrently. */
  max_vms: number;
  /** Required to run macOS guests on non-Apple hardware (dockur backend). */
  macos_eula_acknowledged: boolean;
  act_version: string;
  /** Image used for ubuntu-* legs run by act on the host. */
  act_linux_image: string;
  guests: Record<string, GuestConfig>;
}

export const DEFAULT_ACT_VERSION = "v0.2.89";
export const DEFAULT_LINUX_IMAGE = "catthehacker/ubuntu:act-24.04";

/**
 * Homebrew stopped building Intel macOS bottles on 2026-08-27 (Homebrew/brew#23677) and made Intel
 * Tier 3 in 7.0.0, so Intel guests get Homebrew pinned to where bottles still exist on ghcr.io:
 * - brew 6.0.22, the last release before 7.0.0;
 * - homebrew-core a5783fb (2026-08-27 21:04 UTC), the last commit before the first update that
 *   shipped without an Intel bottle (apify-cli 1.9.0, merged 22:03 UTC).
 * Formula versions are frozen there: older than on GitHub's runners, but they pour bottles instead
 * of building from source.
 */
export const DEFAULT_HOMEBREW: Required<HomebrewPins> = {
  brew: "6.0.22",
  core: "a5783fb0df65b1eeeaee4dbdf7e0c41b133c72ac",
};

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
      homebrew: { ...DEFAULT_HOMEBREW },
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
  for (const k of ["max_vms", "macos_eula_acknowledged", "act_version", "act_linux_image"] as const) {
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

export function guestWorkdir(g: GuestConfig): string {
  return g.workdir ?? "work";
}

/**
 * The Homebrew pins an Intel macOS guest is provisioned with, or undefined for `homebrew = false`.
 * Checked strictly: the values end up in a shell command in the guest.
 */
export function guestHomebrew(g: GuestConfig): Required<HomebrewPins> | undefined {
  const h: unknown = g.homebrew;
  if (h === false) return undefined;
  if (h !== undefined && (typeof h !== "object" || h === null || Array.isArray(h))) {
    throw new Error(`config: guest "${g.name}": homebrew must be false or a table like { brew = "${DEFAULT_HOMEBREW.brew}", core = "<commit sha>" }`);
  }
  const over = (h ?? {}) as HomebrewPins;
  const pins = { brew: over.brew ?? DEFAULT_HOMEBREW.brew, core: over.core ?? DEFAULT_HOMEBREW.core };
  if (typeof pins.brew !== "string" || !/^\d+\.\d+\.\d+$/.test(pins.brew)) {
    throw new Error(`config: guest "${g.name}": homebrew.brew must be a Homebrew/brew release tag such as "${DEFAULT_HOMEBREW.brew}"`);
  }
  if (typeof pins.core !== "string" || !/^[0-9a-f]{40}$/.test(pins.core)) {
    throw new Error(`config: guest "${g.name}": homebrew.core must be a full 40-character homebrew-core commit SHA`);
  }
  return pins;
}

/**
 * The brew tag an Apple Silicon guest is pinned to by its config, if any. Without one it matches GitHub's
 * arm64 runner image for its macOS version (looked up at provisioning); `homebrew = false` leaves its
 * brew where it is (Homebrew provides the toolchain there, so it can't be skipped).
 */
export function guestArm64Brew(g: GuestConfig): string | false | undefined {
  if (g.homebrew === false) return false;
  return g.homebrew?.brew === undefined ? undefined : guestHomebrew(g)!.brew;
}

/**
 * Environment for the macOS provisioning script: the Intel pins (or OSMATRIX_HOMEBREW=0) and, when known,
 * the brew tag for Apple Silicon. The script uses whichever matches the guest's architecture.
 */
export function homebrewProvisionEnv(g: GuestConfig, arm64Brew?: string): Record<string, string> {
  const pins = guestHomebrew(g);
  const env: Record<string, string> = pins ? { OSMATRIX_BREW_TAG: pins.brew, OSMATRIX_BREW_CORE: pins.core } : { OSMATRIX_HOMEBREW: "0" };
  if (arm64Brew !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(arm64Brew)) throw new Error(`not a Homebrew release tag: ${arm64Brew}`);
    env.OSMATRIX_BREW_ARM64_TAG = arm64Brew;
  }
  return env;
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export function labelMatches(label: string, g: GuestConfig): boolean {
  return guestLabels(g).some((pat) => globToRegExp(pat).test(label));
}
