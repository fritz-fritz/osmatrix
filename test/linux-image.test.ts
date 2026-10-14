import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  PARITY_DOCKERFILE,
  ensureLinuxImage,
  expectedLinuxImage,
  fallbackImage,
  latestRunnerTag,
  parityImageTag,
  parseRustVersion,
  runnerRust,
  type ImageDeps,
} from "../src/backends/linux-image.ts";
import { DEFAULT_LINUX_IMAGE } from "../src/core/config.ts";

// Trimmed from images/ubuntu/Ubuntu2404-Readme.md at actions/runner-images ubuntu24/20261004.327.
const README = `### Haskell Tools
- Cabal 3.16.0.0
- GHC 9.14.1

### Rust Tools
- Cargo 1.99.0
- Rust 1.99.0
- Rustdoc 1.99.0
- Rustup 1.29.1

#### Packages
- Rustfmt 1.10.0

### Browsers and Drivers
- Google Chrome 154.0.8037.97
`;

test("parseRustVersion reads the Rust Tools section", () => {
  assert.equal(parseRustVersion(README), "1.99.0");
  assert.equal(parseRustVersion(README.replace(/\n/g, "\r\n")), "1.99.0");
  // Only that section counts, up to the next ### heading.
  assert.equal(parseRustVersion("### Rust Tools\n- Cargo 1.99.0\n\n### Other\n- Rust 1.98.0\n"), undefined);
  assert.equal(parseRustVersion("### Tools\n- Rust 1.99.0\n"), undefined);
  assert.equal(parseRustVersion(""), undefined);
});

test("latestRunnerTag takes the first ubuntu24/ release, not ubuntu24-arm64", () => {
  const releases = [
    { tag_name: "win25/20261004.281" },
    { tag_name: "ubuntu24-arm64/20261004.142" },
    { tag_name: "ubuntu24/20261004.327" },
    { tag_name: "ubuntu24/20260927.300" },
  ];
  assert.equal(latestRunnerTag(releases), "ubuntu24/20261004.327");
  assert.equal(latestRunnerTag([{ tag_name: "ubuntu22/1" }]), undefined);
  // Releases still rolling out (prereleases) and drafts never count, even with no full release listed.
  const rolling = [
    { tag_name: "ubuntu24/20261011.330", prerelease: true },
    { tag_name: "ubuntu24/20261010.329", draft: true },
    { tag_name: "ubuntu24/20261004.327", prerelease: false },
  ];
  assert.equal(latestRunnerTag(rolling), "ubuntu24/20261004.327");
  assert.equal(latestRunnerTag(rolling.slice(0, 2)), undefined);
  assert.equal(latestRunnerTag({ message: "API rate limit exceeded" }), undefined);
});

test("the parity image tag follows the Dockerfile and the Rust version", () => {
  const tag = parityImageTag("1.99.0");
  assert.match(tag, /^osmatrix\/ubuntu:act-24\.04-[0-9a-f]{12}-rust1\.99\.0$/);
  assert.equal(parityImageTag("1.99.0", fs.readFileSync(PARITY_DOCKERFILE)), tag);
  assert.notEqual(parityImageTag("1.100.0"), tag);
  assert.notEqual(parityImageTag("1.99.0", "FROM scratch\n"), tag);
  assert.match(parityImageTag("stable"), /-ruststable$/);
});

test("the parity Dockerfile builds on act's default image and takes RUST_VERSION", () => {
  const text = fs.readFileSync(PARITY_DOCKERFILE, "utf8");
  assert.equal(text.match(/^FROM (\S+)$/m)?.[1], DEFAULT_LINUX_IMAGE);
  assert.match(text, /^ARG RUST_VERSION=stable$/m);
});

