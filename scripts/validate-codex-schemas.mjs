#!/usr/bin/env node
// Validate the Codex plugin manifests against the published Agent Plugins 1.0.0 JSON Schemas.
// ajv comes from .github/ci-tools (npm ci --prefix .github/ci-tools), so the root package doesn't
// depend on it; CI runs this, contributors can too.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, ".github", "ci-tools", "package.json"));
let Ajv2020, addFormats;
try {
  Ajv2020 = require("ajv/dist/2020").default;
  addFormats = require("ajv-formats").default ?? require("ajv-formats");
} catch {
  console.error("ajv not installed: run npm ci --prefix .github/ci-tools");
  process.exit(2);
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
let bad = 0;
for (const [schema, file] of [
  ["plugin", "codex/plugin.json"],
  ["mcp", "codex/mcp.json"],
]) {
  const res = await fetch(`https://agent-plugins.org/schemas/1.0.0/${schema}.schema.json`);
  if (!res.ok) throw new Error(`fetching ${schema} schema: HTTP ${res.status}`);
  const validate = ajv.compile(await res.json());
  if (validate(JSON.parse(readFileSync(join(root, file), "utf8")))) console.log(`${file} valid`);
  else {
    bad = 1;
    console.error(file, JSON.stringify(validate.errors, null, 2));
  }
}
process.exitCode = bad;
