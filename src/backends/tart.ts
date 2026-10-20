import fs from "node:fs";
import path from "node:path";
import { guestShell, type GuestConfig } from "../core/config.ts";
import { ensureDir, paths, resourcePrefix } from "../core/paths.ts";
import { run, runOk, spawnDetached, which } from "../core/proc.ts";
import { ensureKey, shutdownMacOverSsh, sshProbe, type Endpoint } from "../core/ssh.ts";
import { updateState } from "../core/state.ts";
import type { Backend, GuestStatus, Support } from "./types.ts";
import { sizeMiB } from "../core/sizing.ts";

/** macOS (or Linux) VMs on Apple Silicon via cirruslabs/tart (Virtualization.framework). */
export class TartBackend implements Backend {
  readonly cfg: GuestConfig;
  constructor(cfg: GuestConfig) {
    this.cfg = cfg;
  }

  private get vm() {
    return `${resourcePrefix}-${this.cfg.name}`;
  }
  private get golden() {
    return `${resourcePrefix}-${this.cfg.name}-golden`;
  }
  private tart(): string {
    const b = which("tart");
    if (!b) throw new Error("tart not found (brew install cirruslabs/cli/tart)");
    return b;
  }

  private async list(): Promise<{ Name: string; State: string }[]> {
    const r = await run(this.tart(), ["list", "--format", "json"]);
    return r.code === 0 ? JSON.parse(r.stdout) : [];
  }

  async supported(): Promise<Support> {
    if (process.platform !== "darwin" || process.arch !== "arm64") return { ok: false, reason: "tart requires an Apple Silicon Mac" };
    if (!which("tart")) return { ok: false, reason: "tart not installed (brew install cirruslabs/cli/tart)" };
    return { ok: true };
  }

  async status(): Promise<GuestStatus> {
    const vms = await this.list();
    const me = vms.find((v) => v.Name === this.vm);
    const base: GuestStatus = {
      name: this.cfg.name,
      os: this.cfg.os,
      backend: "tart",
      state: "absent",
      hasSnapshot: vms.some((v) => v.Name === this.golden),
    };
    if (!me) return base;
    if (me.State !== "running") return { ...base, state: "stopped" };
    let ep: Endpoint;
    try {
      ep = await this.endpoint();
    } catch {
      return { ...base, state: "booting" };
    }
    const p = await sshProbe(ep);
    return { ...base, state: p === "ok" ? "ready" : p === "auth" ? "needs-ssh-setup" : "booting" };
  }

  async up(): Promise<void> {
    const vms = await this.list();
    const me = vms.find((v) => v.Name === this.vm);
    if (!me) {
      await runOk(this.tart(), ["clone", this.cfg.image ?? "ghcr.io/cirruslabs/macos-sequoia-base:latest", this.vm], { timeoutMs: 2 * 60 * 60_000 });
    } else if (me.State === "running") {
      return;
    }
    // Applied on every start, so changed cpus/memory take effect at the next boot.
    const set = ["set", this.vm];
    if (this.cfg.cpus) set.push("--cpu", String(this.cfg.cpus));
    if (this.cfg.memory) set.push("--memory", String(sizeMiB(this.cfg.memory)));
    if (set.length > 2) await runOk(this.tart(), set);
    const log = path.join(ensureDir(paths.guestDir(this.cfg.name)), "tart-run.log");
    // Virtualization.framework's own VNC server (on 127.0.0.1, with a password made up for this run) shows
    // the screen from boot, with no macOS account involved; vnc() reads its address from the log.
    fs.writeFileSync(log, "");
    const pid = spawnDetached(this.tart(), ["run", "--no-graphics", "--vnc-experimental", this.vm], { logFile: log });
    updateState((s) => {
      s.pids[this.cfg.name] = pid;
    });
  }

  async authorizeKey(): Promise<boolean> {
    // cirruslabs images ship the tart guest agent, which lets us install our key without a password.
    const { publicKey } = await ensureKey();
    const r = await run(this.tart(), ["exec", "-i", this.vm, "sh", "-c", "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"], {
      input: publicKey + "\n",
      timeoutMs: 60_000,
    });
    return r.code === 0;
  }

  /**
   * `tart stop` asks the VM to stop and force-stops it after 30 s; a macOS guest answers that request
   * with a dialog, not a shutdown. A reachable macOS guest is shut down over ssh first, so it stops
   * cleanly; `tart stop` then handles whatever is still running.
   */
  async down(): Promise<void> {
    const running = async () => (await this.list()).some((v) => v.Name === this.vm && v.State === "running");
    try {
      // Optional: no address yet (still booting), no key or no ssh all fall through to tart stop.
      if (this.cfg.os === "macos" && (await running())) await shutdownMacOverSsh(await this.endpoint(), running);
    } catch {
      /* fall through to tart stop */
    }
    await run(this.tart(), ["stop", this.vm], { timeoutMs: 3 * 60_000 });
  }

  async snapshot(): Promise<void> {
    await this.down();
    await run(this.tart(), ["delete", this.golden]);
    await runOk(this.tart(), ["clone", this.vm, this.golden]);
  }

  async reset(): Promise<void> {
    await this.down();
    const hasGolden = (await this.list()).some((v) => v.Name === this.golden);
    await run(this.tart(), ["delete", this.vm]);
    if (hasGolden) await runOk(this.tart(), ["clone", this.golden, this.vm]);
    await this.up();
  }

  async destroy(): Promise<void> {
    await this.down();
    await run(this.tart(), ["delete", this.vm]);
    await run(this.tart(), ["delete", this.golden]);
  }

  /** The VNC server `tart run --vnc-experimental` started; its password changes with every run. */
  async vnc(): Promise<{ host: string; port: number; password: string } | undefined> {
    let log: string;
    try {
      log = fs.readFileSync(path.join(paths.guestDir(this.cfg.name), "tart-run.log"), "utf8");
    } catch {
      return undefined;
    }
    const m = [...log.matchAll(/vnc:\/\/:([^@\s]*)@([\d.]+):(\d+)/g)].pop();
    if (!m) return undefined;
    return { host: m[2], port: parseInt(m[3], 10), password: decodeURIComponent(m[1]) };
  }

  async endpoint(): Promise<Endpoint> {
    const ip = (await runOk(this.tart(), ["ip", "--wait", "5", this.vm])).trim();
    const { privateKey } = await ensureKey();
    return {
      host: ip,
      port: 22,
      user: this.cfg.user ?? "admin",
      identity: privateKey,
      os: this.cfg.os,
      shell: guestShell(this.cfg),
      checkHostKey: false,
    };
  }
}
