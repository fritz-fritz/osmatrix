#!/usr/bin/env node
// Supply-chain rules for workflows, all kept current by Dependabot:
// - every GitHub Action is pinned to a full commit SHA with a version comment
//   (`owner/repo@<40 hex> # vX.Y.Z`); tags and branches can be moved, a commit SHA can't;
// - npm tools come from .github/ci-tools (exact versions + lockfile integrity), never `npx -y`
//   or `npm install <pkg>@<version>`, which Dependabot can't see.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Problems in one workflow file's text (empty when every `uses:` is pinned). */
export function unpinnedUses(text, file = "workflow") {
  const problems = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)["']?\s*(#\s*(\S+))?/.exec(line);
    if (!m) return;
    const [, ref, , comment] = m;
    if (ref.startsWith("./")) return; // local action in this repository
    if (ref.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref)) problems.push(`${file}:${i + 1}: docker image must be pinned by digest: ${ref}`);
      return;
    }
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) problems.push(`${file}:${i + 1}: action must be pinned to a full commit SHA: ${ref}`);
    else if (!comment || !/^v?\d/.test(comment)) problems.push(`${file}:${i + 1}: add a "# vX.Y.Z" comment so Dependabot can track ${ref.split("@")[0]}`);
  });
  // Tools must come from .github/ci-tools (lockfile + Dependabot), not ad-hoc npx/npm installs.
  text.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    if (/\bnpx\s+(-y|--yes)\b|\bnpx\s+[@\w./-]+@|\bnpm\s+(i|install|add)\s+(--no-save\s+)?[@\w./-]+@/.test(line)) {
      problems.push(`${file}:${i + 1}: install CI tools via .github/ci-tools (so Dependabot updates them), not npx/npm install: ${line.trim()}`);
    }
  });
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".github", "workflows");
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const problems = files.flatMap((f) => unpinnedUses(readFileSync(join(dir, f), "utf8"), `.github/workflows/${f}`));
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`workflow actions pinned to commit SHAs (${files.length} files)`);
  }
}
