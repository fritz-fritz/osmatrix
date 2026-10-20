import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { backendFor, type Backend, type GuestStatus } from "./backends/index.ts";
import type { Viewer } from "./backends/types.ts";
import { guestArm64Brew, guestHomebrew, guestMsvc, guestWorkdir, homebrewProvisionEnv, loadConfig, readRawConfig, writeConfig, type GuestConfig } from "./core/config.ts";
import { macArm64Image, runnerHomebrew } from "./core/runner-images.ts";
import { checkSizing, requirements, type Sizing } from "./core/sizing.ts";
import { assetsDir, cliEntry, ensureDir, paths } from "./core/paths.ts";
import { isAlive, kill, sleep, spawnDetached } from "./core/proc.ts";
import {
  ensureKey,
  freePort,
  powershell,
  quotePosix,
  quotePwsh,
  pull as sshPull,
  push as sshPush,
  sshArgs,
  sshBin,
  sshExec,
  sshProbe,
  startForward,
  type Endpoint,
} from "./core/ssh.ts";
import { acquireLocks, lockHeld, LockTimeout } from "./core/locks.ts";
import { loadState, updateState, type ForwardRecord } from "./core/state.ts";

export interface Guest {
  cfg: GuestConfig;
  backend: Backend;
}

export function listGuests(): Guest[] {
  return Object.values(loadConfig().guests).map((cfg) => ({ cfg, backend: backendFor(cfg) }));
}

export function getGuest(name: string): Guest {
  const cfg = loadConfig().guests[name];
  if (!cfg) {
    const known = Object.keys(loadConfig().guests).join(", ");
    throw new Error(`unknown guest "${name}" (configured: ${known})`);
  }
  return { cfg, backend: backendFor(cfg) };
}

export async function status(name?: string): Promise<(GuestStatus & { forwards?: ForwardRecord[]; setup?: unknown })[]> {
  const guests = name ? [getGuest(name)] : listGuests();
  const fwd = loadState().forwards;
  return Promise.all(
    guests.map(async (g) => {
      let s: GuestStatus;
      try {
        s = await g.backend.status();
      } catch (e) {
        s = { name: g.cfg.name, os: g.cfg.os, backend: g.cfg.backend, state: "absent", detail: (e as Error).message };
      }
      const f = fwd.filter((x) => x.guest === g.cfg.name);
      const { setupState } = await import("./setup.ts");
      const su = setupState(g.cfg.name);
      const withSetup = su && !su.done ? { ...s, setup: { phase: su.phase, error: su.error, updatedAt: su.updatedAt } } : s;
      return f.length ? { ...withSetup, forwards: f } : withSetup;
    }),
  );
}

/**
 * Where the user can watch and use a running guest's screen, always in a browser and without a sign-in:
 * dockur's own noVNC page (at the host port Docker actually published, which differs from the 8006 in
 * dockur's log when that port was taken), or for qemu and tart guests osmatrix's viewer server, which
 * bridges noVNC to the guest's VNC display. Guests log in automatically and don't lock their screen, so
 * no credentials are involved or returned.
 */
export async function viewer(name: string): Promise<GuestViewer> {
  const g = getGuest(name);
  // viewerFor checks the guest's status; under the lock, its VNC address is rechecked (once).
  return viewerFor(g, (n) => ensureViewerServer(n, async () => !!(await g.backend.vnc?.())));
}

export type GuestViewer = Viewer & { guest: string };

/** The guest has no VNC address yet (starting, or stopped). */
export class DisplayNotUp extends Error {}

const HOW = "Open it in a browser. It shows the guest's screen, already signed in, and only listens on this machine.";

/** viewer() for a resolved guest; `serve` starts (or finds) the guest's viewer server and returns its URL. */
export async function viewerFor(g: Guest, serve: (name: string) => Promise<string>): Promise<GuestViewer> {
  const name = g.cfg.name;
  if (g.cfg.backend === "ssh" || g.cfg.backend === "container") {
    throw new Error(`${name} is a${g.cfg.backend === "ssh" ? "n ssh" : " container"} guest without a display osmatrix manages`);
  }
  // dockur serves its own viewer, at the port status() reports. Other backends need no status() (for tart
  // that's tart ip and an ssh probe): serve() checks their VNC address, which is what matters here.
  if (g.cfg.backend === "dockur" || !g.backend.vnc) {
    const st = await g.backend.status();
    if (st.state === "absent" || st.state === "stopped") throw new Error(`${name} is ${st.state}; start it first (env_up / \`osmatrix up ${name}\`)`);
    if (st.ports?.web) return { guest: name, kind: "web", url: `http://127.0.0.1:${st.ports.web}`, how: HOW };
    if (!g.backend.vnc) throw new Error(`${name} has no display osmatrix can show`);
  }
  try {
    return { guest: name, kind: "web", url: await serve(name), how: HOW };
  } catch (e) {
    // No display: say so plainly when the guest is stopped or doesn't exist (status() only on this path).
    if (e instanceof DisplayNotUp) {
      const st = await g.backend.status();
      if (st.state === "absent" || st.state === "stopped") throw new Error(`${name} is ${st.state}; start it first (env_up / \`osmatrix up ${name}\`)`);
    }
    throw e;
  }
}

