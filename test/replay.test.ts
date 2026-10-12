import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import YAML from "yaml";
import {
  UPLOAD_ARTIFACT,
  collectorWorkflow,
  extractArtifacts,
  githubOutputFile,
  parseNeedsRecord,
  readZip,
  replayStubWorkflow,
  uploadArtifactAction,
} from "../src/ci/replay.ts";

const WF = `name: CI
on: push
jobs:
  plan:
    name: Plan the run
    runs-on: ubuntu-latest
    strategy: { matrix: { x: [1, 2] } }
    outputs:
      mode: \${{ steps.p.outputs.mode }}
      my-key: \${{ steps.p.outputs.k }}
    steps:
      - id: p
        run: echo "mode=full" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with: { name: plan, path: out }
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  test:
    needs: [plan, lint]
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [windows-latest] } }
    steps: [{ run: echo }]
`;

/** act's parser for file commands (pkg/container/parse_env_file.go), to check what a stub writes. */
function parseFileCommands(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const eq = l.indexOf("=");
    const hd = l.indexOf("<<");
    if (eq >= 0 && (hd < 0 || eq < hd)) out[l.slice(0, eq)] = l.slice(eq + 1);
    else {
      const d = l.slice(hd + 2);
      const body: string[] = [];
      while (lines[++i] !== d) body.push(lines[i]);
      out[l.slice(0, hd)] = body.join("\n");
    }
  }
  return out;
}

test("the collector needs the replayed jobs, always runs and gets a free id", () => {
  const { text, job } = collectorWorkflow(WF, ["plan"]);
  assert.equal(job, "osmatrix-replay");
  const jobs = YAML.parse(text).jobs;
  assert.deepEqual(jobs[job].needs, ["plan"]);
  assert.equal(jobs[job].if, "${{ always() }}");
  assert.equal(jobs[job]["runs-on"], "ubuntu-latest");
  assert.equal(jobs[job].steps[0].env.OSMATRIX_NEEDS, "${{ toJSON(needs) }}");
  assert.match(jobs[job].steps[0].run, /osmatrix-needs:\$\(printf '%s' "\$OSMATRIX_NEEDS" \| base64 \| tr -d '\\n'\)/);
  assert.deepEqual(Object.keys(jobs).slice(0, 3), ["plan", "lint", "test"]);
  const taken = WF + "  osmatrix-replay:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n";
  assert.equal(collectorWorkflow(taken, ["plan"]).job, "osmatrix-replay-2");
});

test("the collector's record is read back from act's log", () => {
  const needs = {
    plan: { outputs: { mode: "full", notes: "it's\nmulti ${{ x }}" }, result: "success" },
    gate: { outputs: { go: "${{ steps.x.outputs.go }}" }, result: "skipped" },
  };
  const line = `  | osmatrix-needs:${Buffer.from(JSON.stringify(needs, null, 2)).toString("base64")}`;
  assert.deepEqual(parseNeedsRecord(line), {
    plan: { result: "success", outputs: { mode: "full", notes: "it's\nmulti ${{ x }}" } },
    // act leaves a job's outputs unevaluated when it didn't run; GitHub gives empty values.
    gate: { result: "skipped", outputs: {} },
  });
  assert.equal(parseNeedsRecord("  | nothing here"), undefined);
  assert.equal(parseNeedsRecord("  | osmatrix-needs:$(printf"), undefined);
  assert.equal(parseNeedsRecord(`osmatrix-needs:${Buffer.from("not json").toString("base64")}`), undefined);
});

test("outputs use GITHUB_OUTPUT's heredoc form for multi-line values", () => {
  const ids = ["EOF", "EOF", "D2"];
  const file = githubOutputFile({ a: "1", b: "x=y", c: "two\nlines\nEOF", d: "" }, () => ids.shift()!);
  assert.equal(file, "a=1\nb=x=y\nc<<D2\ntwo\nlines\nEOF\nD2\nd=\n");
  const values = { m: "line 1\r\nline 2", s: "single ${{ x }}", e: "" };
  assert.deepEqual(parseFileCommands(githubOutputFile(values).replace(/\r/g, "")), { ...values, m: "line 1\nline 2" });
});

