import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunResult } from "../src/core/proc.ts";
import { shutdownMacOverSsh, type Endpoint, type ShutdownDeps } from "../src/core/ssh.ts";

const ep = { host: "127.0.0.1", port: 2223, user: "osmatrix", os: "macos", shell: "posix" } as Endpoint;
const ok: RunResult = { code: 0, stdout: "", stderr: "" };

/** A fake clock that advances when the helper sleeps, and a VM that stops after `stopsAfterMs` (never if undefined). */
function harness(o: { probe?: ShutdownDeps["probe"]; exec?: ShutdownDeps["exec"]; stopsAfterMs?: number }) {
  let t = 0;
  const cmds: string[] = [];
  const deps: Partial<ShutdownDeps> = {
    probe: o.probe ?? (async () => "ok"),
    exec: o.exec ?? (async (_ep, cmd) => (cmds.push(cmd), ok)),
    sleep: async (ms) => void (t += ms),
    now: () => t,
    timeoutMs: 120_000,
  };
  const running = async () => o.stopsAfterMs === undefined || t < o.stopsAfterMs;
  return { deps, running, cmds, elapsed: () => t };
}

test("shutdownMacOverSsh: shuts down over ssh and waits until the VM stops", async () => {
  const h = harness({ stopsAfterMs: 8000 });
  assert.equal(await shutdownMacOverSsh(ep, h.running, h.deps), true);
  assert.deepEqual(h.cmds, ["sudo -n shutdown -h now"]);
  assert.equal(h.elapsed(), 8000);
});

test("shutdownMacOverSsh: an ssh session dropped by the shutdown still counts", async () => {
  const h = harness({ exec: async () => ({ code: 255, stdout: "", stderr: "Connection closed by remote host" }), stopsAfterMs: 3000 });
  assert.equal(await shutdownMacOverSsh(ep, h.running, h.deps), true);
  const thrown = harness({ exec: async () => Promise.reject(new Error("timeout")), stopsAfterMs: 3000 });
  assert.equal(await shutdownMacOverSsh(ep, thrown.running, thrown.deps), true);
});

test("shutdownMacOverSsh: falls back when ssh doesn't answer, can't run, or sudo wants a password", async () => {
  for (const probe of [async () => "down" as const, async () => "auth" as const]) {
    const h = harness({ probe });
    assert.equal(await shutdownMacOverSsh(ep, h.running, h.deps), false);
    assert.equal(h.cmds.length, 0);
  }
  // No ssh client on the host: sshBin() throws inside the probe.
  const noSsh = harness({ probe: async () => Promise.reject(new Error("ssh not found")) });
  assert.equal(await shutdownMacOverSsh(ep, noSsh.running, noSsh.deps), false);
  const sudo = harness({ exec: async () => ({ code: 1, stdout: "", stderr: "sudo: a password is required" }) });
  assert.equal(await shutdownMacOverSsh(ep, sudo.running, sudo.deps), false);
  assert.equal(sudo.elapsed(), 0, "no wait when the shutdown never started");
});

test("shutdownMacOverSsh: gives up at the deadline, and never throws", async () => {
  const h = harness({});
  assert.equal(await shutdownMacOverSsh(ep, h.running, h.deps), false);
  assert.equal(h.elapsed(), 120_000);
  const broken = harness({});
  assert.equal(await shutdownMacOverSsh(ep, async () => Promise.reject(new Error("docker gone")), broken.deps), false);
});

test("shutdownMacOverSsh: slow ssh and a guest that never stops stay within the caller's budget", async () => {
  let t = 0;
  const timeouts: number[] = [];
  const deps: Partial<ShutdownDeps> = {
    // The probe takes 10 s and the shutdown command runs until its timeout.
    probe: async () => ((t += 10_000), "ok"),
    exec: async (_ep, _cmd, o) => ((timeouts.push(o?.timeoutMs ?? 0), (t += o?.timeoutMs ?? 0)), { code: 255, stdout: "", stderr: "timed out" }),
    sleep: async (ms) => void (t += ms),
    now: () => t,
    timeoutMs: 80_000,
  };
  assert.equal(await shutdownMacOverSsh(ep, async () => true, deps), false);
  assert.ok(t <= 81_000, `took ${t} ms of an 80 s budget`);
  assert.deepEqual(timeouts, [30_000]);
  // With less budget than the command's usual 30 s, the command gets only what's left.
  t = 0;
  timeouts.length = 0;
  assert.equal(await shutdownMacOverSsh(ep, async () => true, { ...deps, timeoutMs: 25_000 }), false);
  assert.deepEqual(timeouts, [15_000]);
  assert.ok(t <= 26_000, `took ${t} ms of a 25 s budget`);
});
