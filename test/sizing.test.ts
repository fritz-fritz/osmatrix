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
  assert.equal(requirements(win).diskGB?.min, 40);
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
