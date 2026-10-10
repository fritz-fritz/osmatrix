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
export const skillDir = path.join(pkgRoot, "skills", "osmatrix");

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