test("fallbackImage prefers the newest image of the current Dockerfile", () => {
  const cur = parityImageTag("1.99.0").replace(/-rust.*/, "");
  assert.equal(fallbackImage([`osmatrix/ubuntu:act-24.04-000000000000-rust1.100.0`, `${cur}-rust1.98.0`, `${cur}-rust1.97.0`]), `${cur}-rust1.98.0`);
  assert.equal(fallbackImage(["osmatrix/ubuntu:act-24.04-000000000000-rust1.100.0"]), "osmatrix/ubuntu:act-24.04-000000000000-rust1.100.0");
  assert.equal(fallbackImage([]), undefined);
});

function fakeFetch(calls: string[], fail = false): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (fail) throw new Error("getaddrinfo ENOTFOUND api.github.com");
    if (new URL(u).hostname === "api.github.com") return new Response(JSON.stringify([{ tag_name: "ubuntu24-arm64/2" }, { tag_name: "ubuntu24/20261004.327" }]));
    const p = new URL(u);
    if (p.hostname === "raw.githubusercontent.com" && p.pathname === "/actions/runner-images/ubuntu24/20261004.327/images/ubuntu/Ubuntu2404-Readme.md") {
      return new Response(README);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("runnerRust looks the version up once a day and never throws", async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-runner-")), "runner-image.json");
  const t0 = Date.parse("2026-10-12T00:00:00Z");
  const calls: string[] = [];
  assert.deepEqual(await runnerRust({ now: t0, cacheFile, fetch: fakeFetch(calls) }), { rust: "1.99.0", tag: "ubuntu24/20261004.327" });
  assert.equal(calls.length, 2);
  // Cached: no network within the TTL.
  assert.equal((await runnerRust({ now: t0 + 23 * 3600_000, cacheFile, fetch: fakeFetch(calls, true) })).rust, "1.99.0");
  assert.equal(calls.length, 2);
  // Expired and offline: no version, an error, and no retry for a while.
  const off = await runnerRust({ now: t0 + 25 * 3600_000, cacheFile, fetch: fakeFetch(calls, true) });
  assert.equal(off.rust, undefined);
  assert.match(off.error!, /ENOTFOUND/);
  assert.equal(calls.length, 3);
  assert.equal((await runnerRust({ now: t0 + 25 * 3600_000 + 60_000, cacheFile, fetch: fakeFetch(calls) })).rust, undefined);
  assert.equal(calls.length, 3);
  // Back online after the failure window.
  assert.equal((await runnerRust({ now: t0 + 26 * 3600_000, cacheFile, fetch: fakeFetch(calls) })).rust, "1.99.0");
});

test("runnerRust with cachedOnly answers from the last lookup and never fetches", async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-runner-")), "runner-image.json");
  const calls: string[] = [];
  assert.equal((await runnerRust({ cacheFile, fetch: fakeFetch(calls), cachedOnly: true })).rust, undefined);
  assert.equal(calls.length, 0);
  const t0 = Date.parse("2026-10-12T00:00:00Z");
  await runnerRust({ now: t0, cacheFile, fetch: fakeFetch(calls) });
  assert.equal(calls.length, 2);
  // Long past the TTL, still the cached version, and no request.
  assert.equal((await runnerRust({ now: t0 + 30 * 24 * 3600_000, cacheFile, fetch: fakeFetch(calls), cachedOnly: true })).rust, "1.99.0");
  assert.equal(calls.length, 2);
});

test("runnerRust reports an HTTP error as an error", async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-runner-")), "runner-image.json");
  const limited = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  assert.match((await runnerRust({ cacheFile, fetch: limited })).error!, /HTTP 403/);
});

// ---------- ensureLinuxImage with fake docker and locks ----------

const owner = { pid: process.pid, run: "r1", repo: "/r", leg: "test" };

