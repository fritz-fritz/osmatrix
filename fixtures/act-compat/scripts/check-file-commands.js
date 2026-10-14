// Fails unless every file-command path lies inside RUNNER_TEMP, as on GitHub's runners
// (`$RUNNER_TEMP/_runner_file_commands/…`). Stock act keeps them in its own act/workflow/ directory.
const fs = require("node:fs");
const path = require("node:path");

const real = (p) => fs.realpathSync.native(path.resolve(p));
const temp = real(process.env.RUNNER_TEMP);
let bad = 0;
for (const name of ["GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STATE", "GITHUB_STEP_SUMMARY"]) {
  const value = process.env[name];
  if (!value) {
    console.log(`${name} is not set`);
    bad++;
    continue;
  }
  // The file may not exist yet; its directory does.
  const resolved = path.join(real(path.dirname(value)), path.basename(value));
  const rel = path.relative(temp, resolved);
  const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  console.log(`${inside ? "ok " : "BAD"} ${name}=${value}`);
  if (!inside) bad++;
}
if (bad) {
  console.log(`::error::${bad} file-command path(s) outside RUNNER_TEMP (${process.env.RUNNER_TEMP})`);
  process.exit(1);
}
console.log(`all file-command paths are inside RUNNER_TEMP (${process.env.RUNNER_TEMP})`);