/**
 * Serializes starting and stopping a guest's viewer server across CLI and MCP processes, so concurrent
 * callers share one server and none is left running untracked. With `busyAfterMs` (env_viewer), rather
 * than wait out a long stop, snapshot or reset, it says the guest is busy.
 */
async function withViewerLock<T>(name: string, fn: () => Promise<T>, busyAfterMs?: number): Promise<T> {
  let release: () => void;
  try {
    // env_viewer polls quickly for a short wait; stops and resets that wait out a long operation, slowly.
    release = await acquireLocks([viewerLockKey(name)], viewerLockOwner(name), () => {}, busyAfterMs ? 100 : 1000, busyAfterMs);
  } catch (e) {
    if (e instanceof LockTimeout) throw new Error(`${name} is busy (being started, stopped, snapshotted or reset, or another viewer request); ask again in a moment`);
    throw e;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

const viewerLockKey = (name: string) => `viewer:${name}`;
const viewerLockOwner = (name: string) => ({ pid: process.pid, run: "viewer", repo: "", leg: name });

/** How long env_viewer waits for whatever holds the guest's viewer lock before saying it's busy. */
// Longer than a worst-case viewer start (3 tries of 20 s), so a concurrent env_viewer isn't told "busy"
// just because another one is starting the server.
const VIEWER_LOCK_WAIT_MS = 70_000;

/** Whether something (a stop, snapshot, reset or viewer start) is working on the guest right now. */
export const viewerLockHeld = (name: string) => lockHeld(viewerLockKey(name));

/**
 * The URL of the guest's viewer server, started in the background unless it is already running.
 * `running` is rechecked under the lock: a guest being stopped meanwhile must not get a fresh server.
 */
export async function ensureViewerServer(name: string, running: () => Promise<boolean>): Promise<string> {
  // All under the lock teardown takes too, so a server being stopped is never handed out.
  return withViewerLock(name, async () => {
    if (!(await running())) {
      throw new DisplayNotUp(`${name}'s display isn't up yet (still starting); try again in a few seconds`);
    }
    return startViewerServer(name);
  }, VIEWER_LOCK_WAIT_MS);
}

/**
 * The guest's viewer server record. It lives in the guest's own directory rather than the shared state
 * file, so the per-guest lock alone guards it.
 */
type ViewerRecord = { pid: number; port: number; id: string; token: string };
const viewerFile = (name: string) => path.join(paths.guestDir(name), "viewer.json");

/**
 * For a viewer server exiting by itself: drop its record, if it's still its own. Under the lock, so a
 * replacement published meanwhile isn't removed; best effort if the lock stays busy.
 */
export async function dropViewerRecord(name: string, id: string): Promise<void> {
  await withViewerLock(
    name,
    async () => {
      if (viewerRecord(name)?.id === id) fs.rmSync(viewerFile(name), { force: true });
    },
    30_000,
  ).catch(() => undefined);
}

export function viewerRecord(name: string): ViewerRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(viewerFile(name), "utf8")) as ViewerRecord;
  } catch {
    return undefined;
  }
}

/** The page's URL: the bridge token rides in the fragment, which browsers never send to the server. */
const viewerUrl = (r: ViewerRecord) => `http://127.0.0.1:${r.port}/#t=${r.token}`;

async function startViewerServer(name: string): Promise<string> {
  const cur = viewerRecord(name);
  // Generous: a server busy relaying a heavy screen can be slow to answer, and replacing it cuts its page.
  if (cur && isAlive(cur.pid) && (await isViewer(cur.port, cur.id, cur.token, 5000))) return viewerUrl(cur);
  // Not answering as our server (crashed, wedged, or the pid is another process's after a reboot): drop the
  // record without signalling anything. A server of ours that is merely slow exits by itself once it sees
  // its record gone (see `osmatrix _viewer`).
  fs.rmSync(viewerFile(name), { force: true });
  let lastErr: Error | undefined;
  const log = path.join(ensureDir(paths.guestDir(name)), "viewer.log");
  fs.writeFileSync(log, ""); // this server's log only
  // A free port can be taken before the server binds it; try a few.
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const pid = spawnDetached(process.execPath, [cliEntry(), "_viewer", name, "--port", String(port)], {
      logFile: log,
      // Both through the environment, not argv, which other local users can list: the id proves the
      // server that answers is this one, the token gates its bridge.
      env: { ...process.env, OSMATRIX_VIEWER_ID: id, OSMATRIX_VIEWER_TOKEN: token },
    });
    // Up to 20 s: a cold node start on a host busy booting a VM can be slow.
    for (let i = 0; i < 200 && isAlive(pid); i++) {
      // Whatever answers must be this server: another program may have taken the port first.
      if (await isViewer(port, id, token)) {
        const rec: ViewerRecord = { pid, port, id, token };
        fs.writeFileSync(viewerFile(name), JSON.stringify(rec), { mode: 0o600 });
        return viewerUrl(rec);
      }
      await sleep(100);
    }
    kill(pid);
    lastErr = new Error(`the viewer server didn't start; see ${log}`);
  }
  throw lastErr!;
}

