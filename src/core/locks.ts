import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, paths } from "./paths.ts";
import { isAlive } from "./proc.ts";

/** Who holds a lock; written into the lock file so waiters can say what they wait for. */
export interface LockOwner {
  pid: number;
  run: string;
  repo: string;
  leg: string;
  since?: string;
}

/** Holders refresh their lock files this often; a lock not refreshed for STALE_MS is abandoned. */
const HEARTBEAT_MS = 15_000;
const STALE_MS = 120_000;
/** An unreadable lock file younger than this may still be being written by its holder. */
const INIT_GRACE_MS = 5_000;

/**
 * Keys starting with "host:" guard resources shared by every install on this host (see
 * paths.hostLockDir); the others belong to this install (OSMATRIX_HOME).
 */
function lockFile(key: string): string {
  const dir = key.startsWith("host:") ? paths.hostLockDir : path.join(paths.dataDir, "locks");
  // Readable prefix for debugging, hash so distinct keys never map to the same file.
  const slug = key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return path.join(ensureDir(dir), `${slug}-${hash}.json`);
}

/** A holder is live while its process exists and it keeps the file fresh (a reused pid doesn't). */
function isLive(file: string, owner: LockOwner | undefined): boolean {
  if (!owner || !isAlive(owner.pid)) return false;
  return isFresh(file, STALE_MS);
}

function isFresh(file: string, ms: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < ms;
  } catch {
    return false;
  }
}

function readOwner(file: string): { raw: string; owner?: LockOwner } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return { raw, owner: JSON.parse(raw) as LockOwner };
  } catch {
    return { raw };
  }
}

/**
 * Create file with content unless it exists, so that nobody ever sees it without its content: written
 * to a private file first, then hard-linked into place, which fails if file exists. (Creating file with
 * "wx" and then writing it would let another process read it empty in between, take it for an abandoned
 * lock, delete it and take the lock too.) Where hard links aren't supported, falls back to "wx".
 */
function publish(file: string, content: string): boolean {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, content, { flag: "wx" });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  try {
    fs.writeFileSync(file, content, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** One attempt: take the lock, or return its live holder. Locks of dead processes are reclaimed. */
export function tryLock(key: string, owner: LockOwner): { ok: true } | { ok: false; holder: LockOwner } {
  const file = lockFile(key);
  for (;;) {
    if (publish(file, JSON.stringify({ ...owner, since: new Date().toISOString() }))) return { ok: true };
    const cur = readOwner(file);
    if (!cur) continue; // released between our attempts
    if (isLive(file, cur.owner)) return { ok: false, holder: cur.owner! };
    // An unreadable lock that was just created is most likely still being written (by an osmatrix that
    // didn't publish locks atomically): give its holder time to finish rather than taking it over.
    if (!cur.owner && isFresh(file, INIT_GRACE_MS)) return { ok: false, holder: { pid: 0, run: "(starting)", repo: "", leg: "(starting)" } };
    // Stale (holder died or stopped refreshing) or unreadable. Only remove it if nobody replaced it meanwhile.
    if (readOwner(file)?.raw === cur.raw) fs.rmSync(file, { force: true });
  }
}

export function unlock(key: string, owner: LockOwner): void {
  const file = lockFile(key);
  const cur = readOwner(file);
  if (cur?.owner?.pid === owner.pid && cur.owner.run === owner.run && cur.owner.leg === owner.leg) fs.rmSync(file, { force: true });
}

/**
 * Take every key, waiting while another live process holds one. Keys are taken in sorted order so two
 * runs needing overlapping sets can't deadlock. Returns the release function.
 */
export async function acquireLocks(
  keys: string[],
  owner: LockOwner,
  onWait: (key: string, holder: LockOwner) => void,
  pollMs = 2000,
): Promise<() => void> {
  const held: string[] = [];
  const heartbeat = setInterval(() => {
    const now = new Date();
    for (const k of held) fs.utimes(lockFile(k), now, now, () => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const release = () => {
    clearInterval(heartbeat);
    for (const k of held.splice(0)) unlock(k, owner);
  };
  try {
    for (const key of [...new Set(keys)].sort()) {
      let lastHolder: string | undefined;
      for (;;) {
        const r = tryLock(key, owner);
        if (r.ok) break;
        const id = `${r.holder.pid}/${r.holder.run}/${r.holder.leg}`;
        if (id !== lastHolder) onWait(key, r.holder);
        lastHolder = id;
        await new Promise((res) => setTimeout(res, pollMs));
      }
      held.push(key);
    }
  } catch (e) {
    release();
    throw e;
  }
  return release;
}
