/**
 * Versions pinned by this package that docs and config defaults repeat. `scripts/sync-manifests.mjs`
 * stamps them into README.md, CONTRIBUTING.md and the skills (`npm run sync`; CI checks with `--check`),
 * so a bump here is the only edit needed. Kept apart from act.ts and config.ts, which import each other.
 */

/** The act release osmatrix's patch applies to; `assets/act/act-<version>-osmatrix.patch` is named after it. */
export const PATCHED_ACT_VERSION = "v0.2.89";
