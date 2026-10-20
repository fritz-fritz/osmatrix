import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Snapshot caches live in the data dir; keep them away from the real install. Git config: the host side
// signs commits by default (the snapshot must not try to) and the "guest" checks out with
// core.autocrlf=true, as Git for Windows does on GitHub's runners and in osmatrix's Windows guest.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "osmatrix-gitsync-"));
process.env.OSMATRIX_HOME = path.join(root, "home");
// Creating symlinks needs a privilege or Developer Mode on Windows; probe rather than assume.
const canSymlink = (() => {
  try {
    fs.symlinkSync("target", path.join(root, "probe-link"));
    return true;
  } catch {
    return false;
  }
})();
const hostConfig = path.join(root, "host.gitconfig");
const guestConfig = path.join(root, "guest.gitconfig");
fs.writeFileSync(hostConfig, `[commit]\n\tgpgSign = true\n[init]\n\tdefaultBranch = main\n[core]\n\tsymlinks = ${canSymlink}\n`);
fs.writeFileSync(guestConfig, "[core]\n\tautocrlf = true\n[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = hostConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const gs = await import("../src/core/gitsync.ts");
const { createBundle, HEAD_REF, NotMaterializable, parseRefs, SNAPSHOT_REF, snapshotCache, snapshotWorktree } = gs;
const { commandChain } = await import("../src/core/ssh.ts");
type Snap = Awaited<ReturnType<typeof snapshotWorktree>>;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
const guestEnv = { GIT_CONFIG_GLOBAL: guestConfig };
const g = (cwd: string, ...args: string[]) => git(cwd, args, guestEnv);
const gStatus = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" }).status;
const commit = (cwd: string, msg: string) => git(cwd, ["-c", "commit.gpgSign=false", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg]);
const status = (cwd: string, env: NodeJS.ProcessEnv = {}) => git(cwd, ["status", "--porcelain"], env).split("\n").filter(Boolean).sort();

function steps(cwd: string, list: { argv: string[]; optional?: boolean }[]) {
  for (const s of list) {
    assert.equal(s.argv[0], "git");
    const r = spawnSync("git", s.argv.slice(1), { cwd, env: { ...process.env, ...guestEnv }, encoding: "utf8" });
    if (r.status !== 0 && !s.optional) throw new Error(`${s.argv.join(" ")}: ${r.stderr}`);
  }
}

/**
 * What run.ts does in the guest, with the guest's Git config: keep a bare cache, fetch the bundle into
 * it, recreate the work tree as a shared clone, check out. Returns the bundle's size when one was sent.
 */
async function guestSync(guestHome: string, name: string, snap: Snap): Promise<number | undefined> {
  const cache = path.join(guestHome, ".osmatrix-cache", `${name}.git`);
  const remote = path.join(guestHome, name);
  let refs = new Map<string, string>();
  if (fs.existsSync(cache)) refs = parseRefs(g(guestHome, "--git-dir", cache, "for-each-ref", "--format=%(objectname) %(refname)"));
  else g(guestHome, "init", "-q", "--bare", cache);
  const bundle = refs.get(SNAPSHOT_REF) !== snap.commit ? await createBundle(snap, [...refs.values()], `${name}.bundle`) : undefined;
  const size = bundle ? fs.statSync(bundle).size : undefined;
  steps(guestHome, gs.guestCacheSteps(snap, cache, bundle));
  fs.rmSync(remote, { recursive: true, force: true });
  steps(guestHome, [gs.guestCloneStep(cache, remote)]);
  const probe = spawnSync("git", ["config", "--local", "--get", "core.symlinks"], { cwd: remote, env: { ...process.env, ...guestEnv }, encoding: "utf8" });
  steps(remote, gs.guestCheckoutSteps(snap, gs.symlinksAllowed(probe.stdout)));
  await snap.synced();
  return size;
}

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
  if (canSymlink) fs.symlinkSync("a.txt", path.join(repo, "link"));
  git(repo, ["add", "-A"]);
  commit(repo, "first");
  git(repo, ["switch", "-q", "-c", "feature"]);
  git(repo, ["tag", "v1"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "tag", "-a", "release", "-m", "annotated"]);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  fs.writeFileSync(path.join(repo, "mod.txt"), "after\n");
  fs.writeFileSync(path.join(repo, "new.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(repo, "ignored.log"), "x");
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const hostStatus = status(repo);
  const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
  const refsBefore = git(repo, ["for-each-ref"]);

  const snap = await snapshotWorktree(repo, "g");
  try {
    assert.equal(snap.dir, snapshotCache(repo, "g"));
    assert.equal(snap.head, head);
    assert.equal(snap.branch, "refs/heads/feature");
    // Annotated tags count too: act picks GITHUB_REF from either kind.
    assert.deepEqual(snap.tags, ["refs/tags/release", "refs/tags/v1"]);
    assert.equal(snap.origin, "https://github.com/acme/widget.git");
    // The user's index, refs and object store are untouched: the untracked file's blob isn't in it.
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), indexBefore);
    assert.equal(git(repo, ["for-each-ref"]), refsBefore);
    assert.deepEqual(status(repo), hostStatus);
    const blob = git(snap.dir, ["--git-dir", snap.dir, "rev-parse", `${snap.commit}:new.bin`]).trim();
    assert.equal(gStatus(repo, ["cat-file", "-e", blob]), 1);
    assert.equal(git(snap.dir, ["--git-dir", snap.dir, "rev-parse", `${snap.commit}^`]).trim(), head);

    const home = path.join(root, "guest-basic");
    fs.mkdirSync(home);
    await guestSync(home, "basic", snap);
    const guest = path.join(home, "basic");
    // CRLF as actions/checkout gives on Windows; the byte copy gave LF.
    assert.equal(fs.readFileSync(path.join(guest, "a.txt"), "utf8"), "one\r\ntwo\r\n");
    assert.equal(fs.readFileSync(path.join(guest, "mod.txt"), "utf8"), "after\r\n");
    assert.equal(fs.readFileSync(path.join(guest, "new.bin")).length, 3 * 1024 * 1024);
    assert.ok(!fs.existsSync(path.join(guest, "ignored.log")));
    // Links and modes as the guest's Git config says, not as the host had them.
    if (canSymlink) {
      if (g(guest, "config", "--get", "core.symlinks").trim() === "true") assert.ok(fs.lstatSync(path.join(guest, "link")).isSymbolicLink());
      else assert.equal(fs.readFileSync(path.join(guest, "link"), "utf8"), "a.txt");
    }
    const mode = g(guest, "ls-files", "-s", "run.sh").split(" ")[0];
    if (mode === "100755" && g(guest, "config", "--get", "core.filemode").trim() === "true") assert.ok(fs.statSync(path.join(guest, "run.sh")).mode & 0o100);
    // act's GITHUB_SHA/GITHUB_REF and GITHUB_REPOSITORY come from these.
    assert.equal(g(guest, "rev-parse", "HEAD").trim(), head);
    assert.equal(g(guest, "symbolic-ref", "HEAD").trim(), "refs/heads/feature");
    assert.equal(g(guest, "rev-parse", "refs/tags/v1").trim(), head);
    assert.equal(g(guest, "rev-parse", "refs/tags/release^{commit}").trim(), head);
    assert.equal(g(home, "--git-dir", path.join(home, ".osmatrix-cache", "basic.git"), "rev-parse", HEAD_REF).trim(), head);
    assert.equal(g(guest, "config", "remote.origin.url").trim(), "https://github.com/acme/widget.git");
    // Same changes as on the host: CRLF files of unchanged content aren't modified, ignored ones stay out.
    assert.deepEqual(status(guest, guestEnv), hostStatus);
  } finally {
    snap.dispose();
  }
  // Temporary files go; the cache stays for the next run.
  assert.deepEqual(fs.readdirSync(snap.dir).filter((f) => f.startsWith("tmp-")), []);
});

