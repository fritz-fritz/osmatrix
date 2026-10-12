import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LINUX_IMAGE } from "../core/config.ts";
import { acquireLocks, type LockOwner } from "../core/locks.ts";
import { assetsDir } from "../core/paths.ts";
import { run } from "../core/proc.ts";
import { dockerBin, imageExists } from "./docker.ts";

/**
 * act's default image lacks toolchains GitHub's ubuntu runners preinstall (Rust, see the Dockerfile), so
 * with the default act_linux_image Linux legs and the ubuntu guest run in a thin layer over it instead.
 */
export const PARITY_DOCKERFILE = path.join(assetsDir, "container", "ubuntu-parity.Dockerfile");

/**
 * Tagged by the Dockerfile's content: an edited Dockerfile gets a new tag and is built on next use. The
 * name ignores OSMATRIX_HOME, since every install building the same file can share the image.
 */
export function parityImageTag(dockerfile: string | Buffer = fs.readFileSync(PARITY_DOCKERFILE)): string {
  return `osmatrix/ubuntu:act-24.04-${crypto.createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
}

/** The image for Linux legs: the parity layer for the default, a user-configured image unchanged. */
export function linuxImageFor(configured: string, parityTag = parityImageTag()): string {
  return configured === DEFAULT_LINUX_IMAGE ? parityTag : configured;
}

/**
 * Resolve the image for `configured`, building the parity layer once if it's missing. Concurrent runs,
 * from any install on this host, take turns on a host lock, and whoever waited finds the image built.
 */
export async function ensureLinuxImage(configured: string, owner: LockOwner, log: (line: string) => void = () => undefined): Promise<string> {
  const tag = linuxImageFor(configured);
  if (tag === configured || (await imageExists(tag))) return tag;
  const release = await acquireLocks([`host:image:${tag}`], owner, (_key, h) => log(`[osmatrix] waiting: ${tag} is being built by run ${h.run} (${h.leg})`));
  try {
    if (await imageExists(tag)) return tag;
    log(`[osmatrix] building ${tag} (act's default image plus what GitHub's ubuntu runners preinstall; once, takes a few minutes)`);
    const r = await run(dockerBin(), ["build", "-t", tag, "-f", PARITY_DOCKERFILE, path.dirname(PARITY_DOCKERFILE)], { timeoutMs: 60 * 60_000 });
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout).trim().split("\n").slice(-30).join("\n");
      throw new Error(`building ${tag} failed (setting act_linux_image to another image skips this layer):\n${tail}`);
    }
    log(`[osmatrix] built ${tag}`);
    return tag;
  } finally {
    release();
  }
}
