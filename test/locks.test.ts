import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Locks live in the data dir; keep them away from the real install. Set before the modules load.
process.env.OSMATRIX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-locks-"));
const { acquireLocks, tryLock, unlock } = await import("../src/core/locks.ts");
const { legLockKeys } = await import("../src/ci/run.ts");
const { plan } = await import("../src/ci/plan.ts");
const { defaultConfig, mergeConfig } = await import("../src/core/config.ts");

const me = (run: string, leg = "leg") => ({ pid: process.pid, run, repo: "/r", leg });

test("a held lock reports its holder until released", () => {
  assert.deepEqual(tryLock("k1", me("A")), { ok: true });
  const r = tryLock("k1", me("B"));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.holder.run, "A");
  unlock("k1", me("B")); // not the holder: no effect
  assert.equal(tryLock("k1", me("B")).ok, false);
  unlock("k1", me("A"));
  assert.equal(tryLock("k1", me("B")).ok, true);
  unlock("k1", me("B"));
});

test("a lock left by a dead process is reclaimed", () => {
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  assert.equal(tryLock("k2", { pid: dead, run: "gone", repo: "/r", leg: "x" }).ok, true);
  assert.equal(tryLock("k2", me("A")).ok, true);
  unlock("k2", me("A"));
});

test("acquireLocks waits for the holder and reports it once", async () => {
  const releaseA = await acquireLocks(["b", "a"], me("A"), () => assert.fail("A should not wait"), 10);
  const waits: string[] = [];
  const pending = acquireLocks(["a", "c"], me("B"), (key, h) => waits.push(`${key}<-${h.run}`), 10);
  await new Promise((r) => setTimeout(r, 60));
  releaseA();
  const releaseB = await pending;
  assert.deepEqual(waits, ["a<-A"]);
  assert.equal(tryLock("c", me("C")).ok, false);
  releaseB();
  assert.equal(tryLock("c", me("C")).ok, true);
  unlock("c", me("C"));
});

test("host legs lock their job and every needed job; guest legs lock the guest", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-locks-repo-"));
  fs.mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".github", "workflows", "ci.yml"),
    `
name: CI
on: push
jobs:
  plan:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  mid:
    needs: plan
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  gw:
    needs: mid
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    runs-on: \${{ matrix.os }}
    steps: [{ run: echo }]
`,
  );
  const cfg = mergeConfig(defaultConfig("linux"), {});
  const legs = plan(repo, cfg, { job: "gw" }).legs;
  const linux = legs.find((l) => l.target === "host")!;
  const win = legs.find((l) => l.targetOs === "windows")!;
  assert.deepEqual(legLockKeys(linux).sort(), ["act-job:CI/gw", "act-job:CI/mid", "act-job:CI/plan"]);
  assert.deepEqual(legLockKeys(win), [`guest:${win.target}`]);
});
