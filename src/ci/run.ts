import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { dockerBin } from "../backends/docker.ts";
import { DockurBackend } from "../backends/dockur.ts";
import { QemuMacBackend } from "../backends/qemu-macos.ts";
import { ensureLinuxImage } from "../backends/linux-image.ts";
import { ensureAct, patchedActFor, targetFromArch, type GoTarget } from "../core/act.ts";
import { guestMsvc, guestWorkdir, loadConfig, type Config, type GuestConfig, type OsFamily } from "../core/config.ts";
import { acquireLocks } from "../core/locks.ts";
import { dockerReach, selinuxEnforcing } from "../core/nesting.ts";
import { cliEntry, ensureDir } from "../core/paths.ts";
import { isAlive, processStartedAt, run, sleep, spawnDetached } from "../core/proc.ts";
import {
  cloneWorktree,
  createBundle,
  gitDirOutsideWorkTree,
  guestCachePath,
  guestCacheSteps,
  guestCheckoutSteps,
  guestCloneStep,
  NotMaterializable,
  parseRefs,
  SNAPSHOT_REF,
  snapshotWorktree,
  symlinksAllowed,
  type Snapshot,
} from "../core/gitsync.ts";
import {
  commandChain,
  commandLine,
  freePort,
  mkdirCmd,
  powershell,
  pull as sshPull,
  push as sshPush,
  quoteFor,
  sshArgs,
  sshBin,
  sshExec,
  withCwd,
  type Endpoint,
} from "../core/ssh.ts";
import { getGuest, readyEndpoint, waitReady } from "../env.ts";
import { plan as makePlan, msvcHint, setDefaultRunShell, type Leg, type Plan, type PlanFilter } from "./plan.ts";
import { collectorWorkflow, combineLegs, mergeArtifacts, parseNeedsRecord, replayStubWorkflow, type NeededJob } from "./replay.ts";

export { powershell };

export type LegState = "pending" | "running" | "success" | "failure" | "skipped" | "error" | "cancelled";

export interface LegResult {
  id: string;
  target?: string;
  workflow: string;
  job: string;
  matrix: Record<string, unknown>;
  state: LegState;
  startedAt?: string;
  finishedAt?: string;
  durationSec?: number;
  failedStep?: string;
  steps?: { name: string; result: string }[];
  error?: string;
  warnings: string[];
  /** Set while the leg waits for another run to release an act container or guest it needs. */
  waitingFor?: string;
  log: string;
  /** Last lines of the log for failed legs. */
  tail?: string;
  /** Not selected by the run's filter: it runs because selected legs need its job. */
  neededOnly?: boolean;
  /** Needed jobs replayed into this leg: the result it got for each, and the legs that produced it. */
  replayed?: { job: string; result: string; legs: string[] }[];
  /**
   * Host legs: act's job container, recorded once it exists. Everything else act creates for the job is
   * named after it, so a cancel after act died mid-teardown (job container already gone) still finds the rest.
   */
  containers?: string[];
}

export interface RunStatus {
  id: string;
  repo: string;
  state: "running" | "done" | "aborted";
  pid?: number;
  /** When the worker process (pid) started, ms since the epoch: tells it from a later process given its pid. */
  workerStartedAt?: number;
  startedAt: string;
  finishedAt?: string;
  options: RunOptions;
  counts: Record<LegState, number>;
  legs: LegResult[];
  planWarnings: string[];
  /** GITHUB_RUN_ID of every act run in this run: on GitHub all jobs of a run share one. */
  githubRunId?: string;
  /** Set when ci_cancel stopped the run; its unfinished legs are `cancelled`. */
  cancelled?: boolean;
}

export interface RunOptions extends PlanFilter {
  /** Event name passed to act (default: first of push/pull_request/workflow_dispatch the workflow listens to). */
  event?: string;
  /** Event payload for act (-e), e.g. {"ref": "refs/tags/v1.2.3"} to simulate a tag push. */
  eventPayload?: Record<string, unknown>;
  secretFile?: string;
  /** Per-leg timeout in minutes (default 60). */
  timeoutMin?: number;
  /** Cancel runs of this repo still running any of the same workflows first (GitHub's `concurrency: cancel-in-progress`). */
  cancelPrevious?: boolean;
}

// ---------- run directory helpers ----------

export function runsDir(repo: string): string {
  const base = ensureDir(path.join(repo, ".osmatrix"));
  const gi = path.join(base, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
  return ensureDir(path.join(base, "runs"));
}

function runDir(repo: string, id: string) {
  return path.join(runsDir(repo), id);
}

export function listRuns(repo: string): string[] {
  const d = runsDir(repo);
  return fs
    .readdirSync(d)
    .filter((f) => fs.existsSync(path.join(d, f, "status.json")))
    .sort();
}

function activeRuns(repo: string): string[] {
  return listRuns(repo).filter((id) => {
    try {
      return ciStatus(repo, id).state === "running";
    } catch {
      return false;
    }
  });
}

/** Runs that ci_cancel can stop or clean up after: running, or aborted (their worker died mid-run). */
function unfinishedRuns(repo: string): string[] {
  return listRuns(repo).filter((id) => {
    try {
      return ciStatus(repo, id).state !== "done";
    } catch {
      return false;
    }
  });
}

function latestRun(repo: string): string {
  const runs = listRuns(repo);
  if (!runs.length) throw new Error(`no runs in ${repo}/.osmatrix/runs`);
  return runs[runs.length - 1];
}

function emptyCounts(): Record<LegState, number> {
  return { pending: 0, running: 0, success: 0, failure: 0, skipped: 0, error: 0, cancelled: 0 };
}

class StatusFile {
  readonly file: string;
  readonly s: RunStatus;
  constructor(file: string, s: RunStatus) {
    this.file = file;
    this.s = s;
  }
  save() {
    this.s.counts = emptyCounts();
    for (const l of this.s.legs) this.s.counts[l.state]++;
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.s, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// ---------- public API ----------

export async function ciPlan(repo: string, filter: PlanFilter = {}): Promise<Plan> {
  return makePlan(path.resolve(repo), loadConfig(), filter);
}

/** Create a run. With wait=false the legs execute in a detached worker and this returns immediately. */
export async function ciRun(repoIn: string, opts: RunOptions = {}, wait = false): Promise<RunStatus> {
  const repo = path.resolve(repoIn);
  const p = makePlan(repo, loadConfig(), opts);
  if (!p.legs.length) throw new Error(`nothing to run: ${p.warnings.join("; ") || "no matching legs"}`);
  if (opts.cancelPrevious) {
    const workflows = new Set(p.legs.map((l) => l.workflow));
    for (const other of unfinishedRuns(repo)) {
      if (!runWorkflows(repo, other).some((w) => workflows.has(w))) continue;
      let c: RunStatus;
      try {
        c = await ciCancel(repo, other);
      } catch (e) {
        // It ended meanwhile: nothing left to cancel.
        if (ciStatus(repo, other).state === "done") continue;
        throw e;
      }
      p.warnings.push(`cancelled run ${other}${c.state === "done" ? "" : ` (${c.state})`}, which was running the same workflows`);
    }
  }
  for (const other of activeRuns(repo)) {
    p.warnings.push(`run ${other} is still running in this repo; legs that need the same act containers or guests wait for it`);
  }
  const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "") + "-" + crypto.randomBytes(2).toString("hex");
  const dir = ensureDir(runDir(repo, id));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(p, null, 2));
  const status: RunStatus = {
    id,
    repo,
    state: "running",
    startedAt: new Date().toISOString(),
    options: opts,
    counts: emptyCounts(),
    planWarnings: p.warnings,
    githubRunId: String(Date.now()),
    legs: p.legs.map((l) => ({
      id: l.id,
      target: l.target,
      workflow: l.workflow,
      job: l.job,
      matrix: l.matrix,
      state: l.skip ? "skipped" : "pending",
      error: l.skip,
      warnings: l.warnings,
      ...(l.neededOnly ? { neededOnly: true } : {}),
      log: path.join(".osmatrix", "runs", id, `${l.id}.log`),
    })),
  };
  const sf = new StatusFile(path.join(dir, "status.json"), status);
  if (wait) {
    status.pid = process.pid;
    sf.save();
    await worker(repo, id);
  } else {
    sf.save();
    const pid = spawnDetached(process.execPath, [cliEntry(), "ci", "_worker", id, "--repo", repo], {
      logFile: path.join(dir, "worker.log"),
    });
    status.pid = pid;
    sf.save();
  }
  return ciStatus(repo, id);
}

export function ciStatus(repoIn: string, idIn?: string): RunStatus {
  const repo = path.resolve(repoIn);
  const id = idIn ?? latestRun(repo);
  const file = path.join(runDir(repo, id), "status.json");
  if (!fs.existsSync(file)) throw new Error(`run ${id} not found`);
  const s = JSON.parse(fs.readFileSync(file, "utf8")) as RunStatus;
  if (s.state === "running" && s.pid && !isAlive(s.pid)) {
    s.state = "aborted";
    for (const l of s.legs) if (l.state === "running" || l.state === "pending") l.state = "error";
  }
  return s;
}

export function ciLogs(repoIn: string, legId: string, opts: { run?: string; tail?: number; grep?: string } = {}): string {
  const repo = path.resolve(repoIn);
  const s = ciStatus(repo, opts.run);
  const leg = s.legs.find((l) => l.id === legId) ?? s.legs.find((l) => l.id.includes(legId));
  if (!leg) throw new Error(`leg "${legId}" not in run ${s.id} (legs: ${s.legs.map((l) => l.id).join(", ")})`);
  const file = path.join(repo, leg.log);
  if (!fs.existsSync(file)) return `(no log yet for ${leg.id}; state ${leg.state})`;
  let lines = fs.readFileSync(file, "utf8").split("\n");
  if (opts.grep) {
    const re = new RegExp(opts.grep, "i");
    lines = lines.filter((l) => re.test(l));
  }
  const n = opts.tail ?? 200;
  return lines.slice(-n).join("\n");
}

/** The workflows a run's legs come from. */
function runWorkflows(repo: string, id: string): string[] {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(runDir(repo, id), "plan.json"), "utf8")) as Plan;
    return [...new Set(p.legs.map((l) => l.workflow))];
  } catch {
    return [];
  }
}

