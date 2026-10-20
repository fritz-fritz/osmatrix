#!/usr/bin/env node
// Checks that JSON Schema cannot express: listing limits, referenced files, and MCP commands, for the
// Claude, Cursor and Codex plugins. The repository root is the plugin for every client (each reads its
// own manifest there); package-plugins.mjs builds bundled copies that are validated the same way.
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillNames } from "./validate-skills.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/** Per-client layout: manifest, MCP config file, logo fields, and the plugin-root placeholder the host expands. */
export const CLIENTS = {
  claude: { manifest: ".claude-plugin/plugin.json", mcp: "mcp.json", rootVar: "${CLAUDE_PLUGIN_ROOT}", logos: (m) => [m.icon] },
  cursor: { manifest: ".cursor-plugin/plugin.json", mcp: "mcp.json", rootVar: "${CURSOR_PLUGIN_ROOT}", logos: (m) => [m.logo] },
  codex: {
    manifest: "plugin.json",
    mcp: "mcp.json",
    rootVar: "${PLUGIN_ROOT}",
    logos: (m) => {
      const l = m.extensions?.["com.openai"]?.interface ?? {};
      return [l.logo, l.composerIcon, l.logoDark, l.composerIconDark].filter((x) => x !== undefined);
    },
  },
};

/** Files every client's bundled plugin carries (plus that client's manifest): what a client reads from the repository. */
// assets/social-preview.svg (the README's banner on GitHub) stays out: no client reads it, and the bundled
// README points at the tagged copy instead (bundleReadme).
export const BUNDLE_FILES = ["skills", "assets/logo.svg", "assets/logo.png", "README.md", "LICENSE", "PRIVACY.md", "TERMS.md", "mcp.json"];

/**
 * A bundle's README: the bundle carries only part of the repository, so Markdown links and HTML `src`
 * attributes to anything else point at the tagged source (raw files for `src`, so images still render).
 * `has(path)` says whether the bundle carries that path.
 */
