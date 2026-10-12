import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultGuests } from "../src/core/config.ts";
import { defaultAccel, qemuArgs, type QemuArgsInput } from "../src/backends/qemu.ts";

const base: QemuArgsInput = {
  accel: "hvf",
  platform: "darwin",
  cpus: 4,
  memory: "8G",
  storage: "/s",
  sshPort: 2222,
  vncDisplay: 1,
  monitorSocket: "/s/m.sock",
  serialLog: "/s/serial.log",
  pidFile: "/s/q.pid",
  mac: "02:05:00:00:00:01",
};
const opt = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);

test("defaultAccel picks the host's hypervisor for an aarch64 guest", () => {
  assert.equal(defaultAccel("darwin", "arm64", false), "hvf");
  assert.equal(defaultAccel("linux", "arm64", true), "kvm");
  assert.equal(defaultAccel("linux", "arm64", false), "tcg");
  assert.equal(defaultAccel("linux", "x64", true), "tcg");
  assert.equal(defaultAccel("darwin", "x64", false), "tcg");
});

test("qemuArgs: HVF on macOS uses the host CPU, no Linux-only disk options, loopback-only ssh and VNC", () => {
  const a = qemuArgs(base);
  assert.deepEqual(opt(a, "-accel"), ["hvf"]);
  assert.deepEqual(opt(a, "-cpu"), ["host"]);
  assert.ok(opt(a, "-drive")[0].includes("cache=writeback") && !a.join(" ").includes("aio=native"));
  assert.deepEqual(opt(a, "-netdev"), ["user,id=hostnet0,hostfwd=tcp:127.0.0.1:2222-:22"]);
  assert.deepEqual(opt(a, "-display"), ["vnc=127.0.0.1:1"]);
  assert.ok(!a.join(" ").includes("usb-storage"), "no install media once installed");
});

test("qemuArgs: TCG emulates a named CPU; install media attach as USB drives after the disk", () => {
  const a = qemuArgs({ ...base, accel: "tcg", platform: "linux", installMedia: { iso: "/s/w.iso", setup: "/s/setup.img" } });
  assert.deepEqual(opt(a, "-accel"), ["tcg,thread=multi"]);
  assert.deepEqual(opt(a, "-cpu"), ["cortex-a76"]);
  assert.ok(a.join(" ").includes("aio=native"));
  assert.equal(a.filter((x) => x.startsWith("usb-storage")).length, 2);
  assert.ok(a.some((x) => x.includes("bootindex=9")) && a.some((x) => x.includes("bootindex=3")));
});

test("Apple Silicon Macs get a Windows guest on the qemu backend; Intel Macs don't", () => {
  assert.equal(defaultGuests("darwin", "arm64").windows?.backend, "qemu");
  assert.equal(defaultGuests("darwin", "arm64").macos?.backend, "tart");
  assert.equal(defaultGuests("darwin", "x64").windows, undefined);
  assert.equal(defaultGuests("linux", "x64").windows?.backend, "dockur");
});