/** The file whose existence asks a run's worker to cancel it: a file, so it works the same on every host OS. */
const CANCEL_FILE = "cancel";
/** How long a cancelled worker gives its legs to stop (act removing its containers, say) before it exits anyway. */
const CANCEL_GRACE_MS = 60_000;
/** The label on a run's act job containers, which finds its containers, networks and volumes. */
export const RUN_LABEL = "osmatrix.run";

/**
 * Cancel a run (default: the latest one still running in repo). Its worker stops each running leg: act
 * on the host gets SIGINT, as from Ctrl-C, and removes its job and service containers, networks and
 * volumes; act in a guest is stopped with its process tree and the leg's per-run files are removed.
 * Pending legs don't start. Unfinished legs end `cancelled` and the run `done` with `cancelled: true`.
 * Guests stay up. When the worker is gone (it crashed or was killed) or doesn't stop in time, this
 * kills it and cleans up what it left: the run's containers on the host and act in the guests.
 */
export async function ciCancel(repoIn: string, idIn?: string): Promise<RunStatus> {
  const repo = path.resolve(repoIn);
  const id = idIn ?? unfinishedRuns(repo).at(-1);
  if (!id) throw new Error(`no run is running in ${repo}`);
  const before = ciStatus(repo, id);
  if (before.state === "done") throw new Error(`run ${id} already finished${before.cancelled ? " (cancelled)" : ""}`);
  const dir = runDir(repo, id);
  if (before.state === "running") {
    fs.writeFileSync(path.join(dir, CANCEL_FILE), new Date().toISOString() + "\n");
    const deadline = Date.now() + CANCEL_GRACE_MS + 30_000;
    while (Date.now() < deadline) {
      const s = ciStatus(repo, id);
      if (s.state === "done") return s;
      if (s.state === "aborted") break;
      await sleep(1000);
    }
  }
  // The worker is gone or stuck: stop what it may have left running, then record the cancellation.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")) as RunStatus;
  if (raw.pid && raw.pid !== process.pid) await killTree(raw.pid, id, raw.workerStartedAt);
  const notes: string[] = [];
  notes.push(...(await removeRunContainers(id, raw.legs.flatMap((l) => l.containers ?? []))));
  new HostCheckout(repo, dir).dispose();
  // Legs the worker already marked cancelled may still have act running in their guest.
  const started = raw.legs.filter((l) => l.startedAt && (l.state === "running" || l.state === "cancelled"));
  const guests = new Set(started.filter((l) => l.target && l.target !== "host").map((l) => l.target!));
  for (const guest of guests) {
    try {
      const g = getGuest(guest);
      const ep = await readyEndpoint(guest);
      await sshExec(ep, guestCancelCmd(ep, id), { timeoutMs: 60_000 });
      await sshExec(ep, removeCmd(ep, guestLegDir(guestWorkdir(g.cfg), id, "").run), { timeoutMs: 120_000 });
      notes.push(`stopped act in guest ${guest}`);
    } catch (e) {
      notes.push(`couldn't stop act in guest ${guest}: ${(e as Error).message}`);
    }
  }
  const sf = new StatusFile(path.join(dir, "status.json"), raw);
  finishCancelled(sf, "cancelled (the run's worker had stopped responding, so ci_cancel cleaned up)");
  for (const l of raw.legs) {
    if (l.state === "cancelled" && notes.length) fs.appendFileSync(path.join(repo, l.log), notes.map((n) => `[osmatrix] ${n}\n`).join(""));
  }
  sf.save();
  return ciStatus(repo, id);
}

/** Mark a leg cancelled, finished now. */
export function cancelLeg(l: LegResult, why = "cancelled", now = new Date().toISOString()) {
  l.state = "cancelled";
  l.error = why;
  l.waitingFor = undefined;
  l.finishedAt = now;
  if (l.startedAt) l.durationSec = Math.round((Date.parse(now) - Date.parse(l.startedAt)) / 1000);
}

/** Mark a cancelled run's unfinished legs and the run itself. */
function finishCancelled(sf: StatusFile, why = "cancelled") {
  const now = new Date().toISOString();
  for (const l of sf.s.legs) if (l.state === "pending" || l.state === "running") cancelLeg(l, why, now);
  sf.s.state = "done";
  sf.s.cancelled = true;
  sf.s.finishedAt ??= now;
}

/** How far apart two readings of one process's start time may be (ps reports it to the second). */
const START_TIME_TOLERANCE_MS = 2_000;

/**
 * Whether a live process with a run's recorded worker pid is that worker: it must have started when the
 * worker recorded it did. Any other start time is a later process given the pid after the worker died.
 * Unknown on either side (a status from before osmatrix recorded it, or ps can't tell) counts as not the
 * worker.
 */
export function isRunWorker(processStartedMs: number | undefined, workerStartedMs: number | undefined): boolean {
  return processStartedMs !== undefined && workerStartedMs !== undefined && Math.abs(processStartedMs - workerStartedMs) <= START_TIME_TOLERANCE_MS;
}

/**
 * Kill a run's worker and everything it started. On POSIX the worker leads its own process group, which
 * outlives it: when it crashed, act may still run there. A live process with the worker's pid counts only
 * when it started when the worker did (isRunWorker), and a group whose leader is gone only when a process in it
 * has the run's id on its command line (act's artifact store path), so a reused pid is safe.
 */
async function killTree(pid: number, runId: string, workerStartedAt: number | undefined) {
  const worker = async () => isAlive(pid) && isRunWorker(await processStartedAt(pid), workerStartedAt);
  if (process.platform === "win32") {
    if (await worker()) await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    // act outlives a dead worker; find it by the run's directory in its arguments (split, so this
    // script's own command line doesn't match).
    const script = `$pat = '*' + '${runId}' + '*'; Get-CimInstance Win32_Process -Filter "Name = 'act.exe'" | Where-Object { $_.CommandLine -like $pat } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F *> $null }; exit 0`;
    await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 60_000 });
    return;
  }
  const ours = async () => (await worker()) || (await run("pgrep", ["-g", String(pid), "-f", runId])).code === 0;
  if (!(await ours())) return;
  for (const sig of ["SIGINT", "SIGKILL"] as const) {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        return;
      }
    }
    for (let i = 0; i < 20 && (await ours()); i++) await sleep(500);
    if (!(await ours())) return;
  }
}

/** The names of a run's act job containers on the host's Docker (labelled in hostActArgs). */
async function runContainers(runId: string): Promise<string[]> {
  const r = await run(dockerBin(), ["ps", "-a", "--filter", `label=${RUN_LABEL}=${runId}`, "--format", "{{.Names}}"]);
  return r.code === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
}

/**
 * Remove what act left on the host's Docker for a run: its job containers (labelled in hostActArgs, so
 * found without the worker, or `known` from the run's status once act removed them) and everything act names after one (pkg/runner createContainerName): service
 * containers start with the job container's name cut to 63 characters, and the job's network and volumes
 * (-env, -filecmds) with its whole name, which ends in a sha256, so nothing else matches. act removes all of it
 * itself on SIGINT; this is for an act that died first (one whose worker died gets SIGPIPE as soon as it
 * logs). Returns what it removed, for the log.
 */
export async function removeRunContainers(runId: string, known: string[] = []): Promise<string[]> {
  const docker = dockerBin();
  const jobs = [...new Set([...known, ...(await runContainers(runId))])];
  if (!jobs.length) return [];
  const list = async (args: string[]) => {
    const r = await run(docker, args);
    return r.code === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
  };
  const containers = new Set<string>();
  const networks = new Set<string>();
  const volumes = new Set<string>();
  for (const job of jobs) {
    const prefix = job.slice(0, 63).replace(/-+$/, "");
    for (const c of await list(["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.Names}}"])) if (c.startsWith(prefix)) containers.add(c);
    for (const n of await list(["network", "ls", "--filter", `name=${job}`, "--format", "{{.Name}}"])) if (n.startsWith(job)) networks.add(n);
    for (const v of await list(["volume", "ls", "--filter", `name=${job}`, "--format", "{{.Name}}"])) if (v.startsWith(job)) volumes.add(v);
  }
  if (containers.size) await run(docker, ["rm", "-f", "-v", ...containers], { timeoutMs: 120_000 });
  if (networks.size) await run(docker, ["network", "rm", ...networks], { timeoutMs: 60_000 });
  if (volumes.size) await run(docker, ["volume", "rm", ...volumes], { timeoutMs: 60_000 });
  const what = [
    containers.size ? `container${containers.size > 1 ? "s" : ""} ${[...containers].join(", ")}` : "",
    networks.size ? `network${networks.size > 1 ? "s" : ""} ${[...networks].join(", ")}` : "",
    volumes.size ? `volume${volumes.size > 1 ? "s" : ""} ${[...volumes].join(", ")}` : "",
  ].filter(Boolean);
  return what.length ? [`removed what act left: ${what.join("; ")}`] : [];
}

