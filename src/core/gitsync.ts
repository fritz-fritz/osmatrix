/**
 * Materialise a host work tree in a guest with Git, the way actions/checkout does on GitHub's runners,
 * instead of copying bytes. The guest's own core.autocrlf, core.filemode and core.symlinks then decide
 * line endings, modes and links (CRLF on Windows, as on GitHub), and none of the host's .git/config
 * (filemode, hooks, worktree paths, credential helpers) reaches the guest.
 *
 * Host side: the work tree (tracked plus untracked, not ignored files) becomes a commit on top of HEAD,
 * with the user's index as a second parent, as `git stash` records it. Its objects go to a cache
 * repository per (checkout, guest) in the data dir that borrows the user's object store as an
 * alternate, so the user's index, HEAD, refs and object store are never written. The cache keeps the
 * snapshot the guest last received, so the next bundle leaves out everything the guest already has,
 * uncommitted and untracked files included.
 *
 * Guest side: a bare cache repository kept between runs receives the bundle. The work tree is then a
 * fresh `git clone --shared` of it: new config, hooks and info/ every run, as on a fresh runner, while
 * the objects stay. HEAD is moved back to the user's commit, and the index to the user's index, with the
 * snapshot's files in the work tree (see guestCheckoutSteps).
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireLocks } from "./locks.ts";
import { ensureDir, paths } from "./paths.ts";
import { run, type RunResult } from "./proc.ts";
import type { ChainStep } from "./ssh.ts";

/** The snapshot commit, in the host and guest cache repositories. */
export const SNAPSHOT_REF = "refs/osmatrix/snapshot";
/** The user's HEAD commit in the guest cache, kept so the next bundle can leave out its history. */
export const HEAD_REF = "refs/osmatrix/head";
/** In the host cache: the snapshot the guest last received. */
const SENT_REF = "refs/osmatrix/sent";

export interface Snapshot {
  /** Host cache repository holding the snapshot's objects (the user's objects are an alternate). */
  dir: string;
  /** The snapshot commit: the work tree, with parents HEAD (if any) and `index` (if any). */
  commit: string;
  /** A commit whose tree is the user's index; unset when HEAD is unborn, for a subdirectory, or during a conflicted merge. */
  index?: string;
  /** The user's HEAD commit; unset when HEAD is unborn or the directory is a subdirectory of the repository. */
  head?: string;
  /** The branch HEAD is on (refs/heads/...), unset when detached. */
  branch?: string;
  /** Tags pointing at head (lightweight or annotated); act prefers a tag over the branch for GITHUB_REF. */
  tags: string[];
  /** remote.origin.url; act derives GITHUB_REPOSITORY from it. */
  origin?: string;
  /** Record that the guest has this snapshot, so the next bundle leaves it out. */
  synced(): Promise<void>;
  /** Remove this snapshot's temporary files (the cache stays). */
  dispose(): void;
}

/** The directory can't be materialised with Git; the caller copies its files instead. */
export class NotMaterializable extends Error {}

// A parent git process (a pre-push hook running osmatrix, say) may point these at another repository or index.
const REPO_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

// A fixed identity and date make the snapshot of an unchanged tree the same commit, so it isn't sent again,
// and let commit-tree work without any user.name/user.email configured.
const IDENTITY = {
  GIT_AUTHOR_NAME: "osmatrix",
  GIT_AUTHOR_EMAIL: "osmatrix@localhost",
  GIT_AUTHOR_DATE: "946684800 +0000",
  GIT_COMMITTER_NAME: "osmatrix",
  GIT_COMMITTER_EMAIL: "osmatrix@localhost",
  GIT_COMMITTER_DATE: "946684800 +0000",
};

// File lists of large repositories exceed run()'s default 4 MiB.
const BIG = 512 * 1024 * 1024;
// Older snapshots' loose objects in a host cache are pruned once they pass this (KiB, as count-objects reports).
const CACHE_PRUNE_KIB = 1024 * 1024;

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of REPO_ENV) delete env[k];
  return { ...env, ...extra };
}

