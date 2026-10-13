/**
 * Replaying cross-OS needs. On GitHub a windows/macos job that `needs:` a Linux job gets that job's
 * outputs and artifacts from a Linux runner. act -j would run the needed job inside the VM instead, so
 * osmatrix runs it once on the host (act on Docker, like any Linux leg), records what it produced, and
 * gives the VM leg a derived workflow in which the needed job is a stub that replays those results:
 *
 * 1. Host: the workflow plus a collector job that `needs:` the replayed jobs with `if: always()` and
 *    prints `toJSON(needs)` (result and outputs of each, as act evaluated them). act has no log event
 *    for job outputs (its --json log carries step and job results only), so reading them through the
 *    `needs` context, act's own expression evaluation, is the reliable way to get them.
 * 2. Artifacts the host run uploaded are read from act's artifact store (--artifact-server-path).
 * 3. Guest: each replayed job becomes a stub with the same id and `outputs:` keys on the leg's runner,
 *    whose one step writes the recorded values to $GITHUB_OUTPUT; a job the stubs need re-uploads the
 *    recorded artifacts under their names. Both act runs get the same GITHUB_RUN_ID.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import YAML from "yaml";

/** What a needed job left for its dependents, as the `needs` context has it. */
export interface NeededJob {
  result: string;
  outputs: Record<string, string>;
}

export interface ReplayArtifact {
  name: string;
  /** Directory holding the artifact's files (on the host, or in the guest for the stub workflow). */
  dir: string;
}

/**
 * The action that re-uploads artifacts when the workflow doesn't use one itself: a full commit SHA with
 * its version, like the actions in this repository's workflows. v4 is what stock act 0.2.89's artifact
 * server accepts (later majors need a fixed act, see the osmatrix issue about upload-artifact v7).
 */
