import { createHash } from "node:crypto";
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

function lockFile(key: string): string {
  // Readable prefix for debugging, hash so distinct keys never map to the same file.
  const slug = key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return path.join(ensureDir(path.join(paths.dataDir, "locks")), `${slug}-${hash}.json`);
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

/** One attempt: take the lock, or return its live holder. Locks of dead processes are reclaimed. */
export function tryLock(key: string, owner: LockOwner): { ok: true } | { ok: false; holder: LockOwner } {
  const file = lockFile(key);
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ ...owner, since: new Date().toISOString() }), { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const cur = readOwner(file);
    if (!cur) continue; // released between our attempts
    if (cur.owner && isAlive(cur.owner.pid)) return { ok: false, holder: cur.owner };
    // Stale (holder died) or unreadable. Only remove it if nobody replaced it meanwhile.
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
  const release = () => {
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
