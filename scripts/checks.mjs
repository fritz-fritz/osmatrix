#!/usr/bin/env node
// Verify a commit's GitHub checks before releasing it:
//   - the ci.yml workflow ran for the commit and succeeded, and
//   - every other check run on the commit (e.g. CodeQL "Analyze (...)") completed successfully.
// Usage: node scripts/checks.mjs <sha> [--wait] [--timeout <sec>] [--exclude-run <github run id>]
//   --wait          poll until checks finish (fails fast once anything fails)
//   --exclude-run   ignore the check runs of this workflow run (the release run itself)
// Needs the gh CLI (GH_TOKEN in Actions). Exits 0 when the commit is releasable.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const sha = args.find((a) => /^[0-9a-f]{7,40}$/.test(a));
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!sha) {
  console.error("usage: checks.mjs <sha> [--wait] [--timeout <sec>] [--exclude-run <run id>]");
  process.exit(2);
}
const wait = flag("--wait");
const timeoutSec = Number(opt("--timeout") ?? 2700);
const gh = (...a) => {
  try {
    return execFileSync("gh", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    console.error(`gh ${a.slice(0, 2).join(" ")} failed: ${(e.stderr || e.message).toString().trim().split("\n").pop()}`);
    process.exit(1);
  }
};
const repo = process.env.GITHUB_REPOSITORY ?? gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").trim();
const excludeRun = opt("--exclude-run");
const excludeSuite = excludeRun ? gh("api", `repos/${repo}/actions/runs/${excludeRun}`, "-q", ".check_suite_id").trim() : undefined;
const OK = new Set(["success", "neutral", "skipped"]);

function snapshot() {
  const ciRuns = JSON.parse(gh("api", `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`)).workflow_runs ?? [];
  const lines = gh("api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs[] | {name, status, conclusion, suite: .check_suite.id}");
  const runs = lines
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => String(r.suite) !== excludeSuite);
  return { ciRuns, runs };
}

const started = Date.now();
for (;;) {
  const { ciRuns, runs } = snapshot();
  const failed = runs.filter((r) => r.status === "completed" && !OK.has(r.conclusion));
  const ciFailed = ciRuns.filter((r) => r.status === "completed" && !OK.has(r.conclusion));
  const pending = runs.filter((r) => r.status !== "completed");
  const ciDone = ciRuns.length > 0 && ciRuns.every((r) => r.status === "completed");
  if (failed.length || ciFailed.length) {
    console.error(`Checks failed for ${sha}:`);
    for (const r of failed) console.error(`  ${r.name}: ${r.conclusion}`);
    for (const r of ciFailed) console.error(`  ci.yml run ${r.id}: ${r.conclusion}`);
    process.exit(1);
  }
  if (ciDone && pending.length === 0) {
    console.log(`All ${runs.length} checks passed for ${sha} (ci.yml: ${ciRuns.map((r) => r.conclusion).join(", ")}).`);
    process.exit(0);
  }
  const elapsed = (Date.now() - started) / 1000;
  const why = ciRuns.length === 0 ? "ci.yml has not run for this commit (is it pushed to main?)" : `waiting for: ${pending.map((r) => r.name).join(", ") || "ci.yml"}`;
  // No CI run at all after a few minutes means it never will (e.g. a tag on an unpushed commit).
  if (!wait || elapsed > timeoutSec || (ciRuns.length === 0 && elapsed > 300)) {
    console.error(`Not releasable yet: ${why}`);
    process.exit(1);
  }
  console.log(`${Math.round(elapsed)}s: ${why}`);
  await new Promise((r) => setTimeout(r, 20000));
}
