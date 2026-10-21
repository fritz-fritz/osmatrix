import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_SKILL_NAMES, cliEntry, pkgRoot, skillNames, skillsDir } from "./core/paths.ts";
import { run, which } from "./core/proc.ts";

export type Agent = "claude" | "cursor" | "codex";

export type Scope = "user" | "project";

export interface InstallOptions {
  agents?: Agent[];
  /**
   * Where to register: the user's home (a global install), or a project that has osmatrix among its
   * dependencies. Detected from where osmatrix runs when unset (see detectScope).
   */
  scope?: Scope;
  /** The project for scope "project"; detected when unset. */
  projectRoot?: string;
  /** Where detection starts; the current directory when unset. */
  cwd?: string;
  /** Register `npx -y osmatrix mcp` instead of this checkout's absolute path. */
  npx?: boolean;
  /** Copy the skills instead of symlinking them. */
  copySkill?: boolean;
  uninstall?: boolean;
  dryRun?: boolean;
}

const home = os.homedir();

/**
 * Where install-agents should register. In the project when the osmatrix that runs is that project's
 * `node_modules/osmatrix` (a dependency: `npm i -D osmatrix`, or `npm link`; compared by real path), else
 * in the user's home (`npm i -g`, an npx cache, a checkout). `pkgDir` is this package's root.
 */
export function detectScope(cwd = process.cwd(), pkgDir = pkgRoot): { scope: Scope; projectRoot?: string; reason: string } {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const pkg = real(pkgDir);
  for (let dir = real(cwd) ?? path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (pkg && real(path.join(dir, "node_modules", "osmatrix")) === pkg) {
      return { scope: "project", projectRoot: dir, reason: `osmatrix is a dependency of ${dir}` };
    }
    if (path.dirname(dir) === dir) break;
  }
  return { scope: "user", reason: `osmatrix runs from ${pkgDir}, not from a project's node_modules` };
}