/**
 * A guest command that stops the act processes of a run, with everything they started: the processes
 * whose command line has the run's per-run directory (`.osmatrix/<run>/`, see guestLegDir) in it, which
 * act's --artifact-server-path always does. The pattern is split in the command itself, so the shell
 * running it doesn't match.
 */
export function guestCancelCmd(ep: Pick<Endpoint, "shell">, runId: string): string {
  if (ep.shell === "posix") {
    const k = `k() { for c in $(pgrep -P "$1"); do k "$c" "$2"; done; kill -"$2" "$1" 2>/dev/null; }`;
    const each = (sig: string) => `for p in $(pgrep -f -- "$pat"); do [ "$p" = "$$" ] || k "$p" ${sig}; done`;
    // The empty "" splits the pattern: quoteFor leaves safe words unquoted.
    return `pat=.osmatrix/""${quoteFor("posix", `${runId}/`)}; ${k}; ${each("TERM")}; sleep 3; ${each("KILL")}; true`;
  }
  return powershell(
    ep,
    `$pat = '*.osmatrix/' + '${runId}' + '/*'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like $pat } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F *> $null }; exit 0`,
  );
}

/** A worker's view of its run's cancellation: whether it was asked for, and how to stop each running leg. */
class Cancellation {
  requested = false;
  private readonly stops = new Set<() => Promise<void>>();
  /** Register how to stop a running leg; returns the unregister function. */
  onCancel(stop: () => Promise<void>): () => void {
    this.stops.add(stop);
    return () => this.stops.delete(stop);
  }
  async cancel() {
    this.requested = true;
    await Promise.all([...this.stops].map((s) => s().catch(() => undefined)));
  }
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** Wait for a child to exit, up to ms; whether it did. */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    child.once("close", () => {
      clearTimeout(t);
      res(true);
    });
  });
}

// ---------- worker ----------

