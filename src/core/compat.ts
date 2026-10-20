import type { BackendKind, OsFamily } from "./config.ts";

/** How well a host/guest combination is known to work. Mirrors the README's compatibility matrix. */
export type Compat = "tested" | "untested" | "unsupported";

export interface HostKind {
  /** Row label in the README matrix. */
  label: string;
  platform: NodeJS.Platform;
  arch: string;
  /** The row also requires KVM for containers (the label says "+ KVM" or "nested virtualization"). */
  needsKvm?: boolean;
  guests: Record<OsFamily, Compat>;
}

/**
 * The compatibility matrix. "tested" means the maintainers have run that guest on that kind of host;
 * "untested" means the code supports it but nobody has reported on it yet. Keep README.md in sync
 * (test/compat.test.ts checks it).
 */
export const HOSTS: HostKind[] = [
  { label: "Linux x86_64 + KVM", platform: "linux", arch: "x64", needsKvm: true, guests: { linux: "tested", windows: "tested", macos: "tested" } },
  { label: "Linux arm64 + KVM", platform: "linux", arch: "arm64", needsKvm: true, guests: { linux: "untested", windows: "untested", macos: "unsupported" } },
  {
    label: "Windows 11 x86_64 + Docker Desktop (WSL2 with nested virtualization)",
    platform: "win32",
    arch: "x64",
    needsKvm: true,
    guests: { linux: "untested", windows: "untested", macos: "untested" },
  },
  { label: "Windows 11 arm64", platform: "win32", arch: "arm64", guests: { linux: "untested", windows: "untested", macos: "unsupported" } },
  { label: "macOS Apple Silicon", platform: "darwin", arch: "arm64", guests: { linux: "untested", windows: "untested", macos: "untested" } },
  { label: "macOS Intel", platform: "darwin", arch: "x64", guests: { linux: "untested", windows: "untested", macos: "untested" } },
];

/** The matrix row for this host; undefined ("Other") when the host lacks what its row requires. */
export function hostKind(platform = process.platform, arch = process.arch, hasKvm?: boolean): HostKind | undefined {
  const h = HOSTS.find((r) => r.platform === platform && r.arch === arch);
  return h && h.needsKvm && hasKvm === false ? undefined : h;
}

/**
 * Compatibility of a guest on this host. ssh guests are other machines, so the host doesn't matter.
 * Pass hasKvm (KVM available to containers) when known; a host outside every row is "untested".
 */
export function compatibility(g: { os: OsFamily; backend: BackendKind }, platform = process.platform, arch = process.arch, hasKvm?: boolean): Compat {
  if (g.backend === "ssh") return "tested";
  return hostKind(platform, arch, hasKvm)?.guests[g.os] ?? "untested";
}

export type Outcome = "Works" | "Partly works" | "Doesn't work";

/**
 * Whether an outcome is news relative to the matrix, i.e. worth a compatibility report: a tested
 * combination that didn't work, any result on an untested one, or something working that the matrix
 * says can't. A tested combination working as expected is not.
 */
export function differsFromMatrix(compat: Compat, outcome: Outcome): boolean {
  if (compat === "tested") return outcome !== "Works";
  if (compat === "untested") return true;
  return outcome !== "Doesn't work";
}

export const ISSUES_URL = "https://github.com/fritz-fritz/osmatrix/issues";
