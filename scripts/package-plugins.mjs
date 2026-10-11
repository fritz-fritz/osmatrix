#!/usr/bin/env node
// Build Claude, Cursor and Codex plugins that bundle this checkout's runtime (an `npm pack` tarball), so
// they work without osmatrix being published on npm. Used for local previews and as release assets.
//
// Each bundled plugin is the subset of the repository a client reads: its manifest, the shared mcp.json,
// skills/, artwork, docs and LICENSE, plus the runtime tarball.
//
// Output, artifacts/:
//   claude/osmatrix, cursor/osmatrix, codex/osmatrix      bundled plugins
//   .claude-plugin, .cursor-plugin, .agents/plugins        a local "fritztech-local" marketplace for each client
//   osmatrix-<client>-<version>.tar.gz                     one archive per client (contains osmatrix/)
// artifacts/ is committed to its own throwaway git repo because Cursor imports marketplaces with git.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_FILES, CLIENTS, expectedMcpArgs, readJson, validatePlugin } from "./validate-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version, homepage } = await readJson(join(root, "package.json"));
const output = join(root, "artifacts");
const MARKETPLACE = "fritztech-local";
const writeJson = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n");

if (!process.env.npm_execpath) throw new Error("Run this through: npm run package:plugins");
const staging = await mkdtemp(join(tmpdir(), "osmatrix-plugins-"));
try {
  // Running npm's JS entrypoint with our node avoids shell quoting differences on Windows.
  const packed = execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--json", "--pack-destination", staging], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [{ filename }] = JSON.parse(packed);
  if (filename !== `osmatrix-${version}.tgz`) throw new Error(`unexpected npm pack output ${filename}`);

  await rm(output, { recursive: true, force: true });
  for (const [client, spec] of Object.entries(CLIENTS)) {
    const plugin = join(output, client, "osmatrix");
    for (const f of [...BUNDLE_FILES, spec.manifest]) await cp(join(root, f), join(plugin, f), { recursive: true });
    await mkdir(join(plugin, "runtime"));
    await cp(join(staging, filename), join(plugin, "runtime", filename));
    const mcpFile = join(plugin, spec.mcp);
    const mcp = await readJson(mcpFile);
    mcp.mcpServers.osmatrix.args = expectedMcpArgs(client, version, true);
    await writeJson(mcpFile, mcp);
    // The bundle carries only part of the repository: links to anything else point at the tagged source.
    const readme = (await readFile(join(plugin, "README.md"), "utf8")).replace(/\]\(([^)#\s:]+)((?:#[^)]*)?)\)/g, (m, target, hash) =>
      existsSync(join(plugin, target)) ? m : `](${homepage}/blob/v${version}/${target}${hash})`,
    );
    await writeFile(
      join(plugin, "README.md"),
      readme.replace(
        "## Install",
        `## Bundled build\n\nThis build includes osmatrix ${version} in \`runtime/\`; its MCP server starts that tarball through npx, so osmatrix does not need to be installed or published. Node.js 22.18+ and npm are required, and dependencies are downloaded from npm on first launch.\n\n## Install`,
      ),
    );
    await validatePlugin(client, plugin, { version, bundled: true });
    execFileSync("tar", ["-czf", join(output, `osmatrix-${client}-${version}.tar.gz`), "-C", join(output, client), "osmatrix"], { stdio: "inherit" });
  }

  // Local marketplaces mirror the repository's, pointing at the bundled plugins.
  const claude = await readJson(join(root, ".claude-plugin", "marketplace.json"));
  claude.name = MARKETPLACE;
  claude.plugins = claude.plugins.map((p) => ({ ...p, source: "./claude/osmatrix" }));
  const cursor = await readJson(join(root, ".cursor-plugin", "marketplace.json"));
  cursor.name = MARKETPLACE;
  cursor.metadata = { ...cursor.metadata, displayName: "FritzTech Local" };
  cursor.plugins = cursor.plugins.map((p) => ({ ...p, source: "./cursor/osmatrix" }));
  const codex = await readJson(join(root, ".agents", "plugins", "marketplace.json"));
  codex.name = MARKETPLACE;
  codex.interface = { ...codex.interface, displayName: "FritzTech Local" };
  codex.plugins = codex.plugins.map((p) => ({ ...p, source: { source: "local", path: "./codex/osmatrix" } }));
  for (const [dir, data] of [[".claude-plugin", claude], [".cursor-plugin", cursor], [".agents/plugins", codex]]) {
    await mkdir(join(output, dir), { recursive: true });
    await writeJson(join(output, dir, "marketplace.json"), data);
  }

  await writeFile(join(output, ".gitignore"), "*.tar.gz\n");
  const git = (...args) => execFileSync("git", ["-c", "user.name=osmatrix", "-c", "user.email=osmatrix@localhost", ...args], { cwd: output, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", `osmatrix ${version} bundled plugins`);

  console.log(`Bundled plugins for ${Object.keys(CLIENTS).join(", ")} in ${output} (marketplace "${MARKETPLACE}")`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
