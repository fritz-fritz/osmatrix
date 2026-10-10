import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CLIENTS, expectedMcpArgs, validatePlugin } from "../scripts/validate-plugins.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

test("every committed client plugin validates", async () => {
  for (const client of Object.keys(CLIENTS)) await validatePlugin(client, path.join(root, client), { version });
});

test("bundled MCP args use each host's plugin-root placeholder", () => {
  assert.equal(expectedMcpArgs("claude", "1.2.3", true)[1], "--package=${CLAUDE_PLUGIN_ROOT}/runtime/osmatrix-1.2.3.tgz");
  assert.equal(expectedMcpArgs("cursor", "1.2.3", true)[1], "--package=${CURSOR_PLUGIN_ROOT}/runtime/osmatrix-1.2.3.tgz");
  assert.equal(expectedMcpArgs("codex", "1.2.3", true)[1], "--package=${PLUGIN_ROOT}/runtime/osmatrix-1.2.3.tgz");
  assert.deepEqual(expectedMcpArgs("cursor", "1.2.3", false), ["-y", "osmatrix@1", "mcp"]);
});

test("plugin validation catches unusable listings, escaping paths, missing files and wrong placeholders", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "osmatrix-listing-"));
  try {
    await cp(path.join(root, "codex"), temp, { recursive: true });
    const manifestFile = path.join(temp, "plugin.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const listing = manifest.extensions["com.openai"].interface;
    const original = listing.shortDescription;
    listing.shortDescription = "x".repeat(31);
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(validatePlugin("codex", temp, { version }), /shortDescription/);
    listing.shortDescription = original;
    delete listing.supportURL;
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(validatePlugin("codex", temp, { version }), /supportURL must be an HTTPS URL/);
    listing.supportURL = "https://example.com/support";
    listing.brandColorDark = "#0B173C"; // navy on #212121: unreadable
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(validatePlugin("codex", temp, { version }), /brandColorDark needs at least 2:1 contrast/);
    listing.brandColorDark = "#5AA9F0";
    await writeFile(path.join(temp, "assets", "wide.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 48"/>');
    listing.logo = "./assets/wide.svg";
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(validatePlugin("codex", temp, { version }), /must be square/);
    listing.logo = "../outside.svg";
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(validatePlugin("codex", temp, { version }), /escapes plugin/);
    listing.logo = "./assets/missing.svg";
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(validatePlugin("codex", temp, { version }), /ENOENT/);

    const cursor = await mkdtemp(path.join(tmpdir(), "osmatrix-cursor-"));
    await cp(path.join(root, "cursor"), cursor, { recursive: true });
    const mcpFile = path.join(cursor, "mcp.json");
    const mcp = JSON.parse(await readFile(mcpFile, "utf8"));
    mcp.mcpServers.osmatrix.args = expectedMcpArgs("codex", version, true); // ${PLUGIN_ROOT}: Cursor would not expand it
    await writeFile(mcpFile, JSON.stringify(mcp));
    await assert.rejects(validatePlugin("cursor", cursor, { version, bundled: true }), /MCP args/);
    await rm(cursor, { recursive: true, force: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
