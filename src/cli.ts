#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import YAML from "yaml";
import { ciLogs, ciPlan, ciRun, ciStatus, listRuns, worker } from "./ci/run.ts";
import { ensureAct } from "./core/act.ts";
import { defaultConfig, readRawConfig, writeConfig, loadConfig } from "./core/config.ts";
import { doctor } from "./core/host.ts";
import { paths, pkgRoot } from "./core/paths.ts";
import { ensureKey } from "./core/ssh.ts";
import * as env from "./env.ts";
import { input, screenshot, type InputAction } from "./gui.ts";
import { installAgents, type Agent } from "./install.ts";

const program = new Command();
const version = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version as string;

program
  .name("osmatrix")
  .description("Local Ubuntu/Windows/macOS guests and GitHub Actions matrix runs (act) for coding agents")
  .version(version)
  .option("--json", "machine-readable output");

function out(v: unknown) {
  if (program.opts().json) process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  else if (typeof v === "string") process.stdout.write(v.endsWith("\n") ? v : v + "\n");
  else process.stdout.write(YAML.stringify(v));
}

function action<A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) {
  return async (...a: A) => {
    try {
      const r = await fn(...a);
      if (r !== undefined) out(r);
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
  };
}

const int = (v: string) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`not a number: ${v}`);
  return n;
};

// ---------- setup ----------

program
  .command("init")
  .description("Write a starter config, generate the ssh key, and check the host")
  .option("--accept-license", "accept Apple's macOS Software License Agreement for macOS guests (asked once)")
  .option("--force", "overwrite an existing config")
  .action(
    action(async (o: { acceptLicense?: boolean; force?: boolean }) => {
      const raw = readRawConfig();
      if (Object.keys(raw).length && !o.force && !o.acceptLicense) {
        return { config: paths.configFile, note: "config exists (use --force to rewrite)", doctor: await doctor() };
      }
      const d = defaultConfig();
      const next: Record<string, unknown> = o.force ? {} : raw;
      next.max_vms ??= d.max_vms;
      if (o.acceptLicense) next.macos_eula_acknowledged = true;
      else next.macos_eula_acknowledged ??= d.macos_eula_acknowledged;
      writeConfig(next);
      await ensureKey();
      const notes: string[] = [];
      if (!loadConfig().macos_eula_acknowledged && loadConfig().guests.macos?.backend === "dockur") {
        notes.push(
          "macOS guests need your consent to Apple's macOS license (it only permits macOS on Apple hardware): `osmatrix setup macos --accept-license`.",
        );
      }
      return { config: paths.configFile, data: paths.dataDir, notes, doctor: await doctor() };
    }),
  );

program
  .command("config")
  .description("Show the effective configuration")
  .option("--defaults", "show built-in defaults only")
  .action(action((o: { defaults?: boolean }) => ({ file: paths.configFile, ...(o.defaults ? defaultConfig() : loadConfig()) })));

program.command("doctor").description("Check host capabilities and which guests can run").action(action(() => doctor()));

program
  .command("install-act")
  .description("Download the pinned act release into the osmatrix data dir (if act is not on PATH)")
  .action(action(async () => ({ act: await ensureAct() })));

program
  .command("install-agents")
  .description("Register the MCP server and skills with Claude Code, Cursor and Codex")
  .option("--claude", "only Claude Code")
  .option("--cursor", "only Cursor")
  .option("--codex", "only Codex")
  .option("--npx", "register `npx -y osmatrix@<major> mcp` instead of this install's path")
  .option("--copy-skill", "copy the skills instead of symlinking them")
  .option("--uninstall", "remove the registrations")
  .option("--dry-run", "show what would change")
  .action(
    action((o: { claude?: boolean; cursor?: boolean; codex?: boolean; npx?: boolean; copySkill?: boolean; uninstall?: boolean; dryRun?: boolean }) => {
      const agents = (["claude", "cursor", "codex"] as Agent[]).filter((a) => o[a]);
      return installAgents({ agents, npx: o.npx, copySkill: o.copySkill, uninstall: o.uninstall, dryRun: o.dryRun });
    }),
  );

