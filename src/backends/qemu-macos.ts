import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostBridge } from "../core/bridge.ts";
import { guestShell, loadConfig, type GuestConfig } from "../core/config.ts";
import { assetsDir, ensureDir, paths } from "../core/paths.ts";
import { isAlive, run, sleep, spawnDetached } from "../core/proc.ts";
import { ensureKey, freePort, sshExec, sshProbe, type Endpoint } from "../core/ssh.ts";
import { dockerBin } from "./docker.ts";
import { cloneFile, defaultAccel, dockerOk, freeVncPort, monitorCommand, monitorQuery, qemuBinary, stopProcess, writePrepScript, type Accel } from "./qemu.ts";
import type { Backend, GuestStatus, MacInstallVm, Support } from "./types.ts";

export interface MacQemuArgsInput {
  accel: Accel;
  platform: NodeJS.Platform;
  /** Host CPU vendor: KVM on an AMD host needs an Intel CPU model, as dockur picks. */
  amdHost: boolean;
  cpus: number;
  memory: string;
  /** dockur's prepared files for this macOS version (base.dmg, boot*.img, data.img, macos.*). */
  storage: string;
  /** Boot OpenCore with its boot menu shown (to choose Recovery after installing). */
  picker: boolean;
  uuid: string;
  mac: string;
  /** Apple SMC key, as dockur's boot.sh derives it. */
  osk: string;
  sshPort: number;
  vncDisplay: number;
  monitor: string | number;
  serialLog: string;
  pidFile: string;
}

/** Intel CPU features macOS expects (dockur's DEFAULT_FLAGS), without nested VMX or 1G pages. */
const MAC_CPU_FLAGS = "vendor=GenuineIntel,vmx=off,vmware-cpuid-freq=on,-pdpe1gb";

/**
 * The CPU for a macOS guest: the host's own on an Intel host under a hypervisor, else (AMD host, or
 * emulation) the Skylake profile dockur uses for macOS 14 and later.
 */
export function macCpu(accel: Accel, amdHost: boolean): string {
  if (accel !== "tcg" && !amdHost) return `host,${MAC_CPU_FLAGS}`;
  // Features an AMD host or TCG can't provide are turned off rather than left to QEMU's warnings.
  const fixed = accel === "tcg" ? ",-pcid,-invpcid,-tsc-deadline,-xsavec,-xsaves,-spec-ctrl" : ",+invtsc,-spec-ctrl,-pcid,-tsc-deadline";
  return `Skylake-Client-v4,${MAC_CPU_FLAGS}${fixed},+ssse3,+sse4.2,+popcnt,+avx,+avx2,+aes,+fma,+bmi1,+bmi2,+smep,+xsave,+xsaveopt,+xgetbv1,+movbe,+rdrand`;
}

/**
 * QEMU arguments for an Intel macOS guest, following what dockur/macos runs inside its container (q35,
 * OpenCore on a virtio disk, the recovery image as a dmg, VMware SVGA) with host-side user networking.
 */
