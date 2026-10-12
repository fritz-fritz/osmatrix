/**
 * Materialise a host work tree in a guest with Git, the way actions/checkout does on GitHub's runners,
 * instead of copying bytes. The guest's own core.autocrlf, core.filemode and core.symlinks then decide
 * line endings, modes and links (CRLF on Windows, as on GitHub), and none of the host's .git/config
 * (filemode, hooks, worktree paths, credential helpers) reaches the guest.
 *
 * Host side: the work tree (tracked plus untracked, not ignored files) becomes a commit on top of HEAD.
 * Its objects go to a temporary repository that borrows the user's object store as an alternate, so
 * the user's index, HEAD, refs and object store are never written. A bundle carries the snapshot to the
 * guest; it leaves out commits the guest already has, so after the first run only new objects travel.
 *
 * Guest side: a repository initialised in the guest and kept between runs fetches the bundle and checks
 * the snapshot out. HEAD is then moved back to the user's commit with the snapshot's files left in the
 * work tree, so act's GITHUB_SHA/GITHUB_REF are the user's, as they were with the byte copy and are for
 * host legs (see guestCheckoutSteps).
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, paths } from "./paths.ts";
import { run, type RunResult } from "./proc.ts";
import type { ChainStep } from "./ssh.ts";

/** The snapshot commit, in the temporary repository the bundle is made from and in the guest repository. */
export const SNAPSHOT_REF = "refs/osmatrix/snapshot";
/** The user's HEAD commit in the guest repository, kept so the next bundle can leave out its history. */
export const HEAD_REF = "refs/osmatrix/head";

export interface Snapshot {
  /** Temporary bare repository holding the snapshot's new objects (the user's objects are an alternate). */
  dir: string;
  /** The snapshot commit. */
  commit: string;
  /** The user's HEAD commit; unset when HEAD is unborn or the directory is a subdirectory of the repository. */
  head?: string;
  /** The branch HEAD is on (refs/heads/...), unset when detached. */
  branch?: string;
  /** Lightweight tags pointing at head; act prefers a tag over the branch for GITHUB_REF. */
  tags: string[];
  /** remote.origin.url; act derives GITHUB_REPOSITORY from it. */
  origin?: string;
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

/** Snapshot dir's work tree (or, for a subdirectory, its part of it) into a commit without touching the user's repository. */
export async function snapshotWorktree(dir: string): Promise<Snapshot> {
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

  const tmp = fs.mkdtempSync(path.join(ensureDir(paths.tmpDir), "snapshot-"));
  const dispose = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    await git(dir, ["init", "-q", "--bare", "--template=", `--object-format=${format}`, tmp]);
    fs.mkdirSync(path.join(tmp, "objects", "info"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "objects", "info", "alternates"), path.resolve(dir, objects) + "\n");

    // Starting from a copy of the user's index lets `git add` skip files whose stat data is unchanged
    // instead of hashing the whole tree. New blobs (large untracked files too) land in the temporary store.
    const tmpIndex = path.join(tmp, "index");
    const userIndex = path.resolve(dir, index);
    if (fs.existsSync(userIndex)) fs.copyFileSync(userIndex, tmpIndex);
    const env = gitEnv({ ...IDENTITY, GIT_INDEX_FILE: tmpIndex, GIT_OBJECT_DIRECTORY: path.join(tmp, "objects") });
    let add = await gitRun(dir, ["add", "-A", "--", "."], { env });
    if (add.code !== 0 && fs.existsSync(tmpIndex)) {
      // A copied index can be unreadable on its own (split index); start from an empty one.
      fs.rmSync(tmpIndex);
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
    const commit = (
      await git(dir, ["commit-tree", "--no-gpg-sign", tree, ...(head ? ["-p", head] : []), "-m", "osmatrix snapshot of the work tree"], { env })
    ).trim();
    const tags = head
      ? (await git(dir, ["for-each-ref", "--points-at", head, "--format=%(objecttype) %(refname)", "refs/tags"]))
          .split("\n")
          .filter((l) => l.startsWith("commit "))
          .map((l) => l.slice("commit ".length))
      : [];
    const origin = (await gitRun(dir, ["config", "--get", "remote.origin.url"])).stdout.trim() || undefined;
    await git(tmp, ["--git-dir", tmp, "update-ref", SNAPSHOT_REF, commit]);
    return { dir: tmp, commit, head, branch, tags, origin, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

/**
 * Bundle the snapshot for a guest that has the given commits. Only commits the host also has can be
 * prerequisites; the first bundle for a guest carries the full history, as the byte copy's .git did on
 * every run. (A depth-1 bundle would be smaller once, but would break `git log`/`describe` in steps and
 * the incremental bundles after it.)
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
  const file = path.join(snap.dir, name);
  await git(snap.dir, ["--git-dir", snap.dir, "bundle", "create", "-q", file, SNAPSHOT_REF, ...(have.length ? ["--not", ...have] : [])]);
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

/**
 * Commands, run in the guest repository, that check the snapshot out.
 *
 * HEAD ends up on the user's commit (and branch) with the snapshot's files in the work tree, not on the
 * snapshot commit. act takes GITHUB_SHA from HEAD and GITHUB_REF from a tag or branch at HEAD
 * (pkg/common/git FindGitRevision/FindGitRef), so the user sees their own commit and branch, as with
 * the byte copy and as on host legs, where act runs in the real checkout. The cost: uncommitted changes
 * show up in `git status` as changes, where a pushed commit would be clean on GitHub; the same holds for
 * host legs. Pointing HEAD at the snapshot would make the tree clean but give GITHUB_SHA a commit that
 * exists nowhere else, and no branch for GITHUB_REF.
 *
 * `git clean -ffdx` empties the tree of everything else, ignored files and earlier runs' artifacts
 * (.osmatrix-artifacts) included, as the byte copy's delete-and-recreate did. act's event and secret
 * files are written after this.
 */
export function guestCheckoutSteps(snap: Snapshot, guestRefs: Map<string, string>, bundle?: string): ChainStep[] {
  const steps: ChainStep[] = [];
  const g = (...argv: string[]) => steps.push({ argv: ["git", ...argv] });
  if (bundle) g("fetch", "-q", "--no-tags", bundle, `+${SNAPSHOT_REF}:${SNAPSHOT_REF}`);
  g("checkout", "-q", "--force", "--detach", snap.commit);
  g("clean", "-q", "-ffdx");
  // Branches and tags from earlier runs could otherwise match HEAD for act's GITHUB_REF.
  for (const ref of guestRefs.keys()) if (ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) g("update-ref", "-d", ref);
  const target = snap.head ?? snap.commit;
  if (snap.head) g("update-ref", HEAD_REF, snap.head);
  for (const t of snap.tags) g("update-ref", t, target);
  if (snap.branch) {
    g("update-ref", snap.branch, target);
    g("symbolic-ref", "HEAD", snap.branch);
  } else {
    g("update-ref", "--no-deref", "HEAD", target);
  }
  // Index to HEAD's tree, work tree untouched: changes since the user's commit show as changes.
  if (snap.head) g("reset", "-q");
  if (snap.origin) g("config", "remote.origin.url", snap.origin);
  else steps.push({ argv: ["git", "config", "--unset-all", "remote.origin.url"], optional: true });
  return steps;
}
