import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));

test("MCP starts, discovers tools, plans an explicit checkout and reports tool errors", { timeout: 120000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "osmatrix-mcp-"));
  const pluginRoot = process.env.OSMATRIX_TEST_PLUGIN_ROOT;
  // OSMATRIX_TEST_PLUGIN_ROOT: a bundled plugin from `npm run package:plugins` (any client).
  const mcpFile = pluginRoot && [".mcp.json", "mcp.json"].map((f) => path.join(pluginRoot, f)).find((f) => existsSync(f));
  const server = mcpFile
    ? JSON.parse(await readFile(mcpFile, "utf8")).mcpServers.osmatrix
    : { command: process.execPath, args: [path.join(root, "src", "cli.ts"), "mcp"] };
  const transport = new StdioClientTransport({
    command: server.command,
    // What the host does: expand its plugin-root placeholder.
    args: server.args.map((arg: string) => arg.replace(/\$\{(?:CLAUDE_|CURSOR_)?PLUGIN_ROOT\}/g, pluginRoot ?? "")),
    // Launch somewhere unrelated to the checkout, as a plugin host may do.
    cwd: home,
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), OSMATRIX_HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "osmatrix-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "env_setup"));
    // Plugin guidelines: explicit boolean safety annotations on every tool.
    for (const t of tools) {
      assert.ok(t.title, `${t.name} has no title`);
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
        assert.equal(typeof t.annotations?.[hint], "boolean", `${t.name}.${hint} must be an explicit boolean`);
      }
      if (t.annotations?.readOnlyHint) assert.equal(t.annotations.destructiveHint, false, `${t.name}: read-only tools cannot be destructive`);
    }
    assert.ok(tools.some((t) => t.name === "env_forward"));
    const plan = await client.callTool({ name: "ci_plan", arguments: { repo: path.join(root, "fixtures", "matrix-demo"), only: ["linux"] } });
    assert.notEqual(plan.isError, true);
    const text = plan.content as { type: string; text: string }[];
    const result = JSON.parse(text[0].text);
    assert.ok(result.legs.length > 0);
    assert.ok(result.legs.every((leg: { target: string }) => leg.target === "host"));
    const forwards = await client.callTool({ name: "env_forwards", arguments: {} });
    assert.notEqual(forwards.isError, true);
    const error = await client.callTool({ name: "env_status", arguments: { guest: "does-not-exist" } });
    assert.equal(error.isError, true);
    assert.match((error.content as { text: string }[])[0].text, /unknown guest/);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
});
