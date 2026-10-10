import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliEntry, pkgRoot, skillDir } from "./core/paths.ts";
import { run, which } from "./core/proc.ts";

export type Agent = "claude" | "cursor" | "codex";

export interface InstallOptions {
  agents?: Agent[];
  /** Register `npx -y osmatrix mcp` instead of this checkout's absolute path. */
  npx?: boolean;
  /** Copy the skill instead of symlinking it. */
  copySkill?: boolean;
  uninstall?: boolean;
  dryRun?: boolean;
}

const home = os.homedir();

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

function installSkill(dest: string, copy: boolean, uninstall: boolean, dry: boolean): string {
  const target = path.join(dest, "osmatrix");
  if (dry) return target;
  fs.rmSync(target, { recursive: true, force: true });
  if (uninstall) return target;
  fs.mkdirSync(dest, { recursive: true });
  if (!copy) {
    try {
      fs.symlinkSync(skillDir, target, process.platform === "win32" ? "junction" : "dir");
      return target;
    } catch {
      /* fall back to copy (e.g. Windows without symlink rights) */
    }
  }
  fs.cpSync(skillDir, target, { recursive: true });
  return target;
}

export async function installAgents(opts: InstallOptions = {}) {
  const agents = opts.agents?.length ? opts.agents : (["claude", "cursor", "codex"] as Agent[]);
  const cmd = serverCommand(!!opts.npx);
  const dry = !!opts.dryRun;
  const copy = opts.copySkill ?? !!opts.npx; // an npx cache path is not a stable symlink target
  const done: Record<string, unknown> = { server: opts.uninstall ? null : cmd };

  if (agents.includes("claude")) {
    const claude = which("claude");
    if (claude && !dry) {
      await run(claude, ["mcp", "remove", "--scope", "user", "osmatrix"]);
      if (!opts.uninstall) {
        const r = await run(claude, ["mcp", "add", "--scope", "user", "osmatrix", "--", cmd.command, ...cmd.args]);
        if (r.code !== 0) throw new Error(`claude mcp add failed: ${r.stderr}`);
      }
      done.claudeMcp = "claude mcp add --scope user";
    } else {
      // No CLI on PATH (e.g. desktop app only): user-scope servers live in ~/.claude.json.
      done.claudeMcp = setMcpJson(path.join(home, ".claude.json"), opts.uninstall ? undefined : { type: "stdio", ...cmd, env: {} }, dry);
    }
    done.claudeSkill = installSkill(path.join(home, ".claude", "skills"), copy, !!opts.uninstall, dry);
  }
  if (agents.includes("cursor")) {
    done.cursorMcp = setMcpJson(path.join(home, ".cursor", "mcp.json"), opts.uninstall ? undefined : { type: "stdio", ...cmd }, dry);
  }
  if (agents.includes("codex")) {
    const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex");
    done.codexMcp = setCodexToml(path.join(codexHome, "config.toml"), opts.uninstall ? undefined : cmd, dry);
  }
  if (agents.includes("cursor") || agents.includes("codex")) {
    // Shared Agent Skills location read by Codex and Cursor.
    done.sharedSkill = installSkill(path.join(home, ".agents", "skills"), copy, !!opts.uninstall, dry);
  }
  return { dryRun: dry, uninstall: !!opts.uninstall, ...done };
}
