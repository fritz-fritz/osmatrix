import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import type { Leg } from "../src/ci/plan.ts";
import { collectorWorkflow, combineLegs, githubOutputFile, mergeArtifacts, parseNeedsRecord, replayStubWorkflow } from "../src/ci/replay.ts";
import { ActJsonParser, legResult, scheduleOrder } from "../src/ci/run.ts";

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

test("the collector needs the leg's job, always runs on the leg's runner and gets a free id", () => {
  const { text, job } = collectorWorkflow(WF, "test", ["windows-latest"]);
  assert.equal(job, "osmatrix-record");
  const jobs = YAML.parse(text).jobs;
  assert.deepEqual(jobs[job].needs, ["test"]);
  assert.equal(jobs[job].if, "${{ always() }}");
  assert.deepEqual(jobs[job]["runs-on"], ["windows-latest"]);
  const step = jobs[job].steps[0];
  assert.equal(step.shell, 'node "{0}"');
  assert.equal(step.env.OSMATRIX_NEEDS, "${{ toJSON(needs) }}");
  assert.deepEqual(Object.keys(jobs).slice(0, 3), ["plan", "lint", "test"]);
  // The step is a plain Node.js script; run it as act would, and read its record back.
  const needs = { test: { result: "success", outputs: { v: "multi\nline ${{ x }}" } } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-record-"));
  fs.writeFileSync(path.join(dir, "record"), step.run);
  const out = execFileSync(process.execPath, [path.join(dir, "record")], { env: { ...process.env, OSMATRIX_NEEDS: JSON.stringify(needs, null, 2) } });
  assert.deepEqual(parseNeedsRecord(`  | ${String(out).trim()}`), needs);
  const taken = WF + "  osmatrix-record:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n";
  assert.equal(collectorWorkflow(taken, "test", ["x"]).job, "osmatrix-record-2");
});

test("the collector's record is read back from act's log", () => {
  const needs = {
    plan: { outputs: { mode: "full", notes: "it's\nmulti ${{ x }}" }, result: "success" },
    gate: { outputs: { go: "${{ steps.x.outputs.go }}" }, result: "skipped" },
    build: { outputs: { half: "set before failing" }, result: "failure" },
  };
  const line = `  | osmatrix-needs:${Buffer.from(JSON.stringify(needs, null, 2)).toString("base64")}`;
  assert.deepEqual(parseNeedsRecord(line), {
    plan: { result: "success", outputs: { mode: "full", notes: "it's\nmulti ${{ x }}" } },
    // act leaves a job's outputs unevaluated when it didn't run; GitHub gives empty values.
    gate: { result: "skipped", outputs: {} },
    // GitHub evaluates outputs when a job ends, whatever its result.
    build: { result: "failure", outputs: { half: "set before failing" } },
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

test("replay stubs keep the job id and outputs, run on the leg's runner and replay the values", () => {
  const notes = "it's \"quoted\"\nand ${{ not.an.expression }}";
  const text = replayStubWorkflow(WF, {
    needs: { plan: { result: "success", outputs: { mode: "full", notes }, legs: ["plan-1", "plan-2"] } },
    runsOn: ["windows-latest"],
  });
  const jobs = YAML.parse(text).jobs;
  const stub = jobs.plan;
  assert.equal(stub.name, "Plan the run (replayed)");
  assert.deepEqual(stub["runs-on"], ["windows-latest"]);
  assert.equal(stub.strategy, undefined);
  assert.equal(stub.if, undefined);
  // What the replayed job needed ran in its own legs already.
  assert.equal(stub.needs, undefined);
  // Declared keys are kept even when the run left them unset; recorded extras are kept too.
  assert.deepEqual(Object.keys(stub.outputs), ["mode", "my-key", "notes"]);
  assert.equal(stub.outputs["my-key"], "${{ steps.replay.outputs['my-key'] }}");
  assert.equal(stub.steps.length, 1);
  assert.equal(stub.steps[0].id, "replay");
  assert.equal(stub.steps[0].name, "Replay the outputs of its legs plan-1, plan-2");
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
  // Everything else is the original workflow.
  const orig = YAML.parse(WF).jobs;
  assert.deepEqual(jobs.lint, orig.lint);
  assert.deepEqual(jobs.test, orig.test);
  assert.deepEqual(Object.keys(jobs), Object.keys(orig));
});

test("a skipped job gets a stub that is skipped too", () => {
  const jobs = YAML.parse(replayStubWorkflow(WF, { needs: { plan: { result: "skipped", outputs: {} } }, runsOn: ["macos-latest"] })).jobs;
  assert.equal(jobs.plan.if, false);
  assert.equal(jobs.plan.needs, undefined);
  assert.deepEqual(Object.keys(jobs.plan.outputs), ["mode", "my-key"]);
});

test("a job that failed gets a stub that replays its outputs, then fails", () => {
  const jobs = YAML.parse(
    replayStubWorkflow(WF, { needs: { plan: { result: "failure", outputs: { mode: "partial" }, legs: ["plan-2"] } }, runsOn: ["windows-latest"] }),
  ).jobs;
  const step = jobs.plan.steps[0];
  assert.equal(jobs.plan.if, undefined);
  assert.equal(step.name, "Replay: plan failed in its leg plan-2");
  assert.deepEqual(Object.keys(jobs.plan.outputs), ["mode", "my-key"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-replay-"));
  const script = path.join(dir, "replay");
  const outFile = path.join(dir, "output");
  fs.writeFileSync(script, step.run);
  fs.writeFileSync(outFile, "");
  assert.throws(() => execFileSync(process.execPath, [script], { env: { ...process.env, GITHUB_OUTPUT: outFile }, stdio: "pipe" }), (e: { status?: number; stderr?: Buffer }) => {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /plan failed in its leg plan-2 of this osmatrix run/);
    return true;
  });
  assert.deepEqual(parseFileCommands(fs.readFileSync(outFile, "utf8")), { mode: "partial", "my-key": "" });
  assert.equal(YAML.parse(replayStubWorkflow(WF, { needs: { plan: { result: "cancelled", outputs: {} } }, runsOn: ["x"] })).jobs.plan.steps[0].name, "Replay: plan ended as cancelled in its own leg");
});

test("a matrix job's legs combine as GitHub's needs context has them", () => {
  const ok = (outputs: Record<string, string> = {}) => ({ result: "success", outputs });
  assert.deepEqual(combineLegs([ok({ a: "1", b: "x" }), ok({ a: "2", b: "" })]), { result: "success", outputs: { a: "2", b: "x" } });
  assert.equal(combineLegs([ok(), { result: "failure", outputs: {} }, { result: "cancelled", outputs: {} }]).result, "failure");
  assert.equal(combineLegs([ok(), { result: "cancelled", outputs: {} }]).result, "cancelled");
  assert.equal(combineLegs([{ result: "skipped", outputs: {} }, { result: "skipped", outputs: {} }]).result, "skipped");
  assert.equal(combineLegs([{ result: "skipped", outputs: {} }, ok()]).result, "success");
});

test("artifacts a leg uploaded join the run's store; the first one by a name stays", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-artifacts-"));
  const from = path.join(root, "guest");
  const to = path.join(root, "host");
  const put = (store: string, rel: string, data: string) => {
    fs.mkdirSync(path.dirname(path.join(store, rel)), { recursive: true });
    fs.writeFileSync(path.join(store, rel), data);
  };
  put(from, "123/plan/plan.zip", "seeded copy");
  put(from, "123/build-win/build-win.zip", "new");
  put(from, "123/old style/nested/file.txt", "v3");
  put(from, "999/other-run/x.zip", "not this run");
  put(to, "123/plan/plan.zip", "original");
  assert.deepEqual(mergeArtifacts(from, to, "123"), ["build-win", "old style"]);
  assert.equal(fs.readFileSync(path.join(to, "123/plan/plan.zip"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(to, "123/build-win/build-win.zip"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(to, "123/old style/nested/file.txt"), "utf8"), "v3");
  assert.ok(!fs.existsSync(path.join(to, "999")));
  // Nothing left behind next to the store.
  assert.deepEqual(fs.readdirSync(to), ["123"]);
  assert.deepEqual(mergeArtifacts(from, to, "404"), []);
});

const leg = (id: string, target: string, waitsFor: string[] = []): Leg => ({
  id,
  workflow: ".github/workflows/ci.yml",
  job: id.split("-")[0],
  matrix: {},
  runsOn: [],
  needsLabels: [],
  needs: [],
  warnings: [],
  target,
  waitsFor,
});

test("legs start after the legs they wait for, in plan order otherwise", () => {
  const legs = [
    leg("gate", "host", ["test-win", "test-linux", "lint"]),
    leg("test-win", "windows", ["plan"]),
    leg("test-linux", "host", ["plan"]),
    leg("lint", "host"),
    leg("plan", "host"),
  ];
  assert.deepEqual(
    scheduleOrder(legs).map((l) => l.id),
    ["lint", "plan", "test-win", "test-linux", "gate"],
  );
});

test("a leg's state comes from its own job; a replayed failure skips it", () => {
  const feed = (events: object[]) => {
    const p = new ActJsonParser(() => {}, "test");
    for (const e of events) p.feed(JSON.stringify(e) + "\n");
    p.flush();
    return p;
  };
  const stubFailed = { jobID: "plan", jobResult: "failure" };
  const ran = (result: string) => [
    { jobID: "test", step: "Run", stepResult: result },
    { jobID: "test", jobResult: result },
  ];
  assert.deepEqual(legResult(0, feed(ran("success")), ["plan"]), { state: "success" });
  // A dependent with if: always() still runs after a failed need; its own result decides.
  assert.deepEqual(legResult(1, feed([stubFailed, ...ran("success")]), ["plan"]), { state: "success" });
  assert.deepEqual(legResult(1, feed(ran("failure")), []), { state: "failure" });
  // act says nothing about a job it skips.
  assert.deepEqual(legResult(1, feed([stubFailed]), ["plan"]), { state: "skipped", error: "act skipped the job: needed job plan failed" });
  assert.equal(legResult(0, feed([]), ["plan"]).state, "skipped");
  // A need act ran inside the leg failing is the leg's failure; so is act failing before the job.
  assert.deepEqual(legResult(1, feed([{ jobID: "gpu", jobResult: "failure" }]), ["plan"]), { state: "failure" });
  assert.deepEqual(legResult(1, feed([]), []), { state: "failure", error: "act exited with code 1 before the job started" });
  assert.equal(legResult(124, feed([{ jobID: "test", step: "Run", stepResult: "success" }]), []).state, "failure");
});
