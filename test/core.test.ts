import assert from "node:assert/strict";
import { test } from "node:test";
import { ActJsonParser, powershell } from "../src/ci/run.ts";
import { defaultGuests, labelMatches, mergeConfig, defaultConfig } from "../src/core/config.ts";
import { commandLine, quotePosix, quotePwsh, withCwd } from "../src/core/ssh.ts";
import { encodePng } from "../src/gui.ts";

test("posix quoting", () => {
  assert.equal(quotePosix("abc"), "abc");
  assert.equal(quotePosix("a b"), "'a b'");
  assert.equal(quotePosix("it's"), `'it'\\''s'`);
});

test("pwsh quoting and command lines", () => {
  assert.equal(quotePwsh("C:\\work\\x"), "C:\\work\\x");
  assert.equal(quotePwsh("it's here"), "'it''s here'");
  assert.equal(commandLine("pwsh", ["act", "-P", "windows-latest=-self-hosted"]), "& act -P windows-latest=-self-hosted");
  assert.equal(withCwd("pwsh", "work/r", "x"), "Set-Location -LiteralPath work/r; x");
  assert.equal(withCwd("posix", "work/my repo", "x"), "cd 'work/my repo' && x");
});

test("default guests per host", () => {
  assert.deepEqual(Object.keys(defaultGuests("darwin", "arm64")).sort(), ["macos", "ubuntu"]);
  assert.equal(defaultGuests("darwin", "arm64").macos.backend, "tart");
  assert.deepEqual(Object.keys(defaultGuests("linux", "x64")).sort(), ["macos", "ubuntu", "windows"]);
  assert.deepEqual(Object.keys(defaultGuests("win32", "x64")).sort(), ["macos", "ubuntu", "windows"]);
  assert.equal(defaultGuests("linux", "arm64").windows.image, "dockurr/windows-arm");
});

test("config merge: override, add ssh guest, disable guest", () => {
  const c = mergeConfig(defaultConfig(), {
    max_vms: 1,
    guests: {
      ubuntu: { ssh_port: 3000 },
      mac_mini: { os: "macos", backend: "ssh", host: "mini.local", labels: ["macos-*"] },
      windows: { enabled: false },
    },
  });
  assert.equal(c.max_vms, 1);
  assert.equal(c.guests.ubuntu.ssh_port, 3000);
  assert.equal(c.guests.ubuntu.backend, "container");
  assert.equal(c.guests.mac_mini.host, "mini.local");
  assert.equal(c.guests.windows, undefined);
  assert.throws(() => mergeConfig(defaultConfig(), { guests: { x: { host: "y" } } }));
});

test("label globs", () => {
  const g = defaultGuests("linux", "x64");
  assert.ok(labelMatches("windows-2025", g.windows));
  assert.ok(labelMatches("ubuntu-24.04", g.ubuntu));
  assert.ok(!labelMatches("ubuntu-24.04", g.windows));
});

test("act json parser tracks failing step", () => {
  const lines: string[] = [];
  const p = new ActJsonParser((l) => lines.push(l));
  p.feed(JSON.stringify({ msg: "hello\n", raw_output: true, step: "Run tests" }) + "\n");
  p.feed(JSON.stringify({ msg: "  ✅  Success - Main Show", step: "Show", stepResult: "success" }) + "\n");
  p.feed(JSON.stringify({ msg: "  ❌  Failure - Main Run tests", step: "Run tests", stepResult: "failure" }) + "\nplain line");
  p.flush();
  assert.equal(p.failedStep, "Run tests");
  assert.deepEqual(p.steps.map((s) => s.result), ["success", "failure"]);
  assert.ok(lines.includes("  | hello"));
  assert.ok(lines.includes("plain line"));
});

test("png encoder emits a valid header", () => {
  const png = encodePng(2, 1, Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 2);
});

test("PowerShell scripts run as-is on pwsh endpoints and encoded on cmd ones", () => {
  const script = `Remove-Item -Force -LiteralPath 'a b/"c"' & echo ü`;
  assert.equal(powershell({ shell: "pwsh" }, script), script);
  const m = /^powershell -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(powershell({ shell: "cmd" }, script));
  assert.ok(m);
  assert.equal(Buffer.from(m[1], "base64").toString("utf16le"), script);
});
