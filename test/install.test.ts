import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installSkills } from "../src/install.ts";
import { skillNames } from "../src/core/paths.ts";

test("installSkills installs every skill, replaces its own earlier copies and leaves other people's directories alone", () => {
  const dest = mkdtempSync(path.join(tmpdir(), "osmatrix-skills-"));
  try {
    const names = skillNames();
    assert.ok(names.includes("osmatrix") && names.length >= 4);
    const expected = names.map((n) => path.join(dest, n));
    const ours = path.join(dest, "osmatrix");
    // An earlier version's copy of the osmatrix skill: ours, so it is replaced.
    mkdirSync(ours);
    writeFileSync(path.join(ours, "SKILL.md"), "---\nname: osmatrix\ndescription: old\n---\n");

    const dry = installSkills(dest, true, false, true);
    assert.deepEqual(dry, { installed: expected, removedLegacy: [], skipped: [] });
    assert.match(readFileSync(path.join(ours, "SKILL.md"), "utf8"), /description: old/, "dry run must not change anything");
    assert.ok(!existsSync(expected[1]));

    const done = installSkills(dest, true, false, false);
    assert.deepEqual(done.installed, expected);
    for (const dir of expected) assert.match(readFileSync(path.join(dir, "SKILL.md"), "utf8"), new RegExp(`^name: ${path.basename(dir)}$`, "m"));
    assert.doesNotMatch(readFileSync(path.join(ours, "SKILL.md"), "utf8"), /description: old/);

    // Symlink mode (falls back to a copy where symlinks are not allowed).
    installSkills(dest, false, false, false);
    for (const dir of expected) assert.ok(lstatSync(dir).isSymbolicLink() || existsSync(path.join(dir, "SKILL.md")));

    // A dangling symlink into an old package's skills/osmatrix is ours too.
    rmSync(ours, { recursive: true, force: true });
    symlinkSync(path.join(dest, "gone", "skills", "osmatrix"), ours, "dir");
    assert.deepEqual(installSkills(dest, false, false, true), { installed: expected, removedLegacy: [], skipped: [] });

    // Someone else's "osmatrix" skill is left alone, whether a directory or a symlink elsewhere: not
    // replaced on install, not removed on uninstall.
    rmSync(ours, { recursive: true, force: true });
    mkdirSync(ours);
    writeFileSync(path.join(ours, "SKILL.md"), "---\nname: something-else\ndescription: theirs\n---\n");
    const rest = expected.filter((d) => d !== ours);
    assert.deepEqual(installSkills(dest, false, false, true), { installed: rest, removedLegacy: [], skipped: [ours] });
    assert.deepEqual(installSkills(dest, false, true, false), { installed: [], removedLegacy: [], skipped: [ours] });
    for (const dir of rest) assert.ok(!existsSync(dir));
    assert.match(readFileSync(path.join(ours, "SKILL.md"), "utf8"), /theirs/);
    rmSync(ours, { recursive: true });
    const theirs = path.join(dest, "theirs");
    mkdirSync(theirs);
    writeFileSync(path.join(theirs, "SKILL.md"), "---\nname: theirs\ndescription: theirs\n---\n");
    symlinkSync(theirs, ours, "dir");
    assert.deepEqual(installSkills(dest, false, false, true).skipped, [ours]);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("installSkills removes a no-longer-shipped skill of an earlier version only when it created it", () => {
  const dest = mkdtempSync(path.join(tmpdir(), "osmatrix-skills-"));
  try {
    const old = path.join(dest, "osmatrix-old");
    mkdirSync(old);
    writeFileSync(path.join(old, "SKILL.md"), "---\nname: osmatrix-old\ndescription: ours, once\n---\n");
    assert.deepEqual(installSkills(dest, true, false, true, ["osmatrix-old"]).removedLegacy, [old]);
    // A shipped name in the legacy list is just a current skill, never "legacy".
    assert.deepEqual(installSkills(dest, true, false, true, ["osmatrix", "osmatrix-old"]).removedLegacy, [old]);
    writeFileSync(path.join(old, "SKILL.md"), "---\nname: theirs\ndescription: theirs\n---\n");
    assert.deepEqual(installSkills(dest, true, false, true, ["osmatrix-old"]).removedLegacy, []);
    installSkills(dest, true, true, false, ["osmatrix-old"]);
    assert.ok(existsSync(path.join(old, "SKILL.md")));
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