export function macQemuArgs(o: MacQemuArgsInput): string[] {
  const diskCache = o.platform === "linux" ? "cache=none,aio=native" : "cache=writeback";
  const monitor = typeof o.monitor === "number" ? `tcp:127.0.0.1:${o.monitor}` : `unix:${o.monitor}`;
  const f = (n: string) => path.join(o.storage, n);
  return [
    "-nodefaults",
    "-machine", "type=q35,smm=off,vmport=off,dump-guest-core=off,hpet=off",
    "-accel", o.accel === "tcg" ? "tcg,thread=multi" : o.accel,
    "-cpu", macCpu(o.accel, o.amdHost),
    ...(o.accel === "kvm" ? ["-global", "kvm-pit.lost_tick_policy=discard"] : []),
    "-smp", `${o.cpus},sockets=1,cores=${o.cpus},threads=1`,
    "-m", o.memory.replace(/i?B$/i, ""),
    "-name", "macOS,process=osmatrix-macos",
    "-uuid", o.uuid,
    "-pidfile", o.pidFile,
    "-display", `vnc=127.0.0.1:${o.vncDisplay}`,
    "-vga", "vmware",
    "-monitor", `${monitor},server=on,wait=off`,
    "-serial", `file:${o.serialLog}`,
    "-device", "nec-usb-xhci,id=xhci",
    "-global", "nec-usb-xhci.msi=off",
    "-device", "usb-kbd,bus=xhci.0",
    "-device", "usb-tablet",
    "-netdev", `user,id=hostnet0,hostfwd=tcp:127.0.0.1:${o.sshPort}-:22`,
    "-device", `virtio-net-pci,id=net0,netdev=hostnet0,romfile=,mac=${o.mac}`,
    "-drive", `file=${f("base.dmg")},id=InstallMedia,format=dmg,cache=unsafe,readonly=on,if=none`,
    "-device", "virtio-blk-pci,drive=InstallMedia,bus=pcie.0,addr=0x6",
    "-object", "iothread,id=io2",
    "-drive", `file=${f("data.img")},id=data3,format=raw,${diskCache},discard=unmap,detect-zeroes=on,if=none`,
    "-device", "virtio-blk-pci,drive=data3,bus=pcie.0,addr=0xa,iothread=io2,bootindex=3",
    "-drive", `file=${f(o.picker ? "boot-picker.img" : "boot.img")},id=OpenCore,format=raw,cache=unsafe,readonly=on,if=none`,
    "-device", "virtio-blk-pci,drive=OpenCore,bus=pcie.0,addr=0x5,bootindex=9",
    "-rtc", "base=utc",
    "-smbios", "type=2",
    "-global", "ICH9-LPC.disable_s3=1",
    "-global", "ICH9-LPC.disable_s4=1",
    "-global", "ICH9-LPC.acpi-pci-hotplug-with-bridge-support=off",
    "-device", `isa-applesmc,osk=${o.osk}`,
    "-drive", `if=pflash,format=raw,readonly=on,file=${f("macos.rom")}`,
    "-drive", `if=pflash,format=raw,file=${f("macos.vars")}`,
    "-object", "rng-builtin,id=objrng0",
    "-device", "virtio-rng-pci,rng=objrng0,id=rng0,bus=pcie.0",
    "-fw_cfg", "name=opt/org.tianocore/UninstallMemAttrProtocol,string=y",
  ];
}

interface Runtime {
  ssh: number;
  vnc: number;
  monitor?: number;
}

const PREPARED = ["base.dmg", "boot.img", "boot-picker.img", "data.img", "macos.rom", "macos.vars", "macos.id", "macos.mac", "osmatrix.osk"];

/**
 * Intel macOS guests run by the host's own QEMU: Hypervisor.framework on Intel Macs (the Apple hardware
 * Apple's licence allows), KVM on Linux. dockur's macOS image prepares the recovery image, OpenCore and
 * firmware once in a container; setup then installs macOS through Recovery like the dockur backend,
 * with the command bridge on the host instead of in a container.
 */
export class QemuMacBackend implements Backend, MacInstallVm {
  readonly cfg: GuestConfig;
  private bridge?: HostBridge;
  constructor(cfg: GuestConfig) {
    this.cfg = cfg;
  }

  private get dir() {
    return ensureDir(paths.guestDir(this.cfg.name));
  }
  /** Mounted as dockur's /storage; dockur keeps each macOS version in its own folder. */
  private get storageRoot() {
    return path.join(this.dir, "disk");
  }
  private get version() {
    return this.cfg.version ?? "15";
  }
  /**
   * Where prep.sh's files land: dockur's macOS install.sh moves STORAGE to /storage/<version, lowercased>
   * before anything is written (prep.sh's $STORAGE is that folder too).
   */
  private get storage() {
    return path.join(this.storageRoot, this.version.toLowerCase());
  }
  private get golden() {
    return path.join(this.dir, "golden");
  }
  private get pidFile() {
    return path.join(this.dir, "qemu.pid");
  }
  private get monitorSocket() {
    return path.join(this.dir, "monitor.sock");
  }
  private get serialLog() {
    return path.join(this.dir, "serial.log");
  }
  private get runtimeFile() {
    return path.join(this.dir, "qemu.json");
  }
  private get readyFile() {
    return path.join(this.dir, ".ready-once");
  }
  private get image() {
    return this.cfg.image ?? "dockurr/macos";
  }
  private get accel(): Accel {
    return (this.cfg.accel as Accel | undefined) ?? defaultAccel("x86_64");
  }

