import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { DockurBackend } from "../backends/dockur.ts";
import { ensureAct } from "../core/act.ts";
import { guestWorkdir, loadConfig, type Config } from "../core/config.ts";
import { acquireLocks } from "../core/locks.ts";
import { dockerReach, selinuxEnforcing } from "../core/nesting.ts";
import { cliEntry, ensureDir } from "../core/paths.ts";
import { isAlive, spawnDetached } from "../core/proc.ts";
import { createBundle, guestCheckoutSteps, NotMaterializable, parseRefs, SNAPSHOT_REF, snapshotWorktree, type Snapshot } from "../core/gitsync.ts";
import {
  commandChain,
  commandLine,
  freePort,
  mkdirCmd,
  push as sshPush,
  quoteFor,
  sshArgs,
  sshBin,
  sshExec,
  withCwd,
  type Endpoint,
} from "../core/ssh.ts";
import { getGuest, readyEndpoint, waitReady } from "../env.ts";
import { plan as makePlan, setDefaultRunShell, type Leg, type Plan, type PlanFilter } from "./plan.ts";

export type LegState = "pending" | "running" | "success" | "failure" | "skipped" | "error";

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
}

export interface RunStatus {
  id: string;
  repo: string;
  state: "running" | "done" | "aborted";
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  options: RunOptions;
  counts: Record<LegState, number>;
  legs: LegResult[];
  planWarnings: string[];
}

