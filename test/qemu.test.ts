import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { defaultGuests, windowsArch } from "../src/core/config.ts";
import { guestTarget } from "../src/core/act.ts";
import { defaultAccel, qemuArgs, type QemuArgsInput } from "../src/backends/qemu.ts";
import { macCpu, macQemuArgs, type MacQemuArgsInput } from "../src/backends/qemu-macos.ts";
import { backendFor } from "../src/backends/index.ts";

const base: QemuArgsInput = {
  arch: "aarch64",
  accel: "hvf",
  platform: "darwin",
  cpus: 4,
  memory: "8G",
  storage: "/s",
  sshPort: 2222,
  vncDisplay: 1,
  monitor: "/s/m.sock",
  serialLog: "/s/serial.log",
  pidFile: "/s/q.pid",
  mac: "02:05:00:00:00:01",
};
const opt = (args: string[], flag: string) => args.filter((_, i) => args[i - 1] === flag);

test("defaultAccel picks the host's hypervisor when guest and host CPU match, else emulation", () => {
  assert.equal(defaultAccel("aarch64", "darwin", "arm64", false), "hvf");
  assert.equal(defaultAccel("aarch64", "linux", "arm64", true), "kvm");
  assert.equal(defaultAccel("aarch64", "linux", "arm64", false), "tcg");
  assert.equal(defaultAccel("aarch64", "win32", "arm64", false), "whpx");
  assert.equal(defaultAccel("aarch64", "linux", "x64", true), "tcg");
  assert.equal(defaultAccel("aarch64", "darwin", "x64", false), "tcg");
  assert.equal(defaultAccel("x86_64", "darwin", "x64", false), "hvf");
  assert.equal(defaultAccel("x86_64", "linux", "x64", true), "kvm");
  assert.equal(defaultAccel("x86_64", "darwin", "arm64", false), "tcg");
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

test("qemuArgs: x64 Windows on a q35 machine with the host CPU, SATA install CD and no ARM-only devices", () => {
  const a = qemuArgs({ ...base, arch: "x86_64", installMedia: { iso: "/s/w.iso", setup: "/s/setup.img" } });
  assert.ok(opt(a, "-machine")[0].startsWith("type=q35,"));
  assert.deepEqual(opt(a, "-cpu"), ["host"]);
  assert.ok(opt(a, "-device").includes("virtio-vga") && !opt(a, "-device").includes("ramfb") && !opt(a, "-device").includes("usb-kbd"));
  assert.ok(opt(a, "-device").includes("ide-cd,drive=boot,bus=ahciboot.0,bootindex=9"));
  assert.equal(a.filter((x) => x.startsWith("usb-storage")).length, 1, "only setup.img is a USB drive");
  assert.ok(opt(a, "-global").includes("ICH9-LPC.disable_s3=1"));
  const kvm = qemuArgs({ ...base, arch: "x86_64", accel: "kvm", platform: "linux" });
  assert.ok(opt(kvm, "-cpu")[0].startsWith("host,") && opt(kvm, "-cpu")[0].includes("hv_passthrough"));
  assert.deepEqual(opt(qemuArgs({ ...base, arch: "x86_64", accel: "tcg" }), "-cpu"), ["max"]);
});

test("qemuArgs: WHPX on Windows on ARM uses GICv3 and a TCP monitor", () => {
  const a = qemuArgs({ ...base, accel: "whpx", platform: "win32", monitor: 4444 });
  assert.deepEqual(opt(a, "-accel"), ["whpx"]);
  assert.ok(opt(a, "-machine")[0].includes("gic-version=3"));
  assert.deepEqual(opt(a, "-monitor"), ["tcp:127.0.0.1:4444,server=on,wait=off"]);
  assert.ok(opt(a, "-drive")[0].includes("cache=writeback"));
});

test("Macs and Windows on ARM get a Windows guest on the qemu backend that matches their CPU", () => {
  assert.equal(defaultGuests("darwin", "arm64").windows?.backend, "qemu");
  assert.equal(defaultGuests("darwin", "arm64").windows?.image, "dockurr/windows-arm");
  assert.equal(defaultGuests("darwin", "arm64").macos?.backend, "tart");
  assert.equal(defaultGuests("darwin", "x64").windows?.backend, "qemu");
  assert.equal(defaultGuests("darwin", "x64").windows?.image, "dockurr/windows");
  assert.equal(defaultGuests("darwin", "x64").windows?.version, "2025");
  assert.equal(defaultGuests("win32", "arm64").windows?.backend, "qemu");
  assert.equal(defaultGuests("win32", "arm64").windows?.image, "dockurr/windows-arm");
  assert.equal(defaultGuests("win32", "x64").windows?.backend, "dockur");
  assert.equal(defaultGuests("linux", "x64").windows?.backend, "dockur");
  assert.equal(defaultGuests("linux", "arm64").windows?.backend, "dockur");
});

test("a qemu guest's CPU, and the act it needs, follow its image or else the host", () => {
  assert.equal(windowsArch({ image: "dockurr/windows" }, "arm64"), "x86_64");
  assert.equal(windowsArch({ image: "dockurr/windows-arm" }, "x64"), "aarch64");
  assert.equal(windowsArch({}, "arm64"), "aarch64");
  assert.equal(windowsArch({}, "x64"), "x86_64");
  assert.equal(guestTarget({ name: "w", os: "windows", backend: "qemu", image: "dockurr/windows" }), "windows/amd64");
  assert.equal(guestTarget({ name: "w", os: "windows", backend: "qemu", image: "dockurr/windows-arm" }), "windows/arm64");
});

const mac: MacQemuArgsInput = {
  accel: "hvf",
  platform: "darwin",
  amdHost: false,
  cpus: 4,
  memory: "8G",
  storage: "/s/15",
  picker: false,
  uuid: "00000000-0000-4000-8000-000000000001",
  mac: "00:16:cb:00:00:01",
  osk: "key",
  sshPort: 2223,
  vncDisplay: 2,
  monitor: "/s/m.sock",
  serialLog: "/s/serial.log",
  pidFile: "/s/q.pid",
};

test("macQemuArgs: dockur's macOS machine on the host's QEMU, OpenCore with or without its boot menu", () => {
  const a = macQemuArgs(mac);
  assert.deepEqual(opt(a, "-accel"), ["hvf"]);
  assert.ok(opt(a, "-cpu")[0].startsWith("host,vendor=GenuineIntel,"));
  assert.deepEqual(opt(a, "-vga"), ["vmware"]);
  assert.ok(opt(a, "-device").includes("isa-applesmc,osk=key"));
  // path.join: the storage path uses the host's separators.
  const file = (n: string) => `file=${path.join("/s/15", n)},`;
  assert.ok(opt(a, "-drive").some((d) => d.startsWith(file("base.dmg")) && d.includes("format=dmg")));
  assert.ok(opt(a, "-drive").some((d) => d.startsWith(file("boot.img"))));
  assert.ok(opt(macQemuArgs({ ...mac, picker: true }), "-drive").some((d) => d.startsWith(file("boot-picker.img"))));
  assert.deepEqual(opt(a, "-netdev"), ["user,id=hostnet0,hostfwd=tcp:127.0.0.1:2223-:22"]);
  assert.deepEqual(opt(a, "-uuid"), [mac.uuid]);
});

test("macCpu: the host CPU on Intel; an Intel model on AMD hosts and under emulation", () => {
  assert.ok(macCpu("hvf", false).startsWith("host,"));
  assert.ok(macCpu("kvm", true).startsWith("Skylake-Client-v4,") && macCpu("kvm", true).includes("+invtsc"));
  assert.ok(macCpu("tcg", false).startsWith("Skylake-Client-v4,") && macCpu("tcg", false).includes("-xsaves"));
});

test("Intel Macs run their macOS guest on the host's QEMU; Linux keeps dockur", () => {
  const intel = defaultGuests("darwin", "x64").macos!;
  assert.equal(intel.backend, "qemu");
  assert.equal(intel.image, "dockurr/macos");
  assert.ok(intel.homebrew, "Intel guests get the pinned Homebrew");
  assert.equal(backendFor(intel).constructor.name, "QemuMacBackend");
  assert.equal(backendFor(defaultGuests("darwin", "x64").windows!).constructor.name, "QemuBackend");
  assert.equal(defaultGuests("linux", "x64").macos?.backend, "dockur");
  assert.equal(guestTarget(intel), "darwin/amd64");
});