test("later syncs send only what changed, uncommitted files included, into a fresh repository", async () => {
  const repo = makeRepo("incr");
  fs.writeFileSync(path.join(repo, "small.txt"), "hello\n");
  git(repo, ["add", "-A"]);
  commit(repo, "first");
  git(repo, ["tag", "old"]);
  // Large and untracked: only the host cache keeps its blob between runs.
  fs.writeFileSync(path.join(repo, "big.dat"), crypto.randomBytes(2 * 1024 * 1024));
  const home = path.join(root, "guest-incr");
  fs.mkdirSync(home);
  const guest = path.join(home, "incr");
  const s1 = await snapshotWorktree(repo, "g");
  const b1 = await guestSync(home, "incr", s1).finally(() => s1.dispose());
  assert.ok(b1! > 2 * 1024 * 1024);

  // What a workflow step might leave behind in the guest repository.
  g(guest, "config", "core.autocrlf", "false");
  g(guest, "config", "core.sparseCheckout", "true");
  fs.writeFileSync(path.join(guest, ".git", "info", "attributes"), "* -text\n");
  fs.mkdirSync(path.join(guest, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(guest, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  g(guest, "update-ref", "refs/heads/stray", "HEAD");

  fs.appendFileSync(path.join(repo, "small.txt"), "one more line\n");
  const s2 = await snapshotWorktree(repo, "g");
  const b2 = await guestSync(home, "incr", s2).finally(() => s2.dispose());
  assert.ok(b2! < 20 * 1024, `the second bundle (${b2} bytes) leaves out the unchanged untracked blob`);
  assert.equal(fs.readFileSync(path.join(guest, "small.txt"), "utf8"), "hello\r\none more line\r\n");
  assert.equal(fs.readFileSync(path.join(guest, "big.dat")).length, 2 * 1024 * 1024);
  assert.equal(gStatus(guest, ["config", "--get", "core.sparseCheckout"], guestEnv), 1);
  assert.ok(!fs.existsSync(path.join(guest, ".git", "hooks", "post-checkout")));
  assert.equal(gStatus(guest, ["rev-parse", "-q", "--verify", "refs/heads/stray"], guestEnv), 1);
  assert.deepEqual(status(guest, guestEnv), status(repo));

  git(repo, ["add", "-A"]);
  commit(repo, "second");
  git(repo, ["switch", "-q", "-c", "next"]);
  const s3 = await snapshotWorktree(repo, "g");
  const b3 = await guestSync(home, "incr", s3).finally(() => s3.dispose());
  assert.ok(b3! < 20 * 1024, "committing what the guest has sends next to nothing");
  assert.equal(g(guest, "symbolic-ref", "HEAD").trim(), "refs/heads/next");
  assert.equal(gStatus(guest, ["rev-parse", "-q", "--verify", "refs/heads/main"], guestEnv), 1);
  assert.equal(gStatus(guest, ["rev-parse", "-q", "--verify", "refs/tags/old"], guestEnv), 1);
  assert.deepEqual(status(guest, guestEnv), []);

  // An unchanged tree is the same snapshot commit, so nothing needs sending.
  const s4 = await snapshotWorktree(repo, "g");
  try {
    assert.equal(s4.commit, s3.commit);
    assert.equal(await guestSync(home, "incr", s4), undefined);
    assert.deepEqual(status(guest, guestEnv), []);
  } finally {
    s4.dispose();
  }
});

test("staged and unstaged changes stay apart in the guest", async () => {
  const repo = makeRepo("staged");
  for (const f of ["a", "b", "c", "d"]) fs.writeFileSync(path.join(repo, `${f}.txt`), `${f}\n`);
  git(repo, ["add", "-A"]);
  commit(repo, "first");
  const home = path.join(root, "guest-staged");
  fs.mkdirSync(home);
  const guest = path.join(home, "staged");
  const check = async (label: string) => {
    const s = await snapshotWorktree(repo, "g");
    await guestSync(home, "staged", s).finally(() => s.dispose());
    assert.deepEqual(status(guest, guestEnv), status(repo), label);
    for (const args of [["diff", "--exit-code"], ["diff", "--cached", "--exit-code"]]) {
      assert.equal(gStatus(guest, args, guestEnv), gStatus(repo, args), `${label}: git ${args.join(" ")}`);
    }
  };
  fs.writeFileSync(path.join(repo, "a.txt"), "a staged\n");
  git(repo, ["add", "a.txt"]);
  await check("staged only");
  git(repo, ["reset", "-q"]);
  await check("unstaged only");
  git(repo, ["add", "a.txt"]);
  fs.writeFileSync(path.join(repo, "b.txt"), "b unstaged\n");
  fs.writeFileSync(path.join(repo, "c.txt"), "c staged\n");
  git(repo, ["add", "c.txt"]);
  fs.writeFileSync(path.join(repo, "c.txt"), "c staged, then edited\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
  git(repo, ["add", "new.txt"]);
  git(repo, ["rm", "-q", "d.txt"]);
  fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");
  await check("mixed");
});

test("unborn HEAD and subdirectories get a standalone snapshot", async () => {
  const fresh = makeRepo("unborn");
  fs.writeFileSync(path.join(fresh, "x.txt"), "x\n");
  const s = await snapshotWorktree(fresh, "g");
  try {
    assert.equal(s.head, undefined);
    assert.equal(s.index, undefined);
    assert.equal(s.branch, "refs/heads/main");
    const home = path.join(root, "guest-unborn");
    fs.mkdirSync(home);
    await guestSync(home, "unborn", s);
    const guest = path.join(home, "unborn");
    assert.equal(g(guest, "rev-parse", "HEAD").trim(), s.commit);
    assert.equal(fs.readFileSync(path.join(guest, "x.txt"), "utf8"), "x\r\n");
    assert.deepEqual(status(guest, guestEnv), []);
    assert.equal(gStatus(guest, ["config", "--get", "remote.origin.url"], guestEnv), 1);
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
  const sub = await snapshotWorktree(path.join(repo, "pkg"), "g");
  try {
    assert.equal(sub.head, undefined);
    const files = git(sub.dir, ["--git-dir", sub.dir, "ls-tree", "-r", "--name-only", sub.commit]).trim().split("\n");
    assert.deepEqual(files.sort(), ["b.txt", "src/a.txt"]);
  } finally {
    sub.dispose();
  }
});

test("a host cache that lost its basis starts over", async () => {
  const repo = makeRepo("rewrite");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, ["add", "-A"]);
  commit(repo, "first");
  const s1 = await snapshotWorktree(repo, "g");
  s1.dispose();
  // Corrupt the cache: its alternates no longer reach the user's objects.
  fs.writeFileSync(path.join(s1.dir, "objects", "info", "alternates"), path.join(root, "nowhere") + "\n");
  const s2 = await snapshotWorktree(repo, "g");
  s2.dispose();
  assert.equal(s2.commit, s1.commit);
});

test("a linked worktree becomes a self-contained clone for host legs", async () => {
  const main = makeRepo("linked-main");
  fs.writeFileSync(path.join(main, "a.txt"), "a\n");
  fs.writeFileSync(path.join(main, "b.txt"), "b\n");
  git(main, ["add", "-A"]);
  commit(main, "first");
  git(main, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  assert.equal(await gs.gitDirOutsideWorkTree(main), false);
  assert.equal(await gs.gitDirOutsideWorkTree(path.join(main, "..")), false);

  const wt = path.join(root, "linked-wt");
  git(main, ["worktree", "add", "-q", "-b", "agent", wt]);
  assert.equal(await gs.gitDirOutsideWorkTree(wt), true);
  fs.writeFileSync(path.join(wt, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(wt, "new.txt"), "untracked\n");
  git(wt, ["add", "b.txt"]);
  const head = git(wt, ["rev-parse", "HEAD"]).trim();
  const statusBefore = status(wt);

  const clone = path.join(root, "linked-clone");
  await gs.cloneWorktree(wt, clone);
  assert.ok(fs.statSync(path.join(clone, ".git")).isDirectory());
  assert.equal(fs.existsSync(path.join(clone, ".git", "objects", "info", "alternates")), false);
  assert.equal(git(clone, ["rev-parse", "HEAD"]).trim(), head);
  assert.equal(git(clone, ["symbolic-ref", "HEAD"]).trim(), "refs/heads/agent");
  assert.equal(git(clone, ["config", "remote.origin.url"]).trim(), "https://github.com/acme/widget.git");
  assert.equal(fs.readFileSync(path.join(clone, "a.txt"), "utf8"), "changed\n");
  assert.equal(fs.readFileSync(path.join(clone, "new.txt"), "utf8"), "untracked\n");
  assert.deepEqual(status(clone), statusBefore);
  assert.equal(git(clone, ["for-each-ref", "refs/osmatrix"]), "");
  // Nothing in the clone reaches back into the main repository.
  git(clone, ["fsck", "--no-progress"]);
  assert.equal(git(main, ["status", "--porcelain"]), "");

  // Concurrent host legs share the cache; each clone gets its own snapshot and leaves no ref behind. They
  // write the same snapshot (same tree, fixed identity and date) into one cache, which on Windows fails
  // with "Permission denied" unless the writers take turns.
  fs.writeFileSync(path.join(wt, "b.txt"), "b2\n");
  fs.writeFileSync(path.join(wt, "big.txt"), crypto.randomBytes(256 * 1024).toString("hex"));
  const clones = Array.from({ length: 6 }, (_, i) => path.join(root, `linked-c${i + 1}`));
  await Promise.all(clones.map((c) => gs.cloneWorktree(wt, c)));
  for (const c of clones) assert.equal(fs.readFileSync(path.join(c, "b.txt"), "utf8"), "b2\n");
  const cache = snapshotCache(wt, "host");
  assert.equal(git(cache, ["--git-dir", cache, "for-each-ref", "--format=%(refname)", "refs/osmatrix/"]).trim(), SNAPSHOT_REF);

  // A clone doesn't write to the cache while another run holds it.
  const release = await gs.lockSnapshotCache(cache);
  const before = git(cache, ["--git-dir", cache, "rev-parse", SNAPSHOT_REF]).trim();
  fs.writeFileSync(path.join(wt, "b.txt"), "b3\n");
  let settled = false;
  const waiting = gs.cloneWorktree(wt, path.join(root, "linked-c-wait")).finally(() => (settled = true));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(settled, false);
  assert.equal(git(cache, ["--git-dir", cache, "rev-parse", SNAPSHOT_REF]).trim(), before);
  release();
  await waiting;
  assert.equal(fs.readFileSync(path.join(root, "linked-c-wait", "b.txt"), "utf8"), "b3\n");

  // A clone that can't create its destination leaves no private ref keeping its snapshot from being pruned.
  const blocker = path.join(root, "linked-blocker");
  fs.writeFileSync(blocker, "a file, not a directory");
  await assert.rejects(gs.cloneWorktree(wt, path.join(blocker, "clone")));
  assert.equal(git(cache, ["--git-dir", cache, "for-each-ref", "--format=%(refname)", "refs/osmatrix/"]).trim(), SNAPSHOT_REF);

  // A repository without an origin stays without one.
  git(main, ["remote", "remove", "origin"]);
  const bare = path.join(root, "linked-clone-noorigin");
  await gs.cloneWorktree(wt, bare);
  assert.equal(gStatus(bare, ["config", "remote.origin.url"]), 1);
});

test("concurrent snapshots of one checkout into one cache take turns", async () => {
  const repo = makeRepo("concurrent");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, ["add", "-A"]);
  commit(repo, "first");
  fs.writeFileSync(path.join(repo, "u.txt"), crypto.randomBytes(256 * 1024).toString("hex"));
  const snaps = await Promise.all(Array.from({ length: 6 }, () => snapshotWorktree(repo, "g")));
  try {
    assert.equal(new Set(snaps.map((s) => s.commit)).size, 1);
    await Promise.all(snaps.map((s) => s.synced()));
    const cache = snapshotCache(repo, "g");
    git(cache, ["--git-dir", cache, "fsck", "--no-progress", "--connectivity-only"]);
    assert.equal(git(cache, ["--git-dir", cache, "rev-parse", "refs/osmatrix/sent"]).trim(), snaps[0].commit);
  } finally {
    for (const s of snaps) s.dispose();
  }
});

test("repositories a checkout can't reproduce fall back to copying", async () => {
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  await assert.rejects(snapshotWorktree(plain, "g"), NotMaterializable);

  const lfs = makeRepo("lfs");
  fs.writeFileSync(path.join(lfs, ".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
  fs.writeFileSync(path.join(lfs, "art.psd"), "binary");
  await assert.rejects(snapshotWorktree(lfs, "g"), (e: Error) => e instanceof NotMaterializable && /art\.psd.*lfs/.test(e.message));

  const outer = makeRepo("nested");
  fs.writeFileSync(path.join(outer, "a.txt"), "a\n");
  const inner = path.join(outer, "vendor", "lib");
  fs.mkdirSync(inner, { recursive: true });
  git(inner, ["init", "-q"]);
  fs.writeFileSync(path.join(inner, "l.txt"), "l\n");
  git(inner, ["add", "-A"]);
  commit(inner, "lib");
  await assert.rejects(snapshotWorktree(outer, "g"), (e: Error) => e instanceof NotMaterializable && /vendor\/lib/.test(e.message));
  assert.deepEqual(fs.readdirSync(snapshotCache(outer, "g")).filter((f) => f.startsWith("tmp-")), []);
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

test("guest paths and the symlink probe", () => {
  assert.equal(gs.guestCachePath("work/my repo"), "work/.osmatrix-cache/my repo.git");
  assert.equal(gs.symlinksAllowed("false\r\n"), false);
  assert.equal(gs.symlinksAllowed(""), true);
  const sha = "a".repeat(40);
  assert.deepEqual([...parseRefs(`${sha} refs/heads/main\r\n${sha} refs/osmatrix/snapshot\r\nfatal: junk\r\n`)], [
    ["refs/heads/main", sha],
    ["refs/osmatrix/snapshot", sha],
  ]);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
