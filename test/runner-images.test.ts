import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultGuests, type GuestConfig } from "../src/core/config.ts";
import { latestImageTag, macArm64Image, macReadmeUrl, parseHomebrewVersion, runnerHomebrew } from "../src/core/runner-images.ts";
import { macProvisionCommand, resolveArm64Brew } from "../src/env.ts";

const README = `# macOS 15
- OS Version: macOS 15.7.9 (24G830)
- Image Version: 20260907.0337.1

### Package Management
- Bundler 2.7.2
- Carthage 0.40.0
- Homebrew 6.0.22
- NPM 10.9.8

### Language and Runtime
- Clang/LLVM (Homebrew) 18.1.8 - available on \`$(brew --prefix llvm@18)/bin/clang\`
`;

const RELEASES = [
  { tag_name: "ubuntu24/20260908.1", prerelease: false, draft: false },
  { tag_name: "macos-26-arm64/20260907.0351", prerelease: true, draft: false },
  { tag_name: "macos-15-arm64/20260910.0001", prerelease: false, draft: true },
  { tag_name: "macos-15-arm64/20260907.0337", prerelease: false, draft: false },
  { tag_name: "macos-15/20260824.0482", prerelease: false, draft: false },
  { tag_name: "macos-26-arm64/20260831.0337", prerelease: false, draft: false },
  { tag_name: "macos-15-arm64/20260829.0321", prerelease: false, draft: false },
];

test("runner readme: the Homebrew version, not Homebrew-built tools", () => {
  assert.equal(parseHomebrewVersion(README), "6.0.22");
  assert.equal(parseHomebrewVersion("- Clang/LLVM (Homebrew) 18.1.8\n"), undefined);
});

test("runner image for a guest's macOS version, and its newest full release", () => {
  assert.equal(macArm64Image("15.7.9"), "macos-15-arm64");
  assert.equal(macArm64Image("26.1"), "macos-26-arm64");
  assert.equal(macArm64Image("14"), "macos-14-arm64");
  assert.equal(macArm64Image(""), undefined);
  // Drafts and prereleases are skipped; macos-15 (Intel) is a different image.
  assert.equal(latestImageTag(RELEASES, "macos-15-arm64"), "macos-15-arm64/20260907.0337");
  assert.equal(latestImageTag(RELEASES, "macos-26-arm64"), "macos-26-arm64/20260831.0337");
  assert.equal(latestImageTag(RELEASES, "macos-14-arm64"), undefined);
  assert.equal(latestImageTag({ message: "rate limited" }, "macos-15-arm64"), undefined);
  assert.equal(
    macReadmeUrl("macos-15-arm64/20260907.0337", "macos-15-arm64"),
    "https://raw.githubusercontent.com/actions/runner-images/macos-15-arm64/20260907.0337/images/macos/macos-15-arm64-Readme.md",
  );
});

function fakeFetch(releases: unknown, readmes: Record<string, string>, calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify(releases), { status: 200 });
    const body = readmes[url];
    return new Response(body ?? "not found", { status: body ? 200 : 404 });
  }) as typeof fetch;
}

test("runnerHomebrew reads the release readme, caches per image, and falls back to main", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-runner-"));
  const cacheFile = path.join(dir, "cache.json");
  const calls: string[] = [];
  const f = fakeFetch(
    RELEASES,
    {
      [macReadmeUrl("macos-15-arm64/20260907.0337", "macos-15-arm64")]: README,
      [macReadmeUrl("main", "macos-14-arm64")]: README.replace("6.0.22", "6.0.21"),
    },
    calls,
  );
  const now = Date.parse("2026-10-12T00:00:00Z");
  assert.deepEqual(await runnerHomebrew("macos-15-arm64", { now, cacheFile, fetch: f }), { brew: "6.0.22", ref: "macos-15-arm64/20260907.0337" });
  const n = calls.length;
  assert.deepEqual(await runnerHomebrew("macos-15-arm64", { now: now + 3600_000, cacheFile, fetch: f }), { brew: "6.0.22", ref: "macos-15-arm64/20260907.0337" });
  assert.equal(calls.length, n, "served from the cache");
  // No release of that image in the listing: main's readme.
  assert.deepEqual(await runnerHomebrew("macos-14-arm64", { now, cacheFile, fetch: f }), { brew: "6.0.21", ref: "main" });
  // A failure is reported, not thrown.
  const r = await runnerHomebrew("macos-27-arm64", { now, cacheFile, fetch: f });
  assert.equal(r.brew, undefined);
  assert.match(r.error ?? "", /HTTP 404/);
});

test("Apple Silicon guests match GitHub's runner unless their config pins brew", async () => {
  const tart = defaultGuests("darwin", "arm64").macos;
  const lookup = async (image: string) => (image === "macos-15-arm64" ? { brew: "6.0.22", ref: "macos-15-arm64/20260907.0337" } : { error: "offline" });
  const sequoia = { arch: "arm64", productVersion: "15.7.9" };
  assert.equal((await resolveArm64Brew(tart, sequoia, lookup)).brew, "6.0.22");
  assert.equal((await resolveArm64Brew({ ...tart, homebrew: { brew: "6.0.20" } }, sequoia, lookup)).brew, "6.0.20");
  const off = await resolveArm64Brew({ ...tart, homebrew: false }, sequoia, lookup);
  assert.equal(off.brew, undefined);
  assert.match(off.note ?? "", /left as it is/);
  // Lookup failed: keep the guest's brew and say why.
  const failed = await resolveArm64Brew(tart, { arch: "arm64", productVersion: "26.1" }, lookup);
  assert.equal(failed.brew, undefined);
  assert.match(failed.note ?? "", /macos-26-arm64.*offline/);
  // Intel guests use their pins instead.
  assert.deepEqual(await resolveArm64Brew({ name: "mini", os: "macos", backend: "ssh" } as GuestConfig, { arch: "x86_64", productVersion: "15.7" }, lookup), {});
  assert.match(macProvisionCommand(tart, "-s", "6.0.22"), / OSMATRIX_BREW_ARM64_TAG=6\.0\.22 bash -s$/);
  assert.throws(() => macProvisionCommand(tart, "-s", "6.0.22; reboot"), /not a Homebrew release tag/);
});
