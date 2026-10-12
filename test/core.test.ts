import assert from "node:assert/strict";
import { test } from "node:test";
import { ActJsonParser, actDifferenceHints, powershell } from "../src/ci/run.ts";
import {
  DEFAULT_HOMEBREW,
  defaultConfig,
  defaultGuests,
  guestHomebrew,
  homebrewProvisionEnv,
  labelMatches,
  mergeConfig,
  type GuestConfig,
} from "../src/core/config.ts";
import { commandLine, quotePosix, quotePwsh, withCwd } from "../src/core/ssh.ts";
import { encodePng } from "../src/gui.ts";
import { bootBudget, bootHang, macProvisionCommand } from "../src/env.ts";

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

test("Intel macOS guests get the pinned Homebrew by default", () => {
  const mac = defaultGuests("linux", "x64").macos;
  assert.deepEqual(mac.homebrew, DEFAULT_HOMEBREW);
  assert.deepEqual(guestHomebrew(mac), DEFAULT_HOMEBREW);
  assert.match(DEFAULT_HOMEBREW.core, /^[0-9a-f]{40}$/);
  assert.deepEqual(homebrewProvisionEnv(mac), { OSMATRIX_BREW_TAG: DEFAULT_HOMEBREW.brew, OSMATRIX_BREW_CORE: DEFAULT_HOMEBREW.core });
  // ssh guests have no default entry; they get the default pins too.
  assert.deepEqual(guestHomebrew({ name: "mini", os: "macos", backend: "ssh" }), DEFAULT_HOMEBREW);
  // Apple Silicon (tart) guests install current Homebrew; the provisioning script ignores the pins there.
  assert.equal(defaultGuests("darwin", "arm64").macos.homebrew, undefined);
});

test("homebrew config: opt out, partial override, invalid values", () => {
  const off = mergeConfig(defaultConfig(), { guests: { macos: { os: "macos", backend: "dockur", homebrew: false } } }).guests.macos;
  assert.equal(guestHomebrew(off), undefined);
  assert.deepEqual(homebrewProvisionEnv(off), { OSMATRIX_HOMEBREW: "0" });
  const sha = "0".repeat(40);
  const core = mergeConfig(defaultConfig(), { guests: { macos: { os: "macos", backend: "dockur", homebrew: { core: sha } } } }).guests.macos;
  assert.deepEqual(guestHomebrew(core), { brew: DEFAULT_HOMEBREW.brew, core: sha });
  const g = (homebrew: unknown) => ({ name: "m", os: "macos", backend: "dockur", homebrew }) as GuestConfig;
  assert.throws(() => guestHomebrew(g({ core: "a5783fb" })), /full 40-character/);
  assert.throws(() => guestHomebrew(g({ brew: "6.0.22; rm -rf /" })), /release tag/);
  assert.throws(() => guestHomebrew(g(true)), /false or a table/);
});

test("macOS provisioning command carries the Homebrew pins", () => {
  const mac = defaultGuests("linux", "x64").macos;
  assert.equal(macProvisionCommand(mac, "-s"), `OSMATRIX_BREW_TAG=${DEFAULT_HOMEBREW.brew} OSMATRIX_BREW_CORE=${DEFAULT_HOMEBREW.core} bash -s`);
  assert.equal(macProvisionCommand({ ...mac, homebrew: false }, "~/p.sh --passwordless-sudo"), "OSMATRIX_HOMEBREW=0 bash ~/p.sh --passwordless-sudo");
});
