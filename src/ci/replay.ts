/**
 * Replaying needs. On GitHub every job of a run runs once, on its own runner, and the jobs that need it
 * get its result, outputs and artifacts. `act -j <job>` would run the needed jobs again inside every
 * dependent leg (and on the dependent's OS), so osmatrix runs each needed job once, as its own leg, and
 * hands its results to the legs that need it:
 *
 * 1. A leg whose job others need runs through a derived workflow with a collector job that `needs:` it
 *    with `if: always()` and prints `toJSON(needs)` (its result and outputs, as act evaluated them). act
 *    has no log event for job outputs (its --json log carries step and job results only), so reading them
 *    through the `needs` context, act's own expression evaluation, is the reliable way to get them.
 * 2. A dependent leg's derived workflow has each needed job as a stub with the same id and `outputs:`
 *    keys on the leg's own runner, whose one step writes the recorded values to $GITHUB_OUTPUT.
 * 3. Artifacts: every act run of a workflow in an osmatrix run uses the same GITHUB_RUN_ID and an artifact
 *    store (--artifact-server-path) holding what the legs before it uploaded, so download-artifact finds
 *    them as on GitHub. Host legs share one store directory; a VM leg gets a copy and its uploads are
 *    merged back (see mergeArtifacts).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";

/** What a needed job left for its dependents, as the `needs` context has it. */
export interface NeededJob {
  result: string;
  outputs: Record<string, string>;
}

const NEEDS_MARKER = "osmatrix-needs:";

function jobsOf(doc: YAML.Document): YAML.YAMLMap {
  const jobs = doc.get("jobs", true);
  if (!YAML.isMap(jobs)) throw new Error("workflow has no jobs: map");
  return jobs;
}