  credentials(): { username: string; password: string } {
    const f = path.join(this.dir, "credentials.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    const c = { username: this.cfg.user ?? "osmatrix", password: crypto.randomBytes(9).toString("base64url") };
    fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
    return c;
  }

  everReady(): boolean {
    return fs.existsSync(this.readyFile);
  }

  private prepared(): boolean {
    return PREPARED.every((f) => fs.existsSync(path.join(this.storage, f)));
  }

  private pid(): number | undefined {
    try {
      const pid = Number(fs.readFileSync(this.pidFile, "utf8").trim());
      return pid && isAlive(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private runtime(): Runtime | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.runtimeFile, "utf8"));
    } catch {
      return undefined;
    }
  }

  private get monitor(): string | number {
    return this.runtime()?.monitor ?? this.monitorSocket;
  }

  async supported(): Promise<Support> {
    if (this.cfg.os !== "macos") return { ok: false, reason: "this backend runs macOS guests only" };
    if (!loadConfig().macos_eula_acknowledged) {
      return {
        ok: false,
        reason:
          "installing macOS accepts Apple's macOS Software License Agreement, which only permits macOS on Apple hardware. With the user's consent run `osmatrix setup macos --accept-license` (MCP: env_setup with accept_license).",
      };
    }
    if (!qemuBinary("qemu-system-x86_64")) {
      return { ok: false, reason: `qemu-system-x86_64 not found (${process.platform === "darwin" ? "brew install qemu" : "install your distribution's QEMU x86_64 package"})` };
    }
    if (!this.prepared() && !dockerOk()) return { ok: false, reason: "Docker is needed once, to prepare the macOS recovery image and OpenCore with dockur" };
    return { ok: true };
  }

  async status(): Promise<GuestStatus> {
    const base: GuestStatus = {
      name: this.cfg.name,
      os: this.cfg.os,
      backend: "qemu",
      state: "absent",
      hasSnapshot: fs.existsSync(path.join(this.golden, "data.img")),
    };
    if (!this.prepared()) return base;
    const rt = this.runtime();
    if (!this.pid() || !rt) return { ...base, state: "stopped" };
    const urls = { vnc: `vnc://127.0.0.1:${rt.vnc}` };
    const ports = { ssh: rt.ssh, vnc: rt.vnc };
    const p = await sshProbe(await this.endpoint());
    if (p === "ok") {
      if (!this.everReady()) fs.writeFileSync(this.readyFile, new Date().toISOString());
      return { ...base, state: "ready", urls, ports };
    }
    if (p === "auth") {
      return { ...base, state: "needs-ssh-setup", urls, ports, detail: `sshd is up but the osmatrix key is not authorized. Run: osmatrix setup-ssh ${this.cfg.name} --user <guest user>` };
    }
    const detail = this.everReady()
      ? `booting (accelerator: ${this.accel}; watch in a browser with env_viewer, or with env_screenshot)`
      : `not set up yet, or setup in progress. Fully automatic: \`osmatrix setup ${this.cfg.name}\` (MCP: env_setup).`;
    return { ...base, state: "booting", urls, ports, detail };
  }

