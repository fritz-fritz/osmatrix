import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { DEFAULT_LINUX_IMAGE, guestHomebrew, guestMsvc, labelMatches, type Config, type GuestConfig } from "../core/config.ts";

export type Scalar = string | number | boolean | null;
export type MatrixCombo = Record<string, unknown>;

export interface Leg {
  id: string;
  workflow: string; // repo-relative path
  /** The workflow's `name:` (act names job containers after it and the job id). */
  workflowName?: string;
  job: string;
  jobName?: string;
  matrix: MatrixCombo;
  runsOn: string[];
  /** runs-on labels of the needed jobs act runs inside this leg (see inlineNeeds). */
  needsLabels: string[];
  /** Jobs this leg's job directly needs. */
  needs: string[];
  /** Every job this leg's job transitively needs. */
  needsAll?: string[];
  /**
   * Needed jobs that run as their own legs in this run (each exactly once, on its own runs-on target):
   * this leg waits for them and act gets stubs that replay their results, outputs and artifacts.
   */
  replayNeeds?: string[];
  /**
   * Needed jobs that can't run as their own legs (no local target): act runs them inside this leg, as
   * `act -j` does, in this leg's environment.
   */
  inlineNeeds?: string[];
  /** The inline needs that target Linux only, when this leg doesn't (Windows legs run them with Git Bash). */
  linuxNeeds?: string[];
  /** Legs (ids) of the replayed needs: this leg starts when they have finished. */
  waitsFor?: string[];
  /** Legs (ids) that wait for this one: osmatrix records its job's result and outputs for them. */
  neededBy?: string[];
  /** Not selected by the filter: runs only because selected legs need its job. */
  neededOnly?: boolean;
  /** "host" = act on the host docker (Linux legs); otherwise a guest name. */
  target?: string;
  targetOs?: string;
  skip?: string;
  /** Windows legs: the steps that need the MSVC Build Tools (Rust toolchains, cargo, C/C++ toolchain actions). */
  msvcUses?: string[];
  warnings: string[];
}

export interface Plan {
  repo: string;
  legs: Leg[];
  warnings: string[];
}

export interface PlanFilter {
  workflow?: string;
  job?: string;
  /** Only legs for these targets (guest names, "host"/"linux", or os families). */
  only?: string[];
  /** key=value matrix filters. */
  matrix?: Record<string, string>;
}

// ---------- matrix expansion (GitHub semantics, simplified) ----------

export function expandMatrix(matrix: unknown, warnings: string[] = []): MatrixCombo[] {
  if (matrix === undefined || matrix === null) return [{}];
  if (typeof matrix === "string") {
    warnings.push(`matrix is an expression (${matrix}); cannot expand locally`);
    return [{}];
  }
  const m = matrix as Record<string, unknown>;
  const keys = Object.keys(m).filter((k) => k !== "include" && k !== "exclude");
  let combos: MatrixCombo[] = [{}];
  for (const k of keys) {
    const vals = m[k];
    if (!Array.isArray(vals)) {
      warnings.push(`matrix.${k} is not a list (${JSON.stringify(vals)}); skipped`);
      continue;
    }
    const next: MatrixCombo[] = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [k]: v });
    combos = next;
  }
  if (keys.length === 0) combos = [];

  const excludes = Array.isArray(m.exclude) ? (m.exclude as MatrixCombo[]) : [];
  combos = combos.filter((c) => !excludes.some((ex) => Object.entries(ex).every(([k, v]) => deepEq(c[k], v))));

  const includes = Array.isArray(m.include) ? (m.include as MatrixCombo[]) : [];
  const original = combos.map((c) => ({ ...c }));
  for (const inc of includes) {
    let matched = false;
    combos.forEach((c, i) => {
      // An include extends a combo when it doesn't overwrite any of the combo's original values.
      const orig = original[i];
      if (!orig) return;
      const ok = Object.entries(inc).every(([k, v]) => !(k in orig) || deepEq(orig[k], v));
      if (ok) {
        Object.assign(c, inc);
        matched = true;
      }
    });
    if (!matched) combos.push({ ...inc });
  }
  return combos.length ? combos : [{}];
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- expressions ----------

