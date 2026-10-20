import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  input?: string | Buffer;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Keep at most this many bytes of each stream (tail is kept). */
  maxBytes?: number;
}

/** Spawn without a shell and collect output. Never throws on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out = new TailBuffer(maxBytes);
    const err = new TailBuffer(maxBytes);
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
    }
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: String(e.message), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout: out.toString(), stderr: err.toString(), timedOut });
    });
    child.stdin!.on("error", () => {});
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/** Run and throw with stderr on failure. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  }
  return r.stdout;
}

/** Start a process that outlives us. Returns its pid. */
export function spawnDetached(cmd: string, args: string[], opts: { cwd?: string; logFile?: string } = {}): number {
  const so: SpawnOptions = { cwd: opts.cwd, detached: true, windowsHide: true, stdio: "ignore" };
  if (opts.logFile) {
    const fd = fs.openSync(opts.logFile, "a");
    so.stdio = ["ignore", fd, fd];
  }
  const child = spawn(cmd, args, so);
  child.unref();
  if (!child.pid) throw new Error(`failed to start ${cmd}`);
  return child.pid;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function kill(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
}

/** Cross-platform PATH lookup. */
export function which(cmd: string): string | undefined {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext.toLowerCase());
      const P = path.join(dir, cmd + ext);
      for (const cand of [p, P]) {
        try {
          if (fs.statSync(cand).isFile()) return cand;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return undefined;
}

export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.max && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
      this.truncated = true;
    }
  }
  toString(): string {
    let s = Buffer.concat(this.chunks).toString("utf8");
    if (s.length > this.max) {
      s = s.slice(-this.max);
      this.truncated = true;
    }
    return (this.truncated ? "[...truncated...]\n" : "") + s;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds in ps's `etime` column ([[dd-]hh:]mm:ss); undefined when it doesn't parse. */
export function parseEtime(s: string): number | undefined {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  const [, d = "0", h = "0", min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}

/** When a running process started (ms since the epoch); undefined when it isn't running or can't be told. */
export async function processStartedAt(pid: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { timeoutMs: 30_000 });
    const t = Date.parse(r.stdout.trim());
    return r.code === 0 && !Number.isNaN(t) ? t : undefined;
  }
  // etime (not lstart or etimes) reads the same on Linux, macOS and the BSDs.
  const r = await run("ps", ["-o", "etime=", "-p", String(pid)]);
  const sec = r.code === 0 ? parseEtime(r.stdout) : undefined;
  return sec === undefined ? undefined : Date.now() - sec * 1000;
}
