import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuestConfig } from "../src/core/config.ts";
import { checkSizing, parseSizeGB, requirements } from "../src/core/sizing.ts";

const host = { cpus: 16, memoryGB: 32 };
const win: GuestConfig = { name: "windows", os: "windows", backend: "dockur", image: "dockurr/windows" };

test("parseSizeGB accepts docker/QEMU style sizes", () => {
  assert.equal(parseSizeGB("8G"), 8);
  assert.equal(parseSizeGB("8GB"), 8);
  assert.equal(parseSizeGB("8GiB"), 8);
  assert.equal(parseSizeGB("8192M"), 8);
  assert.equal(parseSizeGB("1T"), 1024);
  assert.equal(parseSizeGB("12"), 12);
  assert.throws(() => parseSizeGB("lots"), /invalid size/);
});

test("requirements differ by guest kind", () => {
  // The MSVC Build Tools (default) don't raise the hard minimum: existing 40G guests must keep working.
  assert.equal(requirements(win).diskGB?.min, 40);
  assert.equal(requirements({ ...win, msvc: false }).diskGB?.min, 40);
  assert.equal(requirements(win).footprintGB, 20);
  assert.equal(requirements({ ...win, msvc: false }).footprintGB, 12);
  assert.match(requirements(win).note ?? "", /msvc = false/);
  assert.equal(requirements({ ...win, image: "dockurr/windows-arm" }).diskGB?.min, 64);
  assert.equal(requirements({ os: "macos", backend: "tart" }).diskGB, undefined);
  assert.equal(requirements({ os: "linux", backend: "container" }).memoryGB.min, 1);
});

test("checkSizing rejects what cannot work and warns below the recommendation", () => {
  assert.deepEqual(checkSizing({ ...win, cpus: 4, memory: "8G", disk: "64G" }, host), { errors: [], warnings: [] });
  assert.match(checkSizing({ ...win, memory: "2G" }, host).errors.join(), /below the minimum of 4G/);
  assert.match(checkSizing({ ...win, memory: "6G" }, host).warnings.join(), /below the recommended 8G/);
  assert.match(checkSizing({ ...win, memory: "30G" }, host).errors.join(), /too little for the host/);
  assert.match(checkSizing({ ...win, cpus: 32 }, host).errors.join(), /exceeds the host's 16/);
  assert.match(checkSizing({ ...win, cpus: 1 }, host).errors.join(), /below the minimum of 2/);
  assert.match(checkSizing({ ...win, disk: "32G" }, host).errors.join(), /below the minimum of 40G/);
  assert.match(checkSizing({ ...win, disk: "48G" }, host, { disk: "64G" }).errors.join(), /can only grow/);
  assert.deepEqual(checkSizing({ ...win, disk: "128G" }, host, { disk: "64G" }).errors, []);
});

test("an existing 40G Windows config still passes; the MSVC Build Tools only warn", () => {
  const existing = checkSizing({ ...win, cpus: 4, memory: "8G", disk: "40G" }, host, { disk: "40G" });
  assert.deepEqual(existing.errors, []);
  assert.match(existing.warnings.join(), /MSVC Build Tools need about 8G more \(48G or more\); raise disk or set msvc = false/);
  assert.deepEqual(checkSizing({ ...win, disk: "47G" }, host).errors, []);
  assert.equal(checkSizing({ ...win, disk: "47G" }, host).warnings.length, 1);
  assert.deepEqual(checkSizing({ ...win, disk: "48G" }, host).warnings, []);
  assert.deepEqual(checkSizing({ ...win, msvc: false, disk: "40G" }, host), { errors: [], warnings: [] });
  // Windows 11 ARM's 64G minimum already has room.
  assert.deepEqual(checkSizing({ ...win, image: "dockurr/windows-arm", disk: "64G" }, host).warnings, []);
});

test("sizes reject malformed numbers; sizeMiB gives docker/tart units", async () => {
  const { sizeMiB } = await import("../src/core/sizing.ts");
  for (const bad of [".", "1.2.3", "G", "-1G", ""]) assert.throws(() => parseSizeGB(bad), /invalid size/, bad);
  assert.equal(sizeMiB("8"), 8192);
  assert.equal(sizeMiB("8G"), 8192);
  assert.equal(sizeMiB("1536M"), 1536);
});