export const UPLOAD_ARTIFACT = { ref: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", version: "v4.6.2" };

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
 * The host-side workflow: the original plus a job that needs `jobs` and prints their results and outputs
 * as one base64 line (single-line whatever the values hold). Returns the text and the collector's job id.
 */
export function collectorWorkflow(text: string, jobs: string[]): { text: string; job: string } {
  const doc = YAML.parseDocument(text);
  const id = freeJobId(jobsOf(doc), "osmatrix-replay");
  doc.setIn(
    ["jobs", id],
    doc.createNode({
      name: "osmatrix: record needed jobs",
      needs: jobs,
      if: "${{ always() }}",
      "runs-on": "ubuntu-latest",
      steps: [
        {
          name: "Record results and outputs",
          shell: "bash",
          env: { OSMATRIX_NEEDS: "${{ toJSON(needs) }}" },
          run: `echo "${NEEDS_MARKER}$(printf '%s' "$OSMATRIX_NEEDS" | base64 | tr -d '\\n')"`,
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

/**
 * The upload-artifact that the replayed jobs use (so a re-upload matches the artifact version they
 * produced). With none, or several different ones, ours.
 */
export function uploadArtifactAction(text: string, jobs: string[]): { ref: string; version?: string } {
  const doc = YAML.parseDocument(text);
  const found = new Map<string, string | undefined>();
  for (const j of jobs) {
    const steps = doc.getIn(["jobs", j, "steps"], true);
    if (!YAML.isSeq(steps)) continue;
    for (const step of steps.items) {
      const uses = YAML.isMap(step) ? step.get("uses", true) : undefined;
      if (!YAML.isScalar(uses) || typeof uses.value !== "string" || !uses.value.startsWith("actions/upload-artifact@")) continue;
      // A trailing "# v4.6.2" is the version of a SHA pin.
      const version = uses.comment?.trim().split(/\s+/)[0];
      if (!found.has(uses.value) || version) found.set(uses.value, version || found.get(uses.value));
    }
  }
  if (found.size !== 1) return UPLOAD_ARTIFACT;
  const [[ref, version]] = found;
  return { ref, version };
}

export interface StubOptions {
  /** Replayed jobs (by id) and what their host run left. */
  needs: Record<string, NeededJob>;
  /** The leg's own runs-on labels: stubs run where the leg runs. */
  runsOn: string[];
  /** Artifacts to re-upload, with their directories in the guest (absolute: stubs have no checkout). */
  artifacts: ReplayArtifact[];
  upload?: { ref: string; version?: string };
}

/**
 * The guest-side workflow: each replayed job replaced by a stub that has the same id and `outputs:`
 * keys, runs on the leg's runner and replays the recorded values. A job skipped on the host gets a
 * stub with `if: false`, so its dependents are skipped as on GitHub; one that failed gets a stub that
 * replays its outputs and then fails, so act runs only the dependents whose if: allows it. The recorded artifacts are
 * re-uploaded by one job that every stub needs, so they exist before any dependent job starts.
 *
 * The replay step is a Node.js script: act needs Node in the guest for JavaScript actions anyway, and
 * one script works on Windows and macOS alike. The outputs travel base64-encoded, so no value can
 * break the script or be read as an expression.
 */
export function replayStubWorkflow(text: string, o: StubOptions): string {
  const doc = YAML.parseDocument(text);
  const jobs = jobsOf(doc);
  let artifactsJob: string | undefined;
  if (o.artifacts.length) {
    artifactsJob = freeJobId(jobs, "osmatrix-replay-artifacts");
    const upload = o.upload ?? UPLOAD_ARTIFACT;
    const node = doc.createNode({
      name: "Artifacts (replayed from host run)",
      "runs-on": o.runsOn,
      steps: o.artifacts.map((a) => ({
        name: `Upload ${a.name}`,
        uses: upload.ref,
        with: { name: a.name, path: a.dir, "include-hidden-files": true, "if-no-files-found": "error" },
      })),
    });
    if (upload.version) {
      for (const step of (node.get("steps") as YAML.YAMLSeq<YAML.YAMLMap>).items) {
        const uses = step.get("uses", true) as YAML.Scalar;
        uses.comment = ` ${upload.version}`;
      }
    }
    jobs.set(artifactsJob, node);
  }
  for (const [id, needed] of Object.entries(o.needs)) {
    const orig = jobs.get(id);
    const name = YAML.isMap(orig) ? orig.get("name") : undefined;
    const declared = YAML.isMap(orig) ? orig.get("outputs") : undefined;
    const keys = new Set([...(YAML.isMap(declared) ? declared.items.map((p) => String(YAML.isScalar(p.key) ? p.key.value : p.key)) : []), ...Object.keys(needed.outputs)]);
    const failed = needed.result !== "success" && needed.result !== "skipped";
    const values = Object.fromEntries([...keys].map((k) => [k, needed.outputs[k] ?? ""]));
    const b64 = Buffer.from(githubOutputFile(values), "utf8").toString("base64");
    // A job that failed (or was cancelled) on the host fails here too, after replaying the outputs it set:
    // GitHub evaluates job outputs when a job ends, whatever its result. act then runs only the
    // dependents whose if: allows it (always(), failure(), …).
    let script = `require("fs").appendFileSync(process.env.GITHUB_OUTPUT, Buffer.from("${b64}", "base64"));\n`;
    if (failed) {
      script += `console.error(${JSON.stringify(`${id} ${needed.result === "failure" ? "failed" : `ended as ${needed.result}`} in osmatrix's host run; its log is in this leg's log`)});\nprocess.exitCode = 1;\n`;
    }
    const stub: Record<string, unknown> = {
      name: `${typeof name === "string" && !name.includes("${{") ? name : id} (replayed from host run)`,
    };
    if (needed.result === "skipped") stub.if = false;
    if (artifactsJob) stub.needs = [artifactsJob];
    stub["runs-on"] = o.runsOn;
    if (keys.size) stub.outputs = Object.fromEntries([...keys].map((k) => [k, `\${{ steps.replay.outputs['${k.replace(/'/g, "''")}'] }}`]));
    stub.steps = [
      {
        id: "replay",
        name: failed ? `Replay the host run: ${id} ${needed.result === "failure" ? "failed" : `ended as ${needed.result}`}` : "Replay outputs from the host run",
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
 * Copy the artifacts a run uploaded out of act's artifact store into `outDir/<n>/`, one directory per
 * artifact, and list them. act 0.2.89 keeps an artifact at `<store>/<run id>/<name>/`: upload-artifact
 * v4 and later send one zip (`<name>.zip`, unpacked here); v3 sent each file (gzipped ones end in `.gz__`).
 */
export function extractArtifacts(store: string, runId: string, outDir: string): ReplayArtifact[] {
  const runDir = path.join(store, runId);
  if (!fs.existsSync(runDir)) return [];
  const out: ReplayArtifact[] = [];
  for (const name of fs.readdirSync(runDir).sort()) {
    const src = path.join(runDir, name);
    if (!fs.statSync(src).isDirectory()) continue;
    const dest = path.join(outDir, String(out.length + 1));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src);
    if (entries.length === 1 && entries[0] === `${name}.zip`) {
      for (const e of readZip(fs.readFileSync(path.join(src, entries[0])))) writeInside(dest, e.name, e.data);
    } else {
      for (const rel of fs.readdirSync(src, { recursive: true, encoding: "utf8" })) {
        const file = path.join(src, rel);
        if (!fs.statSync(file).isFile()) continue;
        const data = fs.readFileSync(file);
        if (rel.endsWith(".gz__")) writeInside(dest, rel.slice(0, -".gz__".length), zlib.gunzipSync(data));
        else writeInside(dest, rel, data);
      }
    }
    out.push({ name, dir: dest });
  }
  return out;
}

function writeInside(root: string, rel: string, data: Buffer) {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === ".." || p === "." || /^[A-Za-z]:$/.test(p))) throw new Error(`unsafe path in artifact: ${rel}`);
  const file = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/**
 * The files in a zip archive (stored or deflated entries; what upload-artifact writes). Sizes come from
 * the central directory, so entries with data descriptors work. Zip64 and encrypted archives are refused.
 */
export function readZip(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("zip64 archives are not supported");
  const files: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (size === 0xffffffff || local === 0xffffffff) throw new Error("zip64 archives are not supported");
    if (flags & 1) throw new Error(`encrypted zip entry: ${name}`);
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip entry: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${method}: ${name}`);
    if (zlib.crc32(data) !== crc) throw new Error(`zip entry failed its checksum: ${name}`);
    files.push({ name, data });
  }
  return files;
}
