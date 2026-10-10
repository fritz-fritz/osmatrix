import os from "node:os";
import path from "node:path";
import { guestShell, type GuestConfig } from "../core/config.ts";
import { ensureKey, sshProbe, type Endpoint } from "../core/ssh.ts";
import type { Backend, GuestStatus, Support } from "./types.ts";

/** An existing machine reachable over ssh (a real Mac, a teammate's VM host, ...). No lifecycle. */
export class SshBackend implements Backend {
  readonly cfg: GuestConfig;
  constructor(cfg: GuestConfig) {
    this.cfg = cfg;
  }

  async supported(): Promise<Support> {
    return this.cfg.host ? { ok: true } : { ok: false, reason: `guest "${this.cfg.name}" (ssh backend) needs host` };
  }

  async status(): Promise<GuestStatus> {
    const p = await sshProbe(await this.endpoint());
    return {
      name: this.cfg.name,
      os: this.cfg.os,
      backend: "ssh",
      state: p === "ok" ? "ready" : p === "auth" ? "needs-ssh-setup" : "unmanaged",
      detail: p === "down" ? `cannot reach ${this.cfg.host}:${this.cfg.port ?? 22}` : undefined,
    };
  }

  private unmanaged(op: string): never {
    throw new Error(`${this.cfg.name} uses the ssh backend; "${op}" must be done on that machine`);
  }
  async up(): Promise<void> {
    /* nothing to start */
  }
  async down(): Promise<void> {
    /* nothing to stop */
  }
  async snapshot(): Promise<void> {
    this.unmanaged("snapshot");
  }
  async reset(): Promise<void> {
    this.unmanaged("reset");
  }
  async destroy(): Promise<void> {
    this.unmanaged("destroy");
  }

  async endpoint(): Promise<Endpoint> {
    const identity = this.cfg.identity ? this.cfg.identity.replace(/^~(?=$|[\\/])/, os.homedir()) : (await ensureKey()).privateKey;
    return {
      host: this.cfg.host ?? "localhost",
      port: this.cfg.port ?? 22,
      user: this.cfg.user ?? os.userInfo().username,
      identity: path.normalize(identity),
      os: this.cfg.os,
      shell: guestShell(this.cfg),
      checkHostKey: true,
    };
  }
}
