import fs from "node:fs";
import path from "node:path";
import { dockerBin } from "./backends/docker.ts";
import { DockurBackend } from "./backends/dockur.ts";
import { QemuMacBackend } from "./backends/qemu-macos.ts";
import { TartBackend } from "./backends/tart.ts";
import type { GuestStatus, MacInstallVm } from "./backends/types.ts";
import { loadConfig, readRawConfig, writeConfig } from "./core/config.ts";
import { assetsDir, cliEntry, ensureDir, paths } from "./core/paths.ts";
import { isAlive, run, sleep, spawnDetached } from "./core/proc.ts";
import { ensureKey, sshExec } from "./core/ssh.ts";
import { getGuest, macProvisionPlan, readyEndpoint, snapshotGuest, waitReady, type Guest } from "./env.ts";
import { input, screenBrightness } from "./gui.ts";

/**
 * `osmatrix setup <guest>`: take a guest from nothing to "ready + provisioned + golden snapshot" with no
 * human steps. The only consent needed is accepting Apple's macOS license (macOS guests).
 */

export interface SetupOptions {
  /** Accept Apple's macOS software license (persisted as macos_eula_acknowledged). */
  acceptLicense?: boolean;
  /** Re-run even if the guest already completed setup. */
  force?: boolean;
  log?: (line: string) => void;
}

export interface SetupState {
  guest: string;
  phase: string;
  startedAt: string;
  updatedAt: string;
  pid?: number;
  done?: boolean;
  error?: string;
}

const stateFile = (name: string) => path.join(ensureDir(paths.guestDir(name)), "setup.json");
const logFile = (name: string) => path.join(ensureDir(paths.guestDir(name)), "setup.log");

export function setupState(name: string): SetupState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(name), "utf8")) as SetupState;
    if (!s.done && !s.error && s.pid && !isAlive(s.pid)) s.error = "setup process exited unexpectedly; see setup.log";
    return s;
  } catch {
    return undefined;
  }
}

function writeState(name: string, patch: Partial<SetupState>) {
  const now = new Date().toISOString();
  const prev = setupState(name) ?? { guest: name, phase: "start", startedAt: now, updatedAt: now };
  fs.writeFileSync(stateFile(name), JSON.stringify({ ...prev, ...patch, updatedAt: now }, null, 2));
}

/** Persist the license acknowledgement, or explain how to give it. */
function requireLicense(opts: SetupOptions) {
  if (loadConfig().macos_eula_acknowledged) return;
  if (!opts.acceptLicense) {
    throw new Error(
      "macOS setup accepts Apple's macOS Software License Agreement (https://www.apple.com/legal/sla/) on the user's behalf. " +
        "Ask the user to confirm, then re-run with accept_license=true (CLI: --accept-license).",
    );
  }
  const raw = readRawConfig();
  raw.macos_eula_acknowledged = true;
  writeConfig(raw);
}

/** Start setup in a detached process (for MCP, where calls must return quickly). */
export function setupInBackground(name: string, opts: SetupOptions): SetupState {
  const g = getGuest(name);
  if (g.cfg.os === "macos") requireLicense(opts);
  const cur = setupState(name);
  if (cur && !cur.done && !cur.error && cur.pid && isAlive(cur.pid)) return cur;
  fs.writeFileSync(logFile(name), "");
  const args = [cliEntry(), "setup", name, "--foreground"];
  if (opts.force) args.push("--force");
  const pid = spawnDetached(process.execPath, args, { logFile: logFile(name) });
  writeState(name, { phase: "starting", pid, done: false, error: undefined, startedAt: new Date().toISOString() });
  return setupState(name)!;
}

export async function setup(name: string, opts: SetupOptions = {}): Promise<GuestStatus & { setup: SetupState | undefined }> {
  const g = getGuest(name);
  const log = opts.log ?? ((l: string) => process.stderr.write(`[setup ${name}] ${l}\n`));
  if (g.cfg.os === "macos") requireLicense(opts);
  writeState(name, { phase: "starting", pid: process.pid, done: false, error: undefined });
  const phase = (p: string) => {
    log(p);
    writeState(name, { phase: p });
  };
  try {
    const mac = g.cfg.os === "macos" ? macInstallVm(g) : undefined;
    if (mac) await setupIntelMac(g, mac, opts, phase, log);
    else await setupGeneric(g, phase);
    const st = await g.backend.status();
    if (st.state !== "ready") throw new Error(`guest not ready after setup: ${st.state} ${st.detail ?? ""}`);
    if (!st.hasSnapshot) {
      phase("saving golden snapshot");
      await snapshotGuest(g);
      await waitReady(g, 600);
    }
    writeState(name, { phase: "done", done: true });
    log("done");
    return { ...(await g.backend.status()), setup: setupState(name) };
  } catch (e) {
    writeState(name, { error: (e as Error).message });
    throw e;
  }
}

