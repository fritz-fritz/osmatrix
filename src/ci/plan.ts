import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { labelMatches, type Config, type GuestConfig } from "../core/config.ts";

export type Scalar = string | number | boolean | null;
export type MatrixCombo = Record<string, unknown>;

export interface Leg {
  id: string;
  workflow: string; // repo-relative path
  job: string;
  jobName?: string;
  matrix: MatrixCombo;
  runsOn: string[];
  /** runs-on labels of jobs this leg transitively needs (act runs them in the same environment). */
  needsLabels: string[];
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
    const jobOs: Record<string, Set<string>> = {};
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
        if (os) (jobOs[jobId] ??= new Set()).add(os);
        let id = legId(jobId, combo);
        if (workflows.length > 1) id = `${path.posix.basename(wf).replace(/\.ya?ml$/, "")}.${id}`;
        while (seen.has(id)) id += "_";
        seen.add(id);
        wfLegs.push({
          id,
          workflow: wf,
          job: jobId,
          jobName: typeof job.name === "string" ? job.name : undefined,
          matrix: combo,
          runsOn: labels,
          target,
          targetOs: os,
          skip,
          warnings: lw,
          needsLabels: [],
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
      return typeof n === "string" ? [n] : Array.isArray(n) ? (n as string[]) : [];
    };
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
    }
    // needs: across OS boundaries can't be honored when legs run in separate environments.
    for (const leg of wfLegs) {
      const needs = jobs[leg.job]?.needs;
      const list = typeof needs === "string" ? [needs] : Array.isArray(needs) ? (needs as string[]) : [];
      for (const n of list) {
        const nos = jobOs[n] ?? new Set<string>();
        if (leg.targetOs && nos.size && [...nos].some((o) => o !== leg.targetOs)) {
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
  return { repo, legs: filtered, warnings };
}
