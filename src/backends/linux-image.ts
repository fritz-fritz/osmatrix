import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LINUX_IMAGE } from "../core/config.ts";
import { acquireLocks, type LockOwner } from "../core/locks.ts";
import { assetsDir, ensureDir, paths } from "../core/paths.ts";
import { run } from "../core/proc.ts";
import { dockerBin, imageExists } from "./docker.ts";

/**
 * act's default image lacks toolchains GitHub's ubuntu runners preinstall (Rust, see the Dockerfile), so
 * with the default act_linux_image Linux legs and the ubuntu guest run in a thin layer over it instead.
 */
export const PARITY_DOCKERFILE = path.join(assetsDir, "container", "ubuntu-parity.Dockerfile");
const PARITY_REPO = "osmatrix/ubuntu";

function dockerfileHash(dockerfile: string | Buffer = fs.readFileSync(PARITY_DOCKERFILE)): string {
  return crypto.createHash("sha256").update(dockerfile).digest("hex").slice(0, 12);
}

/**
 * Tagged by the Dockerfile's content and the Rust version it installs, so an edited Dockerfile or a runner
 * image with a new Rust version is built on next use. Runner releases that keep the Rust version reuse the
 * image (the runner tag would only add rebuilds that change nothing). The name ignores OSMATRIX_HOME:
 * every install building the same file and version can share the image.
 */
export function parityImageTag(rust: string, dockerfile?: string | Buffer): string {
  return `${PARITY_REPO}:act-24.04-${dockerfileHash(dockerfile)}-rust${rust}`;
}

/**
 * The image to use when the runner's Rust version is unknown (offline): the newest local parity image
 * built from the current Dockerfile, else the newest from any earlier one. `refs` is newest first.
 */
export function fallbackImage(refs: string[], dockerfile?: string | Buffer): string | undefined {
  const current = `${PARITY_REPO}:act-24.04-${dockerfileHash(dockerfile)}-`;
  return refs.find((r) => r.startsWith(current)) ?? refs.find((r) => r.startsWith(`${PARITY_REPO}:act-24.04-`));
}

// ---------- the Rust version of GitHub's ubuntu-24.04 runner image ----------
//
// Only Rust is pinned so far. The same readme lists the other toolchains the runner preinstalls (Go,
// Python, Node and Java in the tool cache, .NET, Haskell, …); act's image already has some of them and
// setup-* actions cover most of the rest, so pin another one here the same way when a gap shows up.

const RELEASES_URL = "https://api.github.com/repos/actions/runner-images/releases?per_page=100";
const readmeUrl = (tag: string) => `https://raw.githubusercontent.com/actions/runner-images/${tag}/images/ubuntu/Ubuntu2404-Readme.md`;
/** One lookup a day keeps unauthenticated GitHub API use far below its rate limit. */
const CACHE_TTL_MS = 24 * 60 * 60_000;
/** After a failed lookup, legs don't retry (and wait on the network) until this has passed. */
const FAILURE_TTL_MS = 15 * 60_000;

interface RunnerCache {
  checkedAt: string;
  tag?: string;
  rust?: string;
  error?: string;
}

/**
 * The newest fully rolled-out ubuntu24 runner image release ("ubuntu24/20261004.327"); ubuntu24-arm64 is a
 * separate image. A release stays a prerelease while it rolls out, so most runners have the newest full
 * release; with none in the listing the lookup fails rather than pinning a prerelease.
 */
export function latestRunnerTag(releases: unknown): string | undefined {
  if (!Array.isArray(releases)) return undefined;
  const full = (releases as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }[]).find(
    (r) => !r?.draft && !r?.prerelease && typeof r?.tag_name === "string" && r.tag_name.startsWith("ubuntu24/"),
  );
  return full?.tag_name as string | undefined;
}

/** "- Rust 1.99.0" in the readme's "### Rust Tools" section. */
export function parseRustVersion(readme: string): string | undefined {
  const section = /^### Rust Tools[ \t]*\r?\n([\s\S]*?)(?=^### |^## |(?![\s\S]))/m.exec(readme)?.[1];
  return section ? /^- Rust (\d+\.\d+\.\d+)\s*$/m.exec(section)?.[1] : undefined;
}

export interface RunnerRustOptions {
  now?: number;
  cacheFile?: string;
  fetch?: typeof fetch;
}

/**
 * The Rust version in GitHub's latest ubuntu24 runner image, read from that release's readme (not main's,
 * so it matches a shipped image) and cached for a day. Never throws: on failure `rust` is undefined and
 * `error` says why.
 */
