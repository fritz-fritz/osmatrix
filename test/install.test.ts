import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectScope, installAgents, installSkills } from "../src/install.ts";
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

test("detectScope: project scope when the running osmatrix is that project's node_modules/osmatrix, else the user's", () => {
  const root = mkdtempSync(path.join(tmpdir(), "osmatrix-scope-"));
  try {
    const pkg = path.join(root, "pkg");
    mkdirSync(pkg);
    const proj = path.join(root, "proj");
    mkdirSync(path.join(proj, "node_modules"), { recursive: true });
    symlinkSync(pkg, path.join(proj, "node_modules", "osmatrix"), "dir"); // as npm link does; npm install puts a directory there
    const deep = path.join(proj, "src", "deep");
    mkdirSync(deep, { recursive: true });
    assert.deepEqual(detectScope(deep, pkg), { scope: "project", projectRoot: realpathSync(proj), reason: `osmatrix is a dependency of ${realpathSync(proj)}` });
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    assert.equal(detectScope(elsewhere, pkg).scope, "user");
    // A project with some other copy of osmatrix in node_modules: the one running (global, say) isn't it.
    const other = path.join(root, "other");
    mkdirSync(path.join(other, "node_modules", "osmatrix"), { recursive: true });
    assert.equal(detectScope(other, pkg).scope, "user");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installAgents --scope project writes the project's files, links its skills relatively, and reverses", async () => {
  const proj = mkdtempSync(path.join(tmpdir(), "osmatrix-proj-"));
  try {
    const r = await installAgents({ scope: "project", projectRoot: proj });
    assert.equal(r.scope, "project");
    const claude = JSON.parse(readFileSync(path.join(proj, ".mcp.json"), "utf8")).mcpServers.osmatrix;
    assert.match(claude.args.join(" "), /^-y osmatrix@\d+ mcp$/, "the npm package, pinned to the major: the project's own copy when it satisfies");
    assert.equal(JSON.parse(readFileSync(path.join(proj, ".cursor", "mcp.json"), "utf8")).mcpServers.osmatrix.command, claude.command);
    assert.match(readFileSync(path.join(proj, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.osmatrix\]/);
    for (const dir of [".claude/skills", ".agents/skills"]) {
      for (const name of skillNames()) {
        const p = path.join(proj, dir, name);
        assert.ok(existsSync(path.join(p, "SKILL.md")), `${dir}/${name}`);
        if (process.platform !== "win32" && lstatSync(p).isSymbolicLink()) assert.ok(!path.isAbsolute(readlinkSync(p)), `relative link: ${readlinkSync(p)}`);
      }
    }
    assert.ok(!existsSync(path.join(proj, ".claude.json")), "nothing of the user's scope");
    const un = await installAgents({ scope: "project", projectRoot: proj, uninstall: true });
    assert.equal(un.uninstall, true);
    assert.equal(JSON.parse(readFileSync(path.join(proj, ".mcp.json"), "utf8")).mcpServers.osmatrix, undefined);
    assert.doesNotMatch(readFileSync(path.join(proj, ".codex", "config.toml"), "utf8"), /mcp_servers\.osmatrix/);
    for (const name of skillNames()) assert.ok(!existsSync(path.join(proj, ".agents", "skills", name)));
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});