async function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<string> {
  const r = await gitRun(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return r.stdout;
}

function gitRun(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<RunResult> {
  return run("git", args, { cwd, env: opts.env ?? gitEnv(), input: opts.input, maxBytes: BIG });
}

/** The host cache repository for snapshots of dir sent to guest. */
export function snapshotCache(dir: string, guest: string): string {
  const key = createHash("sha256").update(`${path.resolve(dir)}\0${guest}`).digest("hex").slice(0, 16);
  return path.join(paths.snapshotDir, `${key}.git`);
}

/**
 * Take the lock that every write to a host cache repository holds: concurrent runs snapshotting the same
 * checkout (host legs of different workflows, say) write the same objects and refs into one cache, since
 * an unchanged tree gives the same snapshot commit. On Windows, git's rename of a new loose object (or
 * ref, or packed-refs) onto a path another git process has open fails with "Permission denied", and a run
 * starting the cache over would delete it under the others. A read that must not see the cache start over
 * holds it too (cloneWorktree, through its fetch); a guest bundle is read under the guest's lock instead.
 * Returns the release function.
 */
export function lockSnapshotCache(cache: string): Promise<() => void> {
  const owner = { pid: process.pid, run: `snapshot-${randomBytes(4).toString("hex")}`, repo: cache, leg: "snapshot" };
  return acquireLocks([`snapshot:${path.resolve(cache)}`], owner, () => undefined, 100);
}

async function ensureCache(cache: string, objects: string, format: string, cwd: string) {
  const alternates = path.join(cache, "objects", "info", "alternates");
  let current: string | undefined;
  try {
    current = fs.readFileSync(alternates, "utf8");
  } catch {
    current = undefined;
  }
  if (current === objects + "\n") return;
  fs.rmSync(cache, { recursive: true, force: true });
  ensureDir(path.dirname(cache));
  await git(cwd, ["init", "-q", "--bare", "--template=", `--object-format=${format}`, cache]);
  fs.mkdirSync(path.dirname(alternates), { recursive: true });
  fs.writeFileSync(alternates, objects + "\n");
}

/**
 * Snapshot dir's work tree (or, for a subdirectory, its part of it) for guest, without touching the
 * user's repository.
 */
export async function snapshotWorktree(dir: string, guest: string): Promise<Snapshot> {
  const release = await lockSnapshotCache(snapshotCache(dir, guest));
  try {
    return await snapshotUnlocked(dir, guest);
  } finally {
    release();
  }
}

/** snapshotWorktree, for a caller that holds the cache's lock. */
async function snapshotUnlocked(dir: string, guest: string): Promise<Snapshot> {
  const inside = await gitRun(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new NotMaterializable(`${dir} is not inside a git work tree`);
  const [prefix, objects, index, format] = (
    await git(dir, ["rev-parse", "--show-prefix", "--git-path", "objects", "--git-path", "index", "--show-object-format"])
  )
    .split("\n")
    .map((l) => l.trim());

  // Filters (Git LFS above all) would run the host's clean filter here and need the guest to smudge
  // content it doesn't have, so such repositories keep the byte copy.
  const files = await git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (files) {
    const attrs = (await git(dir, ["check-attr", "-z", "--stdin", "filter"], { input: files })).split("\0");
    for (let i = 0; i + 2 < attrs.length; i += 3) {
      if (attrs[i + 2] !== "unspecified" && attrs[i + 2] !== "unset") {
        throw new NotMaterializable(`${attrs[i]} uses the git filter "${attrs[i + 2]}" (e.g. Git LFS), which a checkout in the guest can't reproduce`);
      }
    }
  }

  const cache = snapshotCache(dir, guest);
  const userIndex = path.resolve(dir, index);
  const attempt = async (): Promise<Snapshot> => {
    await ensureCache(cache, path.resolve(dir, objects), format, dir);
    const tmp = fs.mkdtempSync(path.join(cache, "tmp-"));
    const dispose = () => fs.rmSync(tmp, { recursive: true, force: true });
    try {
      return await snapshotInto(dir, cache, tmp, prefix, userIndex, dispose);
    } catch (e) {
      dispose();
      throw e;
    }
  };
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof NotMaterializable) throw e;
    // The cache may refer to objects the user's repository no longer has (history rewritten and
    // garbage-collected): start it over once.
    fs.rmSync(cache, { recursive: true, force: true });
    return attempt();
  }
}

async function snapshotInto(dir: string, cache: string, tmp: string, prefix: string, userIndex: string, dispose: () => void): Promise<Snapshot> {
  const objectsEnv = { ...IDENTITY, GIT_OBJECT_DIRECTORY: path.join(cache, "objects") };

  // Starting from a copy of the user's index lets `git add` skip files whose stat data is unchanged
  // instead of hashing the whole tree. New blobs (large untracked files too) land in the cache.
  const wtIndex = path.join(tmp, "worktree-index");
  if (fs.existsSync(userIndex)) fs.copyFileSync(userIndex, wtIndex);
  const env = gitEnv({ ...objectsEnv, GIT_INDEX_FILE: wtIndex });
  let add = await gitRun(dir, ["add", "-A", "--", "."], { env });
  if (add.code !== 0 && fs.existsSync(wtIndex)) {
    // A copied index can be unreadable on its own (split index); start from an empty one.
    fs.rmSync(wtIndex);
    add = await gitRun(dir, ["add", "-A", "--", "."], { env });
  }
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim().slice(-2000)}`);

  // Submodules and nested repositories become gitlinks, which a checkout leaves empty (as actions/checkout
  // does without `submodules:`); the byte copy keeps their files.
  for (const e of (await git(dir, ["ls-files", "-z", "-s", "--", "."], { env })).split("\0")) {
    if (e.startsWith("160000 ")) throw new NotMaterializable(`${e.slice(e.indexOf("\t") + 1)} is a submodule or nested git repository`);
  }

  const tree = (await git(dir, ["write-tree", ...(prefix ? [`--prefix=${prefix}`] : [])], { env })).trim();
  const branch = (await gitRun(dir, ["symbolic-ref", "-q", "HEAD"])).stdout.trim() || undefined;
  // A subdirectory's tree isn't HEAD's tree, so its snapshot stands alone, like the throwaway repository
  // the byte copy makes for it.
  const headRes = prefix ? undefined : await gitRun(dir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  const head = headRes?.code === 0 ? headRes.stdout.trim() : undefined;

  // The user's index as it is, so staged and unstaged changes stay apart in the guest. write-tree
  // refuses an index with conflicts; then the guest's index is HEAD's.
  let indexCommit: string | undefined;
  if (head && fs.existsSync(userIndex)) {
    const realIndex = path.join(tmp, "index");
    fs.copyFileSync(userIndex, realIndex);
    const it = await gitRun(dir, ["write-tree"], { env: gitEnv({ ...objectsEnv, GIT_INDEX_FILE: realIndex }) });
    if (it.code === 0) {
      indexCommit = (
        await git(dir, ["commit-tree", "--no-gpg-sign", it.stdout.trim(), "-p", head, "-m", "osmatrix snapshot of the index"], { env })
      ).trim();
    }
  }
  const parents = [head, indexCommit].filter((p): p is string => !!p).flatMap((p) => ["-p", p]);
  const commit = (await git(dir, ["commit-tree", "--no-gpg-sign", tree, ...parents, "-m", "osmatrix snapshot of the work tree"], { env })).trim();
  // Annotated tags too (--points-at peels them): act counts both when it picks GITHUB_REF. The guest gets
  // them as lightweight tags on the same commit, since the bundle carries no tag objects.
  const tags = head
    ? (await git(dir, ["for-each-ref", "--points-at", head, "--format=%(refname)", "refs/tags"])).split("\n").filter(Boolean)
    : [];
  const origin = (await gitRun(dir, ["config", "--get", "remote.origin.url"])).stdout.trim() || undefined;
  await git(cache, ["--git-dir", cache, "update-ref", SNAPSHOT_REF, commit]);
  const synced = async () => {
    const release = await lockSnapshotCache(cache);
    try {
      await git(cache, ["--git-dir", cache, "update-ref", SENT_REF, commit]);
      await pruneCache(cache, "now");
    } finally {
      release();
    }
  };
  return { dir: cache, commit, index: indexCommit, head, branch, tags, origin, synced, dispose };
}

/** Each snapshot leaves its changed blobs behind; drop the unreachable ones older than `expire` once they add up. */
async function pruneCache(cache: string, expire: string) {
  const kib = Number(/^size: (\d+)$/m.exec(await git(cache, ["--git-dir", cache, "count-objects", "-v"]))?.[1] ?? 0);
  if (kib > CACHE_PRUNE_KIB) await git(cache, ["--git-dir", cache, "prune", `--expire=${expire}`]);
}

/**
 * Bundle the snapshot for a guest that has the given commits. Only commits the host cache also has can
 * be prerequisites: the user's history and the snapshot the guest last received. The first bundle for
 * a guest carries the full history, as the byte copy's .git did on every run. (A depth-1 bundle would
 * be smaller once, but would break `git log`/`describe` in steps and the incremental bundles after it.)
 */
export async function createBundle(snap: Snapshot, guestHas: string[], name: string): Promise<string> {
  const candidates = [...new Set(guestHas)].filter((s) => /^[0-9a-f]{40,64}$/.test(s) && s !== snap.commit);
  let have: string[] = [];
  if (candidates.length) {
    const out = await git(snap.dir, ["--git-dir", snap.dir, "cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      input: candidates.join("\n") + "\n",
    });
    have = out
      .split("\n")
      .filter((l) => l.endsWith(" commit"))
      .map((l) => l.split(" ")[0]);
  }
  const tmp = fs.mkdtempSync(path.join(snap.dir, "tmp-"));
  const file = path.join(tmp, name);
  const dispose = snap.dispose;
  snap.dispose = () => {
    dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  // Excluding a commit only excludes the trees of commits on the boundary of the new history, and the
  // previous snapshot isn't an ancestor of this one (both sit on HEAD). Excluding its tree too keeps
  // unchanged uncommitted and untracked files out of the bundle; trees aren't recorded as prerequisites.
  const not = have.flatMap((c) => [c, `${c}^{tree}`]);
  await git(snap.dir, ["--git-dir", snap.dir, "bundle", "create", "-q", file, SNAPSHOT_REF, ...(not.length ? ["--not", ...not] : [])]);
  return file;
}

/** Parse `git for-each-ref --format='%(objectname) %(refname)'`. */
export function parseRefs(out: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const l of out.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(l.trim());
    if (m) refs.set(m[2], m[1]);
  }
  return refs;
}

/** Where the guest keeps the object cache for the work tree at remote (a path relative to the guest home). */
export function guestCachePath(remote: string): string {
  const slash = remote.lastIndexOf("/");
  return `${slash >= 0 ? remote.slice(0, slash) : "."}/.osmatrix-cache/${remote.slice(slash + 1)}.git`;
}

/** Bring the guest cache up to date (run from the guest home, before the work tree is recreated). */
export function guestCacheSteps(snap: Snapshot, cache: string, bundle?: string): ChainStep[] {
  const steps: ChainStep[] = [];
  if (bundle) steps.push({ argv: ["git", "--git-dir", cache, "fetch", "-q", "--no-tags", bundle, `+${SNAPSHOT_REF}:${SNAPSHOT_REF}`] });
  if (snap.head) steps.push({ argv: ["git", "--git-dir", cache, "update-ref", HEAD_REF, snap.head] });
  return steps;
}

/**
 * Create the work tree's repository as a fresh clone sharing the cache's objects (run from the guest
 * home into an empty or missing remote). Config, hooks, info/attributes and refs a previous run's steps
 * changed are gone; only objects carry over.
 */
export function guestCloneStep(cache: string, remote: string): ChainStep {
  return { argv: ["git", "clone", "-q", "--shared", "--no-checkout", cache, remote] };
}

/**
 * Given `git config --local --get core.symlinks` in the fresh clone: whether to turn symlinks on. git
 * writes false there when its probe can't create a symlink. Otherwise turn them on: Git for Windows
 * leaves them off unless configured, and guests provisioned before osmatrix enabled them have
 * core.symlinks=false system-wide, while GitHub's Windows image installs Git with symlinks enabled.
 */
export function symlinksAllowed(probe: string): boolean {
  return probe.trim() !== "false";
}

/**
 * Commands, run in the fresh clone, that check the snapshot out.
 *
 * HEAD ends up on the user's commit (and branch) and the index on the user's index, with the snapshot's
 * files in the work tree, so `git status` and `git diff [--cached]` read as on the host. act takes
 * GITHUB_SHA from HEAD and GITHUB_REF from a tag or branch at HEAD (pkg/common/git
 * FindGitRevision/FindGitRef), so the user sees their own commit and branch, as with the byte copy and
 * as on host legs, where act runs in the real checkout. The cost: uncommitted changes show up as
 * changes, where a pushed commit would be clean on GitHub; the same holds for host legs. Pointing HEAD
 * at the snapshot would make the tree clean but give GITHUB_SHA a commit that exists nowhere else, and
 * no branch for GITHUB_REF.
 */
export function guestCheckoutSteps(snap: Snapshot, symlinks: boolean): ChainStep[] {
  const steps: ChainStep[] = [];
  const g = (...argv: string[]) => steps.push({ argv: ["git", ...argv] });
  if (symlinks) g("config", "core.symlinks", "true");
  g("checkout", "-q", "--force", "--detach", snap.commit);
  const target = snap.head ?? snap.commit;
  for (const t of snap.tags) g("update-ref", t, target);
  if (snap.branch) {
    g("update-ref", snap.branch, target);
    g("symbolic-ref", "HEAD", snap.branch);
  } else {
    g("update-ref", "--no-deref", "HEAD", target);
  }
  // The index to the user's (or HEAD's) tree; the work tree stays as checked out. Entries that match
  // keep their stat data, so `git status` doesn't rehash the tree.
  if (snap.index) g("reset", "-q", snap.index, "--", ".");
  else if (snap.head) g("reset", "-q");
  if (snap.origin) g("config", "remote.origin.url", snap.origin);
  else g("remote", "remove", "origin");
  return steps;
}

/**
 * Whether dir's repository keeps its git directory outside the work tree: a linked worktree (`git
 * worktree add`, whose .git file points into the main repository's .git/worktrees), a submodule (into
 * the superproject's .git/modules) or a `--separate-git-dir` checkout. act copies only the work tree
 * into a host leg's job container, so git finds no repository there. False outside a git work tree.
 */
export async function gitDirOutsideWorkTree(dir: string): Promise<boolean> {
  // All three from git, absolute and in one form: on Windows, dir may be an 8.3 short path (RUNNER~1)
  // where git prints the long one, and only the native realpath expands those.
  const r = await gitRun(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
  if (r.code !== 0) return false;
  const [top, gitDir, common] = r.stdout.split("\n").map((l) => l.trim());
  if (!top || !gitDir || !common) return false;
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const root = real(top);
  const inside = (p: string) => {
    const rel = path.relative(root, real(p));
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  return !inside(gitDir) || !inside(common);
}

/**
 * Check dir's work tree out into dest (a new directory) as an ordinary, self-contained clone, as
 * actions/checkout gives on GitHub: the user's history, HEAD on the user's commit and branch, the index
 * on the user's index, and the work tree with its uncommitted and untracked (not ignored) files, as a
 * guest gets it (guestCheckoutSteps). The user's repository is only read. Throws NotMaterializable for
 * what a checkout can't reproduce (filters such as LFS, submodules).
 */
export async function cloneWorktree(dir: string, dest: string): Promise<void> {
  const cache = snapshotCache(dir, "host");
  // Host legs of different workflows (and runs) share this cache and may snapshot at the same time,
  // moving SNAPSHOT_REF, or start the cache over: hold its lock until this snapshot is in dest.
  const release = await lockSnapshotCache(cache);
  let snap: Snapshot;
  try {
    snap = await snapshotUnlocked(dir, "host");
    try {
      const format = (await git(snap.dir, ["--git-dir", snap.dir, "rev-parse", "--show-object-format"])).trim();
      ensureDir(path.dirname(dest));
      await git(path.dirname(dest), ["init", "-q", `--object-format=${format}`, dest]);
      // A fetch from the cache packs what it borrows from the user's object store, so the clone has no
      // alternates pointing back at it.
      await git(dest, ["fetch", "-q", "--no-tags", snap.dir, `+${SNAPSHOT_REF}:${SNAPSHOT_REF}`]);
    } catch (e) {
      snap.dispose();
      throw e;
    }
  } finally {
    release();
  }
  try {
    const symlinks = symlinksAllowed((await gitRun(dest, ["config", "--local", "--get", "core.symlinks"])).stdout);
    // A new repository has no origin to remove.
    const steps = guestCheckoutSteps(snap, symlinks).filter((s) => s.argv.join(" ") !== "git remote remove origin");
    for (const s of steps) {
      const r = await gitRun(dest, s.argv.slice(1));
      if (r.code !== 0 && !s.optional) throw new Error(`git ${s.argv.slice(1).join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`);
    }
    await git(dest, ["update-ref", "-d", SNAPSHOT_REF]);
    // Nothing records what a clone got, so nothing is left out next time; only keep the cache from growing.
    // Keep recent objects anyway: an older osmatrix, which takes no lock, may be writing a snapshot.
    const releasePrune = await lockSnapshotCache(cache);
    try {
      await pruneCache(snap.dir, "1.hour.ago");
    } finally {
      releasePrune();
    }
  } finally {
    snap.dispose();
  }
}