export async function worker(repo: string, id: string): Promise<void> {
  const dir = runDir(repo, id);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")) as Plan;
  const sf = new StatusFile(path.join(dir, "status.json"), JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")));
  sf.s.pid = process.pid;
  sf.s.workerStartedAt = Math.round(Date.now() - process.uptime() * 1000);
  sf.save();
  const cfg = loadConfig();
  const cancel = new Cancellation();
  const checkout = new HostCheckout(repo, dir);
  const watch = setInterval(() => {
    if (cancel.requested || !fs.existsSync(path.join(dir, CANCEL_FILE))) return;
    for (const l of sf.s.legs) if (l.state === "running") fs.appendFileSync(path.join(dir, `${l.id}.log`), "[osmatrix] cancelling: stopping this leg\n");
    void cancel.cancel();
    // A leg stuck where it can't be stopped (booting a guest, say) doesn't keep the run going. The run
    // isn't marked done here: with this worker gone it reads as aborted, so ci_cancel cleans up after it.
    setTimeout(() => process.exit(1), CANCEL_GRACE_MS).unref();
  }, 1000);

  // Each target runs its legs one at a time, in an order where a leg comes after every leg it waits for,
  // so no target waits for a leg queued behind one of its own.
  const runnable = scheduleOrder(p.legs.filter((l) => !l.skip && l.target));
  const outcomes = new Map(runnable.map((l) => [l.id, new Deferred<LegOutcome>()]));
  const groups = new Map<string, Leg[]>();
  for (const leg of runnable) groups.set(leg.target!, [...(groups.get(leg.target!) ?? []), leg]);
  const vmSlots = new Semaphore(cfg.max_vms);
  try {
    await Promise.all(
      [...groups.entries()].map(async ([target, legs]) => {
        const isVm = target !== "host";
        let slot = false;
        try {
          for (const leg of legs) {
            const waits = (leg.waitsFor ?? []).map((id) => outcomes.get(id));
            // Never hold a VM slot while waiting for other legs: they may need it.
            if (slot && waits.some((w) => !w?.settled)) {
              vmSlots.release();
              slot = false;
            }
            // Every leg must settle its outcome, or the legs waiting for it on other targets never start.
            const replay = await neededResults(dir, leg, p.legs, outcomes, sf).catch(
              (e: Error): Replay => ({ needs: {}, error: `couldn't collect the results of the legs it needs: ${e.message}` }),
            );
            if (cancel.requested) {
              cancelLeg(sf.s.legs.find((l) => l.id === leg.id)!);
              sf.save();
              outcomes.get(leg.id)!.resolve({ state: "cancelled", error: "cancelled", finished: Date.now() });
              continue;
            }
            if (isVm && !slot && !replay?.error) {
              await vmSlots.acquire();
              slot = true;
            }
            const outcome = await runLeg(repo, dir, cfg, leg, sf, checkout, cancel, replay).catch((e: Error): LegOutcome => ({ state: "error", error: e.message, finished: Date.now() }));
            outcomes.get(leg.id)!.resolve(outcome);
          }
        } finally {
          if (slot) vmSlots.release();
        }
      }),
    );
  } finally {
    // Also when the loop throws: the interval would keep this worker alive, its run "running" for good.
    clearInterval(watch);
    checkout.dispose();
  }
  if (cancel.requested) finishCancelled(sf);
  sf.s.state = "done";
  sf.s.finishedAt = new Date().toISOString();
  sf.save();
}

/**
 * What a leg must have to itself while it runs. act names job containers (and their volumes)
 * `act-<workflow name>-<job name>`, canonicalized, with nothing from the checkout or the run, so two
 * runs of a workflow with that name, even from different checkouts or osmatrix installs, could replace
 * each other's containers. Job names can be expressions and needed matrix jobs get suffixes, so the
 * whole workflow is locked, canonicalized as act does. A guest has one work directory per repo name and
 * one desktop, so its legs take turns too.
 */
export function legLockKeys(leg: Leg): string[] {
  return leg.target === "host" ? [hostLockKey(leg)] : [`guest:${leg.target}`];
}

function hostLockKey(leg: Pick<Leg, "workflow" | "workflowName">): string {
  // act falls back to the workflow's file name.
  const name = leg.workflowName ?? path.posix.basename(leg.workflow);
  return `host:act-workflow:${`act-${name}`.replace(/[^a-zA-Z0-9]/g, "-").replaceAll("--", "-")}`;
}

/**
 * Legs in the order they start: each after every leg it waits for (its depth in the needs graph), in plan
 * order otherwise.
 */
export function scheduleOrder(legs: Leg[]): Leg[] {
  const byId = new Map(legs.map((l) => [l.id, l]));
  const depth = new Map<string, number>();
  const depthOf = (l: Leg, visiting: Set<string>): number => {
    const known = depth.get(l.id);
    if (known !== undefined) return known;
    if (visiting.has(l.id)) return 0; // a needs cycle; plan() skips those legs
    visiting.add(l.id);
    let d = 0;
    for (const id of l.waitsFor ?? []) {
      const n = byId.get(id);
      if (n) d = Math.max(d, depthOf(n, visiting) + 1);
    }
    visiting.delete(l.id);
    depth.set(l.id, d);
    return d;
  };
  return legs
    .map((l, i) => ({ l, i, d: depthOf(l, new Set()) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.l);
}

/** What a finished leg leaves for the legs that wait for it. */
interface LegOutcome {
  state: LegState;
  /** Its job's result and outputs, as the collector recorded them (legs that others need). */
  record?: NeededJob;
  error?: string;
  /** When it finished (ms): a matrix job's outputs come from the legs that finished last. */
  finished: number;
}

class Deferred<T> {
  settled = false;
  readonly promise: Promise<T>;
  private done!: (v: T) => void;
  constructor() {
    this.promise = new Promise((res) => (this.done = res));
  }
  resolve(v: T) {
    this.settled = true;
    this.done(v);
  }
}

/** The results a leg replays from the legs it waits for. */
interface Replay {
  needs: Record<string, NeededJob & { legs: string[] }>;
  /** Set when a needed leg left no result to replay; the leg then doesn't run. */
  error?: string;
}

/** Wait for the legs `leg` needs and combine what they recorded, per needed job. */
async function neededResults(dir: string, leg: Leg, legs: Leg[], outcomes: Map<string, Deferred<LegOutcome>>, sf: StatusFile): Promise<Replay | undefined> {
  if (!leg.replayNeeds?.length) return undefined;
  const r = sf.s.legs.find((l) => l.id === leg.id)!;
  const ids = leg.waitsFor ?? [];
  const pending = ids.filter((id) => !outcomes.get(id)?.settled);
  if (pending.length) {
    r.waitingFor = `needed leg${pending.length > 1 ? "s" : ""} ${pending.join(", ")}`;
    fs.appendFileSync(path.join(dir, `${leg.id}.log`), `[osmatrix] waiting for ${r.waitingFor} to finish; their results are replayed into this leg\n`);
    sf.save();
  }
  const done = new Map<string, LegOutcome>();
  for (const id of ids) done.set(id, (await outcomes.get(id)?.promise) ?? { state: "error", error: "it isn't scheduled in this run", finished: 0 });
  r.waitingFor = undefined;
  const replay: Replay = { needs: {} };
  const problems: string[] = [];
  for (const job of leg.replayNeeds) {
    const jobLegs = ids.filter((id) => legs.find((l) => l.id === id)?.job === job);
    const finished = jobLegs.map((id) => ({ id, ...done.get(id)! })).sort((a, b) => a.finished - b.finished);
    for (const o of finished.filter((o) => !o.record)) {
      problems.push(`${o.id} ${o.state === "error" ? `errored${o.error ? ` (${o.error})` : ""}` : `ended as ${o.state} without recording its result`}`);
    }
    if (finished.every((o) => o.record)) replay.needs[job] = { ...combineLegs(finished.map((o) => o.record!)), legs: jobLegs };
  }
  if (problems.length) replay.error = `no result to replay from needed leg${problems.length > 1 ? "s" : ""} ${problems.join("; ")}`;
  return replay;
}

/**
 * Run one leg. `replay` holds the results of the legs it waits for, which act gets as stubs. When other
 * legs need this one, a collector job records its result and outputs, returned for them.
 */
async function runLeg(
  repo: string,
  dir: string,
  cfg: Config,
  leg: Leg,
  sf: StatusFile,
  checkout: HostCheckout,
  cancel: Cancellation,
  replay?: Replay,
): Promise<LegOutcome> {
  const r = sf.s.legs.find((l) => l.id === leg.id)!;
  const logFile = path.join(dir, `${leg.id}.log`);
  const log = fs.createWriteStream(logFile, { flags: "a" });
  let record: NeededJob | undefined;
  const parser = new ActJsonParser((line) => {
    log.write(line + "\n");
    record = parseNeedsRecord(line)?.[leg.job] ?? record;
  }, leg.job);
  const timeoutMs = (sf.s.options.timeoutMin ?? 60) * 60_000;
  const note = (m: string) => log.write(`[osmatrix] ${m}\n`);
  // For a cancel's stop function, which can still be running after the leg ended and closed `log` (a write
  // to an ended stream emits an unhandled 'error' and crashes the worker).
  const lateNote = (m: string) => (log.writableEnded ? fs.appendFileSync(logFile, `[osmatrix] ${m}\n`) : note(m));
  // Whether the leg runs osmatrix's patched act; stock act's known differences are only hinted at otherwise.
  let patched = false;
  const outcome = (): LegOutcome => ({ state: r.state, record, error: r.error, finished: Date.now() });
  let release: (() => void) | undefined;
  try {
    if (replay) {
      r.replayed = Object.entries(replay.needs).map(([job, n]) => ({ job, result: n.result, legs: n.legs }));
      // Without a needed job's result there is nothing to replay. A needed job that failed is no reason
      // to stop: its stub fails too, and act decides whether this leg's job still runs, as GitHub would.
      if (replay.error) {
        r.state = "error";
        r.error = replay.error;
        log.write(`[osmatrix] ${r.error}\n`);
        return outcome();
      }
      const got = Object.entries(replay.needs).map(([job, n]) => `${job} (${n.result}, from ${n.legs.join(", ")})`);
      log.write(`[osmatrix] needed jobs ran once, as their own legs; replaying their results, outputs and artifacts: ${got.join("; ")}\n`);
    }
    let waited: string | undefined;
    release = await acquireLocks(legLockKeys(leg), { pid: process.pid, run: sf.s.id, repo, leg: leg.id }, (key, h) => {
      waited = key.startsWith("guest:") ? `guest ${leg.target}` : `workflow "${leg.workflowName ?? leg.workflow}" (act containers)`;
      r.waitingFor = `${waited} is in use by run ${h.run} (leg ${h.leg}${h.repo === repo ? "" : `, ${h.repo}`})`;
      log.write(`[osmatrix] waiting: ${r.waitingFor}\n`);
      sf.save();
    });
    if (waited) log.write(`[osmatrix] ${waited} is free; starting\n`);
    if (cancel.requested) throw new Cancelled();
    r.waitingFor = undefined;
    r.state = "running";
    r.startedAt ??= new Date().toISOString();
    sf.save();
    const event = sf.s.options.event ?? detectEvent(path.join(repo, leg.workflow));
    const secretFile = resolveSecretFile(repo, sf.s.options.secretFile);
    const original = fs.readFileSync(path.join(repo, leg.workflow), "utf8");
    let derived = replay ? replayStubWorkflow(original, { needs: replay.needs, runsOn: leg.runsOn }) : undefined;
    let collector: string | undefined;
    if (leg.neededBy?.length) {
      const c = collectorWorkflow(derived ?? original, leg.job, leg.runsOn);
      derived = c.text;
      collector = c.job;
      log.write(`[osmatrix] ${leg.neededBy.join(", ")} need${leg.neededBy.length > 1 ? "" : "s"} this leg's job; job ${collector} records its result and outputs for them\n`);
    }
    // act -j <collector> runs the leg's job first, as the collector needs it.
    const actLeg = { workflow: leg.workflow, job: collector ?? leg.job, matrix: leg.matrix };
    const store = artifactStore(dir, leg);
    const runId = sf.s.githubRunId ?? "1";
    let code: number;
    if (leg.target === "host") {
      const act = await ensureAct({ log: note });
      patched = act.source === "patched";
      if (act.warning) r.warnings.push(act.warning);
      note(`act: ${act.source === "user" ? `${act.path} (act_path)` : `${act.version} (${act.source === "patched" ? "osmatrix's patched build" : "stock release"})`}`);
      // The parity image is in no registry, so it's built here before act looks for it.
      const image = await ensureLinuxImage(cfg.act_linux_image, { pid: process.pid, run: sf.s.id, repo, leg: leg.id }, (l) => log.write(l + "\n"));
      const labels = [...leg.runsOn, ...(leg.needsLabels ?? [])];
      const workflow = derived === undefined ? leg.workflow : writeDerivedCopy(dir, leg, derived, log);
      const args = [event, ...commonActArgs(actLeg, workflow, sf.s.githubRunId), ...(await hostActArgs(image, dir, sf, labels, store, secretFile))];
      const reach = await dockerReach();
      if (reach && !reach.error && (!reach.files || !reach.loopback)) {
        // act copies the checkout into job containers, so legs still run; what can break is anything that
        // has the job reach back to act's own servers or to host paths.
        log.write(
          "[osmatrix] note: Docker's daemon doesn't share this environment's filesystem and/or loopback (devcontainer or remote DOCKER_HOST). " +
            "Steps that upload/download artifacts or use the actions cache can fail when job containers can't reach this environment, " +
            "and steps that bind-mount host paths see the daemon host's filesystem.\n",
        );
      }
      const cwd = await checkout.dir((l) => log.write(l + "\n"));
      log.write(`$ act ${args.join(" ")}\n`);
      if (cancel.requested) throw new Cancelled();
      code = await streamProcess(act.path, args, cwd, parser, timeoutMs, (child) => {
        // Record act's job containers while act runs (replay stubs, the job, a collector: one after the
        // other), saving only when a new one appears: if act dies mid-teardown after removing one, its name
        // still finds that job's network, volumes and services.
        const track = setInterval(async () => {
          const names = (await runContainers(sf.s.id)).filter((n) => !r.containers?.includes(n));
          if (!names.length) return;
          r.containers = [...(r.containers ?? []), ...names];
          sf.save();
        }, 5000);
        const unregister = cancel.onCancel(async () => {
          // act stops the job and removes its containers, services, networks and volumes on SIGINT.
          child.kill("SIGINT");
          if (!(await exited(child, 30_000))) child.kill("SIGKILL");
          await exited(child, 10_000);
          for (const n of await removeRunContainers(sf.s.id, r.containers)) lateNote(n);
        });
        return () => {
          clearInterval(track);
          unregister();
        };
      });
    } else {
      const g = getGuest(leg.target!);
      if ((g.backend instanceof DockurBackend || g.backend instanceof QemuMacBackend) && g.cfg.os === "macos" && !g.backend.everReady()) {
        throw new Error(
          `macOS guest "${g.cfg.name}" has not been set up yet. Run \`osmatrix setup ${g.cfg.name} --accept-license\` (MCP: env_setup) once the user agrees to Apple's macOS license; it is fully automatic (~30-60 min).`,
        );
      }
      log.write(`[osmatrix] ensuring guest ${g.cfg.name} is up\n`);
      await g.backend.up();
      const s = await waitReady(g, g.cfg.boot_timeout ?? 3600);
      if (s.state !== "ready") throw new Error(`guest ${g.cfg.name} not ready: ${s.state}${s.detail ? ` (${s.detail})` : ""}`);
      const ep = await readyEndpoint(g.cfg.name);
      const workdir = guestWorkdir(g.cfg);
      const remote = `${workdir}/${path.basename(repo)}`;
      log.write(`[osmatrix] syncing ${repo} -> ${g.cfg.name}:${remote}\n`);
      await syncRepo(ep, g.cfg.name, repo, remote, r, log);
      if (g.cfg.os === "macos" && ep.shell === "posix") await ensureMacToolCache(ep, r, log);
      // An opted-out guest was already warned about by the plan.
      if (g.cfg.os === "windows" && leg.msvcUses?.length && guestMsvc(g.cfg)) await checkMsvc(ep, g.cfg, leg, r, log);
      const act = await guestAct(ep, g.cfg.os, note);
      patched = act.patched;
      if (act.warning) r.warnings.push(act.warning);
      // The synced tree is what the job checks out (as on GitHub), so this leg's own files go next to it.
      const own = guestLegDir(workdir, sf.s.id, leg.id);
      try {
        if (g.cfg.os === "windows" && leg.linuxNeeds?.length) derived = (await bashForLinuxNeeds(ep, derived ?? original, leg, r, log)) ?? derived;
        const workflow = derived === undefined ? leg.workflow : await writeDerivedWorkflow(ep, dir, own, leg, derived, log);
        // act's artifact store in the guest starts with what the legs before this one uploaded.
        const seed = path.join(store, runId);
        if (fs.existsSync(seed) && fs.readdirSync(seed).length) {
          log.write(`[osmatrix] copying the run's artifacts so far (${fs.readdirSync(seed).sort().join(", ")}) into this leg's artifact store\n`);
          await sshPush(ep, seed, `${own.path}/artifacts/${runId}`, { gitAware: false });
        }
        const args = [event, ...commonActArgs(actLeg, workflow, sf.s.githubRunId), "--artifact-server-path", `${own.fromWorkTree}/artifacts`];
        for (const l of new Set([...leg.runsOn, ...(leg.needsLabels ?? [])])) args.push("-P", `${l}=-self-hosted`);
        if (sf.s.options.eventPayload) {
          await writeRemoteFile(ep, `${own.path}/event.json`, JSON.stringify(sf.s.options.eventPayload));
          args.push("-e", `${own.fromWorkTree}/event.json`);
        }
        if (secretFile) {
          await writeRemoteFile(ep, `${own.path}/secrets`, fs.readFileSync(secretFile, "utf8"));
          args.push("--secret-file", `${own.fromWorkTree}/secrets`);
        }
        log.write(`$ act ${args.join(" ")}\n`);
        const command = withCwd(ep.shell, remote, commandLine(ep.shell, [act.command, ...args]));
        if (cancel.requested) throw new Cancelled();
        code = await streamProcess(sshBin(), sshArgs(ep, ["-T"]).concat([command]), undefined, parser, timeoutMs, (child) =>
          cancel.onCancel(async () => {
            // Closing ssh leaves act running in the guest: stop it there, which ends the session.
            const r = await sshExec(ep, guestCancelCmd(ep, sf.s.id), { timeoutMs: 60_000 }).catch((e: Error) => ({ code: -1, stderr: e.message }));
            if (r.code !== 0) lateNote(`warning: couldn't stop act in guest ${g.cfg.name}: ${r.stderr.trim() || `exit code ${r.code}`}`);
            if (!(await exited(child, 15_000))) child.kill();
          }),
        );
        // The legs that need this one find what it uploaded in the run's store on the host.
        if (leg.neededBy?.length) {
          try {
            const added = await collectArtifacts(ep, `${own.path}/artifacts/${runId}`, path.join(dir, `.incoming-${leg.id}`), store, runId);
            if (added.length) log.write(`[osmatrix] artifacts this leg uploaded (${added.join(", ")}) are available to the legs that need it\n`);
          } catch (e) {
            const w = `could not copy the artifacts this leg uploaded to the host, so the legs that need it won't find them: ${(e as Error).message}`;
            r.warnings.push(w);
            log.write(`[osmatrix] warning: ${w}\n`);
          }
        }
      } finally {
        // Per-run files only (secrets among them); the next leg on this guest starts its own. sshExec
        // resolves on a failed command, so check its exit code: a leftover secrets file must be reported.
        const rm = await sshExec(ep, removeCmd(ep, own.run), { timeoutMs: 120_000 }).catch((e: Error) => ({ code: -1, stderr: e.message }));
        if (rm.code !== 0) {
          const w = `could not remove ${own.run} in guest ${g.cfg.name} (it may still hold this run's secrets file): ${rm.stderr.trim() || `exit code ${rm.code}`}`;
          r.warnings.push(w);
          log.write(`[osmatrix] warning: ${w}\n`);
        }
      }
    }
    parser.flush();
    const replayed = [...Object.keys(replay?.needs ?? {}), ...(collector ? [collector] : [])];
    const ours = (s: { name: string }) => !replayed.some((j) => s.name.startsWith(`${j}: `));
    r.steps = parser.steps.filter(ours);
    const result = legResult(code, parser, Object.keys(replay?.needs ?? {}));
    r.state = result.state;
    if (result.error) r.error = result.error;
    // A failing stub stands for a needed leg's failure, which that leg reports.
    r.failedStep = r.state === "failure" ? parser.steps.find((s) => s.result === "failure" && ours(s))?.name : undefined;
    if (code === 124) {
      r.state = "failure";
      r.error = `timed out after ${sf.s.options.timeoutMin ?? 60} min`;
    }
    if (leg.neededBy?.length && !record) {
      const w = `the result of this leg's job wasn't recorded, so the legs that need it (${leg.neededBy.join(", ")}) don't run`;
      r.warnings.push(w);
      log.write(`[osmatrix] warning: ${w}\n`);
    }
  } catch (e) {
    r.state = "error";
    r.error = (e as Error).message;
    if (!(e instanceof Cancelled)) log.write(`[osmatrix] error: ${r.error}\n`);
  } finally {
    release?.();
    if (cancel.requested && r.state !== "success" && r.state !== "skipped") {
      r.state = "cancelled";
      r.error = "cancelled";
      r.failedStep = undefined;
      log.write("[osmatrix] cancelled\n");
    }
    await new Promise((res) => log.end(res));
    r.startedAt ??= new Date().toISOString();
    r.finishedAt = new Date().toISOString();
    r.durationSec = Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt!)) / 1000);
    if (r.state !== "success" && r.state !== "skipped") {
      r.tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-60).join("\n");
      if (!patched) r.warnings.push(...actDifferenceHints(r.tail));
    }
    sf.save();
  }
  return outcome();
}

