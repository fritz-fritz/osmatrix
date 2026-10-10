#!/usr/bin/env node
// Copy the canonical skills/ into each client plugin, stamp package.json's version into every
// plugin manifest, sync the shared logo, and pin the plugins' MCP command to the current major version.
// `--check` verifies instead of writing (CI fails on drift).
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "skills");
const hosts = ["claude", "cursor", "codex"];
const manifests = ["claude/.claude-plugin/plugin.json", "cursor/.cursor-plugin/plugin.json", "codex/plugin.json"];
const check = process.argv.includes("--check");
const problems = [];

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(relative(dir, full));
    }
  }
  await walk(dir);
  return out.sort();
}

const files = await listFiles(source);
if (!files.length) {
  console.error("no skills found in skills/");
  process.exit(1);
}

for (const host of hosts) {
  const target = join(root, host, "skills");
  const existing = await listFiles(target);
  for (const f of files) {
    const from = join(source, f);
    const to = join(target, f);
    if (check) {
      if (!existing.includes(f)) problems.push(`missing: ${host}/skills/${f}`);
      else if (!(await readFile(from)).equals(await readFile(to))) problems.push(`differs: ${host}/skills/${f}`);
    } else {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
  for (const f of existing.filter((f) => !files.includes(f))) {
    if (check) problems.push(`extra: ${host}/skills/${f}`);
    else await rm(join(target, f));
  }
}

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

// The canonical artwork lives in assets/. All clients use the same image, with
// each manifest choosing the filename expected by that client.
const codexManifest = JSON.parse(await readFile(join(root, "codex/plugin.json"), "utf8"));
const canonicalLogo = codexManifest.extensions["com.openai"].interface.logo;
const assetPath = /^(?:\.\/)?assets\/[a-z0-9-]+\.(?:svg|png|jpg|jpeg|webp)$/;
if (!assetPath.test(canonicalLogo)) throw new Error("Codex logo must reference a file in assets/");
for (const [host, manifestPath] of hosts.map((host, i) => [host, manifests[i]])) {
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  const targets = host === "codex"
    ? [manifest.extensions["com.openai"].interface.logo, manifest.extensions["com.openai"].interface.composerIcon]
    : [host === "claude" ? manifest.icon : manifest.logo];
  // Keep both formats current in every client, including the one a host does not reference.
  for (const target of new Set([...targets, "assets/logo.svg", "assets/logo.png"])) {
    if (!assetPath.test(target)) throw new Error(`${host}: logo must reference a file in assets/`);
    const artwork = await readFile(join(root, "assets", `logo${extname(target)}`));
    const file = join(root, host, target);
    if (check) {
      let existing;
      try { existing = await readFile(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (!existing) problems.push(`missing logo: ${host}/${target}`);
      else if (!artwork.equals(existing)) problems.push(`logo differs: ${host}/${target}`);
    } else {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, artwork);
    }
  }
}

for (const m of manifests) {
  const file = join(root, m);
  const json = JSON.parse(await readFile(file, "utf8"));
  if (json.version === version) continue;
  if (check) problems.push(`version: ${m} is ${json.version}, package.json is ${version}`);
  else {
    json.version = version;
    await writeFile(file, JSON.stringify(json, null, 2) + "\n");
  }
}

// Plugins run `npx -y osmatrix@<major> mcp`: same-major updates arrive automatically, breaking ones don't.
const pin = `osmatrix@${version.split(".")[0]}`;
for (const m of ["claude/.mcp.json", "cursor/mcp.json", "codex/mcp.json"]) {
  const file = join(root, m);
  const text = await readFile(file, "utf8");
  const next = text.replace(/osmatrix@[^"]*/g, pin);
  if (next === text) continue;
  if (check) problems.push(`mcp pin: ${m} should run ${pin}`);
  else await writeFile(file, next);
}

if (problems.length) {
  console.error(problems.join("\n") + "\n\nRun: npm run sync");
  process.exit(1);
}
console.log(check ? "skills, artwork and manifests in sync" : `synced ${files.length} skill file(s) and artwork to ${hosts.join(", ")}; version ${version}`);
