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
