import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { OsFamily, Shell } from "./config.ts";
import { ensureDir, paths } from "./paths.ts";
import { run, runOk, sleep, spawnDetached, TailBuffer, which, isAlive, type RunResult } from "./proc.ts";

export interface Endpoint {
  host: string;
  port: number;
  user: string;
  /** Private key path. */
  identity: string;
  os: OsFamily;
  shell: Shell;
  /** Disposable local VMs change host keys on reset, so we skip checking for them. */
  checkHostKey: boolean;
}

export function sshBin(): string {
  const b = which("ssh");
  if (!b) throw new Error("OpenSSH client (ssh) not found on PATH");
  return b;
}

/** Generate the osmatrix key pair on first use. */
export async function ensureKey(): Promise<{ privateKey: string; publicKey: string }> {
  const key = paths.keyFile;
  if (!fs.existsSync(key)) {
    ensureDir(path.dirname(key));
    await runOk(which("ssh-keygen") ?? "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "osmatrix", "-f", key]);
  }
  return { privateKey: key, publicKey: fs.readFileSync(key + ".pub", "utf8").trim() };
}

export function sshArgs(ep: Endpoint, extra: string[] = [], interactive = false): string[] {
  const nullDev = process.platform === "win32" ? "NUL" : "/dev/null";
  const a = ["-p", String(ep.port), "-i", ep.identity];
  // Interactive mode allows password prompts (one-time key installation).
  if (!interactive) a.push("-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes");
  a.push(
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "LogLevel=ERROR",
  );
  // Disposable local guests: ignore host keys. Real machines: trust on first use, then verify.
  if (!ep.checkHostKey) a.push("-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${nullDev}`);
  else a.push("-o", "StrictHostKeyChecking=accept-new");
  return [...a, ...extra, `${ep.user}@${ep.host}`];
}

// ---------- quoting ----------

export function quotePosix(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function quotePwsh(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+,\\]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

export function quoteFor(shell: Shell, s: string): string {
  if (shell === "pwsh") return quotePwsh(s);
  if (shell === "cmd") return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return quotePosix(s);
}

/** Join argv into a command line for the guest shell. Native executables only for pwsh (uses the & call operator). */
export function commandLine(shell: Shell, argv: string[]): string {
  const q = argv.map((a) => quoteFor(shell, a));
  return shell === "pwsh" ? `& ${q.join(" ")}` : q.join(" ");
}

/**
 * A PowerShell script as a command for a Windows endpoint. Guests whose ssh shell is cmd get Windows
 * PowerShell with the script encoded, which sidesteps cmd's quoting.
 */
export function powershell(ep: Pick<Endpoint, "shell">, script: string): string {
  if (ep.shell === "pwsh") return script;
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/** Prefix a command with a working-directory change (relative paths are relative to the guest home). */
export function withCwd(shell: Shell, cwd: string | undefined, command: string): string {
  if (!cwd) return command;
  if (shell === "pwsh") return `Set-Location -LiteralPath ${quotePwsh(cwd)}; ${command}`;
  if (shell === "cmd") return `cd /d ${quoteFor("cmd", cwd)} && ${command}`;
  return `cd ${quotePosix(cwd)} && ${command}`;
}

export interface ChainStep {
  argv: string[];
  /** Keep going when this step fails. */
  optional?: boolean;
}

/**
 * Run native commands one after another in the guest shell, stopping at the first required step that
 * fails. Windows PowerShell 5.1 has no `&&`, so pwsh checks $LASTEXITCODE after each step instead.
 */
export function commandChain(shell: Shell, steps: ChainStep[]): string {
  if (shell === "pwsh") {
    // Stop turns "command not found" into a failure; otherwise pwsh prints it and carries on.
    const body = steps.map((s) => commandLine(shell, s.argv) + (s.optional ? "" : "; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"));
    return ["$ErrorActionPreference = 'Stop'", ...body].join("; ");
  }
  const ok = shell === "cmd" ? "ver >nul" : "true";
  return steps.map((s) => (s.optional ? `(${commandLine(shell, s.argv)} || ${ok})` : commandLine(shell, s.argv))).join(" && ");
}

// ---------- exec ----------

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string | Buffer;
  maxBytes?: number;
}

export function sshExec(ep: Endpoint, command: string, opts: ExecOptions = {}): Promise<RunResult> {
  return run(sshBin(), sshArgs(ep, ["-T"]).concat([withCwd(ep.shell, opts.cwd, command)]), {
    timeoutMs: opts.timeoutMs,
    input: opts.input,
    maxBytes: opts.maxBytes,
  });
}

export type ProbeResult = "ok" | "auth" | "down";

export async function sshProbe(ep: Endpoint): Promise<ProbeResult> {
  const r = await run(sshBin(), sshArgs(ep, ["-T", "-o", "ConnectTimeout=3"]).concat(["echo osmatrix-ok"]), {
    timeoutMs: 10_000,
  });
  if (r.code === 0 && r.stdout.includes("osmatrix-ok")) return "ok";
  if (/Permission denied|Too many authentication failures/i.test(r.stderr)) return "auth";
  return "down";
}

// ---------- file transfer (tar over ssh) ----------

/** Create dir in the guest (relative paths are relative to the guest home); clean deletes it first. */
export function mkdirCmd(shell: Shell, dir: string, clean: boolean): string {
  if (shell === "pwsh") {
    const q = quotePwsh(dir);
    return (
      (clean ? `if (Test-Path -LiteralPath ${q}) { Remove-Item -LiteralPath ${q} -Recurse -Force }; ` : "") +
      `New-Item -ItemType Directory -Force -Path ${q} | Out-Null`
    );
  }
  if (shell === "cmd") {
    const q = quoteFor("cmd", dir);
    return (clean ? `(if exist ${q} rmdir /s /q ${q}) & ` : "") + `(if not exist ${q} mkdir ${q})`;
  }
  const q = quotePosix(dir);
  return (clean ? `rm -rf ${q} && ` : "") + `mkdir -p ${q}`;
}

/** Files to send for a directory: git-tracked + untracked-not-ignored when it is a git work tree. */
export async function listPushFiles(localDir: string, includeGit: boolean): Promise<string[] | undefined> {
  const r = await run("git", ["-C", localDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (r.code !== 0) return undefined;
  const files = r.stdout.split("\0").filter((f) => f && fs.existsSync(path.join(localDir, f)));
  if (includeGit && fs.existsSync(path.join(localDir, ".git"))) files.push(".git");
  return files;
}

export interface PushOptions {
  /** Delete the remote directory first. */
  clean?: boolean;
  /** Respect .gitignore when localPath is a git work tree (default true). */
  gitAware?: boolean;
  /** Also send the .git directory (needed by act). */
  includeGit?: boolean;
  timeoutMs?: number;
}

/** Copy a local file or directory into remoteDir on the guest. */
export async function push(ep: Endpoint, localPath: string, remoteDir: string, opts: PushOptions = {}): Promise<{ files: number | "all" }> {
  const st = fs.statSync(localPath);
  const baseDir = st.isDirectory() ? localPath : path.dirname(localPath);
  let files: string[] | undefined;
  if (st.isDirectory()) {
    if (opts.gitAware !== false) files = await listPushFiles(localPath, !!opts.includeGit);
  } else {
    files = [path.basename(localPath)];
  }
  const tarArgs = ["-c", "-f", "-", "-C", baseDir];
  if (files) tarArgs.push("--null", "-T", "-");
  else tarArgs.push(".");

  const remote = `${mkdirCmd(ep.shell, remoteDir, !!opts.clean)}${ep.shell === "pwsh" ? ";" : " &&"} tar -x -f - -C ${quoteFor(ep.shell, remoteDir)}`;
  await pipe(
    "tar",
    tarArgs,
    files ? Buffer.from(files.join("\0") + "\0") : undefined,
    sshBin(),
    sshArgs(ep, ["-T"]).concat([remote]),
    opts.timeoutMs ?? 30 * 60_000,
  );
  return { files: files ? files.length : "all" };
}

/** Copy a remote file or directory (relative to guest home or absolute) into localDir. */
export async function pull(ep: Endpoint, remotePath: string, localDir: string, timeoutMs = 30 * 60_000): Promise<void> {
  ensureDir(localDir);
  const norm = remotePath.replace(/[\\/]+$/, "");
  const sep = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  const parent = sep >= 0 ? norm.slice(0, sep) || "/" : ".";
  const base = sep >= 0 ? norm.slice(sep + 1) : norm;
  const remote = `tar -c -f - -C ${quoteFor(ep.shell, parent)} ${quoteFor(ep.shell, base)}`;
  await pipe(sshBin(), sshArgs(ep, ["-T"]).concat([remote]), undefined, "tar", ["-x", "-f", "-", "-C", localDir], timeoutMs);
}

function pipe(
  aCmd: string,
  aArgs: string[],
  aInput: Buffer | undefined,
  bCmd: string,
  bArgs: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, COPYFILE_DISABLE: "1" };
    const a = spawn(aCmd, aArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    const b = spawn(bCmd, bArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    const errA = new TailBuffer(8192);
    const errB = new TailBuffer(8192);
    a.stderr!.on("data", (d) => errA.push(d));
    b.stderr!.on("data", (d) => errB.push(d));
    b.stdout!.on("data", () => {});
    a.stdout!.pipe(b.stdin!);
    a.stdin!.on("error", () => {});
    b.stdin!.on("error", () => {});
    if (aInput) a.stdin!.end(aInput);
    else a.stdin!.end();
    const timer = setTimeout(() => {
      a.kill();
      b.kill();
    }, timeoutMs);
    let codeA: number | null = null;
    let done = 0;
    const finish = () => {
      if (++done < 2) return;
      clearTimeout(timer);
      if (codeA === 0 && codeB === 0) resolve();
      else reject(new Error(`transfer failed (${aCmd}=${codeA}, ${bCmd}=${codeB}): ${(errA.toString() + errB.toString()).trim()}`));
    };
    let codeB: number | null = null;
    a.on("error", (e) => errA.push(Buffer.from(e.message)));
    b.on("error", (e) => errB.push(Buffer.from(e.message)));
    a.on("close", (c) => {
      codeA = c;
      finish();
    });
    b.on("close", (c) => {
      codeB = c;
      finish();
    });
  });
}

// ---------- port forwarding ----------

export function freePort(preferred?: number): Promise<number> {
  const tryListen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
  return preferred ? tryListen(preferred).catch(() => tryListen(0)) : tryListen(0);
}

/** True when nothing is listening on 127.0.0.1:port (so we could bind it). */
export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

export function canConnect(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const t = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(t);
      s.end();
      resolve(true);
    });
    s.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/**
 * Start a detached `ssh -N` forward.
 * local:   127.0.0.1:hostPort on the host  -> 127.0.0.1:guestPort in the guest
 * reverse: 127.0.0.1:guestPort in the guest -> 127.0.0.1:hostPort on the host
 */
export async function startForward(ep: Endpoint, kind: "local" | "reverse", hostPort: number, guestPort: number): Promise<number> {
  const spec =
    kind === "local" ? ["-L", `127.0.0.1:${hostPort}:127.0.0.1:${guestPort}`] : ["-R", `127.0.0.1:${guestPort}:127.0.0.1:${hostPort}`];
  const logFile = path.join(ensureDir(path.join(paths.dataDir, "logs")), `forward-${kind}-${hostPort}-${guestPort}.log`);
  fs.writeFileSync(logFile, "");
  const pid = spawnDetached(sshBin(), sshArgs(ep, ["-N", "-o", "ExitOnForwardFailure=yes", ...spec]), { logFile });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      throw new Error(`forward failed: ${fs.readFileSync(logFile, "utf8").trim() || "ssh exited"}`);
    }
    if (kind === "local" && (await canConnect(hostPort))) return pid;
    if (kind === "reverse" && Date.now() > deadline - 7_000) return pid; // no cheap readiness check; ExitOnForwardFailure catches errors
    await sleep(250);
  }
  if (isAlive(pid)) return pid;
  throw new Error(`forward did not come up: ${fs.readFileSync(logFile, "utf8").trim()}`);
}

/** What shutdownMacOverSsh calls, replaceable in tests. */
export interface ShutdownDeps {
  probe: typeof sshProbe;
  exec: typeof sshExec;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  timeoutMs: number;
}

const SHUTDOWN_DEPS: ShutdownDeps = { probe: sshProbe, exec: sshExec, sleep, now: Date.now, timeoutMs: 120_000 };

/**
 * Shut a macOS guest down over ssh and wait (up to 120 s) until `running` reports it stopped. macOS
 * answers the ACPI power button and Virtualization.framework's stop request with a dialog, not a
 * shutdown, so backends that only ask the VM to stop end up killing it after their timeout: slow, and
 * an unclean power-off. Needs passwordless sudo, which osmatrix's setup gives the guest user.
 *
 * Never throws: it returns false (the caller then stops the VM its usual way) when ssh doesn't answer
 * or can't run (no ssh client), sudo needs a password, or the guest is still running at the deadline.
 */
export async function shutdownMacOverSsh(ep: Endpoint, running: () => Promise<boolean>, deps: Partial<ShutdownDeps> = {}): Promise<boolean> {
  const d = { ...SHUTDOWN_DEPS, ...deps };
  // One budget for the whole attempt, ssh included, so a caller's own deadline (and its fallback) holds.
  const deadline = d.now() + d.timeoutMs;
  try {
    if ((await d.probe(ep)) !== "ok") return false;
    const left = deadline - d.now();
    if (left <= 0) return false;
    const r = await d.exec(ep, "sudo -n shutdown -h now", { timeoutMs: Math.min(30_000, left) }).catch(() => undefined);
    // ssh may drop as the guest goes down; only a refusal (no passwordless sudo) means it didn't start.
    if (r && r.code !== 0 && /password|sudoers|not allowed/i.test(r.stderr)) return false;
    while (d.now() < deadline && (await running())) await d.sleep(1000);
    return !(await running());
  } catch {
    return false;
  }
}
