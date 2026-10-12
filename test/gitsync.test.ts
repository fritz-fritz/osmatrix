import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Snapshots go to the data dir's tmp; keep them away from the real install. Git config: the host side
// signs commits by default (the snapshot must not try to) and the "guest" checks out with
// core.autocrlf=true, as Git for Windows does on GitHub's runners and in osmatrix's Windows guest.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-gitsync-"));
process.env.OSMATRIX_HOME = path.join(root, "home");
const hostConfig = path.join(root, "host.gitconfig");
const guestConfig = path.join(root, "guest.gitconfig");
fs.writeFileSync(hostConfig, "[commit]\n\tgpgSign = true\n[init]\n\tdefaultBranch = main\n");
fs.writeFileSync(guestConfig, "[core]\n\tautocrlf = true\n[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = hostConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const { createBundle, guestCheckoutSteps, HEAD_REF, NotMaterializable, parseRefs, SNAPSHOT_REF, snapshotWorktree } = await import(
  "../src/core/gitsync.ts"
);
const { commandChain } = await import("../src/core/ssh.ts");

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
const guestEnv = { GIT_CONFIG_GLOBAL: guestConfig };
const g = (cwd: string, ...args: string[]) => git(cwd, args, guestEnv);
const commit = (cwd: string, msg: string) => git(cwd, ["-c", "commit.gpgSign=false", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg]);

type Snap = Awaited<ReturnType<typeof snapshotWorktree>>;

/** What run.ts does in the guest, with the guest's Git config: init once, fetch the bundle, check out. */
async function guestSync(guest: string, snap: Snap) {
  if (!fs.existsSync(path.join(guest, ".git"))) return applyFirst(guest, snap);
  return applySteps(guest, snap, parseRefs(g(guest, "for-each-ref", "--format=%(objectname) %(refname)")));
}
async function applyFirst(guest: string, snap: Snap) {
  g(root, "init", "-q", guest);
  return applySteps(guest, snap, new Map());
}
async function applySteps(guest: string, snap: Snap, refs: Map<string, string>): Promise<string | undefined> {
  const send = refs.get(SNAPSHOT_REF) !== snap.commit;
  const bundle = send ? await createBundle(snap, [...refs.values()], "r.bundle") : undefined;
  for (const s of guestCheckoutSteps(snap, refs, bundle)) {
    assert.equal(s.argv[0], "git");
    const r = spawnSync("git", s.argv.slice(1), { cwd: guest, env: { ...process.env, ...guestEnv }, encoding: "utf8" });
    if (r.status !== 0 && !s.optional) throw new Error(`${s.argv.join(" ")}: ${r.stderr}`);
  }
  return bundle;
}
const status = (cwd: string, env: NodeJS.ProcessEnv = {}) => git(cwd, ["status", "--porcelain"], env).split("\n").filter(Boolean).sort();

function makeRepo(name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  return repo;
}