  /** Download the recovery image and build OpenCore and the firmware with dockur's scripts, in a throwaway container. */
  private async prepare(): Promise<void> {
    ensureDir(this.storageRoot);
    const prep = writePrepScript(this.dir);
    const r = await run(
      dockerBin(),
      [
        "run", "--rm",
        "--name", `osmatrix-${this.cfg.name}-prep-${process.pid}`,
        "-e", `VERSION=${this.version}`,
        "-e", `DISK_SIZE=${this.cfg.disk ?? "64G"}`,
        // No VM runs in this container; this only skips dockur's /dev/kvm check.
        "-e", "KVM=N",
        ...(process.getuid && process.getgid ? ["-e", `HOST_UID=${process.getuid()}`, "-e", `HOST_GID=${process.getgid()}`] : []),
        "-v", `${this.storageRoot}:/storage:z`,
        "-v", `${prep}:/osmatrix-prep.sh:ro,z`,
        "--entrypoint", "bash",
        this.image,
        "/osmatrix-prep.sh",
      ],
      { timeoutMs: 60 * 60_000 },
    );
    fs.writeFileSync(path.join(this.dir, "prep.log"), r.stdout + r.stderr);
    if (r.code !== 0 || !this.prepared()) {
      throw new Error(`preparing the macOS recovery image failed (exit ${r.code}); see ${path.join(this.dir, "prep.log")}: ${(r.stderr || r.stdout).trim().slice(-800)}`);
    }
  }

  private read(f: string): string {
    return fs.readFileSync(path.join(this.storage, f), "utf8").trim();
  }

  async up(opts: { picker?: boolean } = {}): Promise<void> {
    if (this.pid()) return;
    const s = await this.supported();
    if (!s.ok) throw new Error(`${this.cfg.name}: ${s.reason}`);
    const qemu = qemuBinary("qemu-system-x86_64")!;
    if (!this.prepared()) await this.prepare();
    const ssh = await freePort(this.cfg.ssh_port ?? 2223);
    const vnc = await freeVncPort(this.cfg.vnc_port ?? 5902);
    const monitorPort = process.platform === "win32" ? await freePort(ssh + 1) : undefined;
    fs.rmSync(this.monitorSocket, { force: true });
    fs.rmSync(this.serialLog, { force: true });
    const args = macQemuArgs({
      accel: this.accel,
      platform: process.platform,
      amdHost: /AMD/i.test(os.cpus()[0]?.model ?? ""),
      cpus: this.cfg.cpus ?? 4,
      memory: this.cfg.memory ?? "8G",
      storage: this.storage,
      picker: !!opts.picker,
      uuid: this.read("macos.id"),
      mac: this.read("macos.mac"),
      osk: this.read("osmatrix.osk"),
      sshPort: ssh,
      vncDisplay: vnc - 5900,
      monitor: monitorPort ?? this.monitorSocket,
      serialLog: this.serialLog,
      pidFile: this.pidFile,
    });
    fs.writeFileSync(this.runtimeFile, JSON.stringify({ ssh, vnc, ...(monitorPort ? { monitor: monitorPort } : {}) } satisfies Runtime));
    const log = path.join(this.dir, "qemu.log");
    // The command line holds the SMC key; keep it out of the log.
    fs.writeFileSync(log, `${qemu} ${args.join(" ").replace(/osk=\S+/, "osk=<redacted>")}\n`);
    const child = spawnDetached(qemu, args, { logFile: log });
    for (let i = 0; i < 40 && !this.pid(); i++) {
      if (!isAlive(child)) throw new Error(`qemu exited at start: ${fs.readFileSync(log, "utf8").trim().split("\n").slice(-5).join(" | ")}`);
      await sleep(250);
    }
  }

  /**
   * Shut macOS down cleanly and wait for QEMU to exit; stop it hard after the grace period. macOS only
   * answers the ACPI power button with a dialog, so a reachable guest is shut down over ssh (setup gives
   * the user passwordless sudo). An unclean stop can leave OpenCore waiting at its boot menu next time.
   */
  async down(): Promise<void> {
    const pid = this.pid();
    if (!pid) return;
    const ep = await this.endpoint();
    if ((await sshProbe(ep)) === "ok") await sshExec(ep, "sudo -n shutdown -h now", { timeoutMs: 30_000 }).catch(() => undefined);
    else await monitorCommand(this.monitor, "system_powerdown").catch(() => undefined);
    const deadline = Date.now() + 120_000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(1000);
    await stopProcess(pid);
    fs.rmSync(this.runtimeFile, { force: true });
  }

