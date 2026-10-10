#!/usr/bin/env node
// Frontmatter and size checks for every published copy of every skill (Agent Skills format).
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 20000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

for (const dir of ["skills", "claude/skills", "cursor/skills", "codex/skills"]) {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    problems.push(`${dir}: missing`);
    continue;
  }
  for (const e of entries.filter((e) => e.isDirectory())) {
    const file = join(root, dir, e.name, "SKILL.md");
    const label = relative(root, file);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      problems.push(`${label}: missing`);
      continue;
    }
    if (text.length > LIMIT) problems.push(`${label}: ${text.length} chars exceeds ${LIMIT}`);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1];
    if (!fm) {
      problems.push(`${label}: no frontmatter`);
      continue;
    }
    const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim();
    const name = field("name");
    const description = field("description");
    if (!name) problems.push(`${label}: no name`);
    else if (name !== basename(dirname(file))) problems.push(`${label}: name "${name}" != directory`);
    else if (!/^[a-z0-9-]{1,64}$/.test(name)) problems.push(`${label}: name must be lowercase letters, digits, hyphens`);
    if (!description) problems.push(`${label}: no description`);
    else if (description.length > 1024) problems.push(`${label}: description longer than 1024 chars`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("skills valid");
