import assert from "node:assert/strict";
import { test } from "node:test";
import type { Backend, GuestStatus, Viewer } from "../src/backends/types.ts";
import type { GuestConfig } from "../src/core/config.ts";
import { viewerFor, type Guest } from "../src/env.ts";

function guest(cfg: Partial<GuestConfig>, status: Partial<GuestStatus>, extra: Partial<Backend> = {}): Guest {
  const full = { name: "g", os: "windows", backend: "dockur", ...cfg } as GuestConfig;
  const backend = { cfg: full, status: async () => ({ name: "g", os: full.os, backend: full.backend, state: "ready", ...status }), ...extra } as unknown as Backend;
  return { cfg: full, backend };
}

test("viewer: dockur's web viewer at the port Docker published, not the configured one", async () => {
  const v = await viewerFor(guest({ web_port: 8006 }, { ports: { web: 8011, vnc: 5901 } }));
  assert.equal(v.kind, "web");
  assert.equal(v.url, "http://127.0.0.1:8011");
});

test("viewer: a guest without a web viewer gets its VNC display", async () => {
  const v = await viewerFor(guest({ backend: "qemu" }, { ports: { ssh: 2222, vnc: 5912 } }, { vnc: async () => ({ host: "127.0.0.1", port: 5912 }) }));
  assert.equal(v.kind, "vnc");
  assert.equal(v.url, "vnc://127.0.0.1:5912");
});

test("viewer: a backend's own viewer wins (tart's Screen Sharing)", async () => {
  const own: Viewer = { kind: "vnc", url: "vnc://192.168.64.5", how: "Screen Sharing" };
  const v = await viewerFor(guest({ backend: "tart", os: "macos" }, {}, { viewer: async () => own }));
  assert.equal(v.url, own.url);
});

test("viewer: stopped, absent, container and ssh guests are refused", async () => {
  await assert.rejects(viewerFor(guest({}, { state: "stopped" })), /stopped; start it first/);
  await assert.rejects(viewerFor(guest({}, { state: "absent" })), /absent/);
  await assert.rejects(viewerFor(guest({ backend: "container", os: "linux" }, {})), /container guest/);
  await assert.rejects(viewerFor(guest({ backend: "ssh" }, {})), /ssh guest/);
  await assert.rejects(viewerFor(guest({ backend: "qemu" }, { ports: { ssh: 2222 } })), /no display/);
});

test("viewer: no login or credentials, since guests open on the desktop", async () => {
  const v = await viewerFor(guest({ user: "osmatrix" }, { ports: { web: 8006 } }));
  assert.deepEqual(Object.keys(v).sort(), ["guest", "how", "kind", "url"]);
  assert.doesNotMatch(JSON.stringify(v), /osmatrix|password|credentials/i);
});