function fakeDeps(o: { rust?: string; existing?: string[]; local?: string[]; failBuild?: boolean; builtWhileWaiting?: boolean }) {
  const events: string[] = [];
  const logs: string[] = [];
  const existing = new Set(o.existing ?? []);
  const deps: ImageDeps = {
    runnerRust: async () => {
      events.push("lookup");
      return o.rust ? { rust: o.rust, tag: "ubuntu24/20261004.327" } : { error: "offline" };
    },
    exists: async (ref) => existing.has(ref),
    localImages: async () => o.local ?? [],
    build: async (tag, rust) => {
      events.push(`build ${tag} ${rust}`);
      if (o.failBuild) throw new Error("build failed: could not resolve sh.rustup.rs");
      existing.add(tag);
    },
    lock: async (key) => {
      events.push(`lock ${key}`);
      // Another run held the lock and built the image meanwhile.
      if (o.builtWhileWaiting) existing.add(key.replace(/^host:image:/, ""));
      return () => void events.push(`unlock ${key}`);
    },
  };
  const ensure = (configured = DEFAULT_LINUX_IMAGE) => ensureLinuxImage(configured, owner, (l) => logs.push(l), deps);
  return { deps, events, logs, ensure };
}

test("ensureLinuxImage: a user-configured image is used unchanged, without a lookup", async () => {
  const f = fakeDeps({ rust: "1.99.0" });
  assert.equal(await f.ensure("catthehacker/ubuntu:full-24.04"), "catthehacker/ubuntu:full-24.04");
  assert.deepEqual(f.events, []);
  assert.equal(await expectedLinuxImage("my/image:1", f.deps), "my/image:1");
});

test("ensureLinuxImage: an existing parity image is used without building", async () => {
  const tag = parityImageTag("1.99.0");
  const f = fakeDeps({ rust: "1.99.0", existing: [tag] });
  assert.equal(await f.ensure(), tag);
  assert.deepEqual(f.events, ["lookup"]);
  assert.equal(await expectedLinuxImage(DEFAULT_LINUX_IMAGE, f.deps), tag);
});

test("ensureLinuxImage: a missing parity image is built once, under the host lock", async () => {
  const tag = parityImageTag("1.99.0");
  const f = fakeDeps({ rust: "1.99.0" });
  assert.equal(await f.ensure(), tag);
  assert.deepEqual(f.events, ["lookup", `lock host:image:${tag}`, `build ${tag} 1.99.0`, `unlock host:image:${tag}`]);
  // A run that waited on the lock finds the image built and doesn't build it again.
  const w = fakeDeps({ rust: "1.99.0", builtWhileWaiting: true });
  assert.equal(await w.ensure(), tag);
  assert.ok(!w.events.some((e) => e.startsWith("build")));
});

test("ensureLinuxImage: a failed build falls back to a local parity image, else to act's image", async () => {
  const older = parityImageTag("1.98.0");
  const f = fakeDeps({ rust: "1.99.0", failBuild: true, local: [older] });
  assert.equal(await f.ensure(), older);
  assert.ok(f.logs.some((l) => l.includes("build failed")));
  assert.ok(f.events.at(-1)!.startsWith("unlock")); // the lock is released after a failure too
  const none = fakeDeps({ rust: "1.99.0", failBuild: true });
  assert.equal(await none.ensure(), DEFAULT_LINUX_IMAGE);
  assert.ok(none.logs.some((l) => /warning: running on catthehacker\/ubuntu:act-24\.04 instead, which lacks the Rust/.test(l)));
});

test("ensureLinuxImage offline: the newest local image, else a stable build, else act's image", async () => {
  const newest = parityImageTag("1.99.0");
  const local = fakeDeps({ local: [newest, parityImageTag("1.98.0")] });
  assert.equal(await local.ensure(), newest);
  assert.ok(!local.events.some((e) => e.startsWith("build")));
  assert.ok(local.logs[0].includes("couldn't look up the Rust version"));
  assert.equal(await expectedLinuxImage(DEFAULT_LINUX_IMAGE, local.deps), undefined);

  const stable = fakeDeps({});
  assert.equal(await stable.ensure(), parityImageTag("stable"));
  assert.ok(stable.events.includes(`build ${parityImageTag("stable")} stable`));

  const nothing = fakeDeps({ failBuild: true });
  assert.equal(await nothing.ensure(), DEFAULT_LINUX_IMAGE);
});