/**
 * A leg's state from its act run. act reports nothing for a job it skips (because of its if:, or a needed
 * job that failed or was skipped), and exits non-zero when any job failed, a replayed need's stub
 * included. `stubs` are the replayed needs.
 */
export function legResult(
  code: number,
  parser: Pick<ActJsonParser, "jobResult" | "jobStarted" | "failedJobs">,
  stubs: string[],
): { state: LegState; error?: string } {
  if (parser.jobResult) return { state: parser.jobResult === "success" ? "success" : "failure" };
  if (parser.jobStarted) return { state: "failure", error: `act exited with code ${code} before the job finished` };
  // A need that act ran inside this leg failed: that is this leg's failure (its failedStep names it).
  if (parser.failedJobs.some((j) => !stubs.includes(j))) return { state: "failure" };
  const failed = parser.failedJobs.filter((j) => stubs.includes(j));
  if (failed.length) return { state: "skipped", error: `act skipped the job: needed job${failed.length > 1 ? "s" : ""} ${failed.join(", ")} failed` };
  if (code === 0) return { state: "skipped", error: "act skipped the job (its if: condition, or a needed job was skipped)" };
  return { state: "failure", error: `act exited with code ${code} before the job started` };
}

/**
 * Hints for failures that come from stock act's environment rather than the code, for legs that don't run
 * osmatrix's patched act (act_path, another act_version, or no Docker to build it). Stock act keeps the
 * file-command files (GITHUB_OUTPUT, GITHUB_ENV, …) under its own act/workflow/ directory; GitHub's
 * runners keep them under RUNNER_TEMP, so scripts that check those paths for containment fail only
 * locally. Its artifact server also rejects actions/upload-artifact v7.
 */
export function actDifferenceHints(log: string): string[] {
  const hints: string[] = [];
  const m = /\S*act[\\/]workflow[\\/](?:outputcmd\.txt|envs\.txt|pathcmd\.txt|statecmd\.txt|SUMMARY\.md)\b/.exec(log);
  if (m) {
    hints.push(
      `the failure mentions ${m[0]}: stock act keeps GITHUB_OUTPUT/GITHUB_ENV/GITHUB_PATH/GITHUB_STATE/GITHUB_STEP_SUMMARY there, outside RUNNER_TEMP, while GitHub keeps them under RUNNER_TEMP. A check that these paths lie inside RUNNER_TEMP or GITHUB_WORKSPACE fails only locally; osmatrix's patched act (the default, unless act_path or act_version is set) fixes this, or skip the check when env.ACT is set`,
    );
  }
  if (/unknown field \\?"mime_type\\?"|Failed to CreateArtifact/.test(log)) {
    hints.push(
      "the failure comes from stock act's artifact server, which rejects actions/upload-artifact v7 and later; it passes on GitHub. osmatrix's patched act (the default, unless act_path or act_version is set) fixes this",
    );
  }
  return hints;
}

const GUEST_BIN_DIR = ".osmatrix/bin";
const GUEST_ACT_STAMP = "act.sha256";

/** Prints the guest's architecture, home directory and the sha256 stamp of its osmatrix act (when present), one per line. */
export function guestActProbe(ep: Pick<Endpoint, "shell">): string {
  if (ep.shell === "posix") {
    return `uname -m; printf '%s\\n' "$HOME"; if [ -x "$HOME/${GUEST_BIN_DIR}/act" ]; then cat "$HOME/${GUEST_BIN_DIR}/${GUEST_ACT_STAMP}" 2>/dev/null; fi; true`;
  }
  // OSArchitecture is the OS's own, also from an emulated x64 shell on Windows on ARM.
  return powershell(
    ep,
    `[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); $HOME; $b = Join-Path $HOME '${GUEST_BIN_DIR.replace("/", "\\")}'; if (Test-Path -LiteralPath (Join-Path $b 'act.exe')) { Get-Content -Raw -LiteralPath (Join-Path $b '${GUEST_ACT_STAMP}') -ErrorAction SilentlyContinue }`,
  );
}

