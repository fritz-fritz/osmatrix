import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import envPaths from "env-paths";

// OSMATRIX_HOME overrides both config and data locations (used by tests and portable installs).
const home = process.env.OSMATRIX_HOME;
const ep = envPaths("osmatrix", { suffix: "" });
const configDir = home ? home : ep.config;
const dataDir = home ? home : ep.data;

export const paths = {
  configDir,
  dataDir,
  configFile: path.join(configDir, "config.toml"),
  stateFile: path.join(dataDir, "state.json"),
  keyFile: path.join(dataDir, "keys", "id_ed25519"),
  binDir: path.join(dataDir, "bin"),
  /** Host caches of the work-tree snapshots sent to guests (src/core/gitsync.ts), one per checkout and guest. */
  snapshotDir: path.join(dataDir, "snapshots"),
  /**
   * Locks for resources every osmatrix install on this host shares (act's job containers on the Docker
   * daemon), so it ignores OSMATRIX_HOME.
   */
  hostLockDir: path.join(ep.data, "locks"),
  guestDir: (name: string) => path.join(dataDir, "guests", name),
};

/**
 * Prefix for Docker/tart resource names. The default install uses "osmatrix"; a custom OSMATRIX_HOME
 * (tests, CI, a second install) gets "osmatrix-<hash>" so it never touches the default install's guests.
 */
export const resourcePrefix = home ? `osmatrix-${createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 6)}` : "osmatrix";

/** Package root (works from both src/ and dist/). */
export const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
export const assetsDir = path.join(pkgRoot, "assets");
export const skillsDir = path.join(pkgRoot, "skills");
/** Skill directory names shipped in this package, so adding a skill needs no code change. */
export function skillNames(): string[] {
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}
/** Skill names earlier versions installed; removed on install/uninstall so they don't trigger next to the new ones. */
export const LEGACY_SKILL_NAMES = ["osmatrix"];

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Entry script used to re-invoke ourselves (detached CI workers, MCP registration). */
export function cliEntry(): string {
  const dist = path.join(pkgRoot, "dist", "cli.js");
  if (fs.existsSync(dist) && !import.meta.url.endsWith(".ts")) return dist;
  return path.join(pkgRoot, "src", "cli.ts");
}
