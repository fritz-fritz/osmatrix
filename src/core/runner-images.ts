import fs from "node:fs";
import path from "node:path";
import { ensureDir, paths } from "./paths.ts";

/**
 * What GitHub's hosted runner images ship, read from the readmes actions/runner-images publishes with
 * each image release. Self-contained (fetch + a cache file in the data dir) so other toolchain lookups
 * can share it.
 */

const RELEASES_URL = "https://api.github.com/repos/actions/runner-images/releases?per_page=100";
/** Image releases of all OSes share one listing; macOS ones are sparse, so look a few pages deep. */
const MAX_PAGES = 3;
/** One lookup a day keeps unauthenticated GitHub API use far below its rate limit. */
const CACHE_TTL_MS = 24 * 60 * 60_000;
/** After a failed lookup, don't retry (and wait on the network) until this has passed. */
const FAILURE_TTL_MS = 15 * 60_000;

/** The runner image for an Apple Silicon guest's macOS major version: 15 -> "macos-15-arm64". */
export function macArm64Image(productVersion: string): string | undefined {
  const major = /^(\d+)\./.exec(productVersion.trim())?.[1] ?? /^(\d+)$/.exec(productVersion.trim())?.[1];
  return major ? `macos-${major}-arm64` : undefined;
}

interface Release {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/**
 * The newest full release of `image` ("macos-15-arm64/20260907.0337"). Releases stay prereleases while
 * they roll out, so most runners have the newest full one; drafts never count.
 */
export function latestImageTag(releases: unknown, image: string): string | undefined {
  if (!Array.isArray(releases)) return undefined;
  return (releases as Release[]).find((r) => !r?.draft && !r?.prerelease && typeof r?.tag_name === "string" && r.tag_name.startsWith(`${image}/`))
    ?.tag_name as string | undefined;
}

/** The readme of a macOS image at a release tag (or "main"). */
export function macReadmeUrl(ref: string, image: string): string {
  return `https://raw.githubusercontent.com/actions/runner-images/${ref}/images/macos/${image}-Readme.md`;
}

/** "- Homebrew 6.0.22" in the readme's package management list. */
export function parseHomebrewVersion(readme: string): string | undefined {
  return /^- Homebrew (\d+\.\d+\.\d+)\s*$/m.exec(readme)?.[1];
}

interface CacheEntry {
  checkedAt: string;
  /** Release tag the readme was read at, or "main" when no full release was listed. */
  ref?: string;
  brew?: string;
  error?: string;
}

export interface LookupOptions {
  now?: number;
  cacheFile?: string;
  fetch?: typeof fetch;
}

/**
 * The Homebrew version in GitHub's runner image `image`, from its newest full release's readme (main's
 * when the listing has none), cached for a day per image. Never throws: on failure `brew` is undefined
 * and `error` says why.
 */
export async function runnerHomebrew(image: string, opts: LookupOptions = {}): Promise<{ brew?: string; ref?: string; error?: string }> {
  const now = opts.now ?? Date.now();
  const file = opts.cacheFile ?? path.join(paths.dataDir, "runner-images-macos.json");
  let cache: Record<string, CacheEntry> = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, CacheEntry>;
  } catch {
    cache = {};
  }
  const hit = cache[image];
  const age = hit ? now - Date.parse(hit.checkedAt) : Infinity;
  if (hit?.brew && age >= 0 && age < CACHE_TTL_MS) return { brew: hit.brew, ref: hit.ref };
  if (hit?.error && age >= 0 && age < FAILURE_TTL_MS) return { error: hit.error };
  const get = async (url: string, json: boolean) => {
    const res = await (opts.fetch ?? fetch)(url, {
      headers: { "User-Agent": "osmatrix", ...(json ? { Accept: "application/vnd.github+json" } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return json ? res.json() : res.text();
  };
  let next: CacheEntry;
  try {
    let ref: string | undefined;
    for (let page = 1; page <= MAX_PAGES && !ref; page++) {
      const releases = await get(`${RELEASES_URL}&page=${page}`, true);
      ref = latestImageTag(releases, image);
      if (!Array.isArray(releases) || releases.length < 100) break;
    }
    ref ??= "main";
    const brew = parseHomebrewVersion((await get(macReadmeUrl(ref, image), false)) as string);
    if (!brew) throw new Error(`no Homebrew version in the ${image} readme at ${ref}`);
    next = { checkedAt: new Date(now).toISOString(), ref, brew };
  } catch (e) {
    next = { checkedAt: new Date(now).toISOString(), error: (e as Error).message };
  }
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ ...cache, [image]: next }, null, 2));
  } catch {
    /* an unwritable cache only costs another lookup */
  }
  return next.brew ? { brew: next.brew, ref: next.ref } : { error: next.error };
}
