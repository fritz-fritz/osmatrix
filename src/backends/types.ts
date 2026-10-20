import type { GuestConfig } from "../core/config.ts";
import type { Endpoint } from "../core/ssh.ts";

export type GuestState =
  | "absent" // never created
  | "stopped"
  | "booting" // running, ssh not answering yet (includes OS installation)
  | "needs-ssh-setup" // sshd answers but our key is not authorized
  | "ready"
  | "unmanaged"; // ssh backend that is not reachable

export interface GuestStatus {
  name: string;
  os: string;
  backend: string;
  state: GuestState;
  detail?: string;
  /** Human-facing URLs (web viewer etc). */
  urls?: Record<string, string>;
  /** Host ports actually in use (configured ports are preferences; a busy one is replaced). */
  ports?: Record<string, number>;
  hasSnapshot?: boolean;
}

export interface Support {
  ok: boolean;
  reason?: string;
}

export interface Backend {
  readonly cfg: GuestConfig;
  supported(): Promise<Support>;
  status(): Promise<GuestStatus>;
  /** Create/start. Returns once the start was issued (not necessarily ready). */
  up(): Promise<void>;
  down(): Promise<void>;
  /** Save current disk as the golden snapshot (guest is stopped while copying). */
  snapshot(): Promise<void>;
  /** Restore golden snapshot (or recreate from scratch when none exists). */
  reset(): Promise<void>;
  /** Permanently remove the guest and its disks. */
  destroy(): Promise<void>;
  endpoint(): Promise<Endpoint>;
  /** Called once ssh answers but rejects our key; backends that can install the key themselves do it here. */
  authorizeKey?(): Promise<boolean>;
  /**
   * Post-boot housekeeping (e.g. growing a partition after a disk resize); idempotent and cheap once
   * done. readyEndpoint calls it; backends may also call it from status().
   */
  afterReady?(): Promise<void>;
  /**
   * Activity counters for an installed guest that is booting: disk bytes moved and firmware boots so far.
   * Undefined while the guest is still being installed, when long quiet phases are normal.
   */
  bootProbe?(): Promise<{ io: number; boots: number } | undefined>;
  /** VNC endpoint for screenshots/input, when available. */
  vnc?(): Promise<{ host: string; port: number } | undefined>;
  /**
   * How a person watches this guest's screen, for backends whose display isn't the web viewer or VNC
   * endpoint above (env.viewer falls back to those).
   */
  viewer?(): Promise<Viewer>;
}

/** Where a person can watch and use a guest's screen. */
export interface Viewer {
  /** "web": open url in a browser; "vnc": open it with a VNC client (Screen Sharing on macOS). */
  kind: "web" | "vnc";
  url: string;
  /** How to open it, in the user's terms. */
  how: string;
}

/**
 * What the unattended macOS install (Recovery -> startosinstall -> Recovery -> ssh, in setup.ts) needs
 * from an Intel macOS VM: dockur's container or the host's QEMU.
 */
export interface MacInstallVm {
  credentials(): { username: string; password: string };
  /** True once ssh has worked at least once. */
  everReady(): boolean;
  /** Start the VM afresh (stopping it hard first if it runs), with or without OpenCore's boot menu. */
  boot(opts: { picker: boolean }): Promise<void>;
  /** Recent firmware and serial console output (OpenCore logs there). */
  console(): Promise<string>;
  /** Number of times OpenCore has started since the VM was booted. */
  bootCount(): Promise<number>;
  /** Total bytes the VM has read and written (a progress signal while installing). */
  ioBytes(): Promise<number>;
  /** Hard reset; the installer occasionally hangs. */
  powerCycle(): Promise<void>;
  /** Start the command bridge's server side (see assets/macos/bridge.py). */
  bridgeStart(): Promise<void>;
  /** The bridge's base URL as the guest reaches it, as a shell expression for the guest to evaluate. */
  bridgeUrl(): string;
  bridgeAlive(): Promise<boolean>;
  /** Run a command in the guest through the bridge; the output ends with "[rc=N]". */
  bridgeRun(cmd: string, timeoutSec: number): Promise<string>;
  /** Offer a host file to the guest at <bridge URL>/file/<name>. */
  bridgeFile(name: string, localPath: string): Promise<void>;
}