/** Whether the viewer server started with this id (and token) answers on the port. */
function isViewer(port: number, id: string, token: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/status?t=${encodeURIComponent(token)}`, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.headers["x-osmatrix-viewer"] === id);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

/** Stop the guest's viewer server, if any. */
export function stopViewer(name: string): Promise<void> {
  return withViewerLock(name, () => killViewer(name));
}

/**
 * Stop the guest's viewer server, then run `fn` (the backend stopping the guest) under the same lock,
 * so no env_viewer call starts a new server while the guest is going down.
 */
function withViewerStopped<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withViewerLock(name, async () => {
    await killViewer(name);
    return fn();
  });
}

async function killViewer(name: string): Promise<void> {
  const v = viewerRecord(name);
  // Only signal the pid while its server still answers with our id; a stale record's pid may be reused.
  if (v && isAlive(v.pid) && (await isViewer(v.port, v.id, v.token))) kill(v.pid);
  fs.rmSync(viewerFile(name), { force: true });
}

/** Without boot history, how long an installed guest may take before a quiet boot counts as hung. */
const DEFAULT_BOOT_BUDGET_SEC = 600;
/** A hung boot is one past its budget that has also gone this long without disk I/O (or keeps resetting). */
const IO_IDLE_SEC = 120;
const RESET_LOOP = 3;

/**
 * Decides whether a booting guest is hung rather than slow. Slow boots (updates, first boot after a
 * snapshot) keep the disk busy; a guest stuck in its boot loader or reset loop does not get further.
 * Returns why it looks hung, or undefined.
 */
export function bootHang(p: { elapsedSec: number; budgetSec: number; ioIdleSec: number; resets: number }): string | undefined {
  if (p.elapsedSec < p.budgetSec) return undefined;
  if (p.resets >= RESET_LOOP) return `its firmware restarted ${p.resets} times (reset loop)`;
  if (p.ioIdleSec >= IO_IDLE_SEC) return `its disk has been idle for ${Math.round(p.ioIdleSec)}s`;
  return undefined;
}

/** Seconds a boot may take before it can count as hung: 3x the slowest recent boot, at least 4 min. */
export function bootBudget(history: number[]): number {
  return history.length ? Math.max(240, 3 * Math.max(...history)) : DEFAULT_BOOT_BUDGET_SEC;
}

const bootHistoryFile = (name: string) => path.join(paths.guestDir(name), "boot-times.json");

function bootHistory(name: string): number[] {
  try {
    const v = JSON.parse(fs.readFileSync(bootHistoryFile(name), "utf8"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function recordBoot(name: string, sec: number) {
  const f = bootHistoryFile(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify([...bootHistory(name), Math.round(sec)].slice(-5)));
}

/**
 * Poll until ssh works. Installs our key automatically when the backend can. For an installed guest
 * whose backend can report boot activity, a hung boot throws instead of waiting out timeoutSec.
 */
export async function waitReady(g: Guest, timeoutSec: number, opts: { detectHang?: boolean } = {}): Promise<GuestStatus> {
  const start = Date.now();
  const deadline = start + timeoutSec * 1000;
  let triedKey = false;
  let polls = 0;
  const bootProbe = opts.detectHang === false ? undefined : g.backend.bootProbe?.bind(g.backend);
  // A failed probe only turns hang detection off; it must not fail the wait itself.
  const probe = bootProbe && (() => bootProbe().catch(() => undefined));
  const first = probe ? await probe() : undefined;
  const budget = bootBudget(bootHistory(g.cfg.name));
  let lastIo = first?.io;
  let lastIoChange = start;
  for (;;) {
    const s = await g.backend.status();
    if (s.state === "ready") {
      if (first && polls > 0) recordBoot(g.cfg.name, (Date.now() - start) / 1000);
      return s;
    }
    polls++;
    if (s.state === "needs-ssh-setup" && g.backend.authorizeKey && !triedKey) {
      triedKey = true;
      await g.backend.authorizeKey();
      continue;
    }
    if (s.state === "needs-ssh-setup" || s.state === "absent" || s.state === "stopped" || Date.now() > deadline) return s;
    if (first && probe && s.state === "booting") {
      const now = await probe();
      if (now) {
        if (now.io !== lastIo) {
          lastIo = now.io;
          lastIoChange = Date.now();
        }
        const elapsedSec = (Date.now() - start) / 1000;
        const why = bootHang({ elapsedSec, budgetSec: budget, ioIdleSec: (Date.now() - lastIoChange) / 1000, resets: now.boots - first.boots });
        if (why) {
          const n = g.cfg.name;
          throw new Error(
            `${n} looks hung while booting: no ssh after ${Math.round(elapsedSec / 60)} min and ${why}. ` +
              `See its screen with \`osmatrix screenshot ${n}\` (MCP: env_screenshot); \`osmatrix reset ${n}\` restores the golden snapshot, \`osmatrix down ${n}\` stops it.`,
          );
        }
      }
    }
    await sleep(5000);
  }
}

