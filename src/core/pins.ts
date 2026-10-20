/**
 * Versions pinned by this package that docs and config defaults repeat. `scripts/sync-manifests.mjs`
 * stamps them into README.md, CONTRIBUTING.md and the skills (`npm run sync`; CI checks with `--check`),
 * so a bump here is the only edit needed. Kept apart from act.ts and config.ts, which import each other, and free of imports, so the sync script
 * runs where no dependencies are installed (CI's plugins job).
 */

/** The act release osmatrix's patch applies to; `assets/act/act-<version>-osmatrix.patch` is named after it. */
export const PATCHED_ACT_VERSION = "v0.2.89";

/** The image act runs ubuntu-* legs in on the host, and the `ubuntu` container guest. */
export const DEFAULT_LINUX_IMAGE = "catthehacker/ubuntu:act-24.04";

/**
 * Homebrew stopped building Intel macOS bottles on 2026-08-27 (Homebrew/brew#23677) and made Intel
 * Tier 3 in 7.0.0, so Intel guests get Homebrew pinned to where bottles still exist on ghcr.io:
 * - brew 6.0.22, the last release before 7.0.0;
 * - homebrew-core a5783fb (2026-08-27 21:04 UTC), the last commit before the first update that
 *   shipped without an Intel bottle (apify-cli 1.9.0, merged 22:03 UTC).
 * Formula versions are frozen there: older than on GitHub's runners, but they pour bottles instead
 * of building from source.
 */
export const DEFAULT_HOMEBREW: { brew: string; core: string } = {
  brew: "6.0.22",
  core: "a5783fb0df65b1eeeaee4dbdf7e0c41b133c72ac",
};