export async function runnerRust(opts: RunnerRustOptions = {}): Promise<{ rust?: string; tag?: string; error?: string }> {
  const now = opts.now ?? Date.now();
  const file = opts.cacheFile ?? path.join(paths.dataDir, "runner-image.json");
  let cache: RunnerCache | undefined;
  try {
    cache = JSON.parse(fs.readFileSync(file, "utf8")) as RunnerCache;
  } catch {
    cache = undefined;
  }
  const age = cache ? now - Date.parse(cache.checkedAt) : Infinity;
  if (cache?.rust && age >= 0 && age < CACHE_TTL_MS) return { rust: cache.rust, tag: cache.tag };
  if (cache?.error && age >= 0 && age < FAILURE_TTL_MS) return { error: cache.error };
  const get = async (url: string, json: boolean) => {
    const res = await (opts.fetch ?? fetch)(url, {
      headers: { "User-Agent": "osmatrix", ...(json ? { Accept: "application/vnd.github+json" } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return json ? res.json() : res.text();
  };
  let next: RunnerCache;
  try {
    const tag = latestRunnerTag(await get(RELEASES_URL, true));
    if (!tag) throw new Error("no fully rolled-out ubuntu24/ release among actions/runner-images' recent releases");
    const rust = parseRustVersion((await get(readmeUrl(tag), false)) as string);
    if (!rust) throw new Error(`no Rust version in the ${tag} readme`);
    next = { checkedAt: new Date(now).toISOString(), tag, rust };
  } catch (e) {
    next = { checkedAt: new Date(now).toISOString(), error: (e as Error).message };
  }
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch {
    /* an unwritable cache only costs another lookup */
  }
  return next.rust ? { rust: next.rust, tag: next.tag } : { error: next.error };
}

// ---------- building ----------

/** What image resolution needs from the outside world; tests replace it. */
export interface ImageDeps {
  runnerRust: () => Promise<{ rust?: string; tag?: string; error?: string }>;
  exists: (ref: string) => Promise<boolean>;
  /** Local parity images, newest first. */
  localImages: () => Promise<string[]>;
  /** Build `tag` with RUST_VERSION=`rust`; throws on failure. */
  build: (tag: string, rust: string) => Promise<void>;
  lock: (key: string, owner: LockOwner, onWait: (holder: LockOwner) => void) => Promise<() => void>;
}

const dockerDeps: ImageDeps = {
  runnerRust: () => runnerRust(),
  exists: imageExists,
  // docker lists images newest first.
  localImages: async () => {
    const r = await run(dockerBin(), ["images", PARITY_REPO, "--format", "{{.Repository}}:{{.Tag}}"]);
    return r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(`${PARITY_REPO}:`)) : [];
  },
  build: async (tag, rust) => {
    const args = ["build", "-t", tag, "--build-arg", `RUST_VERSION=${rust}`, "-f", PARITY_DOCKERFILE, path.dirname(PARITY_DOCKERFILE)];
    const r = await run(dockerBin(), args, { timeoutMs: 60 * 60_000 });
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout).trim().split("\n").slice(-30).join("\n");
      throw new Error(`building ${tag} failed (setting act_linux_image to another image skips this layer):\n${tail}`);
    }
  },
  lock: (key, owner, onWait) => acquireLocks([key], owner, (_k, h) => onWait(h)),
};

/**
 * The image Linux legs should use now, without building anything: `configured` unless it's act's
 * default, else the parity image for the runner's Rust version; undefined when that version is unknown.
 */
export async function expectedLinuxImage(configured: string, deps: ImageDeps = dockerDeps): Promise<string | undefined> {
  if (configured !== DEFAULT_LINUX_IMAGE) return configured;
  const { rust } = await deps.runnerRust();
  return rust ? parityImageTag(rust) : undefined;
}

/**
 * Resolve the image for `configured`: unchanged unless it's act's default, else the parity layer with the
 * runner's Rust version, built once if missing. When that version can't be looked up, the newest local
 * parity image is used, or one with the current stable Rust is built. If building fails and there's no
 * local parity image, legs run on act's plain image (without Rust) rather than failing. Concurrent runs,
 * from any install on this host, take turns on a host lock, and whoever waited finds the image built.
 */
export async function ensureLinuxImage(
  configured: string,
  owner: LockOwner,
  log: (line: string) => void = () => undefined,
  deps: ImageDeps = dockerDeps,
): Promise<string> {
  if (configured !== DEFAULT_LINUX_IMAGE) return configured;
  const { rust, tag: runner, error } = await deps.runnerRust();
  let tag: string;
  let what: string;
  if (rust) {
    tag = parityImageTag(rust);
    what = `Rust ${rust}, as in GitHub's ${runner} runner image`;
  } else {
    log(`[osmatrix] note: couldn't look up the Rust version of GitHub's ubuntu24 runner image (${error})`);
    const local = fallbackImage(await deps.localImages());
    if (local) {
      log(`[osmatrix] using the newest local image ${local}`);
      return local;
    }
    tag = parityImageTag("stable");
    what = "the current stable Rust, which may be newer than GitHub's runner image has";
  }
  if (await deps.exists(tag)) return tag;
  try {
    return await build(tag, rust ?? "stable", what, owner, log, deps);
  } catch (e) {
    const local = fallbackImage(await deps.localImages());
    log(`[osmatrix] ${(e as Error).message}`);
    if (local) {
      log(`[osmatrix] using the older local image ${local} instead`);
      return local;
    }
    log(`[osmatrix] warning: running on ${configured} instead, which lacks the Rust toolchain GitHub's ubuntu runners preinstall`);
    return configured;
  }
}

async function build(tag: string, rust: string, what: string, owner: LockOwner, log: (line: string) => void, deps: ImageDeps): Promise<string> {
  const release = await deps.lock(`host:image:${tag}`, owner, (h) => log(`[osmatrix] waiting: ${tag} is being built by run ${h.run} (${h.leg})`));
  try {
    if (await deps.exists(tag)) return tag;
    log(`[osmatrix] building ${tag}: act's default image plus ${what} (once, takes a few minutes)`);
    await deps.build(tag, rust);
    log(`[osmatrix] built ${tag}`);
    return tag;
  } finally {
    release();
  }
}