/** `base`, or `base-2`, `base-3`, … when the workflow already has a job by that id. */
function freeJobId(jobs: YAML.YAMLMap, base: string): string {
  let id = base;
  for (let i = 2; jobs.has(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * The workflow plus a job that needs `job` and prints its result and outputs as one base64 line
 * (single-line whatever the values hold). It runs on `runsOn`, the leg's own runner, as a Node.js script:
 * act needs Node wherever it runs JavaScript actions, and one script works on every OS. Returns the text
 * and the collector's job id.
 */
export function collectorWorkflow(text: string, job: string, runsOn: string[]): { text: string; job: string } {
  const doc = YAML.parseDocument(text);
  const id = freeJobId(jobsOf(doc), "osmatrix-record");
  doc.setIn(
    ["jobs", id],
    doc.createNode({
      name: "osmatrix: record the result for legs that need it",
      needs: [job],
      if: "${{ always() }}",
      "runs-on": runsOn,
      steps: [
        {
          name: "Record result and outputs",
          shell: 'node "{0}"',
          env: { OSMATRIX_NEEDS: "${{ toJSON(needs) }}" },
          run: `console.log(${JSON.stringify(NEEDS_MARKER)} + Buffer.from(process.env.OSMATRIX_NEEDS || "", "utf8").toString("base64"));\n`,
        },
      ],
    }),
  );
  return { text: doc.toString({ lineWidth: 0 }), job: id };
}

/**
 * The collector's record in a log line, if the line has one. Outputs of skipped jobs are dropped (act
 * leaves them unevaluated; GitHub gives empty values). Failed and cancelled jobs keep theirs: GitHub
 * evaluates job outputs when a job ends, whatever its result.
 */
export function parseNeedsRecord(line: string): Record<string, NeededJob> | undefined {
  const i = line.indexOf(NEEDS_MARKER);
  if (i < 0) return undefined;
  const b64 = /^[A-Za-z0-9+/=]+/.exec(line.slice(i + NEEDS_MARKER.length))?.[0];
  if (!b64) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, NeededJob> = {};
  for (const [job, v] of Object.entries(raw as Record<string, { result?: unknown; outputs?: unknown }>)) {
    const result = typeof v?.result === "string" && v.result ? v.result : "success";
    const outputs: Record<string, string> = {};
    if (result !== "skipped" && v?.outputs && typeof v.outputs === "object") {
      for (const [k, o] of Object.entries(v.outputs as Record<string, unknown>)) outputs[k] = o == null ? "" : String(o);
    }
    out[job] = { result, outputs };
  }
  return out;
}

/**
 * A needed job as its dependents see it, from the records of its legs in the order they finished. As on
 * GitHub: it failed if any leg failed, was cancelled if any was (and none failed), was skipped if every
 * leg was, and succeeded otherwise; for a matrix job each output is the last non-empty value a leg set.
 */
export function combineLegs(records: NeededJob[]): NeededJob {
  const results = records.map((r) => r.result);
  const result = results.includes("failure")
    ? "failure"
    : results.includes("cancelled")
      ? "cancelled"
      : results.length && results.every((r) => r === "skipped")
        ? "skipped"
        : "success";
  const outputs: Record<string, string> = {};
  for (const r of records) for (const [k, v] of Object.entries(r.outputs)) if (v !== "" || !(k in outputs)) outputs[k] = v;
  return { result, outputs };
}

/**
 * Outputs in $GITHUB_OUTPUT's file format. Values with line breaks use the heredoc form with a delimiter
 * that doesn't occur in the value.
 */
export function githubOutputFile(outputs: Record<string, string>, delimiter = () => `ghadelimiter_${crypto.randomUUID()}`): string {
  let s = "";
  for (const [k, v] of Object.entries(outputs)) {
    if (!/[\r\n]/.test(v)) {
      s += `${k}=${v}\n`;
      continue;
    }
    let d = delimiter();
    while (v.split(/\r?\n/).includes(d)) d = delimiter();
    s += `${k}<<${d}\n${v}\n${d}\n`;
  }
  return s;
}

export interface StubOptions {
  /** Replayed jobs (by id), what their legs left, and those legs' ids (named when a stub fails). */
  needs: Record<string, NeededJob & { legs?: string[] }>;
  /** The leg's own runs-on labels: stubs run where the leg runs. */
  runsOn: string[];
}

/**
 * The workflow with each replayed job replaced by a stub that has the same id and `outputs:` keys, runs
 * on the leg's runner and replays the recorded values. A skipped job gets a stub with `if: false`, so
 * its dependents are skipped as on GitHub; one that failed gets a stub that replays its outputs and then
 * fails, so act runs only the dependents whose if: allows it. Stubs have no needs: what the replayed jobs
 * needed has run already, in its own legs.
 *
 * The replay step is a Node.js script (see collectorWorkflow). The outputs travel base64-encoded, so no
 * value can break the script or be read as an expression.
 */
export function replayStubWorkflow(text: string, o: StubOptions): string {
  const doc = YAML.parseDocument(text);
  const jobs = jobsOf(doc);
  for (const [id, needed] of Object.entries(o.needs)) {
    const orig = jobs.get(id);
    const name = YAML.isMap(orig) ? orig.get("name") : undefined;
    const declared = YAML.isMap(orig) ? orig.get("outputs") : undefined;
    const keys = new Set([...(YAML.isMap(declared) ? declared.items.map((p) => String(YAML.isScalar(p.key) ? p.key.value : p.key)) : []), ...Object.keys(needed.outputs)]);
    const failed = needed.result !== "success" && needed.result !== "skipped";
    const values = Object.fromEntries([...keys].map((k) => [k, needed.outputs[k] ?? ""]));
    const b64 = Buffer.from(githubOutputFile(values), "utf8").toString("base64");
    const ended = needed.result === "failure" ? "failed" : `ended as ${needed.result}`;
    const where = needed.legs?.length ? `its leg${needed.legs.length > 1 ? "s" : ""} ${needed.legs.join(", ")}` : "its own leg";
    // A job that failed (or was cancelled) fails here too, after replaying the outputs it set: GitHub
    // evaluates job outputs when a job ends, whatever its result. act then runs only the dependents whose
    // if: allows it (always(), failure(), …).
    let script = `require("fs").appendFileSync(process.env.GITHUB_OUTPUT, Buffer.from("${b64}", "base64"));\n`;
    if (failed) script += `console.error(${JSON.stringify(`${id} ${ended} in ${where} of this osmatrix run; see that log`)});\nprocess.exitCode = 1;\n`;
    const stub: Record<string, unknown> = {
      name: `${typeof name === "string" && !name.includes("${{") ? name : id} (replayed)`,
    };
    if (needed.result === "skipped") stub.if = false;
    stub["runs-on"] = o.runsOn;
    if (keys.size) stub.outputs = Object.fromEntries([...keys].map((k) => [k, `\${{ steps.replay.outputs['${k.replace(/'/g, "''")}'] }}`]));
    stub.steps = [
      {
        id: "replay",
        name: failed ? `Replay: ${id} ${ended} in ${where}` : `Replay the outputs of ${where}`,
        shell: 'node "{0}"',
        run: script,
      },
    ];
    jobs.set(id, doc.createNode(stub));
  }
  return doc.toString({ lineWidth: 0 });
}

// ---------- act's artifact store ----------

/**
 * Add the artifacts of `runId` in act's store `from` that the store `to` doesn't have yet, and return
 * their names. act keeps an artifact in `<store>/<run id>/<name>/` (upload-artifact v4 and later as one
 * `<name>.zip`, v3 as its files), so copying that directory hands it over whole. An artifact `to`
 * already has stays: a run can't have two artifacts by one name. Each one is copied next to the store
 * and then renamed into place, so an act run serving `to` never sees half of it.
 */
export function mergeArtifacts(from: string, to: string, runId: string): string[] {
  const src = path.join(from, runId);
  if (!fs.existsSync(src)) return [];
  const dest = path.join(to, runId);
  fs.mkdirSync(dest, { recursive: true });
  const added: string[] = [];
  for (const name of fs.readdirSync(src).sort()) {
    if (!fs.statSync(path.join(src, name)).isDirectory() || fs.existsSync(path.join(dest, name))) continue;
    const tmp = path.join(to, `.incoming-${crypto.randomBytes(4).toString("hex")}`);
    fs.cpSync(path.join(src, name), tmp, { recursive: true });
    try {
      fs.renameSync(tmp, path.join(dest, name));
      added.push(name);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      // Another leg added it meanwhile; first one wins.
      if (!fs.existsSync(path.join(dest, name))) throw e;
    }
  }
  return added;
}
