import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { labelMatches, type Config, type GuestConfig } from "../core/config.ts";

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
  /** runs-on labels of jobs this leg transitively needs (act runs them in the same environment). */
  needsLabels: string[];
  /** Jobs this leg's job directly needs. */
  needs: string[];
  /** Every job this leg's job transitively needs (act -j runs them all). */
  needsAll?: string[];
  /**
   * Needed jobs (transitively) that target Linux, when this leg doesn't, and that can't be replayed (see
   * replayNeeds): act runs them in this leg's OS.
   */
  linuxNeeds?: string[];
  /**
   * Needed jobs (transitively) that target Linux, when this leg doesn't, and whose own needs do too:
   * osmatrix runs them once on the host and replays their outputs and artifacts into this leg.
   */
  replayNeeds?: string[];
  /** "host" = act on the host docker (Linux legs); otherwise a guest name. */
  target?: string;
  targetOs?: string;
  skip?: string;
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
    const wfLegs: Leg[] = [];
    for (const [jobId, job] of Object.entries(jobs)) {
      if (filter.job && filter.job !== jobId) continue;
      const jw: string[] = [];
      const strategy = (job.strategy ?? {}) as Record<string, unknown>;
      const combos = expandMatrix(strategy.matrix, jw);
      for (const combo of combos) {
        if (filter.matrix && !Object.entries(filter.matrix).every(([k, v]) => String(combo[k]) === v)) continue;
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
        if (job.permissions && JSON.stringify(job.permissions).includes("id-token")) lw.push("OIDC (id-token) is not available locally");
        let id = legId(jobId, combo);
        if (workflows.length > 1) id = `${path.posix.basename(wf).replace(/\.ya?ml$/, "")}.${id}`;
        while (seen.has(id)) id += "_";
        seen.add(id);
        wfLegs.push({
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
          warnings: lw,
          needsLabels: [],
          needs: [],
        });
      }
    }
    // Labels of every job in a leg's transitive needs: act -j runs those jobs too, in the same environment.
    const labelsOf = (jobId: string): string[] => {
      const job = jobs[jobId] ?? {};
      if (typeof job.uses === "string") return ["ubuntu-latest"];
      const combos = expandMatrix(((job.strategy ?? {}) as Record<string, unknown>).matrix, []);
      return combos.flatMap((c) => runsOnLabels(job["runs-on"], c, []));
    };
    const needsOf = (jobId: string): string[] => {
      const n = jobs[jobId]?.needs;
      // A copy: callers mutate the result (the traversal below pops from it).
      return typeof n === "string" ? [n] : Array.isArray(n) ? [...(n as string[])] : [];
    };
    // OS families a job targets, from its labels; independent of the job filter, so needs are classified too.
    const osOf = (jobId: string): Set<string> =>
      new Set(labelsOf(jobId).flatMap((l) => pickTarget([l], cfg).os ?? (/^ubuntu-/.test(l) ? "linux" : [])));
    for (const leg of wfLegs) {
      const seenJobs = new Set<string>();
      const stack = needsOf(leg.job);
      while (stack.length) {
        const j = stack.pop()!;
        if (seenJobs.has(j)) continue;
        seenJobs.add(j);
        stack.push(...needsOf(j));
      }
      leg.needsLabels = [...new Set([...seenJobs].flatMap(labelsOf))].filter((l) => !l.includes("${{"));
      leg.needs = needsOf(leg.job);
      leg.needsAll = [...seenJobs].sort();
      // needs: across OS boundaries can't be honored when legs run in separate environments.
      if (!leg.targetOs) continue;
      const crossOs = leg.needsAll.filter((n) => [...osOf(n)].some((o) => o !== leg.targetOs));
      // Only jobs that target Linux alone: a job-wide shell default would also change a mixed-OS job's other legs.
      const linuxOnly = (n: string) => [...osOf(n)].every((o) => o === "linux");
      if (leg.targetOs !== "linux") {
        // Linux jobs whose own needs are all on Linux too run once on the host, as on GitHub, and are
        // replayed into this leg. Reusable workflow calls keep running inside the leg.
        const memo = new Map<string, boolean>();
        const replayable = (n: string): boolean => {
          if (!memo.has(n)) {
            memo.set(n, true); // a needs cycle is invalid anyway; don't recurse forever
            memo.set(n, osOf(n).size > 0 && linuxOnly(n) && typeof jobs[n]?.uses !== "string" && needsOf(n).every(replayable));
          }
          return memo.get(n)!;
        };
        leg.replayNeeds = crossOs.filter(replayable);
        leg.linuxNeeds = crossOs.filter((n) => linuxOnly(n) && !leg.replayNeeds!.includes(n));
      }
      for (const n of crossOs) {
        if (leg.replayNeeds?.includes(n)) {
          leg.warnings.push(
            `needs "${n}" targets Linux; osmatrix runs it once on the host (act on Docker) and replays its outputs and artifacts into this leg, as GitHub would hand them over from a Linux runner`,
          );
        } else if (leg.targetOs === "windows" && osOf(n).has("linux") && !linuxOnly(n)) {
          leg.warnings.push(
            `needs "${n}" runs on Linux and other OSes; act runs all of its matrix legs inside this Windows leg, where its run: steps without a shell: use pwsh, so its Linux legs will likely fail. Check it on its own legs instead`,
          );
        } else if (leg.targetOs === "windows" && leg.linuxNeeds?.includes(n)) {
          leg.warnings.push(
            `needs "${n}" targets Linux; act runs it inside this Windows leg. osmatrix runs its run: steps without a shell: under Git Bash, as GitHub would use bash, but Linux-only tools (apt-get, docker, …) fail there and outputs/artifacts may differ`,
          );
        } else {
          leg.warnings.push(`needs "${n}" runs on another OS; act will run it inside this leg's environment (outputs/artifacts may differ)`);
        }
      }
    }
    legs.push(...wfLegs);
  }

  const only = filter.only?.map((s) => s.toLowerCase());
  const filtered = only
    ? legs.filter((l) => {
        const keys = [l.target, l.targetOs, l.target === "host" ? "linux" : undefined].filter(Boolean) as string[];
        return keys.some((k) => only.includes(k.toLowerCase()));
      })
    : legs;

  // act -j <job> also runs the job's needs. When every needed job already runs as its own leg in
  // this run (typical for gate / fan-in jobs such as "CI Gate"), running the dependent job would
  // repeat all of them, on the wrong OS for Windows/macOS legs. Skip it unless asked for by name.
  if (!filter.job) {
    for (const leg of filtered) {
      if (leg.skip || !leg.needs.length) continue;
      const covered = leg.needs.every((n) => filtered.some((o) => o !== leg && o.workflow === leg.workflow && o.job === n && !o.skip));
      if (covered) {
        leg.skip = `its needs (${leg.needs.join(", ")}) already run as legs here; act would repeat them. Run it alone with --job ${leg.job}`;
      }
    }
  }
  return { repo, legs: filtered, warnings };
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
