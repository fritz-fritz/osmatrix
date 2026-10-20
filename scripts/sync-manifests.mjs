#!/usr/bin/env node
// Stamp package.json's version into every plugin manifest and the skills' npx fallback, pin the MCP
// command to the current major version, stamp the versions the code pins (act, the Linux act image,
// Intel Homebrew, Node) into the docs, and check that every logo a manifest references exists in assets/.
// `--check` verifies instead of writing (CI fails on drift).
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LINUX_IMAGE, DEFAULT_HOMEBREW } from "../src/core/config.ts";
import { PATCHED_ACT_VERSION } from "../src/core/pins.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", "plugin.json"];
const mcpFiles = ["mcp.json"];

/** The versions the docs must agree with: package.json's, and the code's pins. */
export function pins(pkg) {
  return {
    version: pkg.version,
    major: pkg.version.split(".")[0],
    act: PATCHED_ACT_VERSION,
    linuxImage: DEFAULT_LINUX_IMAGE,
    brew: DEFAULT_HOMEBREW.brew,
    core: DEFAULT_HOMEBREW.core,
    node: /(\d+\.\d+)/.exec(pkg.engines?.node ?? "")?.[1],
  };
}

/** The docs that repeat pinned versions: README, CONTRIBUTING, the bundled README's text, every skill. */
export async function docFiles() {
  const files = ["README.md", "CONTRIBUTING.md", "scripts/package-plugins.mjs"];
  for (const name of await readdir(join(root, "skills"))) {
    for (const f of [`skills/${name}/SKILL.md`, `skills/${name}/references/reference.md`]) {
      await access(join(root, f)).then(() => files.push(f), () => undefined);
    }
  }
  return files;
}

/**
 * Stamp the pins into a doc's text. Each rule names the phrasings it covers. A version inside quotes or
 * after `@` is left alone: `act_version = "v0.2.88"` is an example of another release, `osmatrix@0.1.0`
 * an npm range.
 */
export function stampDocs(text, p) {
  const act = p.act.replace(/^v/, "");
  let out = text
    // Skills offer `npx osmatrix@<version>` when the CLI isn't installed: an exact version, so what the
    // user agrees to run is the release the skill was written for.
    .replace(/(npx|npm i -g) osmatrix@[0-9A-Za-z.+-]+/g, (_m, cmd) => `${cmd} osmatrix@${p.version}`)
    // The plugins run `npx -y osmatrix@<major> mcp`.
    .replace(/\bosmatrix@\d+ mcp\b/g, `osmatrix@${p.major} mcp`)
    // act: "act 0.2.89", "act-v0.2.89-osmatrix.patch", "the stock v0.2.89 release", "the patched v0.2.89",
    // "apply it to the v0.2.89 source".
    .replace(/\b(act[ -]|stock |patched |to the )(v?)\d+\.\d+\.\d+/gi, (_m, ctx, v) => `${ctx}${v}${act}`)
    // Intel Homebrew: "brew 6.0.22", `brew = "6.0.22"`, `core = "<commit>"`.
    .replace(/\b(brew (?:= ")?)\d+\.\d+\.\d+/g, `$1${p.brew}`)
    .replace(/\b(core = ")[0-9a-f]{40}/g, `$1${p.core}`);
  // The Linux act image, while it stays in catthehacker's family (another image needs the docs rewritten).
  if (/^catthehacker\/ubuntu:act-/.test(p.linuxImage)) out = out.replace(/\bcatthehacker\/ubuntu:act-[\w.-]+/g, p.linuxImage);
  if (p.node) out = out.replace(/\bNode\.js \d+\.\d+/g, `Node.js ${p.node}`);
  return out;
}

async function main() {
  const check = process.argv.includes("--check");
  const problems = [];
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { version } = pkg;

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

  // The docs repeat the pins; stamp them so a bump in package.json or src/core is the only edit.
  const p = pins(pkg);
  for (const f of await docFiles()) {
    const file = join(root, f);
    const text = await readFile(file, "utf8");
    const next = stampDocs(text, p);
    if (next === text) continue;
    if (check) problems.push(`pins: ${f} is out of date (act ${p.act}, ${p.linuxImage}, brew ${p.brew}, Node.js ${p.node}, osmatrix ${p.version})`);
    else await writeFile(file, next);
  }

  if (problems.length) {
    console.error(problems.join("\n") + "\n\nRun: npm run sync");
    process.exit(1);
  }
  console.log(check ? "manifests in sync" : `manifests at version ${version}, MCP pinned to ${pin}, docs at act ${p.act}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
