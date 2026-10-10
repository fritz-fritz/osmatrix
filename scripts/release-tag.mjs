#!/usr/bin/env node
// Tag and push v<package.json version>, only once the commit is releasable, so tags aren't burned:
//   - clean working tree, on main, HEAD pushed (equal to origin/main)
//   - the version is not on npm and the tag doesn't exist (locally or on origin)
//   - the commit's GitHub checks passed (ci.yml + everything else), via scripts/checks.mjs
// The tag is annotated (signed when git's tag.gpgsign is set). Pushing it starts release.yml.
// Flags: --wait  wait for still-running checks   --no-push  create the tag but don't push it
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(`release:tag: ${msg}`);
  process.exit(1);
};
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${version}`;

if (git("status", "--porcelain")) fail("working tree is not clean");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("not on main");
git("fetch", "--quiet", "--tags", "origin");
const sha = git("rev-parse", "HEAD");
if (sha !== git("rev-parse", "origin/main")) fail("HEAD is not origin/main; push main (and let CI run) first");
if (spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: root }).status === 0) fail(`tag ${tag} already exists`);
const npm = spawnSync("npm", ["view", `osmatrix@${version}`, "version"], { encoding: "utf8", shell: process.platform === "win32" });
if (npm.stdout.trim() === version) fail(`osmatrix@${version} is already on npm; bump the version (npm version patch --no-git-tag-version && npm run sync)`);

const checkArgs = [join(root, "scripts", "checks.mjs"), sha, ...(args.includes("--wait") ? ["--wait"] : [])];
if (spawnSync(process.execPath, checkArgs, { stdio: "inherit" }).status !== 0) fail(`checks have not passed for ${sha.slice(0, 7)}; not tagging`);

git("tag", "-a", tag, "-m", `osmatrix ${version}`, sha);
console.log(`Created ${tag} at ${sha.slice(0, 7)}.`);
if (args.includes("--no-push")) {
  console.log(`Not pushed (--no-push). Push with: git push origin ${tag}`);
} else {
  execFileSync("git", ["push", "origin", tag], { cwd: root, stdio: "inherit" });
  console.log(`Pushed ${tag}; release.yml will publish once its own check gate passes.`);
}