const EXPR = /\$\{\{\s*([^}]+?)\s*\}\}/g;

/** Substitute `${{ matrix.x }}` (and literal-only expressions); returns unresolved expressions. */
export function substitute(s: string, matrix: MatrixCombo): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const value = s.replace(EXPR, (whole, expr: string) => {
    const m = /^matrix\.([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)$/.exec(expr.trim());
    if (m) {
      let v: unknown = matrix[m[1]];
      for (const p of m[2].split(".").filter(Boolean)) v = (v as Record<string, unknown> | undefined)?.[p];
      if (v !== undefined) return typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    unresolved.push(whole);
    return whole;
  });
  return { value, unresolved };
}

function runsOnLabels(runsOn: unknown, matrix: MatrixCombo, warnings: string[]): string[] {
  const resolve = (x: unknown): string[] => {
    if (typeof x === "string") {
      const { value, unresolved } = substitute(x, matrix);
      if (unresolved.length) warnings.push(`runs-on has unresolved expression ${unresolved.join(", ")}`);
      // An expression may itself produce a JSON array.
      if (value.startsWith("[")) {
        try {
          return (JSON.parse(value) as unknown[]).map(String);
        } catch {
          /* fall through */
        }
      }
      return [value];
    }
    if (Array.isArray(x)) return x.flatMap(resolve);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (o.labels) return resolve(o.labels);
      if (o.group) warnings.push(`runs-on group "${String(o.group)}" not supported locally`);
    }
    return [];
  };
  return resolve(runsOn);
}

/** Pick where a leg runs. Linux legs run through act on the host; others go to the first guest whose labels match. */
export function pickTarget(labels: string[], cfg: Config): { target?: string; os?: string } {
  const guests = Object.values(cfg.guests);
  const pick = (pred: (g: GuestConfig) => boolean) => guests.find(pred);
  for (const l of labels) {
    if (l === "self-hosted") continue;
    const g = pick((g) => labelMatches(l, g));
    if (g) return g.os === "linux" && g.backend === "container" ? { target: "host", os: "linux" } : { target: g.name, os: g.os };
  }
  return {};
}

// ---------- MSVC ----------

/**
 * Actions that set up a toolchain which links with MSVC on Windows (Rust's default *-pc-windows-msvc targets,
 * C/C++). An entry ending in "/" covers every action of that owner (actions-rs/toolchain, /cargo, /clippy-check, …).
 */
const MSVC_ACTIONS = [
  "dtolnay/rust-toolchain",
  "actions-rust-lang/setup-rust-toolchain",
  "actions-rs/",
  "ilammy/msvc-dev-cmd",
  "microsoft/setup-msbuild",
];
const MSVC_COMMANDS = new Set(["rustup", "cargo"]);
/** Words that run the command after them: sudo cargo, time cargo, env RUSTFLAGS=… cargo, PowerShell's & cargo. */
const COMMAND_WRAPPERS = new Set(["sudo", "time", "env", "command", "exec", "nohup", "&", "call"]);

/**
 * The commands a run: script executes: the first word of each line and of each part after &&, ||, ;, | or (,
 * past wrappers, their flags and VAR=value assignments. Lower-cased, without directory and .exe (Windows
 * looks commands up case-insensitively). Arguments such as `echo cargo` or `npm run cargo` are not commands.
 */