  /** Stop QEMU at once, like pulling the plug (setup only does this when the guest is idle or off). */
  private async stopHard(): Promise<void> {
    const pid = this.pid();
    if (!pid) return;
    await monitorCommand(this.monitor, "quit").catch(() => undefined);
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(500);
    await stopProcess(pid);
    fs.rmSync(this.runtimeFile, { force: true });
  }

  async snapshot(): Promise<void> {
    if (!this.prepared()) throw new Error(`${this.cfg.name} has no disk yet; run setup first`);
    const wasRunning = !!this.pid();
    await this.down();
    ensureDir(this.golden);
    for (const f of ["data.img", "macos.vars"]) await cloneFile(path.join(this.storage, f), path.join(this.golden, f));
    if (wasRunning) await this.up();
  }

  async reset(): Promise<void> {
    await this.down();
    if (fs.existsSync(path.join(this.golden, "data.img"))) {
      for (const f of ["data.img", "macos.vars"]) await cloneFile(path.join(this.golden, f), path.join(this.storage, f));
    } else {
      // Without a golden snapshot the guest starts over: a fresh disk and firmware from the next prepare.
      fs.rmSync(this.storageRoot, { recursive: true, force: true });
      fs.rmSync(this.readyFile, { force: true });
    }
    await this.up();
  }

  async destroy(): Promise<void> {
    await this.down();
    this.bridge?.stop();
    for (const p of [this.storageRoot, this.golden, this.readyFile]) fs.rmSync(p, { recursive: true, force: true });
  }

  async endpoint(): Promise<Endpoint> {
    const { privateKey } = await ensureKey();
    return {
      host: "127.0.0.1",
      port: this.runtime()?.ssh ?? this.cfg.ssh_port ?? 2223,
      user: this.cfg.user ?? this.credentials().username,
      identity: privateKey,
      os: this.cfg.os,
      shell: guestShell(this.cfg),
      checkHostKey: false,
    };
  }

  async vnc() {
    const rt = this.runtime();
    if (!rt || !this.pid()) throw new Error(`${this.cfg.name} is not running`);
    return { host: "127.0.0.1", port: rt.vnc };
  }

  async bootProbe(): Promise<{ io: number; boots: number } | undefined> {
    if (!this.everReady()) return undefined;
    const [io, boots] = await Promise.all([this.ioBytes(), this.bootCount()]);
    return { io, boots };
  }

  // ----- MacInstallVm: what setup's unattended install drives -----

  async boot(opts: { picker: boolean }): Promise<void> {
    await this.stopHard();
    await this.up(opts);
  }

  async console(): Promise<string> {
    try {
      const fd = fs.openSync(this.serialLog, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 16 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString("latin1");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  async bootCount(): Promise<number> {
    const log = fs.existsSync(this.serialLog) ? fs.readFileSync(this.serialLog, "latin1") : "";
    return (log.match(/OC: Loaded configuration/g) ?? []).length;
  }

  async ioBytes(): Promise<number> {
    const out = await monitorQuery(this.monitor, "info blockstats");
    return [...out.matchAll(/(?:rd|wr)_bytes=(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  }

  async powerCycle(): Promise<void> {
    await monitorCommand(this.monitor, "system_reset");
  }

  async bridgeStart(): Promise<void> {
    this.bridge ??= new HostBridge();
    await this.bridge.start();
  }

  bridgeUrl(): string {
    if (!this.bridge) throw new Error("bridge not started");
    // QEMU user networking: the guest's default gateway (10.0.2.2) is the host's loopback.
    return this.bridge.url("$(route -n get default | awk '/gateway/{print $2}')");
  }

  async bridgeAlive(): Promise<boolean> {
    return !!this.bridge?.alive();
  }

  async bridgeRun(cmd: string, timeoutSec: number): Promise<string> {
    if (!this.bridge) throw new Error("bridge not started");
    return this.bridge.run(cmd, timeoutSec);
  }

  async bridgeFile(name: string, localPath: string): Promise<void> {
    if (!this.bridge) throw new Error("bridge not started");
    this.bridge.serveFile(name, localPath);
  }
}
