#!/usr/bin/env node
// Rehearse release.yml locally with act, as if tag v<package.json version> had been pushed.
// Attestation, the real npm publish and the GitHub release are skipped under act (they need GitHub
// OIDC); an `npm publish --dry-run` checks the package instead. Uses this checkout's osmatrix.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The real workflow skips publishing a version that already exists on npm (so a half-finished
// release can be re-run). Before a release that silently means "nothing gets published": stop here.
const published = spawnSync("npm", ["view", `osmatrix@${version}`, "version"], { encoding: "utf8", shell: process.platform === "win32" });
if (published.stdout.trim() === version && !process.argv.includes("--allow-published")) {
  console.error(
    `osmatrix@${version} is already on npm, so tagging v${version} would publish nothing.\n` +
      `Bump the version first (e.g. npm version patch --no-git-tag-version && npm run sync), or pass --allow-published.`,
  );
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), "osmatrix-release-"));
const event = join(dir, "event.json");
writeFileSync(event, JSON.stringify({ ref: `refs/tags/v${version}`, ref_name: `v${version}` }));
console.error(`Rehearsing release.yml for v${version}`);
const r = spawnSync(process.execPath, [join(root, "src", "cli.ts"), "ci", "run", "--repo", root, "-W", "release.yml", "--event-file", event, "--wait"], {
  stdio: "inherit",
});
rmSync(dir, { recursive: true, force: true });
process.exitCode = r.status ?? 1;
