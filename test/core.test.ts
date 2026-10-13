import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ActJsonParser, actDifferenceHints, macToolCacheCmd, powershell } from "../src/ci/run.ts";
import { defaultGuests, labelMatches, mergeConfig, defaultConfig } from "../src/core/config.ts";
import { commandLine, quotePosix, quotePwsh, withCwd } from "../src/core/ssh.ts";
import { encodePng } from "../src/gui.ts";
import { bootBudget, bootHang } from "../src/env.ts";

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
  assert.deepEqual(Object.keys(defaultGuests("darwin", "arm64")).sort(), ["macos", "ubuntu", "windows"]);
  assert.deepEqual(Object.keys(defaultGuests("darwin", "x64")).sort(), ["macos", "ubuntu"]);
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

test("failures that mention act's file-command paths get an act-difference hint", () => {
  const container = "  | refusing GITHUB_OUTPUT outside RUNNER_TEMP/GITHUB_WORKSPACE: /run/act/workflow/outputcmd.txt";
  assert.match(actDifferenceHints(container)[0], /^the failure mentions \/run\/act\/workflow\/outputcmd\.txt: .*env\.ACT/);
  assert.equal(actDifferenceHints("bad path C:/Users/u/.cache/act/1f2e/act/workflow/envs.txt").length, 1);
  // act's own step script paths live in the same directory and are not file commands.
  assert.deepEqual(actDifferenceHints("🐳 docker exec cmd=[bash -e /var/run/act/workflow/resolve]\nexit 1"), []);
});

test("PowerShell scripts run as-is on pwsh endpoints and encoded on cmd ones", () => {
  const script = `Remove-Item -Force -LiteralPath 'a b/"c"' & echo ü`;
  assert.equal(powershell({ shell: "pwsh" }, script), script);
  const m = /^powershell -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(powershell({ shell: "cmd" }, script));
  assert.ok(m);
  assert.equal(Buffer.from(m[1], "base64").toString("utf16le"), script);
});

test("macOS tool cache check repairs only what isn't owned, writable and searchable, and reports a failed repair", { skip: process.platform === "win32" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-toolcache-"));
  try {
    // A stand-in sudo that records its arguments and runs them without root. chown is only recorded:
    // the test's files already belong to the test user, and Linux has no "staff" group.
    // OSMATRIX_TEST_SUDO_FAIL makes it fail, like sudo -n without passwordless sudo.
    const calls = path.join(tmp, "sudo-calls");
    fs.mkdirSync(path.join(tmp, "bin"));
    const fake = `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\n[ -z "$OSMATRIX_TEST_SUDO_FAIL" ] || exit 1\n[ "$1" = -n ] && shift\n[ "$1" = chown ] && exit 0\nexec "$@"\n`;
    fs.writeFileSync(path.join(tmp, "bin", "sudo"), fake, { mode: 0o755 });
    const sh = (cmd: string, env: Record<string, string> = {}) =>
      spawnSync("sh", ["-c", cmd], { env: { ...process.env, ...env, PATH: `${path.join(tmp, "bin")}:${process.env.PATH}` } }).status;
    const sudoCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : []);
    const runner = path.join(tmp, "runner");
    const cache = path.join(runner, "hostedtoolcache");

    // Missing: created, given to the user, and the postcondition holds.
    assert.equal(sh(macToolCacheCmd(cache)), 0);
    const lines = sudoCalls();
    assert.equal(lines[0], `-n mkdir -p ${cache}`);
    assert.match(lines[1], new RegExp(`^-n chown -R \\S+:staff ${runner}$`));
    assert.equal(lines[2], `-n chmod u+rwx ${runner} ${cache}`);
    fs.rmSync(calls);

    // Already fine: no sudo at all.
    assert.equal(sh(macToolCacheCmd(cache)), 0);
    assert.deepEqual(sudoCalls(), []);

    // Read-only (root ignores permission bits, so only meaningful for a normal user).
    if (process.getuid?.() !== 0) {
      fs.chmodSync(cache, 0o555);
      assert.equal(sh(macToolCacheCmd(cache)), 0);
      assert.equal(sudoCalls().length, 3);
      fs.accessSync(cache, fs.constants.W_OK | fs.constants.X_OK);
      fs.rmSync(calls);

      // A repair that fails leaves the postcondition unmet, so the command fails and the leg warns.
      fs.chmodSync(cache, 0o555);
      assert.notEqual(sh(macToolCacheCmd(cache), { OSMATRIX_TEST_SUDO_FAIL: "1" }), 0);
      fs.chmodSync(cache, 0o755);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("bootBudget scales with the slowest recent boot", () => {
  assert.equal(bootBudget([]), 600);
  assert.equal(bootBudget([40, 60]), 240);
  assert.equal(bootBudget([90, 200]), 600);
});

test("bootHang tells a hung boot from a slow one", () => {
  const base = { elapsedSec: 300, budgetSec: 240, ioIdleSec: 0, resets: 0 };
  assert.equal(bootHang(base), undefined, "disk still busy: slow, not hung");
  assert.equal(bootHang({ ...base, elapsedSec: 200, ioIdleSec: 200 }), undefined, "within budget");
  assert.match(bootHang({ ...base, ioIdleSec: 130 }) ?? "", /disk has been idle/);
  assert.match(bootHang({ ...base, resets: 3 }) ?? "", /reset loop/);
});
