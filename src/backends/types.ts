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
  /** VNC endpoint for screenshots/input, when available. */
  vnc?(): Promise<{ host: string; port: number } | undefined>;
}