test("the guest checkout follows the guest's Git config and matches the host's state", async () => {
  const repo = makeRepo("basic");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(repo, "mod.txt"), "before\n");
  fs.writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  fs.symlinkSync("a.txt", path.join(repo, "link"));
  git(repo, ["add", "-A"]);
  commit(repo, "first");
  git(repo, ["switch", "-q", "-c", "feature"]);
  git(repo, ["tag", "v1"]);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  fs.writeFileSync(path.join(repo, "mod.txt"), "after\n");
  fs.writeFileSync(path.join(repo, "new.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(repo, "ignored.log"), "x");
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const hostStatus = status(repo);
  const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
  const refsBefore = git(repo, ["for-each-ref"]);

  const snap = await snapshotWorktree(repo);
  try {
    assert.equal(snap.head, head);
    assert.equal(snap.branch, "refs/heads/feature");
    assert.deepEqual(snap.tags, ["refs/tags/v1"]);
    assert.equal(snap.origin, "https://github.com/acme/widget.git");
    // The user's index, refs and object store are untouched: the untracked file's blob isn't in it.
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), indexBefore);
    assert.equal(git(repo, ["for-each-ref"]), refsBefore);
    assert.deepEqual(status(repo), hostStatus);
    const blob = git(snap.dir, ["--git-dir", snap.dir, "rev-parse", `${snap.commit}:new.bin`]).trim();
    assert.equal(spawnSync("git", ["cat-file", "-e", blob], { cwd: repo }).status, 1);
    assert.equal(git(snap.dir, ["--git-dir", snap.dir, "rev-parse", `${snap.commit}^`]).trim(), head);

    const guest = path.join(root, "guest-basic");
    await guestSync(guest, snap);
    // CRLF as actions/checkout gives on Windows; the byte copy gave LF.
    assert.equal(fs.readFileSync(path.join(guest, "a.txt"), "utf8"), "one\r\ntwo\r\n");
    assert.equal(fs.readFileSync(path.join(guest, "mod.txt"), "utf8"), "after\r\n");
    assert.equal(fs.readFileSync(path.join(guest, "new.bin")).length, 3 * 1024 * 1024);
    assert.ok(fs.lstatSync(path.join(guest, "link")).isSymbolicLink());
    assert.ok(fs.statSync(path.join(guest, "run.sh")).mode & 0o100);
    assert.ok(!fs.existsSync(path.join(guest, "ignored.log")));
    // act's GITHUB_SHA/GITHUB_REF and GITHUB_REPOSITORY come from these.
    assert.equal(g(guest, "rev-parse", "HEAD").trim(), head);
    assert.equal(g(guest, "symbolic-ref", "HEAD").trim(), "refs/heads/feature");
    assert.equal(g(guest, "rev-parse", "refs/tags/v1").trim(), head);
    assert.equal(g(guest, "rev-parse", HEAD_REF).trim(), head);
    assert.equal(g(guest, "config", "remote.origin.url").trim(), "https://github.com/acme/widget.git");
    // Same changes as on the host: CRLF files of unchanged content aren't modified, ignored ones stay out.
    assert.deepEqual(status(guest, guestEnv), hostStatus);
    assert.equal(g(guest, "config", "--get", "core.filemode").trim(), "true");
  } finally {
    snap.dispose();
  }
  assert.ok(!fs.existsSync(snap.dir));
});

test("later syncs send only new objects and replace the previous run's refs and files", async () => {
  const repo = makeRepo("incr");
  fs.writeFileSync(path.join(repo, "big.dat"), Buffer.alloc(2 * 1024 * 1024, 1).map((_, i) => (i * 7919) % 251));
  git(repo, ["add", "-A"]);
  commit(repo, "first");
  git(repo, ["tag", "old"]);
  const guest = path.join(root, "guest-incr");
  const s1 = await snapshotWorktree(repo);
  const b1 = fs.statSync((await applyFirst(guest, s1))!).size;
  s1.dispose();
  fs.writeFileSync(path.join(guest, "junk.txt"), "left over");

  fs.writeFileSync(path.join(repo, "small.txt"), "hello\n");
  git(repo, ["add", "-A"]);
  commit(repo, "second");
  git(repo, ["switch", "-q", "-c", "next"]);
  const s2 = await snapshotWorktree(repo);
  try {
    const refs = parseRefs(g(guest, "for-each-ref", "--format=%(objectname) %(refname)"));
    const bundle = await applySteps(guest, s2, refs);
    assert.ok(bundle);
    assert.ok(fs.statSync(bundle).size < b1 / 10, "the second bundle leaves out what the guest has");
    assert.match(git(root, ["bundle", "list-heads", bundle]), /refs\/osmatrix\/snapshot/);
    assert.equal(g(guest, "symbolic-ref", "HEAD").trim(), "refs/heads/next");
    assert.ok(spawnSync("git", ["rev-parse", "-q", "--verify", "refs/heads/main"], { cwd: guest }).status !== 0, "old branch removed");
    assert.ok(spawnSync("git", ["rev-parse", "-q", "--verify", "refs/tags/old"], { cwd: guest }).status !== 0, "old tag removed");
    assert.ok(!fs.existsSync(path.join(guest, "junk.txt")));
    assert.equal(fs.readFileSync(path.join(guest, "small.txt"), "utf8"), "hello\r\n");
    assert.deepEqual(status(guest, guestEnv), []);
  } finally {
    s2.dispose();
  }

  // An unchanged tree is the same snapshot commit, so nothing needs sending.
  const s3 = await snapshotWorktree(repo);
  const s4 = await snapshotWorktree(repo);
  try {
    assert.equal(s3.commit, s4.commit);
    const refs = parseRefs(g(guest, "for-each-ref", "--format=%(objectname) %(refname)"));
    assert.equal(refs.get(SNAPSHOT_REF), s3.commit);
    assert.equal(await applySteps(guest, s3, refs), undefined);
  } finally {
    s3.dispose();
    s4.dispose();
  }
});