export function parseGuestActProbe(os: OsFamily, stdout: string): { arch: string; target?: GoTarget; home: string; stamp?: string } {
  const [arch = "", home = "", stamp] = stdout.split(/\r?\n/).map((l) => l.trim());
  return { arch, target: targetFromArch(os, arch), home, stamp: stamp || undefined };
}

/** Where osmatrix keeps its act in a guest, as an absolute path for the guest's shell. */
export function guestActPath(os: OsFamily, home: string): string {
  return os === "windows" ? `${home.replace(/[\\/]+$/, "")}\\.osmatrix\\bin\\act.exe` : `${home.replace(/\/+$/, "")}/${GUEST_BIN_DIR}/act`;
}

/** The guest's copy is current when its stamp holds the local binary's sha256. */
export function guestActCurrent(localSha256: string, stamp: string | undefined): boolean {
  return !!stamp && stamp.trim().toLowerCase() === localSha256.toLowerCase();
}

/**
 * The act command for a guest leg: osmatrix's patched build for the guest's OS and architecture, pushed
 * into ~/.osmatrix/bin when the guest's copy differs. Guests can't build it themselves, so the host builds
 * it. When the patched build isn't in use, the guest runs the act its provisioning put on PATH.
 */
async function guestAct(ep: Endpoint, os: OsFamily, note: (m: string) => void): Promise<{ command: string; patched: boolean; warning?: string }> {
  const probe = parseGuestActProbe(os, (await sshExec(ep, guestActProbe(ep), { timeoutMs: 60_000 })).stdout);
  if (!probe.target || !probe.home) {
    return { command: "act", patched: false, warning: `couldn't tell this guest's architecture ("${probe.arch}"), so it runs its own act from PATH, which may be stock act` };
  }
  const p = await patchedActFor(probe.target, note);
  if ("reason" in p) return { command: "act", patched: false, warning: p.reason };
  const bin = guestActPath(os, probe.home);
  if (guestActCurrent(p.sha256, probe.stamp)) {
    note(`act ${p.version} is current in the guest (${bin})`);
  } else {
    note(`installing act ${p.version} (${probe.target}) in the guest at ${bin}`);
    await sshPush(ep, p.path, GUEST_BIN_DIR, { timeoutMs: 10 * 60_000 });
    // The stamp goes last, so an interrupted copy is pushed again next time.
    await writeRemoteFile(ep, `${GUEST_BIN_DIR}/${GUEST_ACT_STAMP}`, p.sha256 + "\n");
  }
  return { command: bin, patched: true };
}

/**
 * act's arguments for a Linux leg on the host's Docker, its runs-on labels mapped to `image` (see
 * ensureLinuxImage). `artifactPath` is the run's store for its workflow.
 */
async function hostActArgs(image: string, dir: string, sf: StatusFile, labels: string[], artifactPath: string, secretFile?: string): Promise<string[]> {
  const args = ["--pull=false", "--rm", "--artifact-server-path", artifactPath];
  for (const l of new Set(labels)) args.push("-P", `${l}=${image}`);
  // The label finds the run's containers if act is killed before it removes them (see removeRunContainers).
  const options = [`--label ${RUN_LABEL}=${sf.s.id}`];
  // act mounts the Docker socket into job containers; SELinux (Fedora, openSUSE, RHEL) denies
  // that unless the container runs unconfined, which matches GitHub's runners.
  if (selinuxEnforcing()) options.push("--security-opt label=disable");
  args.push("--container-options", options.join(" "));
  // act's artifact server defaults to a fixed port (34567); concurrent or nested runs would collide.
  args.push("--artifact-server-port", String(await freePort()));
  if (secretFile) args.push("--secret-file", secretFile);
  if (sf.s.options.eventPayload) {
    const eventFile = path.join(dir, "event.json");
    fs.writeFileSync(eventFile, JSON.stringify(sf.s.options.eventPayload));
    args.push("-e", eventFile);
  }
  return args;
}

/**
 * Where a run's host legs run act. act copies the work tree into job containers but not a git directory
 * kept outside it, so in a linked worktree (as agent sessions use), a submodule or a --separate-git-dir
 * checkout, git in the job finds no repository. There host legs run in a clone of the work tree made
 * once per run (see cloneWorktree), the ordinary repository actions/checkout gives on GitHub; elsewhere
 * in the checkout itself.
 */
class HostCheckout {
  private readonly repo: string;
  private readonly clone: string;
  private ready?: Promise<string>;
  constructor(repo: string, runDir: string) {
    this.repo = repo;
    this.clone = path.join(runDir, "checkout");
  }
  dir(log: (line: string) => void): Promise<string> {
    this.ready ??= this.make(log);
    return this.ready;
  }
  private async make(log: (line: string) => void): Promise<string> {
    if (!(await gitDirOutsideWorkTree(this.repo))) return this.repo;
    log(`[osmatrix] ${this.repo} keeps its git directory outside the work tree (a linked worktree, say), which act doesn't copy into job containers; host legs run in a clone of it at ${this.clone}, with its uncommitted changes`);
    try {
      await cloneWorktree(this.repo, this.clone);
      const copied = copyActCwdFiles(this.repo, this.clone);
      if (copied.length) log(`[osmatrix] copied ${copied.join(", ")} into the clone: act reads ${copied.length > 1 ? "them" : "it"} from the directory it runs in, and the clone leaves out ignored files`);
      return this.clone;
    } catch (e) {
      fs.rmSync(this.clone, { recursive: true, force: true });
      log(`[osmatrix] warning: couldn't clone the work tree (${(e as Error).message}); running in the checkout itself, where steps that run git can fail`);
      return this.repo;
    }
  }
  /** Never throws: a clone Windows still holds open stays behind rather than stopping a cleanup. */
  dispose() {
    try {
      fs.rmSync(this.clone, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* left for the next cleanup of the run directory */
    }
  }
}

/**
 * The files act reads from the directory it runs in by default: its options (.actrc) and --env-file,
 * --var-file and --input-file. .secrets isn't among them: resolveSecretFile passes the checkout's own.
 */
const ACT_CWD_FILES = [".actrc", ".env", ".vars", ".input"];

/**
 * Copy the act files (ACT_CWD_FILES) that `from` has and `to` lacks: usually ignored by git, so a clone of
 * the work tree leaves them out. Returns the names copied.
 */
export function copyActCwdFiles(from: string, to: string): string[] {
  const copied: string[] = [];
  for (const f of ACT_CWD_FILES) {
    const src = path.join(from, f);
    const dest = path.join(to, f);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile() || fs.existsSync(dest)) continue;
    fs.copyFileSync(src, dest);
    copied.push(f);
  }
  return copied;
}

// ---------- replayed needs (see replay.ts) ----------

/** act's artifact store for a workflow's legs on the host; every leg of the workflow uploads into it. */
function artifactStore(dir: string, leg: Pick<Leg, "workflow">): string {
  return path.join(dir, "artifacts", path.posix.basename(leg.workflow).replace(/\.ya?ml$/, ""));
}

/**
 * Copy the artifacts a VM leg uploaded (act's store in the guest, `remote`) into the run's store on the
 * host, through `local`. Returns the names added.
 */
async function collectArtifacts(ep: Endpoint, remote: string, local: string, store: string, runId: string): Promise<string[]> {
  const exists =
    ep.shell === "posix"
      ? `test -d ${quoteFor("posix", remote)}`
      : powershell(ep, `if (Test-Path -LiteralPath (${pwshHomePath(remote)}) -PathType Container) { exit 0 } else { exit 1 }`);
  if ((await sshExec(ep, exists, { timeoutMs: 60_000 })).code !== 0) return [];
  fs.rmSync(local, { recursive: true, force: true });
  try {
    await sshPull(ep, remote, local);
    return mergeArtifacts(local, store, runId);
  } finally {
    fs.rmSync(local, { recursive: true, force: true });
  }
}

/**
 * Where a VM leg keeps the files osmatrix gives act (a derived workflow, the event payload, secrets,
 * act's artifact store): `<workdir>/.osmatrix/<run>/<leg>`, a sibling of the synced work trees, so the
 * synced tree stays untouched. `fromWorkTree` is the same directory relative to
 * `<workdir>/<repo>`, where act runs; `run` is the run's directory, removed when the leg ends.
 */
export function guestLegDir(workdir: string, runId: string, legId: string): { path: string; fromWorkTree: string; run: string } {
  const rel = `.osmatrix/${runId}/${legId}`;
  return { path: `${workdir}/${rel}`, fromWorkTree: `../${rel}`, run: `${workdir}/.osmatrix/${runId}` };
}

/**
 * Save a leg's derived workflow in the run directory, under the workflow's file name (act falls back to
 * it for the workflow's name). Host legs run it from there, outside the checkout; returns its path.
 */
function writeDerivedCopy(dir: string, leg: Leg, text: string, log: fs.WriteStream): string {
  const file = path.join(ensureDir(path.join(dir, "workflows", leg.id)), path.posix.basename(leg.workflow));
  fs.writeFileSync(file, text);
  log.write(`[osmatrix] act runs a derived copy of ${leg.workflow} (${file}); the checkout is unchanged\n`);
  return file;
}

/**
 * Write a VM leg's derived workflow next to the work tree (keeping its file name) and a copy into the run
 * directory for debugging. Returns the path to pass to -W.
 */
