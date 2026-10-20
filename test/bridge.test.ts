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

test("HostBridge: runs one command through the guest's polling loop, only under its token", async () => {
  const { HostBridge } = await import("../src/core/bridge.ts");
  const b = new HostBridge();
  await b.start();
  try {
    const base = b.url("127.0.0.1");
    const root = `http://127.0.0.1:${b.port}`;
    assert.equal(b.alive(), false);
    assert.equal((await fetch(`${base}/next`)).status, 204, "no command queued");
    assert.equal(b.alive(), true);
    const out = b.run("echo hi", 5);
    // Another local process without the token can't take the command or answer it.
    assert.equal((await fetch(`${root}/next`)).status, 404);
    assert.equal((await fetch(`${root}/result`, { method: "POST", body: "forged" })).status, 404);
    const next = await fetch(`${base}/next`);
    assert.equal(await next.text(), "echo hi");
    assert.equal((await fetch(`${base}/next`)).status, 204, "a command is handed out once");
    await fetch(`${base}/result`, { method: "POST", body: "hi\n[rc=0]\n" });
    assert.equal(await out, "hi\n[rc=0]\n");

    const dir = mkdtempSync(path.join(tmpdir(), "osmatrix-hostbridge-"));
    writeFileSync(path.join(dir, "configure.sh"), "echo ok\n");
    b.serveFile("configure.sh", path.join(dir, "configure.sh"));
    assert.equal(await (await fetch(`${base}/file/configure.sh`)).text(), "echo ok\n");
    assert.equal((await fetch(`${base}/file/..%2Fsecret`)).status, 404, "only files offered by name");
    rmSync(dir, { recursive: true, force: true });
    await assert.rejects(b.run("sleep 9", 0.2), /timeout/);
  } finally {
    b.stop();
  }
});
