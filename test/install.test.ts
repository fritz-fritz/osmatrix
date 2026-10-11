import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installSkills } from "../src/install.ts";
import { skillNames } from "../src/core/paths.ts";

test("installSkills installs every skill and removes only the legacy osmatrix skill it created", () => {
  const dest = mkdtempSync(path.join(tmpdir(), "osmatrix-skills-"));
  try {
    const expected = skillNames().map((n) => path.join(dest, n));
    assert.ok(expected.length >= 3);
    // An earlier version's copy, and a user's unrelated directory that happens to share the name.
    mkdirSync(path.join(dest, "osmatrix"));
    writeFileSync(path.join(dest, "osmatrix", "SKILL.md"), "---\nname: osmatrix\ndescription: old\n---\n");

    const dry = installSkills(dest, true, false, true);
    assert.deepEqual(dry.installed, expected);
    assert.deepEqual(dry.removedLegacy, [path.join(dest, "osmatrix")]);
    assert.ok(existsSync(path.join(dest, "osmatrix", "SKILL.md")), "dry run must not change anything");
    assert.ok(!existsSync(expected[0]));

    const done = installSkills(dest, true, false, false);
    assert.deepEqual(done.installed, expected);
    assert.ok(!existsSync(path.join(dest, "osmatrix")));
    for (const dir of expected) assert.match(readFileSync(path.join(dir, "SKILL.md"), "utf8"), new RegExp(`^name: ${path.basename(dir)}$`, "m"));

    // Symlink mode (falls back to a copy where symlinks are not allowed).
    installSkills(dest, false, false, false);
    for (const dir of expected) assert.ok(lstatSync(dir).isSymbolicLink() || existsSync(path.join(dir, "SKILL.md")));

    // Someone else's "osmatrix" skill is left alone.
    mkdirSync(path.join(dest, "osmatrix"));
    writeFileSync(path.join(dest, "osmatrix", "SKILL.md"), "---\nname: something-else\ndescription: theirs\n---\n");
    const un = installSkills(dest, false, true, false);
    assert.deepEqual(un.installed, []);
    assert.deepEqual(un.removedLegacy, []);
    for (const dir of expected) assert.ok(!existsSync(dir));
    assert.ok(existsSync(path.join(dest, "osmatrix", "SKILL.md")));
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