async function writeDerivedWorkflow(
  ep: Endpoint,
  dir: string,
  own: ReturnType<typeof guestLegDir>,
  leg: Leg,
  text: string,
  log: fs.WriteStream,
): Promise<string> {
  const name = path.posix.basename(leg.workflow);
  await writeRemoteFile(ep, `${own.path}/${name}`, text);
  const copy = path.join(ensureDir(path.join(dir, "workflows", leg.id)), name);
  fs.writeFileSync(copy, text);
  log.write(`[osmatrix] act runs a derived copy of ${leg.workflow} (saved as ${copy}); the checkout is unchanged\n`);
  return `${own.fromWorkTree}/${name}`;
}

/**
 * act's arguments for a leg; `workflow` replaces the leg's own workflow file (a derived copy outside the
 * work tree). `githubRunId` is the run's shared GITHUB_RUN_ID (act's default is 1).
 */
export function commonActArgs(leg: Pick<Leg, "workflow" | "job" | "matrix">, workflow = leg.workflow, githubRunId?: string): string[] {
  const a = ["-W", workflow, "-j", leg.job, "--json"];
  if (githubRunId) a.push("--env", `GITHUB_RUN_ID=${githubRunId}`);
  for (const [k, v] of Object.entries(leg.matrix)) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) a.push("--matrix", `${k}:${String(v)}`);
  }
  return a;
}

function detectEvent(workflowFile: string): string {
  try {
    const doc = YAML.parse(fs.readFileSync(workflowFile, "utf8")) ?? {};
    const on = doc.on ?? doc[true as unknown as string]; // YAML 1.1 parsers may read `on` as true
    const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
    for (const pref of ["push", "pull_request", "workflow_dispatch"]) if (events.includes(pref)) return pref;
    return events[0] ?? "push";
  } catch {
    return "push";
  }
}

function resolveSecretFile(repo: string, explicit?: string): string | undefined {
  if (explicit) {
    const f = path.resolve(repo, explicit);
    if (!fs.existsSync(f)) throw new Error(`secret file ${f} not found`);
    return f;
  }
  for (const c of [path.join(repo, ".osmatrix", "secrets"), path.join(repo, ".secrets")]) if (fs.existsSync(c)) return c;
  return undefined;
}

/**
 * Bring the guest's copy of the repo up to date with the host's work tree. Every VM guest gets a git
 * checkout (src/core/gitsync.ts), not only Windows: every GitHub runner checks out with git, so the
 * guest's own Git config deciding line endings, modes and symlinks is right everywhere; on macOS and
 * Linux that gives the same bytes as a copy, but the host's .git/config (hooks, worktree paths, helpers)
 * stays home and later runs send only new objects instead of the whole .git. Directories outside a git
 * repository and repositories the checkout can't reproduce (filters such as LFS, submodules) are copied
 * file by file, as is everything when the checkout fails in the guest (no git there, say).
 */
async function syncRepo(ep: Endpoint, guest: string, repo: string, remote: string, r: LegResult, log: fs.WriteStream) {
  let snap: Snapshot;
  try {
    snap = await snapshotWorktree(repo, guest);
  } catch (e) {
    const why = e instanceof NotMaterializable ? e.message : `snapshot failed: ${(e as Error).message}`;
    log.write(`[osmatrix] copying files instead of a git checkout: ${why}\n`);
    return copyRepo(ep, repo, remote);
  }
  try {
    try {
      await checkoutInGuest(ep, remote, snap, false);
    } catch (e) {
      // A guest cache in an unexpected state (missing prerequisites, interrupted run): start over.
      log.write(`[osmatrix] git checkout in the guest failed (${(e as Error).message}); retrying with a fresh cache\n`);
      await checkoutInGuest(ep, remote, snap, true);
    }
    await snap.synced();
  } catch (e) {
    const w = `git checkout in the guest failed (${(e as Error).message}); copied the files instead, so line endings, file modes and symlinks follow the host`;
    r.warnings.push(w);
    log.write(`[osmatrix] ${w}\n`);
    await copyRepo(ep, repo, remote);
  } finally {
    snap.dispose();
  }
}

async function checkoutInGuest(ep: Endpoint, remote: string, snap: Snapshot, fresh: boolean) {
  const cache = guestCachePath(remote);
  const cacheDir = cache.slice(0, cache.lastIndexOf("/"));
  const sep = ep.shell === "pwsh" ? ";" : " &&";
  const exec = async (what: string, command: string) => {
    const res = await sshExec(ep, command, { timeoutMs: 30 * 60_000 });
    if (res.code !== 0) throw new Error(`${what}: ${(res.stderr || res.stdout).trim().split("\n").slice(-5).join(" ") || `exit ${res.code}`}`);
    return res.stdout;
  };
  let refs = new Map<string, string>();
  const list = fresh ? undefined : await sshExec(ep, commandLine(ep.shell, ["git", "--git-dir", cache, "for-each-ref", "--format=%(objectname) %(refname)"]));
  if (list?.code === 0) refs = parseRefs(list.stdout);
  else await exec("git init", `${mkdirCmd(ep.shell, cache, true)}${sep} ${commandChain(ep.shell, [{ argv: ["git", "init", "-q", "--bare", cache] }])}`);

  // An unchanged tree gives the same snapshot commit, which the guest already has.
  const name = `${cache.slice(cache.lastIndexOf("/") + 1, -".git".length)}.bundle`;
  const bundle = refs.get(SNAPSHOT_REF) !== snap.commit ? `${cacheDir}/${name}` : undefined;
  if (bundle) await sshPush(ep, await createBundle(snap, [...refs.values()], name), cacheDir, { timeoutMs: 30 * 60_000 });
  try {
    // The work tree is recreated every run (as the byte copy's delete-and-copy did), as a clone sharing the cache's objects.
    const cacheSteps = guestCacheSteps(snap, cache, bundle);
    await exec(
      "updating the guest repository",
      [
        ...(cacheSteps.length ? [commandChain(ep.shell, cacheSteps)] : []),
        mkdirCmd(ep.shell, remote, true),
        commandChain(ep.shell, [guestCloneStep(cache, remote)]),
      ].join(`${sep} `),
    );
  } finally {
    if (bundle) await sshExec(ep, removeCmd(ep, bundle), { timeoutMs: 60_000 }).catch(() => undefined);
  }
  const probe = await sshExec(ep, commandLine(ep.shell, ["git", "--git-dir", `${remote}/.git`, "config", "--local", "--get", "core.symlinks"]));
  await exec("git checkout", withCwd(ep.shell, remote, commandChain(ep.shell, guestCheckoutSteps(snap, symlinksAllowed(probe.stdout)))));
}

/** The byte copy: the host's files and .git as they are. */
async function copyRepo(ep: Endpoint, repo: string, remote: string) {
  await sshPush(ep, repo, remote, { clean: true, includeGit: true });
  if (!fs.existsSync(path.join(repo, ".git"))) {
    // act wants a git repository (sha/ref); directories outside one get a throwaway one.
    const init = "git init -q; git add -A; git -c user.name=osmatrix -c user.email=osmatrix@localhost commit -qm osmatrix";
    await sshExec(ep, withCwd(ep.shell, remote, init), { timeoutMs: 120_000 });
  }
}

/**
 * act runs a Windows leg's Linux needs in the VM, where run: steps without a shell: default to pwsh.
 * GitHub would run them with bash, so point those jobs at Git Bash. Only needs that can't run as their
 * own legs (see Leg.inlineNeeds) get here. Returns the derived workflow, or undefined when
 * nothing changes.
 */
async function bashForLinuxNeeds(ep: Endpoint, workflow: string, leg: Leg, r: LegResult, log: fs.WriteStream): Promise<string | undefined> {
  // Git Bash's launcher (bin\bash.exe) sets up PATH; System32\bash.exe would be WSL, so don't rely on PATH.
  const find = `$g = Get-Command git -ErrorAction SilentlyContinue; $c = @('C:\\Program Files\\Git\\bin\\bash.exe'); if ($g) { $c = @((Join-Path (Split-Path (Split-Path $g.Source)) 'bin\\bash.exe'), (Join-Path (Split-Path (Split-Path (Split-Path $g.Source))) 'bin\\bash.exe')) + $c }; $c | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1`;
  const bash = (await sshExec(ep, powershell(ep, find), { timeoutMs: 60_000 })).stdout.trim().replace(/\\/g, "/");
  if (!bash) {
    r.warnings.push(`Git Bash not found in the guest; Linux needs (${leg.linuxNeeds!.join(", ")}) run their run: steps under pwsh`);
    return undefined;
  }
  // GitHub's default for a run: step without shell: on Linux is `bash -e {0}`. Double quotes: act splits
  // the string to find the program, but on Windows hands the raw string to CreateProcess as the command line.
  const { text, changed } = setDefaultRunShell(workflow, leg.linuxNeeds!, `"${bash}" -e {0}`);
  if (!changed.length) return undefined;
  log.write(`[osmatrix] Linux needs ${changed.join(", ")}: run: steps without shell: use ${bash} in this leg\n`);
  return text;
}

/** Where the macOS packages behind actions/setup-python & co. install, as on GitHub's runners. */
export const MAC_TOOL_CACHE = "/Users/runner/hostedtoolcache";

/**
 * A posix command that makes `dir` a directory the ssh user owns and can write to and search, and does
 * nothing when it already is; it exits non-zero when the repair didn't get there. The actions/*-versions
 * macOS packages install into /Users/runner/hostedtoolcache whatever RUNNER_TOOL_CACHE says, and act's
 * host mode can't redirect them. Provisioning creates it; this covers guests provisioned before it did,
 * and golden snapshots taken then, without re-provisioning.
 */