async function setupGeneric(g: Guest, phase: (p: string) => void) {
  phase("starting guest");
  await g.backend.up();
  phase(g.cfg.os === "windows" ? "waiting for Windows to install and provision itself (first boot: 20-60 min)" : "waiting for ssh");
  const s = await waitReady(g, g.cfg.boot_timeout ?? 2 * 3600);
  if (s.state !== "ready") throw new Error(`${g.cfg.name} did not become ready: ${s.state} ${s.detail ?? ""}`);
  if (g.cfg.os === "macos" && g.backend instanceof TartBackend) {
    phase("provisioning toolchain");
    await provisionMac(g);
  }
}

// ---------------------------------------------------------------------------------------------
// Intel macOS (dockur, or the host's QEMU): Recovery -> startosinstall -> Recovery (offline
// configure) -> ssh -> provision
// ---------------------------------------------------------------------------------------------

const BRIDGE_PORT = 8099;
const BRIDGE = "/tmp/osmatrix-bridge.py";
/** The guest's default gateway: dockur's container, or the host under QEMU user networking. */
const GATEWAY = "$(route -n get default | awk '/gateway/{print $2}')";

/** The Intel macOS VM behind a guest, for the unattended install; undefined for tart and ssh guests. */
function macInstallVm(g: Guest): MacInstallVm | undefined {
  if (g.backend instanceof QemuMacBackend) return g.backend;
  if (g.backend instanceof DockurBackend) return dockurMacVm(g.backend);
  return undefined;
}

/** dockur's macOS container: the bridge (assets/macos/bridge.py) runs inside it, next to QEMU. */
function dockurMacVm(b: DockurBackend): MacInstallVm {
  const exec = (args: string[], timeoutMs?: number) => run(dockerBin(), ["exec", ...args], timeoutMs ? { timeoutMs } : {});
  return {
    credentials: () => b.credentials(),
    everReady: () => b.everReady(),
    boot: (o) => b.recreate(o),
    console: async () => {
      const r = await run(dockerBin(), ["logs", "--tail", "50", b.containerName]);
      return r.stdout + r.stderr;
    },
    bootCount: () => b.bootCount(),
    ioBytes: () => b.ioBytes(),
    powerCycle: async () => {
      await run(dockerBin(), ["restart", "-t", "10", b.containerName]);
    },
    bridgeStart: async () => {
      await run(dockerBin(), ["cp", path.join(assetsDir, "macos", "bridge.py"), `${b.containerName}:${BRIDGE}`]);
      await exec([b.containerName, "pkill", "-f", BRIDGE]);
      await exec(["-d", "-e", `OSMATRIX_BRIDGE_PORT=${BRIDGE_PORT}`, b.containerName, "python3", BRIDGE, "serve"]);
    },
    bridgeUrl: () => `http://${GATEWAY}:${BRIDGE_PORT}`,
    bridgeAlive: async () => (await exec([b.containerName, "python3", BRIDGE, "alive"])).code === 0,
    bridgeRun: async (cmd, timeoutSec) => {
      const r = await exec([b.containerName, "python3", BRIDGE, "run", cmd, String(timeoutSec)], (timeoutSec + 30) * 1000);
      if (r.code !== 0) throw new Error(`bridge: ${r.stderr.trim() || "no response from guest"}`);
      return r.stdout;
    },
    bridgeFile: async (name, localPath) => {
      await exec([b.containerName, "mkdir", "-p", "/tmp/osmatrix-bridge/files"]);
      await run(dockerBin(), ["cp", localPath, `${b.containerName}:/tmp/osmatrix-bridge/files/${name}`]);
    },
  };
}

