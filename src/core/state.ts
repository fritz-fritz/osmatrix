import fs from "node:fs";
import path from "node:path";
import { ensureDir, paths } from "./paths.ts";
import { isAlive } from "./proc.ts";

export interface ForwardRecord {
  guest: string;
  /** local: host port -> guest port. reverse: guest port -> host port. */
  kind: "local" | "reverse";
  hostPort: number;
  guestPort: number;
  pid: number;
  createdAt: string;
}

export interface State {
  forwards: ForwardRecord[];
  /** Background processes owned by a guest (e.g. tart run). */
  pids: Record<string, number>;
  /** A guest's browser viewer server (`osmatrix _viewer`), for guests without a web viewer of their own. */
  viewers: Record<string, { pid: number; port: number }>;
}

export function loadState(): State {
  let s: State = { forwards: [], pids: {}, viewers: {} };
  try {
    s = { ...s, ...JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) };
  } catch {
    /* fresh state */
  }
  // Drop records whose process has died.
  s.forwards = s.forwards.filter((f) => isAlive(f.pid));
  for (const [k, pid] of Object.entries(s.pids)) if (!isAlive(pid)) delete s.pids[k];
  for (const [k, v] of Object.entries(s.viewers)) if (!isAlive(v.pid)) delete s.viewers[k];
  return s;
}

export function saveState(s: State): void {
  ensureDir(path.dirname(paths.stateFile));
  const tmp = paths.stateFile + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, paths.stateFile);
}

export function updateState(fn: (s: State) => void): State {
  const s = loadState();
  fn(s);
  saveState(s);
  return s;
}