export function bundleReadme(text, has, homepage, version) {
  return text
    .replace(/\]\(([^)#\s:]+)((?:#[^)]*)?)\)/g, (m, target, hash) => (has(target) ? m : `](${homepage}/blob/v${version}/${target}${hash})`))
    .replace(/\bsrc="([^"#\s:]+)"/g, (m, target) => (has(target) ? m : `src="${homepage}/raw/v${version}/${target}"`));
}

/** The MCP args a plugin must use: the npm major pin, or the runtime tarball bundled inside the plugin. */
export function expectedMcpArgs(client, version, bundled) {
  if (!bundled) return ["-y", `osmatrix@${version.split(".")[0]}`, "mcp"];
  return ["-y", `--package=${CLIENTS[client].rootVar}/runtime/osmatrix-${version}.tgz`, "osmatrix", "mcp"];
}

async function containedFile(dir, file) {
  if (typeof file !== "string" || isAbsolute(file)) throw new Error(`invalid relative file: ${file}`);
  const full = resolve(dir, file);
  const rel = relative(resolve(dir), full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`file escapes plugin: ${file}`);
  // Check every component so a symlinked parent cannot escape the package.
  for (let cursor = full; cursor !== resolve(dir); cursor = dirname(cursor)) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`symlink in plugin: ${file}`);
  }
  const stat = await lstat(full);
  if (!stat.isFile()) throw new Error(`not a file: ${file}`);
  return stat;
}

// Limits from https://developers.openai.com/plugins/deploy/submission (listing fields).
const len = (v) => [...v].length;
function validateCodexListing(manifest) {
  const listing = manifest.extensions?.["com.openai"]?.interface;
  if (!listing) throw new Error("missing extensions.com.openai.interface");
  const text = (key, max) => {
    if (typeof listing[key] !== "string" || !listing[key].trim()) throw new Error(`missing listing ${key}`);
    if (len(listing[key]) > max) throw new Error(`${key} must be at most ${max} characters`);
  };
  text("displayName", 30);
  text("shortDescription", 30);
  text("longDescription", 4000);
  text("developerName", 80);
  text("category", 80);
  if (!Array.isArray(listing.capabilities) || listing.capabilities.length > 20 || listing.capabilities.some((c) => typeof c !== "string" || len(c) > 120)) {
    throw new Error("capabilities must be an array of up to 20 strings of at most 120 characters");
  }
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    const v = listing[key];
    let url;
    try {
      url = new URL(v);
    } catch {
      throw new Error(`${key} must be an HTTPS URL (required for MCP review)`);
    }
    if (url.protocol !== "https:" || url.username || url.password || len(v) > 1024) throw new Error(`${key} must be an HTTPS URL without credentials, at most 1024 characters`);
  }
  const prompts = Array.isArray(listing.defaultPrompt) ? listing.defaultPrompt : [listing.defaultPrompt];
  if (prompts.length < 1 || prompts.length > 3 || prompts.some((p) => typeof p !== "string" || !p.trim() || len(p) > 128) || new Set(prompts).size !== prompts.length) {
    throw new Error("defaultPrompt must contain 1–3 unique prompts of at most 128 characters");
  }
  for (const [key, background] of [["brandColor", "#FFFFFF"], ["brandColorDark", "#212121"]]) {
    if (listing[key] === undefined) continue;
    if (!/^#[0-9A-Fa-f]{6}$/.test(listing[key])) throw new Error(`${key} must be #RRGGBB`);
    if (contrast(listing[key], background) < 2) throw new Error(`${key} needs at least 2:1 contrast against ${background}`);
  }
}

function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Icons/logos must be square and at least 48x48 (PNG header or SVG viewBox/size). */
async function checkSquareIcon(file) {
  const buf = await readFile(file);
  let w, h;
  if (buf.subarray(1, 4).toString("latin1") === "PNG") {
    w = buf.readUInt32BE(16);
    h = buf.readUInt32BE(20);
  } else if (/\.svg$/i.test(file)) {
    const svg = buf.toString("utf8");
    const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
    [w, h] = vb ? [Number(vb[1]), Number(vb[2])] : [Number(/\bwidth="([\d.]+)"/.exec(svg)?.[1]), Number(/\bheight="([\d.]+)"/.exec(svg)?.[1])];
  } else {
    return; // JPEG/WebP: not inspected
  }
  if (!(w >= 48 && h >= 48 && w === h)) throw new Error(`${file} must be square and at least 48x48 (got ${w}x${h})`);
  if (!/\.svg$/i.test(file) && (w > 4096 || h > 4096)) throw new Error(`${file} must be at most 4096px`);
}

export async function validatePlugin(client, dir, { version, bundled = false } = {}) {
  const spec = CLIENTS[client];
  if (!spec) throw new Error(`unknown client ${client}`);
  const label = `${client}${bundled ? " (bundled)" : ""}`;
  try {
    const manifest = await readJson(resolve(dir, spec.manifest));
    if (manifest.name !== "osmatrix" || manifest.version !== version) throw new Error("plugin identity/version differs from package.json");
    if (client === "codex") validateCodexListing(manifest);
    const logos = spec.logos(manifest);
    if (!logos.length || logos.some((l) => !l)) throw new Error("manifest does not reference a logo");
    for (const logo of logos) {
      if ((await containedFile(dir, logo)).size > 5 * 1024 * 1024) throw new Error(`${logo} exceeds 5 MiB`);
      await checkSquareIcon(resolve(dir, logo));
    }
    // Claude's default MCP file is .mcp.json; the manifest must point it at the shared mcp.json.
    if (client === "claude" && manifest.mcpServers !== "./mcp.json") throw new Error('manifest must set "mcpServers": "./mcp.json"');
    // Every skill of the canonical set, each self-contained.
    const skills = await skillNames();
    const shipped = await skillNames(resolve(dir, "skills")).catch(() => []);
    if (JSON.stringify(shipped) !== JSON.stringify(skills)) throw new Error(`skills/ must contain exactly ${skills.join(", ")} (found ${shipped.join(", ") || "none"})`);
    for (const skill of skills) {
      await containedFile(dir, `skills/${skill}/SKILL.md`);
      await containedFile(dir, `skills/${skill}/references/reference.md`);
    }
    const server = (await readJson(resolve(dir, spec.mcp))).mcpServers?.osmatrix;
    if (server?.type !== "stdio" || server.command !== "npx") throw new Error("osmatrix must use the npx stdio transport");
    if (JSON.stringify(server.args) !== JSON.stringify(expectedMcpArgs(client, version, bundled))) {
      throw new Error(`MCP args must be ${JSON.stringify(expectedMcpArgs(client, version, bundled))}`);
    }
    if (bundled) {
      await containedFile(dir, `runtime/osmatrix-${version}.tgz`);
      await containedFile(dir, "LICENSE");
    }
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version } = await readJson(resolve(root, "package.json"));
    for (const client of Object.keys(CLIENTS)) await validatePlugin(client, root, { version });
    // Codex marketplace entries need installation/authentication policy and a category.
    for (const p of (await readJson(resolve(root, ".agents/plugins/marketplace.json"))).plugins) {
      const pol = p.policy ?? {};
      if (!["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(pol.installation) || !["ON_INSTALL", "ON_USE"].includes(pol.authentication) || !p.category) {
        throw new Error(`codex marketplace: ${p.name} needs policy.installation, policy.authentication and category`);
      }
    }
    console.log("plugin listings, assets and MCP commands valid");
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
