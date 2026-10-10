#!/usr/bin/env node
// Local CodeQL scan, matching GitHub's default code-scanning setup for this repo: the
// JavaScript/TypeScript, Python and GitHub Actions with their default "code-scanning" suites.
// Run before pushing: `npm run codeql`. Needs the CodeQL CLI on PATH (or CODEQL=/path/to/codeql); the
// easiest way to install and update it is the gh extension:
//   gh extension install github/gh-codeql && gh codeql set-version latest && gh codeql install-stub ~/.local/bin/
// Exits 1 when any alert is found; SARIF files are left in .codeql/ for inspection.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codeql = process.env.CODEQL ?? "codeql";
const out = join(root, ".codeql");
const LANGUAGES = [
  { name: "javascript", pack: "codeql/javascript-queries" }, // covers TypeScript too
  { name: "python", pack: "codeql/python-queries" },
  { name: "actions", pack: "codeql/actions-queries" },
];
const only = process.argv.slice(2);

try {
  execFileSync(codeql, ["version", "--format=terse"], { stdio: "ignore" });
} catch {
  console.error("CodeQL CLI not found. Install: gh extension install github/gh-codeql && gh codeql set-version latest && gh codeql install-stub ~/.local/bin/  (or set CODEQL)");
  process.exit(2);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Generated and third-party code is not ours to scan (GitHub only sees what is committed anyway).
const config = join(out, "config.yml");
writeFileSync(config, "paths-ignore:\n  - node_modules\n  - dist\n  - artifacts\n  - .osmatrix\n  - .codeql\n");

let total = 0;
for (const lang of LANGUAGES.filter((l) => !only.length || only.includes(l.name))) {
  const db = join(out, `db-${lang.name}`);
  const sarif = join(out, `${lang.name}.sarif`);
  const run = (args) => {
    const r = spawnSync(codeql, args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error(`codeql ${args[0]} ${args[1]} failed for ${lang.name}`);
  };
  process.stderr.write(`\n== ${lang.name}\n`);
  run(["database", "create", db, `--language=${lang.name}`, "--build-mode=none", `--source-root=${root}`, `--codescanning-config=${config}`, "--overwrite", "--quiet"]);
  // --download fetches (or updates) the query pack from GitHub's registry when it isn't cached.
  run(["database", "analyze", db, `${lang.pack}:codeql-suites/${lang.name}-code-scanning.qls`, "--download", "--format=sarif-latest", `--output=${sarif}`, "--quiet"]);
  const results = JSON.parse(readFileSync(sarif, "utf8")).runs.flatMap((r) =>
    (r.results ?? []).map((res) => {
      const loc = res.locations?.[0]?.physicalLocation;
      return `  [${res.level ?? "warning"}] ${res.ruleId}  ${loc?.artifactLocation?.uri}:${loc?.region?.startLine}\n      ${res.message?.text?.replace(/\s+/g, " ")}`;
    }),
  );
  total += results.length;
  console.log(`${lang.name}: ${results.length} alert(s)${results.length ? "\n" + results.join("\n") : ""}`);
}

console.log(total ? `\n${total} CodeQL alert(s). SARIF in .codeql/` : "\nCodeQL: no alerts");
process.exitCode = total ? 1 : 0;
