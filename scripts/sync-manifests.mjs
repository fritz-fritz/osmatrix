#!/usr/bin/env node
// Stamp package.json's version into every plugin manifest and the skills' npx fallback, pin the MCP
// command to the current major version, and check that every logo a manifest references exists in assets/.
// `--check` verifies instead of writing (CI fails on drift).
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", "plugin.json"];
const mcpFiles = ["mcp.json"];
const check = process.argv.includes("--check");
const problems = [];

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

for (const m of manifests) {
  const file = join(root, m);
  const json = JSON.parse(await readFile(file, "utf8"));
  if (json.version !== version) {
    if (check) problems.push(`version: ${m} is ${json.version}, package.json is ${version}`);
    else {
      json.version = version;
      await writeFile(file, JSON.stringify(json, null, 2) + "\n");
    }
  }
  // Every client reads the same artwork from assets/ at the repository root.
  const listing = json.extensions?.["com.openai"]?.interface ?? {};
  for (const logo of [json.icon, json.logo, listing.logo, listing.composerIcon].filter(Boolean)) {
    if (!/^(?:\.\/)?assets\/[a-z0-9-]+\.(?:svg|png|jpg|jpeg|webp)$/.test(logo)) problems.push(`${m}: logo must reference a file in assets/ (${logo})`);
    else await access(join(root, logo)).catch(() => problems.push(`${m}: missing logo ${logo}`));
  }
}

// Plugins run `npx -y osmatrix@<major> mcp`: same-major updates arrive automatically, breaking ones don't.
const pin = `osmatrix@${version.split(".")[0]}`;
for (const m of mcpFiles) {
  const file = join(root, m);
  const text = await readFile(file, "utf8");
  const next = text.replace(/osmatrix@[^"]*/g, pin);
  if (next === text) continue;
  if (check) problems.push(`mcp pin: ${m} should run ${pin}`);
  else await writeFile(file, next);
}

// Skills offer `npx osmatrix@<version>` when the CLI isn't installed: an exact version, so what the
// user agrees to run is the release the skill was written for.
const skillPin = `osmatrix@${version}`;
for (const name of await readdir(join(root, "skills"))) {
  const file = join(root, "skills", name, "SKILL.md");
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) continue;
  const next = text.replace(/(npx|npm i -g) osmatrix@[0-9A-Za-z.+-]+/g, (_m, cmd) => `${cmd} ${skillPin}`);
  if (next === text) continue;
  if (check) problems.push(`skill pin: skills/${name}/SKILL.md should offer ${skillPin}`);
  else await writeFile(file, next);
}

if (problems.length) {
  console.error(problems.join("\n") + "\n\nRun: npm run sync");
  process.exit(1);
}
console.log(check ? "manifests in sync" : `manifests at version ${version}, MCP pinned to ${pin}`);
