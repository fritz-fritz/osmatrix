import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// A throwaway install with one tart guest; the viewer server only reads the guest's tart log.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-viewer-home-"));
process.env.OSMATRIX_HOME = home;
fs.writeFileSync(path.join(home, "config.toml"), '[guests.mac]\nos = "macos"\nbackend = "tart"\n');
fs.mkdirSync(path.join(home, "guests", "mac"), { recursive: true });
fs.writeFileSync(path.join(home, "guests", "mac", "tart-run.log"), "VNC server is running at vnc://:a-b-c-d@127.0.0.1:1\n");

const env = await import("../src/env.ts");
const { loadState } = await import("../src/core/state.ts");
const { isAlive } = await import("../src/core/proc.ts");

test("viewer server: concurrent callers share one server, and stopping it leaves nothing running", async () => {
  const ports = await Promise.all([env.ensureViewerServer("mac"), env.ensureViewerServer("mac"), env.ensureViewerServer("mac")]);
  assert.equal(new Set(ports).size, 1, `one server, got ports ${ports.join(", ")}`);
  const rec = loadState().viewers.mac;
  assert.equal(rec.port, ports[0]);
  assert.equal((await fetch(`http://127.0.0.1:${rec.port}/`)).status, 200);
  await env.stopViewer("mac");
  for (let i = 0; i < 50 && isAlive(rec.pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(isAlive(rec.pid), false);
  assert.equal(loadState().viewers.mac, undefined);
});
