import fs from "node:fs";
import path from "node:path";
import { backendFor, type Backend, type GuestStatus } from "./backends/index.ts";
import { guestWorkdir, loadConfig, type GuestConfig } from "./core/config.ts";
import { assetsDir } from "./core/paths.ts";
import { kill, sleep } from "./core/proc.ts";
import {
  ensureKey,
  freePort,
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

/** Poll until ssh works. Installs our key automatically when the backend can. */
export async function waitReady(g: Guest, timeoutSec: number): Promise<GuestStatus> {
  const deadline = Date.now() + timeoutSec * 1000;
  let triedKey = false;
  for (;;) {
    const s = await g.backend.status();
    if (s.state === "ready") return s;
    if (s.state === "needs-ssh-setup" && g.backend.authorizeKey && !triedKey) {
      triedKey = true;
      await g.backend.authorizeKey();
      continue;
    }
    if (s.state === "needs-ssh-setup" || s.state === "absent" || s.state === "stopped" || Date.now() > deadline) return s;
    await sleep(5000);
  }
}

export async function up(name: string, waitSec = 0): Promise<GuestStatus> {
  const g = getGuest(name);
  await g.backend.up();
  return waitSec > 0 ? waitReady(g, waitSec) : g.backend.status();
}

export async function down(name: string): Promise<GuestStatus> {
  const g = getGuest(name);
  await unforward(name, undefined, true);
  await g.backend.down();
  return g.backend.status();
}

export async function snapshot(name: string): Promise<GuestStatus> {
  const g = getGuest(name);
  await unforward(name, undefined, true);
  await g.backend.snapshot();
  return g.backend.status();
}

export async function reset(name: string, waitSec = 0): Promise<GuestStatus> {
  const g = getGuest(name);
  await unforward(name, undefined, true);
  await g.backend.reset();
  return waitSec > 0 ? waitReady(g, waitSec) : g.backend.status();
}

export async function destroy(name: string): Promise<void> {
  const g = getGuest(name);
  await unforward(name, undefined, true);
  await g.backend.destroy();
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
  if (p === "ok") return ep;
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

export async function push(name: string, localPath: string, remoteDir?: string, opts: { clean?: boolean; all?: boolean } = {}) {
  const g = getGuest(name);
  const ep = await readyEndpoint(name);
  const abs = path.resolve(localPath);
  const dest = remoteDir ?? `${guestWorkdir(g.cfg)}/${path.basename(abs)}`;
  const r = await sshPush(ep, abs, fs.statSync(abs).isDirectory() ? dest : remoteDir ?? guestWorkdir(g.cfg), {
    clean: opts.clean,
    gitAware: !opts.all,
  });
  return { guest: name, local: abs, remote: dest, files: r.files };
}

export async function pull(name: string, remotePath: string, localDir = ".") {
  const ep = await readyEndpoint(name);
  const abs = path.resolve(localDir);
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

/**
 * Run the bundled provisioning script for the guest OS (macOS: Xcode CLT, Homebrew, git, node, python, act).
 * Interactive: runs in a terminal so sudo can ask for the guest password once.
 */
export async function provision(name: string, opts: { passwordlessSudo?: boolean } = {}) {
  const g = getGuest(name);
  if (g.cfg.os !== "macos") throw new Error("provision is only needed for macOS guests (Windows provisions itself at install, the ubuntu image is preconfigured)");
  const script = fs.readFileSync(path.join(assetsDir, "provision", "macos.sh"), "utf8");
  const ep = await readyEndpoint(name);
  const up = await sshExec(ep, "cat > ~/.osmatrix-provision.sh && chmod +x ~/.osmatrix-provision.sh", { input: script, timeoutMs: 60_000 });
  if (up.code !== 0) throw new Error(`failed to copy provisioning script: ${up.stderr}`);
  const { spawnSync } = await import("node:child_process");
  const cmd = `bash ~/.osmatrix-provision.sh${opts.passwordlessSudo ? " --passwordless-sudo" : ""}`;
  const r = spawnSync(sshBin(), [...sshArgs(ep, ["-t"]), cmd], { stdio: "inherit" });
  return { guest: name, exitCode: r.status ?? 1 };
}
