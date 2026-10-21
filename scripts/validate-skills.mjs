#!/usr/bin/env node
// Frontmatter, size and link checks for every skill in skills/ (Agent Skills format). Codex, Cursor and
// skills.sh install skills flat into a shared directory, so each one must be self-contained and carry
// the plugin's name as a prefix. The one exception is the bare "osmatrix": the map to the other skills,
// which can't collide with anything but the plugin itself.
import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 20000;
const MAX_LINES = 500;
const PREFIX = "osmatrix-";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

/** Names of the skills in skills/ (directories with a SKILL.md), sorted. */
export async function skillNames(dir = join(root, "skills")) {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await access(join(dir, e.name, "SKILL.md"));
      names.push(e.name);
    } catch {
      /* not a skill */
    }
  }
  return names.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = join(root, "skills");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    problems.push("skills: missing");
    entries = [];
  }
  if (!entries.some((e) => e.isDirectory())) problems.push("skills: no skills found");
  for (const e of entries.filter((e) => e.isDirectory())) {
    const file = join(dir, e.name, "SKILL.md");
    const label = relative(root, file);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      problems.push(`${label}: missing`);
      continue;
    }
    if (text.length > LIMIT) problems.push(`${label}: ${text.length} chars exceeds ${LIMIT}`);
    const lines = text.split("\n").length;
    if (lines > MAX_LINES) problems.push(`${label}: ${lines} lines exceeds ${MAX_LINES}`);
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
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push(`${label}: name must be lowercase letters, digits, single hyphens, at most 64 chars`);
    else if (name !== "osmatrix" && !name.startsWith(PREFIX)) problems.push(`${label}: name must be "osmatrix" or start with "${PREFIX}" (skills are installed flat next to other plugins' skills)`);
    if (!description) problems.push(`${label}: no description`);
    else if (description.length > 1024) problems.push(`${label}: description longer than 1024 chars`);
    // The values are unquoted YAML scalars: a ": " or " #" inside one is a parse error in the clients'
    // YAML parsers (skills.sh skips the skill), even though the regexes above accept it.
    for (const [k, v] of [["name", name], ["description", description]]) {
      if (v && !/^["']/.test(v) && /: | #/.test(v)) problems.push(`${label}: ${k} contains ": " or " #", which is invalid in an unquoted YAML value`);
    }
    // Relative links must stay inside the skill: nothing else is installed with it.
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const rel = relative(join(dir, e.name), resolve(dir, e.name, target));
      if (rel.startsWith("..")) problems.push(`${label}: link ${target} leaves the skill`);
      else await access(resolve(dir, e.name, target)).catch(() => problems.push(`${label}: broken link ${target}`));
    }
  }

  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`${entries.filter((e) => e.isDirectory()).length} skills valid`);
}
