import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { QemuMacBackend } from "../src/backends/qemu-macos.ts";
import { cancelLeg, copyActCwdFiles, isRunWorker, type LegResult } from "../src/ci/run.ts";
import type { GuestConfig } from "../src/core/config.ts";
import { parseEtime, processStartedAt } from "../src/core/proc.ts";

test("isRunWorker: a process that started after the run was created has a reused pid", () => {
  const created = "2026-10-20T12:00:00.000Z";
  const t = Date.parse(created);
  // A background worker starts right after ciRun creates the run; a --wait run's worker before it.
  assert.equal(isRunWorker(t + 2_000, created), true);
  assert.equal(isRunWorker(t - 5_000, created), true);
  assert.equal(isRunWorker(t + 3_600_000, created), false);
  assert.equal(isRunWorker(undefined, created), false);
  assert.equal(isRunWorker(t, "not a date"), false);
});

test("parseEtime reads ps's etime column", () => {
  assert.equal(parseEtime("00:07"), 7);
  assert.equal(parseEtime("  12:34\n"), 12 * 60 + 34);
  assert.equal(parseEtime("01:02:03"), 3723);
  assert.equal(parseEtime("2-01:02:03"), 2 * 86400 + 3723);
  assert.equal(parseEtime(""), undefined);
  assert.equal(parseEtime("garbage"), undefined);
});

test("processStartedAt: this process started a moment ago; a dead pid has no start", async () => {
  const started = await processStartedAt(process.pid);
  assert.ok(started !== undefined, "start time of this process");
  assert.ok(started <= Date.now() + 1000 && started > Date.now() - 10 * 60_000, `started ${new Date(started).toISOString()}`);
  assert.equal(await processStartedAt(2 ** 22 + 12345), undefined);
});

test("cancelLeg: a leg cancelled before it started still gets finishedAt", () => {
  const leg = (o: Partial<LegResult>): LegResult => ({ id: "l", workflow: "ci.yml", job: "j", matrix: {}, state: "pending", warnings: [], log: "l.log", ...o }) as LegResult;
  const pending = leg({ waitingFor: "needed leg x" });
  cancelLeg(pending, "cancelled", "2026-10-20T12:00:10.000Z");
  assert.equal(pending.state, "cancelled");
  assert.equal(pending.finishedAt, "2026-10-20T12:00:10.000Z");
  assert.equal(pending.durationSec, undefined);
  assert.equal(pending.waitingFor, undefined);
  const running = leg({ state: "running", startedAt: "2026-10-20T12:00:00.000Z" });
  cancelLeg(running, "cancelled", "2026-10-20T12:00:10.000Z");
  assert.equal(running.durationSec, 10);
});

test("copyActCwdFiles copies the act files a clone left out, and nothing else", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-actfiles-"));
  try {
    const from = path.join(root, "repo");
    const to = path.join(root, "clone");
    fs.mkdirSync(path.join(from, ".input"), { recursive: true }); // a directory isn't act's input file
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(from, ".actrc"), "-P ubuntu-latest=img\n");
    fs.writeFileSync(path.join(from, ".env"), "A=1\n");
    fs.writeFileSync(path.join(from, ".secrets"), "TOKEN=x\n");
    fs.writeFileSync(path.join(from, ".vars"), "V=from-repo\n");
    fs.writeFileSync(path.join(to, ".vars"), "V=tracked\n");
    assert.deepEqual(copyActCwdFiles(from, to), [".actrc", ".env"]);
    assert.equal(fs.readFileSync(path.join(to, ".actrc"), "utf8"), "-P ubuntu-latest=img\n");
    assert.equal(fs.readFileSync(path.join(to, ".vars"), "utf8"), "V=tracked\n");
    assert.equal(fs.existsSync(path.join(to, ".secrets")), false);
    assert.equal(fs.existsSync(path.join(to, ".input")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("QemuMacBackend.bridgeStop closes the bridge's server, so setup can exit", async () => {
  const b = new QemuMacBackend({ name: "bridge-test", os: "macos" } as GuestConfig);
  await b.bridgeStart();
  const port = Number(/:(\d+)\//.exec(b.bridgeUrl())![1]);
  const connects = () =>
    new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.destroy(), resolve(true)));
      s.on("error", () => resolve(false));
    });
  assert.equal(await connects(), true);
  await b.bridgeStop();
  assert.equal(await connects(), false);
  assert.throws(() => b.bridgeUrl(), /bridge not started/);
});
