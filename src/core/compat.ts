import type { BackendKind, OsFamily } from "./config.ts";

/** How well a host/guest combination is known to work. Mirrors the README's compatibility matrix. */
export type Compat = "tested" | "untested" | "unsupported";

export interface HostKind {
  /** Row label in the README matrix. */
  label: string;
  platform: NodeJS.Platform;
  arch: string;
  guests: Record<OsFamily, Compat>;
}

/**
 * The compatibility matrix. "tested" means the maintainers have run that guest on that kind of host;
 * "untested" means the code supports it but nobody has reported on it yet. Keep README.md in sync
 * (test/compat.test.ts checks it).
 */
export const HOSTS: HostKind[] = [
  { label: "Linux x86_64 + KVM", platform: "linux", arch: "x64", guests: { linux: "tested", windows: "tested", macos: "tested" } },
  { label: "Linux arm64 + KVM", platform: "linux", arch: "arm64", guests: { linux: "untested", windows: "untested", macos: "unsupported" } },
  {
    label: "Windows 11 x86_64 + Docker Desktop (WSL2 with nested virtualization)",
    platform: "win32",
    arch: "x64",
    guests: { linux: "untested", windows: "untested", macos: "untested" },
  },
  { label: "Windows 11 arm64", platform: "win32", arch: "arm64", guests: { linux: "untested", windows: "unsupported", macos: "unsupported" } },
  { label: "macOS Apple Silicon", platform: "darwin", arch: "arm64", guests: { linux: "untested", windows: "untested", macos: "untested" } },
  { label: "macOS Intel", platform: "darwin", arch: "x64", guests: { linux: "untested", windows: "unsupported", macos: "unsupported" } },
];

export function hostKind(platform = process.platform, arch = process.arch): HostKind | undefined {
  return HOSTS.find((h) => h.platform === platform && h.arch === arch);
}

/** Compatibility of a guest on this host. ssh guests are other machines, so the host doesn't matter. */
export function compatibility(g: { os: OsFamily; backend: BackendKind }, platform = process.platform, arch = process.arch): Compat {
  if (g.backend === "ssh") return "tested";
  return hostKind(platform, arch)?.guests[g.os] ?? "untested";
}

export const ISSUES_URL = "https://github.com/fritz-fritz/osmatrix/issues";
