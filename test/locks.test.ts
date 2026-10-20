import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

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

test("a lock whose holder stopped refreshing it is reclaimed, even if its pid is alive", () => {
  assert.equal(tryLock("k3", me("A")).ok, true);
  const dir = path.join(process.env.OSMATRIX_HOME!, "locks");
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("k3-"))!);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, old, old); // e.g. the pid now belongs to an unrelated process
  assert.equal(tryLock("k3", me("B")).ok, true);
  unlock("k3", me("B"));
});

test("a lock file its holder is still writing isn't taken over; an abandoned unreadable one is", () => {
  assert.equal(tryLock("k4", me("A")).ok, true);
  const dir = path.join(process.env.OSMATRIX_HOME!, "locks");
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("k4-"))!);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).run, "A"); // published complete
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  fs.writeFileSync(file, ""); // created, owner not written yet
  assert.equal(tryLock("k4", me("B")).ok, false);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  assert.equal(tryLock("k4", me("B")).ok, true);
  unlock("k4", me("B"));
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

test("separate processes never hold a lock at the same time", async () => {
  // Each process takes the lock over and over and claims a marker file inside it: a second claimant fails.
  const marker = path.join(process.env.OSMATRIX_HOME!, "inside");
  const locks = pathToFileURL(path.resolve("src/core/locks.ts")).href;
  const child = `
    import fs from "node:fs";
    const { acquireLocks } = await import(${JSON.stringify(locks)});
    const owner = { pid: process.pid, run: "r" + process.pid, repo: "/r", leg: "leg" };
    for (let i = 0; i < 25; i++) {
      const release = await acquireLocks(["contended"], owner, () => undefined, 1);
      try {
        fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid), { flag: "wx" });
      } catch (e) {
        console.error("two holders at once: " + e.message);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 1));
      fs.rmSync(${JSON.stringify(marker)});
      release();
    }`;
  const codes = await Promise.all(
    Array.from({ length: 6 }, () => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", child], { env: process.env, stdio: ["ignore", "inherit", "inherit"] });
      return new Promise<number | null>((res) => p.on("exit", res));
    }),
  );
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
});

test("host legs lock their workflow as act names its containers; guest legs lock the guest", () => {
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
  // Explicit guests: the defaults depend on the host (a macOS host has no Windows guest).
  const cfg = mergeConfig(defaultConfig(), { guests: { windows: { os: "windows", backend: "dockur" } } });
  const legs = plan(repo, cfg, { job: "gw" }).legs;
  const linux = legs.find((l) => l.target === "host")!;
  const win = legs.find((l) => l.targetOs === "windows")!;
  assert.deepEqual(legLockKeys(linux), ["host:act-workflow:act-CI"]);
  assert.deepEqual(legLockKeys(win), [`guest:${win.target}`]);
  // act canonicalizes names, so these share containers and must share a lock; unnamed workflows use the file name.
  const key = (workflowName: string | undefined, workflow = ".github/workflows/ci.yml") => legLockKeys({ ...linux, workflowName, workflow })[0];
  assert.equal(key("A/B"), key("A-B"));
  assert.equal(key("A -B"), key("A-B"));
  assert.equal(key(undefined), "host:act-workflow:act-ci-yml");
});