export async function up(name: string, waitSec = 0): Promise<GuestStatus> {
  const g = getGuest(name);
  await g.backend.up();
  return waitSec > 0 ? waitReady(g, waitSec) : g.backend.status();
}

export interface ConfigureResult {
  guest: string;
  /** Effective sizing after the change. */
  sizing: Sizing;
  requirements: ReturnType<typeof requirements>;
  warnings: string[];
  /** What happened, or what still has to happen, for the change to take effect. */
  applied: string;
  status?: GuestStatus;
}

/**
 * Change a guest's cpus/memory/disk in config.toml after checking them against the guest's minimums and
 * this host. With apply, a running guest is restarted (a stopped one started) and waited for, so the
 * change is live on return; otherwise it takes effect at the guest's next start.
 */
export async function configure(name: string, change: Sizing, opts: { apply?: boolean; waitSec?: number } = {}): Promise<ConfigureResult> {
  const g = getGuest(name);
  if (g.cfg.backend === "ssh") throw new Error(`${name} is an ssh guest: osmatrix does not size existing machines`);
  if (change.disk !== undefined && g.cfg.backend !== "dockur") throw new Error(`disk can only be set for dockur VM guests (${name} uses ${g.cfg.backend})`);
  const next: GuestConfig = { ...g.cfg };
  for (const k of ["cpus", "memory", "disk"] as const) if (change[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = change[k];
  const current = { disk: g.cfg.disk ?? (g.cfg.backend === "dockur" ? "64G" : undefined) };
  const { errors, warnings } = checkSizing(next, undefined, current);
  if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);

  const raw = readRawConfig();
  const guests = ((raw.guests ??= {}) as Record<string, Record<string, unknown>>);
  const entry = (guests[name] ??= {});
  for (const k of ["cpus", "memory", "disk"] as const) if (change[k] !== undefined) entry[k] = change[k];
  writeConfig(raw);

  const sizing = { cpus: next.cpus, memory: next.memory, disk: next.disk };
  const base = { guest: name, sizing, requirements: requirements(next), warnings };
  const st = await g.backend.status();
  if (!opts.apply) {
    const applied =
      st.state === "absent" || st.state === "stopped"
        ? "saved; takes effect when the guest next starts"
        : "saved; the running guest keeps its old sizing until it restarts (env_down, then env_up), or call again with apply";
    return { ...base, applied };
  }
  const fresh = getGuest(name);
  if (st.state !== "absent" && st.state !== "stopped") {
    await unforward(name, undefined, true);
    await withViewerLock(name, () => fresh.backend.down());
  }
  await withViewerLock(name, () => fresh.backend.up());
  const status = await waitReady(fresh, opts.waitSec ?? 900);
  return { ...base, applied: status.state === "ready" ? "applied; the guest restarted with the new sizing" : `restarted, but not ready yet (${status.state})`, status };
}

export async function down(name: string): Promise<GuestStatus> {
  const g = getGuest(name);
  await unforward(name, undefined, true);
  await withViewerStopped(name, () => g.backend.down());
  return g.backend.status();
}

export async function snapshot(name: string): Promise<GuestStatus> {
  const g = getGuest(name);
  await unforward(name, undefined, true);
  await snapshotGuest(g);
  return g.backend.status();
}

/**
 * The backend's snapshot, under the guest's viewer lock. Backends that stop the guest for the copy and
 * start it again keep the viewer (its page reconnects); one left stopped (tart) loses it, as with down.
 */
export function snapshotGuest(g: Guest): Promise<void> {
  const name = g.cfg.name;
  return withViewerLock(name, async () => {
    await g.backend.snapshot();
    if (!(await g.backend.vnc?.().catch(() => undefined))) {
      const st = await g.backend.status();
      if (st.state === "absent" || st.state === "stopped") await killViewer(name);
    }
  });
}

export async function reset(name: string, waitSec = 0): Promise<GuestStatus> {
  const g = getGuest(name);
  await unforward(name, undefined, true);
  // Under the viewer lock, so no viewer is started for the guest mid-reset; a running one stays and its
  // page reconnects to the new run.
  await withViewerLock(name, () => g.backend.reset());
  return waitSec > 0 ? waitReady(g, waitSec) : g.backend.status();
}

export async function destroy(name: string): Promise<void> {
  const g = getGuest(name);
  await unforward(name, undefined, true);
  await withViewerStopped(name, () => g.backend.destroy());
}

/** Endpoint for a guest that must already be reachable. */
export async function readyEndpoint(name: string): Promise<Endpoint> {
  const g = getGuest(name);
  const ep = await g.backend.endpoint();
  let p = await sshProbe(ep);
  // A busy or emulated guest can miss the probe's short connect timeout; give it a couple more tries.
  for (let i = 0; p === "down" && i < 2; i++) {
    await sleep(2000);
    p = await sshProbe(ep);
  }
  if (p === "ok") {
    // e.g. grow the partition after a disk resize, for callers that never looked at status. Best effort:
    // status() reports a failure.
    await g.backend.afterReady?.().catch(() => undefined);
    return ep;
  }
  if (p === "auth" && g.backend.authorizeKey && (await g.backend.authorizeKey()) && (await sshProbe(ep)) === "ok") return ep;
  const s = await g.backend.status();
  throw new Error(`guest ${name} is not ready (state: ${s.state}${s.detail ? `; ${s.detail}` : ""}). Run: osmatrix up ${name} --wait`);
}

export async function exec(name: string, command: string, opts: { cwd?: string; timeoutSec?: number; input?: string } = {}) {
  const ep = await readyEndpoint(name);
  const r = await sshExec(ep, command, {
    cwd: opts.cwd,
    timeoutMs: (opts.timeoutSec ?? 600) * 1000,
    input: opts.input,
    maxBytes: 256 * 1024,
  });
  return { exitCode: r.code, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Start a long-running command (dev server, watcher) that survives the ssh session.
 * Windows OpenSSH kills every process in the session's job object on disconnect, so there the process is
 * created through WMI (parented outside the job). Output goes to a log file in the working directory.
 */
export async function spawnBackground(name: string, command: string, opts: { cwd?: string } = {}) {
  const ep = await readyEndpoint(name);
  const id = Date.now().toString(36);
  const logName = `.osmatrix-bg-${id}.log`;
  let script: string;
  if (ep.shell === "pwsh" || ep.shell === "cmd") {
    const inner = `& { ${command} } *> ${quotePwsh(logName)}`;
    const encoded = Buffer.from(inner, "utf16le").toString("base64");
    script =
      `$d = (Resolve-Path -LiteralPath ${quotePwsh(opts.cwd ?? ".")}).Path; ` +
      `$exe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source; if (-not $exe) { $exe = 'powershell.exe' }; ` +
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "\`"$exe\`" -NoProfile -NonInteractive -EncodedCommand ${encoded}"; CurrentDirectory = $d }; ` +
      `if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($r.ReturnValue)" }; ` +
      `Write-Output "$($r.ProcessId) $(Join-Path $d '${logName}')"`;
    // From cmd, hand PowerShell the script base64-encoded: no cmd/PowerShell quoting to get wrong.
    if (ep.shell === "cmd") script = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  } else {
    // setsid (Linux) makes the pid a process-group leader so the whole tree can be stopped; macOS lacks it.
    const launcher = `if command -v setsid >/dev/null 2>&1; then exec setsid sh -c ${quotePosix(command)}; else exec sh -c ${quotePosix(command)}; fi`;
    script =
      `cd ${quotePosix(opts.cwd ?? ".")} || exit 1; ` +
      `nohup sh -c ${quotePosix(launcher)} > ${logName} 2>&1 < /dev/null & ` +
      `echo "$! $(pwd)/${logName}"`;
  }
  const r = await sshExec(ep, script, { timeoutMs: 60_000 });
  const m = /^(\d+)\s+(.+)$/m.exec(r.stdout.trim());
  if (r.code !== 0 || !m) throw new Error(`failed to start background command: ${(r.stderr || r.stdout).trim()}`);
  const pid = Number(m[1]);
  // Kill the whole tree: the pid is a shell wrapper around the real program.
  const stop = ep.shell === "posix" ? `kill -- -${pid} 2>/dev/null || { pkill -P ${pid}; kill ${pid}; }` : `taskkill /PID ${pid} /T /F`;
  return { guest: name, pid, log: m[2].trim(), stop };
}

// ---------- host paths that stay on the host ----------

/** Under the home directory: keys, tokens and credential stores that a guest has no business seeing. */
const SECRET_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".password-store",
  "Library/Keychains", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
];

/**
 * Why `p` shouldn't be copied to or from a guest (undefined when it's fine): the home directory or a
 * directory containing it (they hold everything below), a credential store, or osmatrix's own data and
 * config (its ssh key and guest passwords). Guests are other machines; a pulled tree could also
 * overwrite dotfiles. Symlinks are resolved first.
 */
export function sensitiveHostPath(p: string, home = os.homedir(), own = [paths.dataDir, paths.configDir]): string | undefined {
  // Resolve symlinks through the nearest existing ancestor, so a path that doesn't exist yet (a pull
  // destination) compares like its parent (macOS: /var is /private/var).
  const real = (q: string): string => {
    const abs = path.resolve(q);
    try {
      return fs.realpathSync(abs);
    } catch {
      const parent = path.dirname(abs);
      return parent === abs ? abs : path.join(real(parent), path.basename(abs));
    }
  };
  const abs = real(p);
  const inside = (dir: string) => abs === dir || abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  const contains = (dir: string) => dir === abs || dir.startsWith(abs.endsWith(path.sep) ? abs : abs + path.sep);
  const h = real(home);
  if (contains(h)) return `${abs} is your home directory or contains it`;
  for (const d of SECRET_DIRS.map((x) => path.join(h, x))) {
    if (inside(d)) return `${abs === d ? abs : `${abs} is in ${d}, which`} holds credentials`;
  }
  for (const d of own.map(real)) if (inside(d) || contains(d)) return `${abs} holds osmatrix's own data (its ssh key and guest passwords)`;
  return undefined;
}

function assertNotSensitive(p: string, allow: boolean | undefined, what: string) {
  const why = allow ? undefined : sensitiveHostPath(p);
  if (why) throw new Error(`refusing to ${what}: ${why}. If the user explicitly asked for this path, pass allow_sensitive (CLI: --allow-sensitive)`);
}

export async function push(name: string, localPath: string, remoteDir?: string, opts: { clean?: boolean; all?: boolean; allowSensitive?: boolean } = {}) {
  const g = getGuest(name);
  const abs = path.resolve(localPath);
  assertNotSensitive(abs, opts.allowSensitive, "copy it into a guest");
  const ep = await readyEndpoint(name);
  const dest = remoteDir ?? `${guestWorkdir(g.cfg)}/${path.basename(abs)}`;
  const r = await sshPush(ep, abs, fs.statSync(abs).isDirectory() ? dest : remoteDir ?? guestWorkdir(g.cfg), {
    clean: opts.clean,
    gitAware: !opts.all,
  });
  return { guest: name, local: abs, remote: dest, files: r.files };
}

export async function pull(name: string, remotePath: string, localDir = ".", opts: { allowSensitive?: boolean } = {}) {
  const abs = path.resolve(localDir);
  assertNotSensitive(abs, opts.allowSensitive, "write guest files there");
  const ep = await readyEndpoint(name);
  await sshPull(ep, remotePath, abs);
  return { guest: name, remote: remotePath, local: abs };
}

// ---------- port forwarding ----------

/**
 * spec: "guestPort" or "guestPort:hostPort" (local), "hostPort" or "hostPort:guestPort" (reverse).
 * Requested ports are preferences: when one is busy another is used, and the result says which.
 * Callers (agents) must use the returned url / hostPort / guestPort, never the number they asked for.
 */
export async function forward(name: string, spec: string, reverse = false) {
  const [a, b] = spec.split(":").map((x) => (x ? parseInt(x, 10) : undefined));
  if (!a || Number.isNaN(a) || (b !== undefined && Number.isNaN(b))) throw new Error(`bad port spec "${spec}"`);
  const ep = await readyEndpoint(name);
  const existing = loadState().forwards.filter((f) => f.guest === name);
  let rec: ForwardRecord | undefined;
  let lastErr: Error | undefined;
  if (!reverse) {
    const guestPort = a;
    const requestedHostPort = b ?? guestPort;
    const dup = existing.find((f) => f.kind === "local" && f.guestPort === guestPort && (!b || f.hostPort === b));
    if (dup) return describe(dup, requestedHostPort, true);
    // A free port can be taken between the check and ssh binding it; retry with fresh picks.
    for (let attempt = 0; attempt < 5 && !rec; attempt++) {
      const hostPort = await freePort(attempt === 0 ? requestedHostPort : undefined);
      try {
        const pid = await startForward(ep, "local", hostPort, guestPort);
        rec = { guest: name, kind: "local", hostPort, guestPort, pid, createdAt: new Date().toISOString() };
      } catch (e) {
        lastErr = e as Error;
      }
    }
    if (!rec) throw lastErr ?? new Error("could not start forward");
    updateState((s) => s.forwards.push(rec!));
    return describe(rec, requestedHostPort);
  }
  const hostPort = a;
  const requestedGuestPort = b ?? a;
  const dup = existing.find((f) => f.kind === "reverse" && f.hostPort === hostPort && (!b || f.guestPort === b));
  if (dup) return describe(dup, requestedGuestPort, true);
  // The guest-side port may be in use inside the guest; ssh then fails (ExitOnForwardFailure) and we try another.
  for (let attempt = 0; attempt < 6 && !rec; attempt++) {
    const guestPort = attempt === 0 ? requestedGuestPort : 20000 + Math.floor(Math.random() * 40000);
    try {
      const pid = await startForward(ep, "reverse", hostPort, guestPort);
      rec = { guest: name, kind: "reverse", hostPort, guestPort, pid, createdAt: new Date().toISOString() };
    } catch (e) {
      lastErr = e as Error;
      if (!/forwarding failed|address already in use|cannot listen/i.test(lastErr.message)) break;
    }
  }
  if (!rec) throw lastErr ?? new Error("could not start reverse forward");
  updateState((s) => s.forwards.push(rec!));
  return describe(rec, requestedGuestPort);
}

/** Forward result with an explicit "use this" field so agents never assume the requested port. */
function describe(f: ForwardRecord, requested: number, reused = false) {
  if (f.kind === "local") {
    const url = `http://127.0.0.1:${f.hostPort}`;
    return {
      ...f,
      url,
      ...(reused ? { reused: true } : {}),
      use: `On the host, connect to 127.0.0.1:${f.hostPort} (${url})`,
      ...(f.hostPort !== requested ? { note: `host port ${requested} was busy; using ${f.hostPort}` } : {}),
    };
  }
  return {
    ...f,
    guestUrl: `http://127.0.0.1:${f.guestPort}`,
    ...(reused ? { reused: true } : {}),
    use: `Inside guest ${f.guest}, connect to 127.0.0.1:${f.guestPort} to reach host port ${f.hostPort}`,
    ...(f.guestPort !== requested ? { note: `guest port ${requested} was busy in the guest; using ${f.guestPort}` } : {}),
  };
}

export function forwards(name?: string) {
  return loadState()
    .forwards.filter((f) => !name || f.guest === name)
    .map((f) => {
      const d = describe(f, f.kind === "local" ? f.hostPort : f.guestPort);
      return { ...f, use: d.use, ...("url" in d ? { url: d.url } : { guestUrl: (d as { guestUrl: string }).guestUrl }) };
    });
}

/** Remove forwards for a guest: one port (matches host or guest port), or all. */
export async function unforward(name: string, port?: number, all = false) {
  const removed: ForwardRecord[] = [];
  updateState((s) => {
    s.forwards = s.forwards.filter((f) => {
      const hit = f.guest === name && (all || f.hostPort === port || f.guestPort === port);
      if (hit) {
        kill(f.pid);
        removed.push(f);
      }
      return !hit;
    });
  });
  return removed;
}

// ---------- one-time setup helpers ----------

/**
 * Install the osmatrix public key on a guest that only accepts passwords (dockur macOS, ssh hosts).
 * Interactive: ssh prompts for the password on the terminal.
 */
export async function setupSsh(name: string, user?: string): Promise<GuestStatus> {
  const g = getGuest(name);
  const ep = await g.backend.endpoint();
  if (user) ep.user = user;
  const { publicKey } = await ensureKey();
  const cmd =
    ep.shell === "posix"
      ? `umask 077; mkdir -p ~/.ssh && grep -qxF '${publicKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${publicKey}' >> ~/.ssh/authorized_keys`
      : `$k='${publicKey}'; $d=Join-Path $HOME '.ssh'; New-Item -ItemType Directory -Force $d | Out-Null; Add-Content (Join-Path $d 'authorized_keys') $k`;
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(sshBin(), [...sshArgs(ep, [], true), cmd], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ssh exited with ${r.status}`);
  if (user && user !== g.cfg.user) {
    const { readRawConfig, writeConfig } = await import("./core/config.ts");
    const raw = readRawConfig();
    const guests = (raw.guests ?? {}) as Record<string, Record<string, unknown>>;
    guests[name] = { ...(guests[name] ?? {}), user };
    raw.guests = guests;
    writeConfig(raw);
  }
  return g.backend.status();
}

/** `bash <args>` with the provisioning script's settings for this guest (which Homebrew it gets) in its environment. */
export function macProvisionCommand(cfg: GuestConfig, bashArgs: string, arm64Brew?: string): string {
  const env = Object.entries(homebrewProvisionEnv(cfg, arm64Brew)).map(([k, v]) => `${k}=${quotePosix(v)}`);
  return [...env, "bash", bashArgs].join(" ");
}

/**
 * The brew tag for an Apple Silicon guest: its configured one, else the one GitHub's arm64 runner image
 * for the guest's macOS version ships. Undefined (with a note) keeps the guest's brew as it is.
 */
export async function resolveArm64Brew(
  cfg: GuestConfig,
  guest: { arch: string; productVersion: string },
  lookup: typeof runnerHomebrew = runnerHomebrew,
): Promise<{ brew?: string; note?: string }> {
  if (guest.arch !== "arm64") return {};
  const configured = guestArm64Brew(cfg);
  if (configured === false) return { note: "homebrew = false: the guest's Homebrew version is left as it is" };
  if (configured) return { brew: configured, note: `Homebrew ${configured} (from config)` };
  const image = macArm64Image(guest.productVersion);
  if (!image) return { note: `unknown macOS version "${guest.productVersion}": the guest's Homebrew version is left as it is` };
  const r = await lookup(image);
  if (!r.brew) return { note: `could not look up the Homebrew version of GitHub's ${image} runner image (${r.error}); the guest's Homebrew is left as it is` };
  return { brew: r.brew, note: `Homebrew ${r.brew}, as in GitHub's ${image} runner image (actions/runner-images ${r.ref})` };
}

/** Probe the guest's architecture and macOS version, then work out which brew an Apple Silicon guest gets. */
async function macHomebrew(ep: Endpoint, cfg: GuestConfig): Promise<{ brew?: string; note?: string }> {
  // dockur guests are always Intel; skip the probe.
  if (cfg.backend === "dockur") return {};
  const p = await sshExec(ep, "uname -m; sw_vers -productVersion", { timeoutMs: 60_000 });
  const [arch = "", productVersion = ""] = p.stdout.trim().split(/\s+/);
  return resolveArm64Brew(cfg, { arch, productVersion });
}

/** The command that runs the provisioning script, plus a note on the Homebrew version chosen. */
export async function macProvisionPlan(ep: Endpoint, cfg: GuestConfig, bashArgs: string): Promise<{ command: string; note?: string }> {
  const { brew, note } = await macHomebrew(ep, cfg);
  return { command: macProvisionCommand(cfg, bashArgs, brew), note };
}

/**
 * Run the bundled provisioning script for the guest OS (macOS: Xcode CLT, Homebrew, git, node, python, act;
 * Windows: the MSVC Build Tools). Interactive: runs in a terminal so sudo can ask for the guest password once.
 * Idempotent, so it also adds what newer osmatrix versions provision (such as Homebrew on Intel guests) to an
 * existing guest.
 */
export async function provision(name: string, opts: { passwordlessSudo?: boolean } = {}): Promise<{ guest: string; exitCode: number; homebrew?: string; hint?: string }> {
  const g = getGuest(name);
  if (g.cfg.os === "windows") return provisionWindows(g);
  if (g.cfg.os !== "macos") throw new Error("provision is only needed for macOS and Windows guests (the ubuntu image is preconfigured)");
  guestHomebrew(g.cfg); // a bad `homebrew` setting fails before anything runs in the guest
  const script = fs.readFileSync(path.join(assetsDir, "provision", "macos.sh"), "utf8");
  const ep = await readyEndpoint(name);
  const { command: cmd, note } = await macProvisionPlan(ep, g.cfg, `~/.osmatrix-provision.sh${opts.passwordlessSudo ? " --passwordless-sudo" : ""}`);
  if (note) process.stderr.write(`[osmatrix] ${note}\n`);
  const up = await sshExec(ep, "cat > ~/.osmatrix-provision.sh && chmod +x ~/.osmatrix-provision.sh", { input: script, timeoutMs: 60_000 });
  if (up.code !== 0) throw new Error(`failed to copy provisioning script: ${up.stderr}`);
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(sshBin(), [...sshArgs(ep, ["-t"]), cmd], { stdio: "inherit" });
  const exitCode = r.status ?? 1;
  // The golden snapshot still has the old toolchain; `reset` would drop what was just installed.
  const hint =
    exitCode === 0 && g.cfg.backend !== "ssh"
      ? `Run \`osmatrix snapshot ${name}\` (MCP: env_snapshot) to keep this in the golden snapshot; \`osmatrix reset ${name}\` restores the old one otherwise.`
      : undefined;
  return { guest: name, exitCode, ...(note ? { homebrew: note } : {}), ...(hint ? { hint } : {}) };
}

/**
 * Windows guests provision themselves at install. This adds what osmatrix provisions now but didn't when
 * an older guest (and its golden snapshot) was set up: the MSVC Build Tools (msvc.ps1, idempotent).
 */
async function provisionWindows(g: Guest): Promise<{ guest: string; exitCode: number; hint?: string }> {
  const name = g.cfg.name;
  if (!guestMsvc(g.cfg)) throw new Error(`${name} has msvc = false; remove it from [guests.${name}] in config.toml to install the MSVC Build Tools`);
  const script = fs.readFileSync(path.join(assetsDir, "oem", "windows", "msvc.ps1"), "utf8");
  const ep = await readyEndpoint(name);
  const file = "$f = Join-Path $env:TEMP 'osmatrix-msvc.ps1'";
  // base64: PowerShell reads stdin in the console's code page.
  const up = await sshExec(ep, powershell(ep, `${file}; [IO.File]::WriteAllBytes($f, [Convert]::FromBase64String([Console]::In.ReadToEnd()))`), {
    input: Buffer.from(script, "utf8").toString("base64"),
    timeoutMs: 60_000,
  });
  if (up.code !== 0) throw new Error(`failed to copy provisioning script: ${up.stderr}`);
  const { spawnSync } = await import("node:child_process");
  const cmd = powershell(ep, `${file}; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $f; $c = $LASTEXITCODE; Remove-Item -Force $f; exit $c`);
  const r = spawnSync(sshBin(), [...sshArgs(ep, ["-T"]), cmd], { stdio: "inherit" });
  const exitCode = r.status ?? 1;
  return exitCode === 0
    ? { guest: name, exitCode, hint: `Run \`osmatrix snapshot ${name}\` (MCP: env_snapshot) to keep this in the golden snapshot; \`osmatrix reset ${name}\` restores the old one otherwise.` }
    : { guest: name, exitCode };
}
