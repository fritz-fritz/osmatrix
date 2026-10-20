import fs from "node:fs";
import path from "node:path";
import { guestShell, type GuestConfig } from "../core/config.ts";
import { ensureDir, paths, resourcePrefix } from "../core/paths.ts";
import { run, runOk, spawnDetached, which } from "../core/proc.ts";
import { ensureKey, shutdownMacOverSsh, sshProbe, type Endpoint } from "../core/ssh.ts";
import { loadState, updateState } from "../core/state.ts";
import type { Backend, GuestStatus, Support } from "./types.ts";
import { sizeMiB } from "../core/sizing.ts";

const RESTART_FOR_VNC = (name: string) =>
  `${name} was started without tart's VNC server (by an older osmatrix, outside osmatrix, or with a tart that lacks --vnc-experimental: update tart); restart it (env_down, then env_up) to view or screenshot it`;

/** Set once this tart is known to have `run --vnc-experimental`; a "no" is asked again (tart may get updated). */
let vncFlag = false;

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
  /** `tart run`'s output, which carries its VNC address and password (so it's private to this user). */
  private get runLog() {
    return path.join(paths.guestDir(this.cfg.name), "tart-run.log");
  }
  /** Present while the guest's runs start with tart's VNC server, so vnc() can tell them from older ones. */
  private get vncRunFile() {
    return path.join(paths.guestDir(this.cfg.name), "tart-run.vnc");
  }
  private async supportsVnc(): Promise<boolean> {
    if (!vncFlag) {
      const r = await run(this.tart(), ["run", "--help"]);
      vncFlag = /--vnc-experimental/.test(r.stdout + r.stderr);
    }
    return vncFlag;
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
    ensureDir(paths.guestDir(this.cfg.name));
    const log = this.runLog;
    // Virtualization.framework's own VNC server (on 127.0.0.1, with a password made up for this run) shows
    // the screen from boot, with no macOS account involved; vnc() reads its address from the log.
    // The log carries tart's VNC password for this run: readable by this user only.
    fs.writeFileSync(log, "", { mode: 0o600 });
    fs.chmodSync(log, 0o600);
    // An older tart without the flag still boots the guest, just without a display osmatrix can show.
    const vnc = await this.supportsVnc();
    // Marked before the VM shows as running, so vnc() never takes this run for one without a VNC server.
    if (vnc) fs.writeFileSync(this.vncRunFile, "");
    else fs.rmSync(this.vncRunFile, { force: true });
    const pid = spawnDetached(this.tart(), ["run", "--no-graphics", ...(vnc ? ["--vnc-experimental"] : []), this.vm], { logFile: log });
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
    // Once stopped, the next run decides for itself (one started by hand then gets the "restart it" hint
    // from vnc()); a VM that didn't stop keeps its VNC server, and its marker.
    if (!(await running())) fs.rmSync(this.vncRunFile, { force: true });
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

  /**
   * The VNC server `tart run --vnc-experimental` started; its password changes with every run. Read from
   * the log of the `tart run` osmatrix started, and only while that process lives: a stale log's address
   * may belong to something else by now.
   */
  async vnc(): Promise<{ host: string; port: number; password: string } | undefined> {
    if (!(await this.list()).some((v) => v.Name === this.vm && v.State === "running")) return undefined;
    // Running, but not started by an `up` that turned tart's VNC server on: an older osmatrix, `tart run`
    // by hand, or a tart without --vnc-experimental.
    if (!fs.existsSync(this.vncRunFile)) throw new Error(RESTART_FOR_VNC(this.cfg.name));
    // Running, but our `tart run` has exited: the VM is going down, or was started again outside osmatrix.
    // Either way the log's address is stale.
    if (!loadState().pids[this.cfg.name]) {
      throw new Error(`${this.cfg.name} is running, but not from osmatrix's \`tart run\` (it may be shutting down); if it stays up, restart it (env_down, then env_up) to view or screenshot it`);
    }
    let log: string;
    try {
      log = fs.readFileSync(this.runLog, "utf8");
    } catch {
      return undefined;
    }
    const m = [...log.matchAll(/vnc:\/\/:([^@\s]*)@([^:/\s]+):(\d+)/g)].pop();
    if (!m) return undefined; // tart hasn't printed the address yet
    let password: string;
    try {
      password = decodeURIComponent(m[1]);
    } catch {
      password = m[1];
    }
    return { host: m[2], port: parseInt(m[3], 10), password };
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