function serverCommand(npx: boolean): { command: string; args: string[] } {
  if (npx) {
    const major = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version.split(".")[0];
    return { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["-y", `osmatrix@${major}`, "mcp"] };
  }
  // Prefer the stable `node` on PATH (e.g. /usr/bin/node) over a versioned execPath like /usr/bin/node26.
  return { command: which("node") ?? process.execPath, args: [cliEntry(), "mcp"] };
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot parse ${file}: ${(e as Error).message}`);
  }
}

function writeJson(file: string, data: unknown, dry: boolean) {
  if (dry) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".osmatrix.bak");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function setMcpJson(file: string, entry: Record<string, unknown> | undefined, dry: boolean): string {
  const j = readJson(file);
  const servers = (j.mcpServers ?? {}) as Record<string, unknown>;
  if (entry) servers.osmatrix = entry;
  else delete servers.osmatrix;
  j.mcpServers = servers;
  writeJson(file, j, dry);
  return file;
}

/** Codex: edit config.toml textually so comments and formatting survive. */
function setCodexToml(file: string, cmd: { command: string; args: string[] } | undefined, dry: boolean): string {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  // Remove an existing [mcp_servers.osmatrix] table (and its subtables) up to the next unrelated table.
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(l);
    if (header) skipping = header[1] === "mcp_servers.osmatrix" || header[1].startsWith("mcp_servers.osmatrix.");
    if (!skipping) out.push(l);
  }
  text = out.join("\n").replace(/\n+$/, "\n");
  if (cmd) {
    text +=
      `\n[mcp_servers.osmatrix]\ncommand = ${JSON.stringify(cmd.command)}\nargs = ${JSON.stringify(cmd.args)}\n` +
      `startup_timeout_sec = 30\ntool_timeout_sec = 900\n`;
  }
  if (!dry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, file + ".osmatrix.bak");
    fs.writeFileSync(file, text);
  }
  return file;
}

/**
 * True if `dir` is a skill osmatrix installed under `name`: a symlink/junction into a package's
 * `skills/<name>`, or a copy whose SKILL.md carries that name. Anything else with the name (a user's own
 * skill, say) is left alone.
 */
function isOurs(dir: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    if (fs.lstatSync(dir).isSymbolicLink() && new RegExp(`[\\\\/]skills[\\\\/]${esc}[\\\\/]?$`).test(fs.readlinkSync(dir))) return true;
    return new RegExp(`^name:\\s*${esc}\\s*$`, "m").test(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  } catch {
    return false;
  }
}

/** Whether anything is at `p`, a dangling symlink included. */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export interface InstalledSkills {
  /** The shipped skills put in place (empty on uninstall, which removes them instead). */
  installed: string[];
  /** Skills of earlier versions that aren't shipped any more, and that we created: removed. */
  removedLegacy: string[];
  /** Directories with a shipped skill's name that we didn't create: left alone, that skill not installed. */
  skipped: string[];
}

export function installSkills(dest: string, copy: boolean, uninstall: boolean, dry: boolean, legacyNames = LEGACY_SKILL_NAMES, relative = false): InstalledSkills {
  const current = skillNames();
  const installed: string[] = [];
  const skipped: string[] = [];
  // Only touch what we created: our earlier copies (and dangling links) are replaced, anyone else's kept.
  for (const name of current) {
    const target = path.join(dest, name);
    (present(target) && !isOurs(target, name) ? skipped : installed).push(target);
  }
  // Skills from before a split would keep triggering next to the current ones.
  const removedLegacy = legacyNames
    .filter((name) => !current.includes(name))
    .map((name) => path.join(dest, name))
    .filter((dir) => isOurs(dir, path.basename(dir)));
  if (dry) return { installed: uninstall ? [] : installed, removedLegacy, skipped };
  for (const target of [...removedLegacy, ...installed]) fs.rmSync(target, { recursive: true, force: true });
  if (uninstall) return { installed: [], removedLegacy, skipped };
  fs.mkdirSync(dest, { recursive: true });
  for (const target of installed) {
    const source = path.join(skillsDir, path.basename(target));
    if (!copy) {
      try {
        // Relative links (a project's, into its node_modules) survive the project moving or being cloned.
        // Between real paths: the OS resolves the link from the real directory, so a symlinked ancestor
        // (macOS's /var -> /private/var, say) would otherwise leave it dangling. Not on Windows: a
        // junction's target is absolute, and Node resolves a relative one against the current directory.
        const to = relative && process.platform !== "win32" ? path.relative(fs.realpathSync(path.dirname(target)), fs.realpathSync(source)) : source;
        fs.symlinkSync(to, target, process.platform === "win32" ? "junction" : "dir");
        continue;
      } catch {
        /* fall back to copy (e.g. Windows without symlink rights) */
      }
    }
    fs.cpSync(source, target, { recursive: true });
  }
  return { installed, removedLegacy, skipped };
}

export async function installAgents(opts: InstallOptions = {}) {
  const agents = opts.agents?.length ? opts.agents : (["claude", "cursor", "codex"] as Agent[]);
  const detected = detectScope(opts.cwd);
  const scope: Scope = opts.scope ?? detected.scope;
  const root = scope === "project" ? (opts.projectRoot ?? detected.projectRoot ?? path.resolve(opts.cwd ?? process.cwd())) : home;
  // A project's config is shared and may be committed: it runs the npm package (the project's own copy,
  // when that satisfies the major), never a path on this machine, and its skills link into node_modules.
  const npx = scope === "project" || !!opts.npx;
  const cmd = serverCommand(npx);
  const dry = !!opts.dryRun;
  const copy = opts.copySkill ?? (scope === "user" && !!opts.npx); // an npx cache path is not a stable symlink target
  const skills = (dest: string) => installSkills(dest, copy, !!opts.uninstall, dry, LEGACY_SKILL_NAMES, scope === "project");
  const done: Record<string, unknown> = {
    scope,
    reason: opts.scope ? `--scope ${opts.scope}` : detected.reason,
    root,
    server: opts.uninstall ? null : cmd,
  };

  if (agents.includes("claude")) {
    const claude = scope === "user" ? which("claude") : undefined;
    if (claude && !dry) {
      await run(claude, ["mcp", "remove", "--scope", "user", "osmatrix"]);
      if (!opts.uninstall) {
        const r = await run(claude, ["mcp", "add", "--scope", "user", "osmatrix", "--", cmd.command, ...cmd.args]);
        if (r.code !== 0) throw new Error(`claude mcp add failed: ${r.stderr}`);
      }
      done.claudeMcp = "claude mcp add --scope user";
    } else {
      // User scope without the CLI on PATH (desktop app only): user servers live in ~/.claude.json. A
      // project's live in .mcp.json at its root, which Claude Code asks to approve once.
      const file = scope === "user" ? path.join(home, ".claude.json") : path.join(root, ".mcp.json");
      done.claudeMcp = setMcpJson(file, opts.uninstall ? undefined : { type: "stdio", ...cmd, env: {} }, dry);
    }
    done.claudeSkills = skills(path.join(root, ".claude", "skills"));
  }
  if (agents.includes("cursor")) {
    done.cursorMcp = setMcpJson(path.join(root, ".cursor", "mcp.json"), opts.uninstall ? undefined : { type: "stdio", ...cmd }, dry);
  }
  if (agents.includes("codex")) {
    const codexDir = scope === "user" ? (process.env.CODEX_HOME ?? path.join(home, ".codex")) : path.join(root, ".codex");
    done.codexMcp = setCodexToml(path.join(codexDir, "config.toml"), opts.uninstall ? undefined : cmd, dry);
  }
  if (agents.includes("cursor") || agents.includes("codex")) {
    // Shared Agent Skills location read by Codex and Cursor.
    done.sharedSkills = skills(path.join(root, ".agents", "skills"));
  }
  if (scope === "project" && !opts.uninstall) {
    done.notes = ["Claude Code asks once to approve the servers in .mcp.json; Codex reads .codex/config.toml in trusted projects only."];
  }
  return { dryRun: dry, uninstall: !!opts.uninstall, ...done };
}