export function macToolCacheCmd(dir: string = MAC_TOOL_CACHE): string {
  const d = quoteFor("posix", dir);
  const owner = quoteFor("posix", path.posix.dirname(dir));
  // Ownership as well as access: the installers create subdirectories and expect to own what they make.
  const ok = `[ -d ${d} ] && [ -O ${d} ] && [ -w ${d} ] && [ -x ${d} ]`;
  // sudo -n: never wait for a password prompt that no one will answer. chown alone doesn't add the
  // owner's permission bits (a 0555 cache stays read-only), hence chmod; then check the result again.
  const repair = `sudo -n mkdir -p ${d} && sudo -n chown -R "$(id -un)":staff ${owner} && sudo -n chmod u+rwx ${owner} ${d}`;
  return `${ok} || { ${repair}; ${ok}; }`;
}

async function ensureMacToolCache(ep: Endpoint, r: LegResult, log: fs.WriteStream) {
  const res = await sshExec(ep, macToolCacheCmd(), { timeoutMs: 120_000 });
  if (res.code === 0) return;
  // Not fatal: only workflows using the actions/*-versions installers (setup-python, …) need it.
  const msg = `could not make ${MAC_TOOL_CACHE} in the guest a directory the guest user owns and can write to (needs passwordless sudo; try \`osmatrix provision <guest> --passwordless-sudo\`); actions/setup-python and similar installers fail with "mkdir: /Users/runner: Permission denied"`;
  r.warnings.push(msg);
  log.write(`[osmatrix] warning: ${msg}\n`);
}

/**
 * Prints `vc:<path>` for a Visual Studio (Build Tools only count with -products *) with the MSVC C++ tools
 * for x64 or ARM64, and `sdk:<version>` for a Windows 10/11 SDK with the guest architecture's import
 * libraries (kernel32.lib; vswhere's SDK component ids change with every SDK version).
 */
export const VC_TOOLS_PROBE = [
  "$v = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'",
  "if (Test-Path -LiteralPath $v) { & $v -products * -requiresAny -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 Microsoft.VisualStudio.Component.VC.Tools.ARM64 -property installationPath | Select-Object -First 1 | ForEach-Object { 'vc:' + $_ } }",
  "$k = @('HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows Kits\\Installed Roots') | ForEach-Object { (Get-ItemProperty -LiteralPath $_ -Name KitsRoot10 -ErrorAction SilentlyContinue).KitsRoot10 } | Where-Object { $_ } | Select-Object -First 1",
  "if (-not $k) { $k = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\\10' }",
  "$a = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }",
  "Get-ChildItem -LiteralPath (Join-Path $k 'Lib') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName \"um\\$a\\kernel32.lib\") } | Select-Object -First 1 | ForEach-Object { 'sdk:' + $_.Name }",
  // A missing key or folder leaves $? false, which would make the probe itself look failed.
  "exit 0",
].join("; ");

/** What VC_TOOLS_PROBE found, or why the guest can't build with MSVC (undefined when it can). */
export function msvcMissing(probeOutput: string): string | undefined {
  const lines = probeOutput.split(/\r?\n/).map((l) => l.trim());
  const vc = lines.some((l) => /^vc:./.test(l));
  const sdk = lines.some((l) => /^sdk:./.test(l));
  if (vc && sdk) return undefined;
  if (vc) return "it has the MSVC C++ tools but no Windows SDK";
  if (sdk) return "it has a Windows SDK but no MSVC C++ tools";
  return "vswhere finds no MSVC C++ tools and there is no Windows SDK";
}

/**
 * Guests set up before osmatrix installed the MSVC Build Tools (or whose install failed) lack them. Warn,
 * with the fix, when this leg needs them; don't install at leg time (it takes several GB and ~15 min).
 */
async function checkMsvc(ep: Endpoint, cfg: GuestConfig, leg: Leg, r: LegResult, log: fs.WriteStream) {
  const p = await sshExec(ep, powershell(ep, VC_TOOLS_PROBE), { timeoutMs: 60_000 }).catch(() => undefined);
  // Only a probe that ran counts; a failed probe proves nothing.
  if (!p || p.code !== 0) return;
  const missing = msvcMissing(p.stdout);
  if (!missing) return;
  const w = msvcHint(cfg, leg.msvcUses!, `guest ${cfg.name} can't build with them: ${missing}`);
  r.warnings.push(w);
  log.write(`[osmatrix] warning: ${w}\n`);
}

/**
 * A PowerShell expression for a guest path relative to the home directory (or absolute, kept as is).
 * Always a quoted string: in an expression a bare word such as work/x would be parsed as division.
 */
export function pwshHomePath(p: string): string {
  return `[IO.Path]::Combine($HOME, '${p.replace(/'/g, "''")}')`;
}

/** Write a file in the guest (relative to its home, or absolute), creating its directory. */
async function writeRemoteFile(ep: Endpoint, target: string, content: string) {
  const dir = path.posix.dirname(target);
  // PowerShell reads stdin in the console's code page; base64 keeps non-ASCII content intact.
  // Path.Combine keeps an absolute target as is; .NET's current directory isn't the home directory.
  const cmd =
    ep.shell === "posix"
      ? `umask 077; mkdir -p ${quoteFor("posix", dir)} && cat > ${quoteFor("posix", target)}`
      : powershell(
          ep,
          `$p = ${pwshHomePath(target)}; [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)); [IO.File]::WriteAllBytes($p, [Convert]::FromBase64String([Console]::In.ReadToEnd()))`,
        );
  const input = ep.shell === "posix" ? content : Buffer.from(content, "utf8").toString("base64");
  const r = await sshExec(ep, cmd, { input, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`failed to write ${target}: ${r.stderr}`);
}

/**
 * Remove a file or directory tree in the guest (relative to its home, or absolute). A missing target is
 * fine; a failed removal exits non-zero.
 */
export function removeCmd(ep: Pick<Endpoint, "shell">, target: string): string {
  return ep.shell === "posix"
    ? `rm -rf ${quoteFor("posix", target)}`
    : powershell(ep, `$p = ${pwshHomePath(target)}; if (Test-Path -LiteralPath $p) { Remove-Item -Recurse -Force -ErrorAction Stop -LiteralPath $p }`);
}

/** `onStart` gets the child and returns a cleanup to run when it exits. */
function streamProcess(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  parser: ActJsonParser,
  timeoutMs: number,
  onStart?: (child: ChildProcess) => () => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const done = onStart?.(child);
    child.once("close", () => done?.());
    const timer = setTimeout(() => {
      parser.raw(`[osmatrix] timeout after ${Math.round(timeoutMs / 60000)} min; killing`);
      child.kill();
      resolve(124);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => parser.feed(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => parser.feed(d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      parser.raw(`[osmatrix] failed to start ${cmd}: ${e.message}`);
      resolve(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** Turns act --json output into a readable log and tracks step/job results. */
export class ActJsonParser {
  steps: { name: string; result: string }[] = [];
  failedStep?: string;
  /** The result of the leg's own job (of any job when constructed without one). */
  jobResult?: string;
  /** Whether the leg's own job ran any step: act reports nothing for a job it skips. */
  jobStarted = false;
  /** Other jobs that failed (needs act ran, or stubs replaying a failure). */
  failedJobs: string[] = [];
  private buf = "";
  private readonly out: (line: string) => void;
  private readonly job?: string;
  constructor(out: (line: string) => void, job?: string) {
    this.out = out;
    this.job = job;
  }
  raw(line: string) {
    this.out(line);
  }
  feed(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, i).replace(/\r$/, ""));
      this.buf = this.buf.slice(i + 1);
    }
  }
  flush() {
    if (this.buf) this.line(this.buf);
    this.buf = "";
  }
  private line(l: string) {
    if (!l.startsWith("{")) {
      this.out(l);
      return;
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(l);
    } catch {
      this.out(l);
      return;
    }
    const msg = String(j.msg ?? "").replace(/\s+$/, "");
    const step = typeof j.step === "string" ? j.step : undefined;
    if (typeof j.stepResult === "string" && step) {
      // act -j also runs needed jobs; qualify step names with the job when they differ.
      const name = typeof j.jobID === "string" && this.job && j.jobID !== this.job ? `${j.jobID}: ${step}` : step;
      this.steps.push({ name, result: j.stepResult });
      if (j.stepResult === "failure" && !this.failedStep) this.failedStep = name;
    }
    const own = !this.job || j.jobID === this.job;
    if (own && step) this.jobStarted = true;
    if (typeof j.jobResult === "string") {
      if (own) {
        if (this.jobResult !== "failure") this.jobResult = j.jobResult;
      } else if (j.jobResult === "failure" && typeof j.jobID === "string" && !this.failedJobs.includes(j.jobID)) {
        this.failedJobs.push(j.jobID);
      }
    }
    const prefix = step ? `[${step}] ` : "";
    if (j.raw_output) this.out(`  | ${msg}`);
    else if (msg) this.out(`${String(j.level ?? "info") === "info" ? "" : String(j.level).toUpperCase() + " "}${prefix}${msg}`);
  }
}

class Semaphore {
  private n: number;
  private q: (() => void)[] = [];
  constructor(n: number) {
    this.n = Math.max(1, n);
  }
  async acquire() {
    if (this.n > 0) {
      this.n--;
      return;
    }
    await new Promise<void>((r) => this.q.push(r));
  }
  release() {
    const next = this.q.shift();
    if (next) next();
    else this.n++;
  }
}