test("unborn HEAD and subdirectories get a standalone snapshot", async () => {
  const fresh = makeRepo("unborn");
  fs.writeFileSync(path.join(fresh, "x.txt"), "x\n");
  const s = await snapshotWorktree(fresh);
  try {
    assert.equal(s.head, undefined);
    assert.equal(s.branch, "refs/heads/main");
    const guest = path.join(root, "guest-unborn");
    await applyFirst(guest, s);
    assert.equal(g(guest, "rev-parse", "HEAD").trim(), s.commit);
    assert.equal(fs.readFileSync(path.join(guest, "x.txt"), "utf8"), "x\r\n");
    assert.deepEqual(status(guest, guestEnv), []);
  } finally {
    s.dispose();
  }

  const repo = makeRepo("mono");
  fs.mkdirSync(path.join(repo, "pkg", "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "top.txt"), "top\n");
  fs.writeFileSync(path.join(repo, "pkg", "src", "a.txt"), "a\n");
  git(repo, ["add", "-A"]);
  commit(repo, "first");
  fs.writeFileSync(path.join(repo, "pkg", "b.txt"), "b\n");
  const sub = await snapshotWorktree(path.join(repo, "pkg"));
  try {
    assert.equal(sub.head, undefined);
    const files = git(sub.dir, ["--git-dir", sub.dir, "ls-tree", "-r", "--name-only", sub.commit]).trim().split("\n");
    assert.deepEqual(files.sort(), ["b.txt", "src/a.txt"]);
  } finally {
    sub.dispose();
  }
});

test("repositories a checkout can't reproduce fall back to copying", async () => {
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  await assert.rejects(snapshotWorktree(plain), NotMaterializable);

  const lfs = makeRepo("lfs");
  fs.writeFileSync(path.join(lfs, ".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
  fs.writeFileSync(path.join(lfs, "art.psd"), "binary");
  await assert.rejects(snapshotWorktree(lfs), (e: Error) => e instanceof NotMaterializable && /art\.psd.*lfs/.test(e.message));

  const outer = makeRepo("nested");
  fs.writeFileSync(path.join(outer, "a.txt"), "a\n");
  const inner = path.join(outer, "vendor", "lib");
  fs.mkdirSync(inner, { recursive: true });
  git(inner, ["init", "-q"]);
  fs.writeFileSync(path.join(inner, "l.txt"), "l\n");
  git(inner, ["add", "-A"]);
  commit(inner, "lib");
  await assert.rejects(snapshotWorktree(outer), (e: Error) => e instanceof NotMaterializable && /vendor\/lib/.test(e.message));
  // Nothing is left behind in the data dir's tmp.
  assert.deepEqual(fs.readdirSync(path.join(root, "home", "tmp")), []);
});

test("command chains stop at the first failing step in every guest shell", () => {
  const steps = [{ argv: ["git", "fetch", "a b"] }, { argv: ["git", "config", "--unset-all", "x"], optional: true }, { argv: ["git", "reset", "-q"] }];
  assert.equal(commandChain("posix", steps), "git fetch 'a b' && (git config --unset-all x || true) && git reset -q");
  assert.equal(commandChain("cmd", steps), `git fetch "a b" && (git config --unset-all x || ver >nul) && git reset -q`);
  assert.equal(
    commandChain("pwsh", steps),
    "$ErrorActionPreference = 'Stop'; & git fetch 'a b'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & git config --unset-all x; & git reset -q; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  );
});

test("parseRefs reads for-each-ref output with CRLF", () => {
  const sha = "a".repeat(40);
  assert.deepEqual([...parseRefs(`${sha} refs/heads/main\r\n${sha} refs/osmatrix/snapshot\r\nfatal: junk\r\n`)], [
    ["refs/heads/main", sha],
    ["refs/osmatrix/snapshot", sha],
  ]);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