export interface RunOptions extends PlanFilter {
  /** Event name passed to act (default: first of push/pull_request/workflow_dispatch the workflow listens to). */
  event?: string;
  /** Event payload for act (-e), e.g. {"ref": "refs/tags/v1.2.3"} to simulate a tag push. */
  eventPayload?: Record<string, unknown>;
  secretFile?: string;
  /** Per-leg timeout in minutes (default 60). */
  timeoutMin?: number;
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

function latestRun(repo: string): string {
  const runs = listRuns(repo);
  if (!runs.length) throw new Error(`no runs in ${repo}/.osmatrix/runs`);
  return runs[runs.length - 1];
}

function emptyCounts(): Record<LegState, number> {
  return { pending: 0, running: 0, success: 0, failure: 0, skipped: 0, error: 0 };
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
    legs: p.legs.map((l) => ({
      id: l.id,
      target: l.target,
      workflow: l.workflow,
      job: l.job,
      matrix: l.matrix,
      state: l.skip ? "skipped" : "pending",
      error: l.skip,
      warnings: l.warnings,
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

// ---------- worker ----------

export async function worker(repo: string, id: string): Promise<void> {
  const dir = runDir(repo, id);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8")) as Plan;
  const sf = new StatusFile(path.join(dir, "status.json"), JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")));
  sf.s.pid = process.pid;
  sf.save();
  const cfg = loadConfig();

  const groups = new Map<string, Leg[]>();
  for (const leg of p.legs) {
    if (leg.skip || !leg.target) continue;
    groups.set(leg.target, [...(groups.get(leg.target) ?? []), leg]);
  }

  const vmSlots = new Semaphore(cfg.max_vms);
  await Promise.all(
    [...groups.entries()].map(async ([target, legs]) => {
      const isVm = target !== "host";
      if (isVm) await vmSlots.acquire();
      try {
        for (const leg of legs) await runLeg(repo, dir, cfg, leg, sf);
      } finally {
        if (isVm) vmSlots.release();
      }
    }),
  );
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
  if (leg.target !== "host") return [`guest:${leg.target}`];
  // act falls back to the workflow's file name.
  const name = leg.workflowName ?? path.posix.basename(leg.workflow);
  return [`host:act-workflow:${`act-${name}`.replace(/[^a-zA-Z0-9]/g, "-").replaceAll("--", "-")}`];
}

async function runLeg(repo: string, dir: string, cfg: Config, leg: Leg, sf: StatusFile): Promise<void> {
  const r = sf.s.legs.find((l) => l.id === leg.id)!;
  const logFile = path.join(dir, `${leg.id}.log`);
  const log = fs.createWriteStream(logFile, { flags: "a" });
  let waited: string | undefined;
  const release = await acquireLocks(legLockKeys(leg), { pid: process.pid, run: sf.s.id, repo, leg: leg.id }, (key, h) => {
    waited = key.startsWith("guest:") ? `guest ${leg.target}` : `workflow "${leg.workflowName ?? leg.workflow}" (act containers)`;
    r.waitingFor = `${waited} is in use by run ${h.run} (leg ${h.leg}${h.repo === repo ? "" : `, ${h.repo}`})`;
    log.write(`[osmatrix] waiting: ${r.waitingFor}\n`);
    sf.save();
  });
  if (waited) log.write(`[osmatrix] ${waited} is free; starting\n`);
  r.waitingFor = undefined;
  r.state = "running";
  r.startedAt = new Date().toISOString();
  sf.save();
  const parser = new ActJsonParser((line) => log.write(line + "\n"), leg.job);
  const timeoutMs = (sf.s.options.timeoutMin ?? 60) * 60_000;
  try {
    const event = sf.s.options.event ?? detectEvent(path.join(repo, leg.workflow));
    const secretFile = resolveSecretFile(repo, sf.s.options.secretFile);
    let code: number;
    if (leg.target === "host") {
      const act = await ensureAct();
      const args = [event, ...commonActArgs(leg), "--pull=false", "--rm", "--artifact-server-path", path.join(dir, "artifacts")];
      for (const l of new Set([...leg.runsOn, ...(leg.needsLabels ?? [])])) args.push("-P", `${l}=${cfg.act_linux_image}`);
      // act mounts the Docker socket into job containers; SELinux (Fedora, openSUSE, RHEL) denies
      // that unless the container runs unconfined, which matches GitHub's runners.
      if (selinuxEnforcing()) args.push("--container-options", "--security-opt label=disable");
      // act's artifact server defaults to a fixed port (34567); concurrent or nested runs would collide.
      args.push("--artifact-server-port", String(await freePort()));
      if (secretFile) args.push("--secret-file", secretFile);
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
      if (sf.s.options.eventPayload) {
        const eventFile = path.join(dir, "event.json");
        fs.writeFileSync(eventFile, JSON.stringify(sf.s.options.eventPayload));
        args.push("-e", eventFile);
      }
      log.write(`$ act ${args.join(" ")}\n`);
      code = await streamProcess(act, args, repo, parser, timeoutMs);
    } else {
      const g = getGuest(leg.target!);
      if (g.backend instanceof DockurBackend && g.cfg.os === "macos" && !g.backend.everReady()) {
        throw new Error(
          `macOS guest "${g.cfg.name}" has not been set up yet. Run \`osmatrix setup ${g.cfg.name} --accept-license\` (MCP: env_setup) once the user agrees to Apple's macOS license; it is fully automatic (~30-60 min).`,
        );
      }
      log.write(`[osmatrix] ensuring guest ${g.cfg.name} is up\n`);
      await g.backend.up();
      const s = await waitReady(g, g.cfg.boot_timeout ?? 3600);
      if (s.state !== "ready") throw new Error(`guest ${g.cfg.name} not ready: ${s.state}${s.detail ? ` (${s.detail})` : ""}`);
      const ep = await readyEndpoint(g.cfg.name);
      const remote = `${guestWorkdir(g.cfg)}/${path.basename(repo)}`;
      log.write(`[osmatrix] syncing ${repo} -> ${g.cfg.name}:${remote}\n`);
      await syncRepo(ep, repo, remote, r, log);
      if (g.cfg.os === "windows" && leg.linuxNeeds?.length) await bashForLinuxNeeds(ep, repo, remote, leg, r, log);
      const args = [event, ...commonActArgs(leg), "--artifact-server-path", ".osmatrix-artifacts"];
      for (const l of new Set([...leg.runsOn, ...(leg.needsLabels ?? [])])) args.push("-P", `${l}=-self-hosted`);
      if (sf.s.options.eventPayload) {
        await writeRemoteFile(ep, remote, ".osmatrix-event.json", JSON.stringify(sf.s.options.eventPayload));
        args.push("-e", ".osmatrix-event.json");
      }
      if (secretFile) {
        await writeRemoteFile(ep, remote, ".osmatrix-secrets", fs.readFileSync(secretFile, "utf8"));
        args.push("--secret-file", ".osmatrix-secrets");
      }
      log.write(`$ act ${args.join(" ")}\n`);
      const command = withCwd(ep.shell, remote, commandLine(ep.shell, ["act", ...args]));
      code = await streamProcess(sshBin(), sshArgs(ep, ["-T"]).concat([command]), undefined, parser, timeoutMs);
      if (secretFile) await sshExec(ep, removeCmd(ep, `${remote}/.osmatrix-secrets`)).catch(() => undefined);
    }
    parser.flush();
    r.steps = parser.steps;
    r.failedStep = parser.failedStep;
    r.state = code === 0 && parser.jobResult !== "failure" ? "success" : "failure";
    if (code === 124) r.error = `timed out after ${sf.s.options.timeoutMin ?? 60} min`;
  } catch (e) {
    r.state = "error";
    r.error = (e as Error).message;
    log.write(`[osmatrix] error: ${r.error}\n`);
  } finally {
    release();
    await new Promise((res) => log.end(res));
    r.finishedAt = new Date().toISOString();
    r.durationSec = Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt!)) / 1000);
    if (r.state !== "success") {
      r.tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-60).join("\n");
      r.warnings.push(...actDifferenceHints(r.tail));
    }
    sf.save();
  }
}

/**
 * Hints for failures that come from act's environment rather than the code. act keeps the file-command
 * files (GITHUB_OUTPUT, GITHUB_ENV, …) under its own act/workflow/ directory; GitHub's runners keep them
 * under RUNNER_TEMP, so scripts that check those paths for containment fail only locally.
 */
export function actDifferenceHints(log: string): string[] {
  const m = /\S*act[\\/]workflow[\\/](?:outputcmd\.txt|envs\.txt|pathcmd\.txt|statecmd\.txt|SUMMARY\.md)\b/.exec(log);
  if (!m) return [];
  return [
    `the failure mentions ${m[0]}: act keeps GITHUB_OUTPUT/GITHUB_ENV/GITHUB_PATH/GITHUB_STATE/GITHUB_STEP_SUMMARY there, outside RUNNER_TEMP, while GitHub keeps them under RUNNER_TEMP. A check that these paths lie inside RUNNER_TEMP or GITHUB_WORKSPACE fails only locally; skip it when env.ACT is set`,
  ];
}

function commonActArgs(leg: Leg): string[] {
  const a = ["-W", leg.workflow, "-j", leg.job, "--json"];
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
async function syncRepo(ep: Endpoint, repo: string, remote: string, r: LegResult, log: fs.WriteStream) {
  let snap: Snapshot;
  try {
    snap = await snapshotWorktree(repo);
  } catch (e) {
    const why = e instanceof NotMaterializable ? e.message : `snapshot failed: ${(e as Error).message}`;
    log.write(`[osmatrix] copying files instead of a git checkout: ${why}\n`);
    return copyRepo(ep, repo, remote);
  }
  try {
    try {
      await checkoutInGuest(ep, remote, snap, false);
    } catch (e) {
      // A guest repository in an unexpected state (missing prerequisites, interrupted run): start over.
      log.write(`[osmatrix] git checkout in the guest failed (${(e as Error).message}); retrying in a fresh repository\n`);
      await checkoutInGuest(ep, remote, snap, true);
    }
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
  const gitDir = `${remote}/.git`;
  const git = (...argv: string[]) => commandLine(ep.shell, ["git", "--git-dir", gitDir, ...argv]);
  let refs = new Map<string, string>();
  if (!fresh) {
    const res = await sshExec(ep, git("for-each-ref", "--format=%(objectname) %(refname)"), { timeoutMs: 120_000 });
    if (res.code === 0) refs = parseRefs(res.stdout);
  }
  if (!refs.has(SNAPSHOT_REF)) {
    // Not a repository osmatrix set up: absent, or a byte copy carrying the host's .git/config. Start over.
    refs = new Map();
    const sep = ep.shell === "pwsh" ? ";" : " &&";
    const init = await sshExec(ep, `${mkdirCmd(ep.shell, remote, true)}${sep} ${commandLine(ep.shell, ["git", "init", "-q", remote])}`, {
      timeoutMs: 10 * 60_000,
    });
    if (init.code !== 0) throw new Error(`git init: ${(init.stderr || init.stdout).trim()}`);
    // git init writes core.symlinks=false when its probe can't create a symlink. Otherwise turn them on
    // here: guests provisioned before osmatrix enabled symlinks have core.symlinks=false system-wide,
    // while GitHub's Windows image installs Git with symlinks enabled.
    const probe = await sshExec(ep, git("config", "--local", "--get", "core.symlinks"), { timeoutMs: 60_000 });
    if (probe.stdout.trim() !== "false") {
      const set = await sshExec(ep, git("config", "core.symlinks", "true"), { timeoutMs: 60_000 });
      if (set.code !== 0) throw new Error(`git config core.symlinks: ${set.stderr.trim()}`);
    }
  }
  const slash = remote.lastIndexOf("/");
  const name = `${remote.slice(slash + 1)}.bundle`;
  const bundleDir = `${slash >= 0 ? remote.slice(0, slash) : "."}/.osmatrix-bundles`;
  // An unchanged tree gives the same snapshot commit, which the guest already has.
  const send = refs.get(SNAPSHOT_REF) !== snap.commit;
  if (send) await sshPush(ep, await createBundle(snap, [...refs.values()], name), bundleDir, { timeoutMs: 30 * 60_000 });
  const steps = guestCheckoutSteps(snap, refs, send ? `../.osmatrix-bundles/${name}` : undefined);
  const res = await sshExec(ep, withCwd(ep.shell, remote, commandChain(ep.shell, steps)), { timeoutMs: 30 * 60_000 });
  if (send) await sshExec(ep, removeCmd(ep, `${bundleDir}/${name}`), { timeoutMs: 60_000 }).catch(() => undefined);
  if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().split("\n").slice(-5).join(" ") || `exit ${res.code}`);
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
 * GitHub would run them with bash, so point those jobs at Git Bash in the guest's copy of the workflow.
 */
async function bashForLinuxNeeds(ep: Endpoint, repo: string, remote: string, leg: Leg, r: LegResult, log: fs.WriteStream) {
  // Git Bash's launcher (bin\bash.exe) sets up PATH; System32\bash.exe would be WSL, so don't rely on PATH.
  const find = `$g = Get-Command git -ErrorAction SilentlyContinue; $c = @('C:\\Program Files\\Git\\bin\\bash.exe'); if ($g) { $c = @((Join-Path (Split-Path (Split-Path $g.Source)) 'bin\\bash.exe'), (Join-Path (Split-Path (Split-Path (Split-Path $g.Source))) 'bin\\bash.exe')) + $c }; $c | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1`;
  const bash = (await sshExec(ep, powershell(ep, find), { timeoutMs: 60_000 })).stdout.trim().replace(/\\/g, "/");
  if (!bash) {
    r.warnings.push(`Git Bash not found in the guest; Linux needs (${leg.linuxNeeds!.join(", ")}) run their run: steps under pwsh`);
    return;
  }
  // GitHub's default for a run: step without shell: on Linux is `bash -e {0}`. Double quotes: act splits
  // the string to find the program, but on Windows hands the raw string to CreateProcess as the command line.
  const { text, changed } = setDefaultRunShell(fs.readFileSync(path.join(repo, leg.workflow), "utf8"), leg.linuxNeeds!, `"${bash}" -e {0}`);
  if (!changed.length) return;
  await writeRemoteFile(ep, remote, leg.workflow, text);
  log.write(`[osmatrix] Linux needs ${changed.join(", ")}: run: steps without shell: use ${bash} in this leg\n`);
}

/**
 * A PowerShell script as a command for a Windows endpoint. Guests whose ssh shell is cmd get Windows
 * PowerShell with the script encoded, which sidesteps cmd's quoting.
 */
export function powershell(ep: Pick<Endpoint, "shell">, script: string): string {
  if (ep.shell === "pwsh") return script;
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

async function writeRemoteFile(ep: Endpoint, dir: string, name: string, content: string) {
  const target = `${dir}/${name}`;
  // PowerShell reads stdin in the console's code page; base64 keeps non-ASCII content intact.
  const cmd =
    ep.shell === "posix"
      ? `umask 077; cat > ${quoteFor("posix", target)}`
      : powershell(ep, `[IO.File]::WriteAllBytes((Join-Path $HOME ${quoteFor("pwsh", target)}), [Convert]::FromBase64String([Console]::In.ReadToEnd()))`);
  const input = ep.shell === "posix" ? content : Buffer.from(content, "utf8").toString("base64");
  const r = await sshExec(ep, cmd, { input, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`failed to write ${target}: ${r.stderr}`);
}

function removeCmd(ep: Endpoint, file: string): string {
  return ep.shell === "posix" ? `rm -f ${quoteFor("posix", file)}` : powershell(ep, `Remove-Item -Force -LiteralPath ${quoteFor("pwsh", file)}`);
}

function streamProcess(cmd: string, args: string[], cwd: string | undefined, parser: ActJsonParser, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
  jobResult?: string;
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
    // The leg's own job result decides; a needed job failing also fails the leg.
    if (typeof j.jobResult === "string" && (j.jobResult === "failure" || !this.job || j.jobID === this.job)) {
      if (this.jobResult !== "failure") this.jobResult = j.jobResult;
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