async function setupIntelMac(g: Guest, b: MacInstallVm, opts: SetupOptions, phase: (p: string) => void, log: (l: string) => void) {
  const name = g.cfg.name;
  const s0 = await g.backend.status();
  if (s0.state === "ready" && !opts.force) {
    phase("already installed; provisioning");
    await provisionMac(g);
    return;
  }
  if (b.everReady() && !opts.force) {
    phase("starting existing guest");
    await g.backend.up();
    const s = await waitReady(g, 900);
    if (s.state !== "ready") throw new Error(`${name} was set up before but is not reachable: ${s.state}`);
    await provisionMac(g);
    return;
  }

  // Phase 1: Recovery, erase the disk, start the unattended install.
  phase("booting macOS Recovery (downloads the recovery image on first run)");
  await b.boot({ picker: false });
  await waitForRecovery(name, b, 45 * 60);
  await startBridge(name, b);
  phase("erasing disk and starting the macOS installer (license accepted via --agreetolicense)");
  const out = await b.bridgeRun(
    [
      // First physical disk larger than 20 GB (skips dockur's recovery image and the EFI disk).
      `disk=$(diskutil list physical | awk '/^\\/dev\\/disk/ {d=$1} /\\*[0-9.]+ [GT]B/ {match($0, /\\*[0-9.]+/); sz=substr($0, RSTART+1, RLENGTH-1)+0; if ($0 ~ / TB/) sz*=1000; if (sz > 20) {print d; exit}}')`,
      `[ -n "$disk" ] || { echo "no target disk found"; diskutil list physical; exit 3; }`,
      `diskutil eraseDisk APFS "Macintosh HD" GPT "$disk"`,
      `app=$(ls -d /Install\\ macOS*.app | head -n 1)`,
      `(nohup "$app/Contents/Resources/startosinstall" --agreetolicense --volume "/Volumes/Macintosh HD" --nointeraction > /tmp/startosinstall.log 2>&1 &)`,
      `sleep 20; tail -c 400 /tmp/startosinstall.log`,
    ].join("\n"),
    300,
  );
  log(out.trim());
  if (/error|failed|could not/i.test(out) && !/Preparing/.test(out)) throw new Error(`installer failed to start: ${out}`);

  phase("preparing installation (startosinstall)");
  const boots0 = await b.bootCount();
  const prepDeadline = Date.now() + 60 * 60_000;
  while ((await b.bootCount()) === boots0) {
    if (Date.now() > prepDeadline) throw new Error("installer did not reboot within 60 min");
    const tail = await b.bridgeRun("tail -c 200 /tmp/startosinstall.log", 20).catch(() => "");
    const pct = /Preparing:\s*([\d.]+)%/.exec(tail.split("\r").pop() ?? "")?.[1];
    if (pct) writeState(name, { phase: `preparing installation (${pct}%)` });
    if (/error|failed/i.test(tail)) throw new Error(`startosinstall: ${tail}`);
    await sleep(15_000);
  }

  // Phase 2: the installer runs across reboots and ends in Setup Assistant (a bright screen).
  phase("installing macOS (about 15-40 min)");
  const instDeadline = Date.now() + 2 * 3600_000;
  // The installer occasionally hangs near the end (vCPUs spinning, no disk I/O). A power cycle
  // resumes it; OpenCore may then wait at its boot menu, which Enter accepts (Macintosh HD).
  let lastIo = await b.ioBytes();
  let lastIoChange = Date.now();
  let restarts = 0;
  for (;;) {
    if (Date.now() > instDeadline) throw new Error("installation did not finish within 2 h; see `osmatrix screenshot " + name + "`");
    const br = await screenBrightness(name).catch(() => 0);
    if (br > 150) break;
    const io = await b.ioBytes();
    if (io !== lastIo) {
      lastIo = io;
      lastIoChange = Date.now();
    } else if (Date.now() - lastIoChange > 10 * 60_000) {
      if (++restarts > 3) throw new Error("installer stalled repeatedly (no disk activity); see `osmatrix screenshot " + name + "`");
      phase(`installer stalled (no disk activity for 10 min); power-cycling the VM (attempt ${restarts}/3)`);
      await b.powerCycle();
      for (let i = 0; i < 8; i++) {
        await sleep(25_000);
        await input(name, [{ keys: ["enter"] }]).catch(() => undefined);
      }
      phase("installing macOS (resumed after power cycle)");
      lastIo = await b.ioBytes();
      lastIoChange = Date.now();
    }
    await sleep(30_000);
  }

  // Phase 3: back to Recovery to configure the new system before its first login.
  phase("rebooting into Recovery to configure the installed system");
  await b.boot({ picker: true });
  await waitForPicker(b);
  await input(name, [{ keys: ["1"] }]); // "macOS Base System" (dockur's recovery image) is the first entry
  await waitForRecovery(name, b, 15 * 60);
  await startBridge(name, b);
  phase("creating user, enabling ssh, passwordless sudo, auto-login");
  const creds = b.credentials();
  const { publicKey } = await ensureKey();
  await b.bridgeFile("configure.sh", path.join(assetsDir, "macos", "configure.sh"));
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const conf = await b.bridgeRun(
    `curl -sf "${b.bridgeUrl()}/file/configure.sh" -o /tmp/configure.sh && ` +
      `DV_USER=${q(creds.username)} DV_PASS=${q(creds.password)} DV_KEY=${q(publicKey)} DV_NAME=${q(creds.username)} DV_HOST=${q(`osmatrix-${name}`)} sh /tmp/configure.sh`,
    300,
  );
  log(conf.trim());
  if (!conf.includes("[configure] done")) throw new Error(`configure failed:\n${conf}`);
  await b.bridgeRun("sync; (sleep 2; shutdown -h now) >/dev/null 2>&1 &", 30).catch(() => "");
  await sleep(15_000);

  // Phase 4: first boot of the configured system.
  phase("booting the installed system");
  await b.boot({ picker: false });
  // First boot of a freshly installed system: an earlier install's boot history does not apply.
  const s = await waitReady(g, 30 * 60, { detectHang: false });
  if (s.state !== "ready") throw new Error(`ssh did not come up after configuration: ${s.state}`);
  await provisionMac(g);
}

