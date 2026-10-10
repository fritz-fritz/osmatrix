import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bridge = fileURLToPath(new URL("../assets/macos/bridge.py", import.meta.url));
const python = ["python3", "python"].find((p) => {
  try {
    execFileSync(p, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

test("bridge /file/ only serves regular files directly inside files/", { skip: !python && "python not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "osmatrix-bridge-"));
  try {
    mkdirSync(path.join(dir, "files", "sub"), { recursive: true });
    writeFileSync(path.join(dir, "files", "configure.sh"), "echo ok\n");
    writeFileSync(path.join(dir, "secret"), "nope\n");
    try {
      symlinkSync(path.join(dir, "secret"), path.join(dir, "files", "link.sh")); // must not be followed
    } catch {
      /* symlinks may need privileges on Windows */
    }
    const names = ["configure.sh", "link.sh", "..", ".", "../secret", "sub", "sub/x", "%2e%2e", ".hidden", "", "missing.sh"];
    const script = [
      "import importlib.util, json, sys",
      `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(bridge)})`,
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      `m.DIR = ${JSON.stringify(dir)}`,
      `print(json.dumps({n: m.safe_file(n) for n in ${JSON.stringify(names)}}))`,
    ].join("\n");
    const result = JSON.parse(execFileSync(python!, ["-c", script], { encoding: "utf8" }));
    assert.ok(result["configure.sh"]?.endsWith(path.join("files", "configure.sh")));
    for (const n of names.filter((n) => n !== "configure.sh")) assert.equal(result[n], null, `${JSON.stringify(n)} must be refused`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
