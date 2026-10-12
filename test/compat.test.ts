import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { HOSTS, compatibility, type Compat } from "../src/core/compat.ts";
import { sanitize } from "../src/report.ts";

const MARK: Record<string, Compat> = { "✅": "tested", "🧪": "untested", "❌": "unsupported" };

/** Rows of the "| Host | ubuntu | windows | macos |" table, as host label -> statuses. */
function matrix(file: string): Map<string, Compat[]> {
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf("| Host | ubuntu | windows | macos |");
  assert.ok(start >= 0, `${file} has no compatibility matrix`);
  const rows = new Map<string, Compat[]>();
  for (const line of text.slice(start).split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    const [label, ...cells] = line.split("|").slice(1, -1).map((c) => c.trim());
    rows.set(label, cells.map((c) => MARK[[...c][0]] ?? (`?${c}` as Compat)));
  }
  return rows;
}

for (const file of ["README.md", "skills/osmatrix-setup/references/reference.md"]) {
  test(`${file} compatibility matrix matches src/core/compat.ts`, () => {
    const rows = matrix(file);
    assert.deepEqual([...rows.keys()], HOSTS.map((h) => h.label));
    for (const h of HOSTS) assert.deepEqual(rows.get(h.label), [h.guests.linux, h.guests.windows, h.guests.macos], h.label);
  });
}

test("compatibility: ssh guests don't depend on the host; unknown hosts are untested", () => {
  assert.equal(compatibility({ os: "macos", backend: "ssh" }, "win32", "arm64"), "tested");
  assert.equal(compatibility({ os: "windows", backend: "qemu" }, "darwin", "arm64"), "untested");
  assert.equal(compatibility({ os: "windows", backend: "dockur" }, "linux", "x64"), "tested");
  assert.equal(compatibility({ os: "linux", backend: "container" }, "freebsd", "x64"), "untested");
});

test("sanitize removes the home directory, user name and host name", () => {
  const ids = { home: "/home/alice", user: "alice", host: "alices-mbp" };
  assert.equal(
    sanitize("act: /home/alice/.local/bin/act on alices-mbp as alice; malice stays", ids),
    "act: ~/.local/bin/act on <host> as <user>; malice stays",
  );
  assert.equal(sanitize("ok", { home: "", user: "a", host: "" }), "ok");
});
