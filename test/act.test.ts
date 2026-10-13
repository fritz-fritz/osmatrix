import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { actDifferenceHints, guestActCurrent, guestActPath, guestActProbe, parseGuestActProbe } from "../src/ci/run.ts";
import {
  ACT_PATCH_FILE,
  GO_IMAGE,
  PATCHED_ACT_VERSION,
  defaultTargets,
  guestTarget,
  hostTarget,
  patchedActKey,
  patchedActVersion,
  resolveAct,
  staleBuilds,
  targetFromArch,
} from "../src/core/act.ts";
import { defaultGuests, type GuestConfig } from "../src/core/config.ts";

test("the patch ships with the package and targets the pinned act", () => {
  const patch = fs.readFileSync(ACT_PATCH_FILE, "utf8");
  for (const f of ["pkg/runner/step.go", "pkg/runner/run_context.go", "pkg/artifacts/artifacts_v4.go"]) assert.match(patch, new RegExp(`^diff --git a/${f} b/${f}$`, "m"));
  assert.match(GO_IMAGE, /^golang:[\d.]+-\w+@sha256:[0-9a-f]{64}$/);
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("assets/act"));
});

test("cache key: act version plus a hash of the patch and toolchain", () => {
  const k = patchedActKey("v0.2.89", "patch A");
  assert.match(k, /^v0\.2\.89-[0-9a-f]{12}$/);
  assert.equal(patchedActKey("v0.2.89", "patch A"), k);
  assert.notEqual(patchedActKey("v0.2.89", "patch B"), k, "a patch change rebuilds");
  assert.notEqual(patchedActKey("v0.2.90", "patch A").split("-")[1], k.split("-")[1]);
  assert.notEqual(patchedActKey("v0.2.89", "patch A", "golang:other@sha256:" + "0".repeat(64)), k, "a toolchain change rebuilds");
  assert.equal(patchedActVersion(k), `0.2.89+osmatrix.${k.split("-")[1]}`);
});

test("build targets: the host's plus what the configured guests need", () => {
  assert.equal(hostTarget("linux", "x64"), "linux/amd64");
  assert.equal(hostTarget("darwin", "arm64"), "darwin/arm64");
  assert.equal(hostTarget("win32", "x64"), "windows/amd64");
  assert.equal(hostTarget("linux", "ia32"), undefined);
  assert.deepEqual(defaultTargets({ guests: defaultGuests("linux", "x64") }, "linux", "x64"), ["darwin/amd64", "linux/amd64", "windows/amd64"]);
  assert.deepEqual(defaultTargets({ guests: defaultGuests("linux", "arm64") }, "linux", "arm64"), ["linux/arm64", "windows/arm64"]);
  assert.deepEqual(defaultTargets({ guests: defaultGuests("darwin", "arm64") }, "darwin", "arm64"), ["darwin/arm64", "windows/arm64"]);
  assert.deepEqual(defaultTargets({ guests: defaultGuests("win32", "x64") }, "win32", "x64"), ["darwin/amd64", "windows/amd64"]);
  const ssh: GuestConfig = { name: "mini", os: "macos", backend: "ssh", host: "mini.local" };
  assert.equal(guestTarget(ssh), undefined, "ssh guests are probed instead");
  assert.equal(guestTarget({ name: "w", os: "windows", backend: "dockur", image: "dockurr/windows-arm" }), "windows/arm64");
});

test("guest architecture from uname -m or .NET's OSArchitecture", () => {
  assert.equal(targetFromArch("macos", "x86_64"), "darwin/amd64");
  assert.equal(targetFromArch("macos", "arm64"), "darwin/arm64");
  assert.equal(targetFromArch("linux", "aarch64"), "linux/arm64");
  assert.equal(targetFromArch("windows", "X64"), "windows/amd64");
  assert.equal(targetFromArch("windows", "Arm64"), "windows/arm64");
  assert.equal(targetFromArch("linux", "riscv64"), undefined);
});

test("which act runs: act_path, then another act_version, then the patched build", () => {
  const lookup = (cmd: string) => (cmd === "act" ? "/usr/bin/act" : undefined);
  const patched = resolveAct({ act_version: PATCHED_ACT_VERSION }, lookup);
  assert.equal(patched.source, "patched", "an act on PATH alone doesn't win");
  assert.deepEqual(resolveAct({ act_version: PATCHED_ACT_VERSION, act_path: "act" }, lookup), { source: "user", configured: "act", path: "/usr/bin/act" });
  assert.deepEqual(resolveAct({ act_version: PATCHED_ACT_VERSION, act_path: "nope" }, lookup), { source: "user", configured: "nope", path: undefined });
  assert.equal(resolveAct({ act_version: PATCHED_ACT_VERSION, act_path: "/does/not/exist/act" }, lookup).source, "user");
  const rel = resolveAct({ act_version: "v0.2.80" }, lookup);
  assert.equal(rel.source, "release");
  assert.match((rel as { reason: string }).reason, /mime_type/);
});

test("guest act: probe output, install path and skipping an up-to-date copy", () => {
  const sha = "ab".repeat(32);
  assert.deepEqual(parseGuestActProbe("macos", `arm64\n/Users/admin\n${sha}\n`), { arch: "arm64", target: "darwin/arm64", home: "/Users/admin", stamp: sha });
  assert.deepEqual(parseGuestActProbe("windows", "X64\r\nC:\\Users\\docker\r\n"), { arch: "X64", target: "windows/amd64", home: "C:\\Users\\docker", stamp: undefined });
  assert.equal(parseGuestActProbe("linux", "").target, undefined);
  assert.equal(guestActPath("macos", "/Users/admin/"), "/Users/admin/.osmatrix/bin/act");
  assert.equal(guestActPath("windows", "C:\\Users\\docker"), "C:\\Users\\docker\\.osmatrix\\bin\\act.exe");
  assert.equal(guestActCurrent(sha, `${sha.toUpperCase()}\r\n`), true);
  assert.equal(guestActCurrent(sha, "cd".repeat(32)), false);
  assert.equal(guestActCurrent(sha, undefined), false);
  assert.match(guestActProbe({ shell: "posix" }), /^uname -m; .*\.osmatrix\/bin\/act\.sha256/);
  assert.match(guestActProbe({ shell: "pwsh" }), /OSArchitecture.*\.osmatrix\\bin/);
  assert.match(guestActProbe({ shell: "cmd" }), /^powershell .*-EncodedCommand /);
});

test("stock act's artifact-server failures are hinted at", () => {
  const log = `level=error msg="Error decode request body: proto: (line 1:95): unknown field \\"mime_type\\""\n::error::Failed to CreateArtifact: Failed to make request after 5 attempts`;
  assert.equal(actDifferenceHints(log).length, 1);
  assert.match(actDifferenceHints(log)[0], /upload-artifact v7/);
  assert.match(actDifferenceHints('unknown field "mime_type"')[0], /artifact server/);
});

test("old builds are pruned only once unused for the retention period", () => {
  const day = 24 * 3600_000;
  const now = 100 * day;
  const entries = [
    { key: "v0.2.89-current", usedMs: now - 30 * day },
    { key: "v0.2.89-recent", usedMs: now - 2 * day },
    { key: "v0.2.89-stale", usedMs: now - 8 * day },
  ];
  assert.deepEqual(staleBuilds(entries, "v0.2.89-current", now), ["v0.2.89-stale"], "the current build and recently used ones stay");
  assert.deepEqual(staleBuilds(entries, "v0.2.89-current", now, 1 * day), ["v0.2.89-recent", "v0.2.89-stale"]);
});