test("the upload action comes from the workflow, else the pinned default", () => {
  assert.deepEqual(uploadArtifactAction(WF), { ref: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", version: "v4.6.2" });
  assert.deepEqual(uploadArtifactAction("steps:\n  - uses: 'actions/upload-artifact@v4'\n"), { ref: "actions/upload-artifact@v4", version: undefined });
  assert.deepEqual(uploadArtifactAction("jobs: {}\n"), UPLOAD_ARTIFACT);
  assert.match(UPLOAD_ARTIFACT.ref, /^actions\/upload-artifact@[0-9a-f]{40}$/);
});

test("replay stubs keep the job id and outputs, run on the leg's runner and replay the values", () => {
  const notes = "it's \"quoted\"\nand ${{ not.an.expression }}";
  const text = replayStubWorkflow(WF, {
    needs: { plan: { result: "success", outputs: { mode: "full", notes } } },
    runsOn: ["windows-latest"],
    artifacts: [{ name: "plan", dir: "C:\\Users\\u\\work\\.osmatrix\\r\\l\\replay\\1" }],
    upload: { ref: "actions/upload-artifact@abc", version: "v9.9.9" },
  });
  assert.match(text, /uses: actions\/upload-artifact@abc # v9\.9\.9/);
  const jobs = YAML.parse(text).jobs;
  const stub = jobs.plan;
  assert.equal(stub.name, "Plan the run (replayed from host run)");
  assert.deepEqual(stub["runs-on"], ["windows-latest"]);
  assert.equal(stub.strategy, undefined);
  assert.equal(stub.if, undefined);
  assert.deepEqual(stub.needs, ["osmatrix-replay-artifacts"]);
  // Declared keys are kept even when the run left them unset; recorded extras are kept too.
  assert.deepEqual(Object.keys(stub.outputs), ["mode", "my-key", "notes"]);
  assert.equal(stub.outputs["my-key"], "${{ steps.replay.outputs['my-key'] }}");
  assert.equal(stub.steps.length, 1);
  assert.equal(stub.steps[0].id, "replay");
  assert.equal(stub.steps[0].shell, 'node "{0}"');
  assert.ok(!stub.steps[0].run.includes("${{"));
  // The step is a plain Node.js script; run it as act would and read GITHUB_OUTPUT back.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-replay-"));
  const script = path.join(dir, "replay");
  const outFile = path.join(dir, "output");
  fs.writeFileSync(script, stub.steps[0].run);
  fs.writeFileSync(outFile, "earlier=1\n");
  execFileSync(process.execPath, [script], { env: { ...process.env, GITHUB_OUTPUT: outFile } });
  assert.deepEqual(parseFileCommands(fs.readFileSync(outFile, "utf8")), { earlier: "1", mode: "full", "my-key": "", notes });
  // Artifacts are uploaded once, from absolute paths, before any stub finishes.
  const up = jobs["osmatrix-replay-artifacts"];
  assert.deepEqual(up["runs-on"], ["windows-latest"]);
  assert.deepEqual(up.steps[0].with, {
    name: "plan",
    path: "C:\\Users\\u\\work\\.osmatrix\\r\\l\\replay\\1",
    "include-hidden-files": true,
    "if-no-files-found": "error",
  });
  // Everything else is the original workflow.
  const orig = YAML.parse(WF).jobs;
  assert.deepEqual(jobs.lint, orig.lint);
  assert.deepEqual(jobs.test, orig.test);
});

test("a job skipped on the host gets a stub that is skipped too; no artifacts, no upload job", () => {
  const jobs = YAML.parse(
    replayStubWorkflow(WF, { needs: { plan: { result: "skipped", outputs: {} } }, runsOn: ["macos-latest"], artifacts: [] }),
  ).jobs;
  assert.equal(jobs.plan.if, false);
  assert.equal(jobs.plan.needs, undefined);
  assert.equal(jobs["osmatrix-replay-artifacts"], undefined);
  assert.deepEqual(Object.keys(jobs.plan.outputs), ["mode", "my-key"]);
});

/** A zip archive like upload-artifact's (deflated entries; optionally with data descriptors). */
function makeZip(entries: { name: string; data: Buffer; store?: boolean; descriptor?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = e.store ? e.data : zlib.deflateRawSync(e.data);
    const crc = zlib.crc32(e.data);
    const name = Buffer.from(e.name, "utf8");
    const flags = 0x800 | (e.descriptor ? 8 : 0);
    const method = e.store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    lh.writeUInt32LE(e.descriptor ? 0 : raw.length, 18);
    lh.writeUInt32LE(e.descriptor ? 0 : e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const dd = Buffer.alloc(e.descriptor ? 16 : 0);
    if (e.descriptor) {
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(raw.length, 8);
      dd.writeUInt32LE(e.data.length, 12);
    }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(raw.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, raw, dd);
    centrals.push(ch, name);
    offset += lh.length + name.length + raw.length + dd.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("readZip reads stored and deflated entries, with or without data descriptors", () => {
  const big = Buffer.from("x".repeat(10_000) + "ü");
  const files = readZip(
    makeZip([
      { name: "run-id.txt", data: Buffer.from("42\n") },
      { name: "sub/dir/big.txt", data: big, descriptor: true },
      { name: ".hidden", data: Buffer.from("h"), store: true },
    ]),
  );
  assert.deepEqual(
    files.map((f) => [f.name, f.data.toString("utf8")]),
    [
      ["run-id.txt", "42\n"],
      ["sub/dir/big.txt", big.toString("utf8")],
      [".hidden", "h"],
    ],
  );
  assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")), /not a zip/);
  const bad = makeZip([{ name: "a", data: Buffer.from("abc"), store: true }]);
  bad[30 + 1] = "X".charCodeAt(0); // corrupt the stored data
  assert.throws(() => readZip(bad), /checksum/);
});

test("artifacts are extracted from act's store: v4 zips and v3 files, per run id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-artifacts-"));
  const store = path.join(root, "store");
  const v4 = path.join(store, "123", "ci-plan");
  fs.mkdirSync(v4, { recursive: true });
  fs.writeFileSync(path.join(v4, "ci-plan.zip"), makeZip([{ name: "plan.json", data: Buffer.from("{}") }, { name: "deep/a.txt", data: Buffer.from("a") }]));
  const v3 = path.join(store, "123", "old style", "nested");
  fs.mkdirSync(v3, { recursive: true });
  fs.writeFileSync(path.join(v3, "plain.txt"), "p");
  fs.writeFileSync(path.join(v3, "packed.txt.gz__"), zlib.gzipSync("unpacked"));
  fs.mkdirSync(path.join(store, "999", "other-run"), { recursive: true });
  const out = path.join(root, "files");
  const arts = extractArtifacts(store, "123", out);
  assert.deepEqual(arts, [
    { name: "ci-plan", dir: path.join(out, "1") },
    { name: "old style", dir: path.join(out, "2") },
  ]);
  assert.equal(fs.readFileSync(path.join(out, "1", "plan.json"), "utf8"), "{}");
  assert.equal(fs.readFileSync(path.join(out, "1", "deep", "a.txt"), "utf8"), "a");
  assert.equal(fs.readFileSync(path.join(out, "2", "nested", "plain.txt"), "utf8"), "p");
  assert.equal(fs.readFileSync(path.join(out, "2", "nested", "packed.txt"), "utf8"), "unpacked");
  assert.deepEqual(extractArtifacts(store, "404", out), []);
  // Entries that would land outside the artifact's directory are refused.
  fs.writeFileSync(path.join(v4, "ci-plan.zip"), makeZip([{ name: "../escape.txt", data: Buffer.from("x") }]));
  assert.throws(() => extractArtifacts(store, "123", out), /unsafe path/);
});