// ---------- guests ----------

program
  .command("status [guest]")
  .description("Show guest state, forwards and URLs")
  .action(action((g?: string) => env.status(g)));

program
  .command("up <guest>")
  .description("Start (creating on first use) a guest")
  .addOption(new Option("--wait [seconds]", "wait for ssh readiness").argParser(int).preset(1800))
  .action(action((g: string, o: { wait?: number }) => env.up(g, o.wait ?? 0)));

program.command("down <guest>").description("Stop a guest (disk kept)").action(action((g: string) => env.down(g)));

program
  .command("snapshot <guest>")
  .description("Save the current disk as the golden snapshot")
  .action(action((g: string) => env.snapshot(g)));

program
  .command("reset <guest>")
  .description("Restore the golden snapshot (or recreate from scratch)")
  .addOption(new Option("--wait [seconds]", "wait for ssh readiness").argParser(int).preset(1800))
  .action(action((g: string, o: { wait?: number }) => env.reset(g, o.wait ?? 0)));

program
  .command("destroy <guest>")
  .description("Delete a guest and all of its disks/snapshots")
  .requiredOption("--yes", "confirm deletion")
  .action(action(async (g: string) => (await env.destroy(g), { destroyed: g })));

program
  .command("exec <guest> <command...>")
  .description("Run a command in a guest (use -- before commands with flags)")
  .option("--cwd <dir>", "working directory (relative to guest home)")
  .option("--timeout <seconds>", "timeout", int)
  .option("--background", "start a long-running process that survives the session; prints pid, log and stop command")
  .action(async (g: string, cmd: string[], o: { cwd?: string; timeout?: number; background?: boolean }) => {
    try {
      if (o.background) {
        out(await env.spawnBackground(g, cmd.join(" "), { cwd: o.cwd }));
        return;
      }
      const r = await env.exec(g, cmd.join(" "), { cwd: o.cwd, timeoutSec: o.timeout });
      if (program.opts().json) out(r);
      else {
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
      }
      process.exitCode = r.exitCode;
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("ssh <guest>")
  .description("Print the ssh command line for an interactive session")
  .action(
    action(async (g: string) => {
      const ep = await env.readyEndpoint(g);
      const { sshArgs } = await import("./core/ssh.ts");
      return ["ssh", ...sshArgs(ep)].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
    }),
  );

program
  .command("push <guest> <localPath> [remoteDir]")
  .description("Copy a file/dir into the guest (default dest: work/<basename>; respects .gitignore)")
  .option("--clean", "delete the remote directory first")
  .option("--all", "ignore .gitignore")
  .action(action((g: string, l: string, r: string | undefined, o: { clean?: boolean; all?: boolean }) => env.push(g, l, r, o)));

program
  .command("pull <guest> <remotePath> [localDir]")
  .description("Copy a file/dir from the guest to the host")
  .action(action((g: string, r: string, l?: string) => env.pull(g, r, l)));

program
  .command("forward <guest> <spec>")
  .description("Forward ports. local: <guestPort>[:<hostPort>]  reverse: --reverse <hostPort>[:<guestPort>]")
  .option("--reverse", "make a host port reachable inside the guest")
  .action(action((g: string, spec: string, o: { reverse?: boolean }) => env.forward(g, spec, !!o.reverse)));

program
  .command("forwards [guest]")
  .description("List active port forwards")
  .action(action((g?: string) => env.forwards(g)));

program
  .command("unforward <guest> [port]")
  .description("Close a forward (by host or guest port) or --all")
  .option("--all", "close all forwards for the guest")
  .action(action((g: string, p: string | undefined, o: { all?: boolean }) => env.unforward(g, p ? int(p) : undefined, !!o.all || !p)));

program
  .command("setup-ssh <guest>")
  .description("Authorize the osmatrix key on a guest that only accepts passwords (prompts for the password)")
  .option("--user <user>", "guest user name")
  .action(action((g: string, o: { user?: string }) => env.setupSsh(g, o.user)));

program
  .command("setup <guest>")
  .description("Make a guest ready end to end: install, configure, provision, golden snapshot (no human steps)")
  .option("--accept-license", "accept Apple's macOS Software License Agreement on the user's behalf (macOS guests)")
  .option("--force", "redo setup even if the guest was set up before")
  .option("--background", "run detached; follow with `osmatrix status <guest>`")
  .option("--foreground", "run in this process (default)")
  .action(
    action(async (g: string, o: { acceptLicense?: boolean; force?: boolean; background?: boolean }) => {
      const { setup, setupInBackground } = await import("./setup.ts");
      if (o.background) return setupInBackground(g, o);
      return setup(g, o);
    }),
  );

program
  .command("provision <guest>")
  .description("Install the CI toolchain in a macOS guest (Xcode CLT, Homebrew, git, node, python, act); asks for the guest sudo password once")
  .option("--passwordless-sudo", "also allow sudo without a password, like GitHub's macOS runners (needed by workflows with sudo steps)")
  .action(
    action(async (g: string, o: { passwordlessSudo?: boolean }) => {
      const r = await env.provision(g, o);
      process.exitCode = r.exitCode;
      return r;
    }),
  );

program
  .command("report <guest>")
  .description("Build a compatibility report for a GitHub issue (prints it and a prefilled issue link; sends nothing)")
  .addOption(new Option("--outcome <outcome>", "how it went").choices(["works", "partly", "fails"]).makeOptionMandatory())
  .option("--notes <text>", "what worked or failed, and at which step")
  .action(
    action(async (g: string, o: { outcome: string; notes?: string }) => {
      const { compatReport } = await import("./report.ts");
      const outcome = ({ works: "Works", partly: "Partly works", fails: "Doesn't work" } as const)[o.outcome as "works" | "partly" | "fails"];
      return compatReport(g, { outcome, notes: o.notes });
    }),
  );

program
  .command("screenshot <guest>")
  .description("Save a PNG of the guest display (dockur guests)")
  .option("-o, --output <file>", "output file", "screenshot.png")
  .action(
    action(async (g: string, o: { output: string }) => {
      const s = await screenshot(g);
      fs.writeFileSync(o.output, s.png);
      return { file: path.resolve(o.output), width: s.width, height: s.height };
    }),
  );

program
  .command("input <guest>")
  .description("Send keys/text/clicks to the guest display")
  .option("--keys <combos...>", 'key combos, e.g. "ctrl+alt+delete" enter')
  .option("--text <text>", "text to type")
  .option("--click <x,y>", "left click at framebuffer coordinates")
  .action(
    action((g: string, o: { keys?: string[]; text?: string; click?: string }) => {
      const acts: InputAction[] = [];
      if (o.click) {
        const [x, y] = o.click.split(",").map(int);
        acts.push({ click: { x, y } });
      }
      if (o.text) acts.push({ text: o.text });
      if (o.keys) acts.push({ keys: o.keys });
      if (!acts.length) throw new Error("nothing to send");
      return input(g, acts);
    }),
  );

// ---------- ci ----------

const ci = program.command("ci").description("Run GitHub Actions workflows locally with act");

function filterOpts(c: Command) {
  return c
    .option("--repo <dir>", "repository directory", ".")
    .option("-W, --workflow <file>", "workflow file name or path")
    .option("-j, --job <id>", "job id")
    .option("--only <targets...>", "linux | windows | macos | guest names")
    .option("-m, --matrix <kv...>", "matrix filter key=value");
}

type FilterCli = { repo: string; workflow?: string; job?: string; only?: string[]; matrix?: string[] };
function toFilter(o: FilterCli) {
  const matrix = o.matrix
    ? Object.fromEntries(
        o.matrix.map((kv) => {
          const i = kv.search(/[=:]/);
          if (i < 0) throw new Error(`bad matrix filter "${kv}" (want key=value)`);
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      )
    : undefined;
  return { workflow: o.workflow, job: o.job, only: o.only, matrix };
}

filterOpts(ci.command("plan").description("Show the legs that would run and where")).action(
  action(async (o: FilterCli) => {
    const p = await ciPlan(o.repo, toFilter(o));
    if (program.opts().json) return p;
    return {
      repo: p.repo,
      warnings: p.warnings.length ? p.warnings : undefined,
      legs: p.legs.map((l) => ({
        id: l.id,
        workflow: l.workflow,
        runsOn: l.runsOn.join(","),
        target: l.target ?? "-",
        ...(l.skip ? { skip: l.skip } : {}),
        ...(l.warnings.length ? { warnings: l.warnings } : {}),
      })),
    };
  }),
);

filterOpts(ci.command("run").description("Run legs (in the background unless --wait)"))
  .option("--wait", "run in the foreground and exit non-zero on failure")
  .option("--event <name>", "event name for act")
  .option("--event-file <file>", "event payload JSON for act, e.g. {\"ref\":\"refs/tags/v1.2.3\"}")
  .option("--secret-file <file>", "KEY=value secrets file (default .osmatrix/secrets or .secrets)")
  .option("--timeout <minutes>", "per-leg timeout", int)
  .action(
    action(async (o: FilterCli & { wait?: boolean; event?: string; eventFile?: string; secretFile?: string; timeout?: number }) => {
      const eventPayload = o.eventFile ? JSON.parse(fs.readFileSync(o.eventFile, "utf8")) : undefined;
      const s = await ciRun(o.repo, { ...toFilter(o), event: o.event, eventPayload, secretFile: o.secretFile, timeoutMin: o.timeout }, !!o.wait);
      if (o.wait && (s.counts.failure || s.counts.error)) process.exitCode = 1;
      return summarize(s);
    }),
  );

ci.command("status [run]")
  .description("Show a run's status (default latest)")
  .option("--repo <dir>", "repository directory", ".")
  .option("--full", "include step lists and log tails")
  .action(action((run: string | undefined, o: { repo: string; full?: boolean }) => {
    const s = ciStatus(o.repo, run);
    return o.full || program.opts().json ? s : summarize(s);
  }));

ci.command("logs <leg>")
  .description("Show a leg's log")
  .option("--repo <dir>", "repository directory", ".")
  .option("--run <id>", "run id (default latest)")
  .option("--tail <n>", "lines", int)
  .option("--grep <re>", "filter lines")
  .action(action((leg: string, o: { repo: string; run?: string; tail?: number; grep?: string }) => ciLogs(o.repo, leg, o)));

ci.command("runs")
  .description("List runs")
  .option("--repo <dir>", "repository directory", ".")
  .action(action((o: { repo: string }) => listRuns(o.repo)));

ci.command("_worker <id>", { hidden: true })
  .requiredOption("--repo <dir>")
  .action(action(async (id: string, o: { repo: string }) => (await worker(path.resolve(o.repo), id), undefined)));

function summarize(s: ReturnType<typeof ciStatus>) {
  return {
    id: s.id,
    state: s.state,
    counts: Object.fromEntries(Object.entries(s.counts).filter(([, n]) => n)),
    legs: s.legs.map((l) => ({
      id: l.id,
      target: l.target ?? "-",
      state: l.state,
      ...(l.durationSec !== undefined ? { sec: l.durationSec } : {}),
      ...(l.waitingFor ? { waitingFor: l.waitingFor } : {}),
      ...(l.failedStep ? { failedStep: l.failedStep } : {}),
      ...(l.error ? { error: l.error } : {}),
    })),
    ...(s.planWarnings.length ? { warnings: s.planWarnings } : {}),
  };
}

// ---------- mcp ----------

program
  .command("mcp")
  .description("Run the MCP server on stdio")
  .action(async () => {
    const { startMcp } = await import("./mcp.ts");
    await startMcp();
  });

await program.parseAsync(process.argv);