async function provisionMac(g: Guest) {
  const ep = await readyEndpoint(g.cfg.name);
  const script = fs.readFileSync(path.join(assetsDir, "provision", "macos.sh"), "utf8");
  const { command, note } = await macProvisionPlan(ep, g.cfg, "-s");
  // Which Homebrew the guest gets, or why it keeps its own (failed lookup): stderr, which is setup.log when detached.
  if (note) process.stderr.write(`[setup ${g.cfg.name}] ${note}\n`);
  const r = await sshExec(ep, command, { input: script, timeoutMs: 2 * 3600_000, maxBytes: 64 * 1024 });
  if (r.code !== 0) throw new Error(`provisioning failed (exit ${r.code}):\n${(r.stdout + r.stderr).slice(-3000)}`);
}

/** Wait for the Recovery app: dark grey screen, stable for two samples, after the firmware handed off to macOS. */
async function waitForRecovery(name: string, b: MacInstallVm, timeoutSec: number) {
  const deadline = Date.now() + timeoutSec * 1000;
  let prev = -1;
  while (Date.now() < deadline) {
    if (/HANDOFF TO XNU/.test(await b.console())) {
      const br = await screenBrightness(name).catch(() => -1);
      if (br > 10 && br < 80 && prev > 10 && Math.abs(br - prev) < 2) {
        await sleep(5000);
        return;
      }
      prev = br;
    }
    await sleep(10_000);
  }
  throw new Error(`macOS Recovery did not appear within ${timeoutSec}s; check \`osmatrix screenshot ${name}\``);
}

async function waitForPicker(b: MacInstallVm) {
  for (let i = 0; i < 60; i++) {
    if ((await b.bootCount()) > 0) {
      await sleep(8000);
      return;
    }
    await sleep(3000);
  }
  throw new Error("OpenCore boot menu did not appear");
}

/** Start the bridge's server side and the polling loop inside the guest's Terminal. */
async function startBridge(name: string, b: MacInstallVm) {
  await b.bridgeStart();
  const loop =
    `G=${b.bridgeUrl()}; ` +
    `while :; do c=$(curl -sf $G/next); if [ -n "$c" ]; then (sh -c "$c") >/tmp/o 2>&1; echo "[rc=$?]" >>/tmp/o; ` +
    `curl -s --data-binary @/tmp/o $G/result; else sleep 1; fi; done`;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Recovery: Utilities > Terminal is shift+cmd+T. A click first focuses the Recovery window.
    await input(name, [{ click: { x: 960, y: 900 } }, { keys: ["shift+cmd+t"] }]);
    await sleep(5000);
    await input(name, [{ text: loop }, { keys: ["enter"] }]);
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      if (await b.bridgeAlive()) return;
    }
  }
  throw new Error("could not start the command bridge in Recovery (Terminal did not open?)");
}
