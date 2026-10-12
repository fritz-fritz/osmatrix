import os from "node:os";
import { guestMsvc, type GuestConfig } from "./config.ts";

/** Resource needs of a guest. Sizes are GiB. */
export interface Requirements {
  cpus: { min: number; recommended: number };
  memoryGB: { min: number; recommended: number };
  /** Virtual disk size. VM disks are sparse: the host only stores what the guest has written. */
  diskGB?: { min: number; recommended: number };
  /** Host disk a freshly provisioned guest actually uses (measured), excluding its golden snapshot. */
  footprintGB?: number;
  note?: string;
}

/** Disk the VS 2022 Build Tools C++ workload (MSVC, Windows SDK, CMake) uses in a Windows guest. */
export const MSVC_GB = 8;

/**
 * What each kind of guest needs. Minimums are what the OS and osmatrix's provisioning still work with;
 * recommended values are the defaults and leave room for a typical CI leg (npm/pip installs, builds).
 */
export function requirements(g: Pick<GuestConfig, "os" | "backend" | "image" | "msvc">): Requirements {
  if (g.backend === "container") {
    return {
      cpus: { min: 1, recommended: 2 },
      memoryGB: { min: 1, recommended: 4 },
      note: "Shares the host kernel; with no cpus/memory set it may use the whole host.",
    };
  }
  if (g.backend === "ssh") {
    return { cpus: { min: 1, recommended: 2 }, memoryGB: { min: 2, recommended: 4 }, note: "An existing machine; osmatrix does not size it." };
  }
  if (g.os === "windows") {
    const arm = /windows-arm/.test(g.image ?? "");
    // The MSVC Build Tools C++ workload with the Windows SDK takes about 8G once installed.
    const msvc = guestMsvc(g) ? MSVC_GB : 0;
    return {
      cpus: { min: 2, recommended: 4 },
      memoryGB: { min: 4, recommended: 8 },
      // Windows 11 (the ARM image) refuses to install on less than 64G; Server 2025 needs 32G plus room for the toolchain.
      diskGB: arm ? { min: 64, recommended: 64 } : { min: 40 + msvc, recommended: 64 },
      footprintGB: (arm ? 20 : 12) + msvc,
      note:
        "First setup also downloads the install ISO (~6G) into the guest's volume." +
        (msvc ? ` Includes the MSVC Build Tools (~${MSVC_GB}G, ~10-20 min of setup); msvc = false skips them.` : ""),
    };
  }
  if (g.backend === "tart") {
    return {
      cpus: { min: 2, recommended: 4 },
      memoryGB: { min: 4, recommended: 8 },
      footprintGB: 25,
      note: "Disk size comes from the tart image (the cirruslabs base images ship 50G).",
    };
  }
  return {
    cpus: { min: 2, recommended: 4 },
    memoryGB: { min: 4, recommended: 8 },
    diskGB: { min: 48, recommended: 64 },
    footprintGB: 25,
    note: "First setup also downloads the macOS recovery image (~1G).",
  };
}

/** "8G", "8192M", "8GB", "8" (GiB) -> GiB. */
export function parseSizeGB(s: string | number): number {
  if (typeof s === "number") return s;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?\s*$/i.exec(s);
  if (!m) throw new Error(`invalid size "${s}" (use e.g. "8G" or "8192M")`);
  const n = Number(m[1]);
  const unit = (m[2] || "G").toUpperCase();
  return { K: n / 1024 ** 2, M: n / 1024, G: n, T: n * 1024 }[unit] ?? n;
}

/** A size as whole MiB, for tools that take a number (tart) or a unit suffix (docker: `${mib}m`). */
export function sizeMiB(s: string | number): number {
  return Math.round(parseSizeGB(s) * 1024);
}

export interface Sizing {
  cpus?: number;
  memory?: string;
  disk?: string;
}

export interface SizingCheck {
  errors: string[];
  warnings: string[];
}

/**
 * Checks one guest's sizing against its requirements and this host. Memory across all VM guests is
 * checked by doctor (host.ts), not here.
 */
export function checkSizing(
  g: GuestConfig,
  host = { cpus: os.cpus().length, memoryGB: os.totalmem() / 1024 ** 3 },
  current?: Sizing,
): SizingCheck {
  const r = requirements(g);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (g.backend === "ssh") return { errors, warnings };
  if (g.cpus !== undefined) {
    if (!Number.isInteger(g.cpus) || g.cpus < 1) errors.push(`cpus must be a positive integer (got ${g.cpus})`);
    else if (g.cpus > host.cpus) errors.push(`cpus = ${g.cpus} exceeds the host's ${host.cpus} logical CPUs`);
    else if (g.cpus < r.cpus.min) errors.push(`cpus = ${g.cpus} is below the minimum of ${r.cpus.min}`);
    else if (g.cpus < r.cpus.recommended) warnings.push(`cpus = ${g.cpus} is below the recommended ${r.cpus.recommended}; builds will be slow`);
  }
  if (g.memory !== undefined) {
    const mem = parseSizeGB(g.memory);
    if (mem < r.memoryGB.min) errors.push(`memory = ${g.memory} is below the minimum of ${r.memoryGB.min}G`);
    else if (mem < r.memoryGB.recommended) warnings.push(`memory = ${g.memory} is below the recommended ${r.memoryGB.recommended}G; large installs or builds may run out`);
    // Leave the host itself room to work (Docker, the agent, editors).
    const usable = Math.floor(host.memoryGB - Math.max(4, host.memoryGB * 0.2));
    if (mem > usable) errors.push(`memory = ${g.memory} leaves too little for the host (${Math.round(host.memoryGB)}G total; at most ${usable}G per guest)`);
  }
  if (g.disk !== undefined && r.diskGB) {
    const disk = parseSizeGB(g.disk);
    if (disk < r.diskGB.min) {
      const without = requirements({ ...g, msvc: false }).diskGB?.min ?? r.diskGB.min;
      const why = without < r.diskGB.min ? ` (it includes the MSVC Build Tools; msvc = false lowers it to ${without}G)` : "";
      errors.push(`disk = ${g.disk} is below the minimum of ${r.diskGB.min}G${why}`);
    }
    if (current?.disk !== undefined && disk < parseSizeGB(current.disk)) {
      errors.push(`disk can only grow (currently ${current.disk}); shrinking a VM disk is not supported`);
    }
  }
  return { errors, warnings };
}