export function runCommands(script: string): string[] {
  const out: string[] = [];
  for (const part of script.split(/\r?\n|&&|\|\||[;|(]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && (COMMAND_WRAPPERS.has(words[i].toLowerCase()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || (i > 0 && words[i].startsWith("-")))) i++;
    const w = words[i];
    if (!w || w.startsWith("#")) continue;
    const name = w.replace(/^["']|["']$/g, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
    if (name) out.push(name);
  }
  return out;
}

/**
 * The entry of `actions` that a step's `uses:` names, ignoring case and the ref; for an "owner/" entry,
 * the action itself (actions-rs/clippy-check).
 */
function matchAction(uses: string, actions: string[]): string | undefined {
  const action = uses.split("@")[0].toLowerCase();
  const hit = actions.find((a) => (a.endsWith("/") ? action.startsWith(a) : action === a || action.startsWith(`${a}/`)));
  return hit && (hit.endsWith("/") ? action : hit);
}

/** The steps of a job that need the MSVC Build Tools on Windows, e.g. ["dtolnay/rust-toolchain", "run: cargo"]. */
export function msvcUses(job: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const steps = Array.isArray(job.steps) ? (job.steps as Record<string, unknown>[]) : [];
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const action = typeof s.uses === "string" ? matchAction(s.uses, MSVC_ACTIONS) : undefined;
    if (action) found.add(action);
    if (typeof s.run === "string") {
      for (const c of runCommands(s.run)) if (MSVC_COMMANDS.has(c)) found.add(`run: ${c}`);
    }
  }
  return [...found];
}

/** Why a Windows leg will fail without the MSVC Build Tools, and how to install them. */
export function msvcHint(guest: Pick<GuestConfig, "name" | "msvc">, uses: string[], why: string): string {
  const fix =
    guest.msvc === false
      ? `remove msvc = false from [guests.${guest.name}] in config.toml, then run \`osmatrix provision ${guest.name}\``
      : `run \`osmatrix provision ${guest.name}\``;
  return (
    `this Windows leg uses ${uses.join(", ")}, which needs the MSVC C++ Build Tools and Windows SDK (as on windows-latest), but ${why}. ` +
    `Rust and C/C++ builds fail without them, typically with "link: extra operand" from the coreutils link.exe of Git for Windows. ` +
    `To install them (several GB, ~10-20 min), ${fix}, then \`osmatrix snapshot ${guest.name}\` (MCP: env_snapshot) to keep them in the golden snapshot`
  );
}

// ---------- Rust on Linux legs ----------

/** Rust setup actions (an entry ending in "/" covers every action of that owner, as in MSVC_ACTIONS). */
const RUST_ACTIONS = ["dtolnay/rust-toolchain", "actions-rust-lang/setup-rust-toolchain", "actions-rs/"];
const RUST_COMMANDS = new Set(["rustup", "cargo", "rustc"]);

/**
 * Why a job looks like it relies on the Rust toolchain GitHub's ubuntu images preinstall (undefined when
 * it doesn't): a Rust setup action, rustup/cargo/rustc run by a run: step (see runCommands), or the
 * repo's toolchain file.
 */
export function rustUse(job: Record<string, unknown>, toolchainFile?: string): string | undefined {
  const steps = Array.isArray(job.steps) ? (job.steps as Record<string, unknown>[]) : [];
  for (const s of steps) {
    const action = typeof s?.uses === "string" ? matchAction(s.uses, RUST_ACTIONS) : undefined;
    if (action) return `the job uses ${action}`;
  }
  for (const s of steps) {
    const cmd = typeof s?.run === "string" ? runCommands(s.run).find((c) => RUST_COMMANDS.has(c)) : undefined;
    if (cmd) return `the job runs ${cmd}`;
  }
  return toolchainFile ? `the repo has ${toolchainFile}` : undefined;
}

/**
 * dockur macOS guests are Intel, where Homebrew is pinned to the last homebrew-core with Intel bottles
 * (or not installed by provisioning with `homebrew = false`). Tell the agent before a `brew` step behaves differently than on GitHub.
 */
export function brewWarnings(job: Record<string, unknown>, g: GuestConfig): string[] {
  if (g.os !== "macos" || g.backend !== "dockur" || !Array.isArray(job.steps)) return [];
  const brew = (job.steps as Record<string, unknown>[])
    // Steps guarded to another OS don't run here. Only a condition that is nothing but `runner.os == 'Linux'`
    // (or Windows) counts: `runner.os == 'Linux' || runner.os == 'macOS'` still runs on macOS.
    .filter((s) => s && typeof s.run === "string" && !/^\s*(\$\{\{\s*)?runner\.os\s*==\s*['"](Linux|Windows)['"]\s*(\}\}\s*)?$/.test(String(s.if ?? "")))
    .map((s) => s.run)
    .join("\n");
  // brew run as a command (see runCommands), not mentioned in an echo or a comment.
  if (!runCommands(brew).includes("brew")) return [];
  let pins;
  try {
    pins = guestHomebrew(g);
  } catch (e) {
    return [(e as Error).message];
  }
  if (!pins) {
    return [
      `steps run brew, but guest ${g.name} has homebrew = false: provisioning skips Homebrew there but doesn't remove one installed earlier, so brew may be missing`,
    ];
  }
  const w: string[] = [];
  if (/\bbrew\s+(install|reinstall|bundle)\b/.test(brew)) {
    w.push(
      `steps run brew install: guest ${g.name} is Intel macOS, where Homebrew ${pins.brew} is pinned to homebrew-core ${pins.core.slice(0, 12)} (the last with Intel bottles). Formulae install at those versions, older than on GitHub's runners; a formula without an Intel bottle there builds from source`,
    );
  }
  if (/\bbrew\s+(update|upgrade)\b/.test(brew)) {
    w.push(
      `steps run brew update/upgrade: on Intel guest ${g.name} that moves Homebrew off its pins to formulae without Intel bottles (builds from source); \`osmatrix reset ${g.name}\` restores the pinned state`,
    );
  }
  return w;
}

// ---------- workflows ----------

export function listWorkflows(repo: string): string[] {
  const dir = path.join(repo, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => path.posix.join(".github/workflows", f));
}

function legId(job: string, matrix: MatrixCombo): string {
  const parts = Object.values(matrix)
    .filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v))
    .map((v) => String(v));
  return [job, ...parts].join("-").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

export function plan(repo: string, cfg: Config, filter: PlanFilter = {}): Plan {
  const warnings: string[] = [];
  let workflows = listWorkflows(repo);
  if (filter.workflow) {
    const w = filter.workflow.replace(/\\/g, "/");
    workflows = workflows.filter((f) => f === w || path.posix.basename(f) === w || path.posix.basename(f).replace(/\.ya?ml$/, "") === w);
    if (!workflows.length) throw new Error(`workflow "${filter.workflow}" not found under .github/workflows`);
  }
  if (!workflows.length) warnings.push(`no workflows found in ${repo}/.github/workflows`);
  const toolchainFile = ["rust-toolchain.toml", "rust-toolchain"].find((f) => fs.existsSync(path.join(repo, f)));

  const only = filter.only?.map((s) => s.toLowerCase());
  const onlyMatches = (l: Leg) => {
    const keys = [l.target, l.targetOs, l.target === "host" ? "linux" : undefined].filter(Boolean) as string[];
    return keys.some((k) => only!.includes(k.toLowerCase()));
  };
  const legs: Leg[] = [];
  const seen = new Set<string>();
  for (const wf of workflows) {
    let doc: Record<string, unknown>;
    try {
      doc = YAML.parse(fs.readFileSync(path.join(repo, wf), "utf8")) ?? {};
    } catch (e) {
      warnings.push(`${wf}: YAML error: ${(e as Error).message}`);
      continue;
    }
    const jobs = (doc.jobs ?? {}) as Record<string, Record<string, unknown>>;
    // Every leg of the workflow: legs the filter doesn't select still run when a selected leg needs their job.
    const wfLegs: Leg[] = [];
    const selected = new Set<Leg>();
    for (const [jobId, job] of Object.entries(jobs)) {
      const jw: string[] = [];
      const strategy = (job.strategy ?? {}) as Record<string, unknown>;
      const combos = expandMatrix(strategy.matrix, jw);
      for (const combo of combos) {
        // A matrix filter selects legs whose combination has every key. Like act's --matrix, it leaves the
        // legs of a needed job that lacks a key alone: they all run.
        const matrixKeys = Object.entries(filter.matrix ?? {});
        if (!matrixKeys.every(([k, v]) => !(k in combo) || String(combo[k]) === v)) continue;
        const lw = [...jw];
        let labels: string[] = [];
        let skip: string | undefined;
        if (typeof job.uses === "string") {
          // Reusable workflow call: act expands it; treat as a Linux leg.
          labels = ["ubuntu-latest"];
          lw.push(`reusable workflow ${job.uses}: runs-on is resolved inside the callee; scheduled as a Linux leg`);
          if (!job.uses.startsWith("./")) skip = "remote reusable workflows are not supported by act";
        } else {
          labels = runsOnLabels(job["runs-on"], combo, lw);
        }
        const { target, os } = pickTarget(labels, cfg);
        if (!target && !skip) skip = `no configured guest serves runs-on ${JSON.stringify(labels)}`;
        if (job.services && os && os !== "linux") lw.push("job services: are only supported on Linux legs");
        if (target && cfg.guests[target]) lw.push(...brewWarnings(job, cfg.guests[target]));
        if (job.permissions && JSON.stringify(job.permissions).includes("id-token")) lw.push("OIDC (id-token) is not available locally");
        if (target === "host" && cfg.act_linux_image !== DEFAULT_LINUX_IMAGE) {
          const why = rustUse(job, toolchainFile);
          if (why) {
            lw.push(
              `${why}, and act_linux_image is set to ${cfg.act_linux_image}: GitHub's ubuntu runners preinstall rustup stable with rustfmt and clippy, which this image may lack. Rust setup failures here may be an image difference`,
            );
          }
        }
        // Needed jobs are added below, once the needs are known.
        const msvc = os === "windows" ? msvcUses(job) : [];
        let id = legId(jobId, combo);
        if (workflows.length > 1) id = `${path.posix.basename(wf).replace(/\.ya?ml$/, "")}.${id}`;
        while (seen.has(id)) id += "_";
        seen.add(id);
        const leg: Leg = {
          id,
          workflow: wf,
          workflowName: typeof doc.name === "string" ? doc.name : undefined,
          job: jobId,
          jobName: typeof job.name === "string" ? job.name : undefined,
          matrix: combo,
          runsOn: labels,
          target,
          targetOs: os,
          skip,
          ...(msvc.length ? { msvcUses: msvc } : {}),
          warnings: lw,
          needsLabels: [],
          needs: [],
        };
        wfLegs.push(leg);
        if ((!filter.job || filter.job === jobId) && matrixKeys.every(([k]) => k in combo) && (!only || onlyMatches(leg))) selected.add(leg);
      }
    }
    const labelsOf = (jobId: string): string[] => {
      const job = jobs[jobId] ?? {};
      if (typeof job.uses === "string") return ["ubuntu-latest"];
      const combos = expandMatrix(((job.strategy ?? {}) as Record<string, unknown>).matrix, []);
      return combos.flatMap((c) => runsOnLabels(job["runs-on"], c, []));
    };
    const needsOf = (jobId: string): string[] => {
      const n = jobs[jobId]?.needs;
      // A copy: callers mutate the result (the traversals below pop from it).
      return typeof n === "string" ? [n] : Array.isArray(n) ? [...(n as string[])] : [];
    };
    // OS families a job targets, from its labels; independent of the job filter, so needs are classified too.
    const osOf = (jobId: string): Set<string> =>
      new Set(labelsOf(jobId).flatMap((l) => pickTarget([l], cfg).os ?? (/^ubuntu-/.test(l) ? "linux" : [])));
    // A needed job with legs that can run here runs as those legs, each once, on its own target; the legs
    // that need it wait for them and get its results replayed.
    const ownLegs = (jobId: string) => wfLegs.filter((l) => l.job === jobId && !l.skip);
    for (const leg of wfLegs) {
      const seenJobs = new Set<string>();
      const stack = needsOf(leg.job);
      while (stack.length) {
        const j = stack.pop()!;
        if (seenJobs.has(j)) continue;
        seenJobs.add(j);
        stack.push(...needsOf(j));
      }
      leg.needs = needsOf(leg.job);
      leg.needsAll = [...seenJobs].sort();
      if (seenJobs.has(leg.job)) {
        // GitHub rejects such a workflow; waiting for its own needs would never end.
        leg.skip ??= `its needs form a cycle through ${leg.job}`;
        continue;
      }
      // act runs the needs that can't run as their own legs inside this leg (as act -j does), and so
      // their needs too, down to the ones that are replayed.
      const replay = new Set<string>();
      const inline = new Set<string>();
      const walk = needsOf(leg.job);
      while (walk.length) {
        const j = walk.pop()!;
        if (replay.has(j) || inline.has(j)) continue;
        if (ownLegs(j).length) replay.add(j);
        else {
          inline.add(j);
          walk.push(...needsOf(j));
        }
      }
      leg.replayNeeds = [...replay].sort();
      leg.inlineNeeds = [...inline].sort();
      leg.waitsFor = wfLegs.filter((l) => replay.has(l.job) && !l.skip).map((l) => l.id);
      leg.needsLabels = [...new Set(leg.inlineNeeds.flatMap(labelsOf))].filter((l) => !l.includes("${{"));
      for (const n of leg.replayNeeds) {
        for (const l of wfLegs.filter((l) => l.job === n && l.skip)) {
          leg.warnings.push(`needs "${n}": its leg ${l.id} can't run here (${l.skip}), so needs.${n} lacks that leg's result`);
        }
      }
      if (leg.targetOs === "windows") {
        // Needs that act runs inside this Windows guest (inlineNeeds) need MSVC there as well for their
        // Rust/C++ steps; replayed needs run on their own legs.
        const uses = new Set(leg.msvcUses ?? []);
        for (const n of leg.inlineNeeds) for (const u of msvcUses(jobs[n] ?? {})) uses.add(`${u} (needs: ${n})`);
        if (uses.size) leg.msvcUses = [...uses];
        // Whether the guest really has the tools is checked when the leg runs (over ssh); an opt-out is known now.
        const guest = leg.target ? cfg.guests[leg.target] : undefined;
        if (leg.msvcUses?.length && guest && !guestMsvc(guest)) {
          leg.warnings.push(msvcHint(guest, leg.msvcUses, `guest ${guest.name} is set up without them (msvc = false)`));
        }
      }
      if (!leg.targetOs) continue;
      const crossOs = (n: string) => [...osOf(n)].some((o) => o !== leg.targetOs);
      // Only jobs that target Linux alone: a job-wide shell default would also change a mixed-OS job's other legs.
      const linuxOnly = (n: string) => [...osOf(n)].every((o) => o === "linux");
      if (leg.targetOs !== "linux") leg.linuxNeeds = leg.inlineNeeds.filter((n) => crossOs(n) && linuxOnly(n));
      for (const n of leg.replayNeeds.filter(crossOs)) {
        const oses = [...osOf(n)].sort().join("/");
        leg.warnings.push(
          `needs "${n}" runs on ${oses}; it runs once, as its own leg${ownLegs(n).length > 1 ? "s" : ""}, and osmatrix replays its result, outputs and artifacts into this leg, as GitHub hands them over from another runner`,
        );
      }
      for (const n of leg.inlineNeeds) {
        const why = wfLegs.find((l) => l.job === n)?.skip;
        const because = why ? ` (${why})` : "";
        if (leg.targetOs === "windows" && osOf(n).has("linux") && !linuxOnly(n)) {
          leg.warnings.push(
            `needs "${n}" can't run as its own legs${because}; act runs all of its matrix legs inside this Windows leg, where its run: steps without a shell: use pwsh, so its Linux legs will likely fail`,
          );
        } else if (leg.linuxNeeds?.includes(n) && leg.targetOs === "windows") {
          leg.warnings.push(
            `needs "${n}" targets Linux but can't run as its own leg${because}; act runs it inside this Windows leg. osmatrix runs its run: steps without a shell: under Git Bash, as GitHub would use bash, but Linux-only tools (apt-get, docker, …) fail there and outputs/artifacts may differ`,
          );
        } else {
          leg.warnings.push(`needs "${n}" can't run as its own leg${because}; act runs it inside this leg's environment${crossOs(n) ? " (outputs/artifacts may differ)" : ""}`);
        }
      }
    }
    // The selected legs and, transitively, the legs they wait for.
    const byId = new Map(wfLegs.map((l) => [l.id, l]));
    const include = new Set(selected);
    const queue = [...selected];
    while (queue.length) {
      const l = queue.pop()!;
      if (l.skip) continue;
      for (const id of l.waitsFor ?? []) {
        const n = byId.get(id)!;
        if (include.has(n)) continue;
        include.add(n);
        n.neededOnly = true;
        queue.push(n);
      }
    }
    for (const l of include) {
      if (l.skip) continue;
      for (const id of l.waitsFor ?? []) (byId.get(id)!.neededBy ??= []).push(l.id);
    }
    legs.push(...wfLegs.filter((l) => include.has(l)));
  }
  return { repo, legs, warnings };
}

/**
 * Give `jobs` a `defaults.run.shell` of `shell`, so their run: steps without a shell: don't fall back to
 * act's host default (pwsh on Windows). Jobs that already set one, reusable workflow calls, and every job
 * when the workflow sets a default are left alone. Returns the jobs changed.
 *
 * The edit inserts lines rather than re-serialising the document, so the rest of the workflow (layout,
 * comments, quoting) stays as written. Jobs written in flow style ({ ... }) fall back to re-serialising.
 */
export function setDefaultRunShell(text: string, jobs: string[], shell: string): { text: string; changed: string[] } {
  const doc = YAML.parseDocument(text);
  if (doc.getIn(["defaults", "run", "shell"]) !== undefined) return { text, changed: [] };
  const changed: string[] = [];
  const inserts: { at: number; text: string }[] = [];
  let reserialise = false;
  for (const j of jobs) {
    const job = doc.getIn(["jobs", j]);
    if (!YAML.isMap(job) || job.has("uses") || doc.getIn(["jobs", j, "defaults", "run", "shell"]) !== undefined) continue;
    changed.push(j);
    // The deepest map along jobs.<j>.defaults.run that exists; the missing keys go in at its top.
    const missing = ["defaults", "run", "shell"];
    let map: YAML.YAMLMap = job;
    for (let next = map.get(missing[0], true); missing.length > 1 && YAML.isMap(next); next = map.get(missing[0], true)) {
      map = next;
      missing.shift();
    }
    const ins = map.has(missing[0]) ? undefined : blockInsert(text, map, missing, shell);
    if (ins) inserts.push(ins);
    else reserialise = true;
    doc.setIn(["jobs", j, "defaults", "run", "shell"], shell);
  }
  if (!changed.length) return { text, changed };
  if (reserialise) return { text: doc.toString({ lineWidth: 0 }), changed };
  for (const ins of inserts.sort((a, b) => b.at - a.at)) text = text.slice(0, ins.at) + ins.text + text.slice(ins.at);
  return { text, changed };
}

/** Lines adding `keys` (nested; the last one set to `value`) at the top of a block map; undefined when it isn't one. */
function blockInsert(text: string, map: YAML.YAMLMap, keys: string[], value: string): { at: number; text: string } | undefined {
  const first = map.items[0]?.key;
  if (map.flow || !YAML.isNode(first) || !first.range) return undefined;
  const at = text.lastIndexOf("\n", first.range[0] - 1) + 1;
  const indent = text.slice(at, first.range[0]);
  if (!/^ *$/.test(indent)) return undefined; // the key shares its line with something else, such as "- "
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const last = keys.length - 1;
  const lines = keys.map((k, i) => `${indent}${"  ".repeat(i)}${k}:${i === last ? ` ${YAML.stringify(value, { lineWidth: 0 }).trimEnd()}` : ""}`);
  return { at, text: lines.join(eol) + eol };
}
