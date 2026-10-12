import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PARITY_DOCKERFILE, fallbackImage, latestRunnerTag, parityImageTag, parseRustVersion, runnerRust } from "../src/backends/linux-image.ts";
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
    if (u.includes("api.github.com")) return new Response(JSON.stringify([{ tag_name: "ubuntu24-arm64/2" }, { tag_name: "ubuntu24/20261004.327" }]));
    if (u.endsWith("/ubuntu24/20261004.327/images/ubuntu/Ubuntu2404-Readme.md")) return new Response(README);
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

test("runnerRust reports an HTTP error as an error", async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-runner-")), "runner-image.json");
  const limited = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  assert.match((await runnerRust({ cacheFile, fetch: limited })).error!, /HTTP 403/);
});
