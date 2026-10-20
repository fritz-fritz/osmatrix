import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// A throwaway install with two tart guests; the viewer server only reads a guest's tart log.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-viewer-home-"));
process.env.OSMATRIX_HOME = home;
fs.writeFileSync(path.join(home, "config.toml"), '[guests.mac]\nos = "macos"\nbackend = "tart"\n\n[guests.mac2]\nos = "macos"\nbackend = "tart"\n');
for (const g of ["mac", "mac2"]) {
  fs.mkdirSync(path.join(home, "guests", g), { recursive: true });
  fs.writeFileSync(path.join(home, "guests", g, "tart-run.log"), "VNC server is running at vnc://:a-b-c-d@127.0.0.1:1\n");
}

const env = await import("../src/env.ts");
const { isAlive } = await import("../src/core/proc.ts");

// The fake guests have no tart behind them; treat them as running.
const up = async () => true;

async function stopped(pid: number) {
  for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !isAlive(pid);
}

test("viewer server: concurrent callers for two guests each share one server, and stopping leaves nothing running", async () => {
  const urls = await Promise.all(["mac", "mac2", "mac", "mac2", "mac"].map((g) => env.ensureViewerServer(g, up)));
  for (const u of urls) assert.match(u, /^http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]{20,}$/);
  const ports = urls.map((u) => new URL(u).port).map(Number);
  assert.equal(new Set([ports[0], ports[2], ports[4]]).size, 1, `mac: one server, got ${ports}`);
  assert.equal(ports[1], ports[3], `mac2: one server, got ${ports}`);
  assert.notEqual(ports[0], ports[1]);
  const recs = ["mac", "mac2"].map((g) => env.viewerRecord(g)!);
  assert.deepEqual(recs.map((r) => r.port), [ports[0], ports[1]]);
  assert.equal((await fetch(`http://127.0.0.1:${ports[0]}/`)).status, 200);
  await Promise.all([env.stopViewer("mac"), env.stopViewer("mac2")]);
  for (const r of recs) assert.ok(await stopped(r.pid), `pid ${r.pid} stopped`);
  assert.equal(env.viewerRecord("mac"), undefined);
  assert.equal(env.viewerRecord("mac2"), undefined);
});

test("viewer server: a port answered by some other program isn't taken for the viewer, and its pid isn't signalled", async () => {
  const decoy = http.createServer((_req, res) => res.end("not osmatrix"));
  await new Promise<void>((r) => decoy.listen(0, "127.0.0.1", r));
  const decoyPort = (decoy.address() as net.AddressInfo).port;
  try {
    // A record whose process is alive and whose port some other program now answers on.
    const { spawn } = await import("node:child_process");
    const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    fs.writeFileSync(path.join(home, "guests", "mac", "viewer.json"), JSON.stringify({ pid: dummy.pid, port: decoyPort, id: "stale" }));
    const port = Number(new URL(await env.ensureViewerServer("mac", up)).port);
    assert.notEqual(port, decoyPort);
    assert.ok(isAlive(dummy.pid!), "a stale record's pid may be another program's: it is left alone");
    dummy.kill();
    const rec = env.viewerRecord("mac")!;
    assert.equal(rec.port, port);
    await env.stopViewer("mac");
    assert.ok(await stopped(rec.pid));
  } finally {
    decoy.close();
  }
});

test("viewer server: stopping with a stale record leaves the recorded pid alone", async () => {
  const { spawn } = await import("node:child_process");
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(home, "guests", "mac2", "viewer.json"), JSON.stringify({ pid: dummy.pid, port: 1, id: "stale" }));
  await env.stopViewer("mac2");
  assert.ok(isAlive(dummy.pid!));
  assert.equal(env.viewerRecord("mac2"), undefined);
  dummy.kill();
});

test("viewer server: a guest that isn't running gets no server", async () => {
  await assert.rejects(env.ensureViewerServer("mac", async () => false), /display isn't up yet/);
  assert.equal(env.viewerRecord("mac"), undefined);
});

test("tart: the VNC address comes from the running VM's run started with it, the latest one in the log", async () => {
  const { TartBackend } = await import("../src/backends/tart.ts");
  const { updateState } = await import("../src/core/state.ts");
  const dir = path.join(home, "guests", "mac");
  const tart = new TartBackend({ name: "mac", os: "macos", backend: "tart" } as never);
  let running = true;
  // No tart here: stand in for `tart list`.
  Object.assign(tart, { list: async () => [{ Name: (tart as unknown as { vm: string }).vm, State: running ? "running" : "stopped" }] });
  fs.writeFileSync(path.join(dir, "tart-run.log"), "VNC server is running at vnc://:old@127.0.0.1:1\nVNC server is running at vnc://:new%25pw@127.0.0.1:5999\n");
  const setPid = (pid?: number) =>
    updateState((s) => {
      if (pid) s.pids.mac = pid;
      else delete s.pids.mac;
    });
  setPid(process.pid);
  fs.writeFileSync(path.join(dir, "tart-run.vnc"), "");
  assert.deepEqual(await tart.vnc(), { host: "127.0.0.1", port: 5999, password: "new%pw" });
  // Our `tart run` gone while tart still lists the VM (going down, or started again by hand): the log's
  // address is stale, and if it stays up it needs a restart.
  setPid();
  await assert.rejects(tart.vnc(), /not from osmatrix's `tart run`/);
  // VM not running (e.g. after a reboot, whatever process has the old pid): nothing.
  setPid(process.pid);
  running = false;
  assert.equal(await tart.vnc(), undefined);
  // Running, but started without tart's VNC server: say to restart it.
  running = true;
  fs.rmSync(path.join(dir, "tart-run.vnc"));
  await assert.rejects(tart.vnc(), /restart it/);
  setPid();
});
