import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { guestShell, windowsArch, windowsImage, windowsOemOptions, type GuestArch, type GuestConfig } from "../core/config.ts";
import { assetsDir, ensureDir, paths } from "../core/paths.ts";
import { isAlive, run, sleep, spawnDetached, which } from "../core/proc.ts";
import { canBind, ensureKey, freePort, sshProbe, type Endpoint } from "../core/ssh.ts";
import { dockerBin } from "./docker.ts";
import type { Backend, GuestStatus, Support } from "./types.ts";

export type Accel = "hvf" | "kvm" | "whpx" | "tcg";
export type { GuestArch };

/**
 * The accelerator the host's native QEMU can use for a guest of this architecture: the host's
 * hypervisor (Hypervisor.framework, KVM or the Windows Hypervisor Platform) when guest and host CPU
 * match, software emulation otherwise.
 */
export function defaultAccel(guest: GuestArch, platform = process.platform, arch = process.arch, hasKvm = fs.existsSync("/dev/kvm")): Accel {
  if ((guest === "aarch64" ? "arm64" : "x64") !== arch) return "tcg";
  if (platform === "darwin") return "hvf";
  if (platform === "win32") return "whpx";
  if (platform === "linux" && hasKvm) return "kvm";
  return "tcg";
}

export interface QemuArgsInput {
  arch: GuestArch;
  accel: Accel;
  platform: NodeJS.Platform;
  cpus: number;
  memory: string;
  /** Directory holding dockur's prepared files (data.img, windows.rom, windows.vars, setup.img, *.iso). */
  storage: string;
  /** Attach the install ISO and setup.img (first setup only). */
  installMedia?: { iso: string; setup: string };
  sshPort: number;
  /** VNC display number (port 5900 + display), bound to 127.0.0.1. */
  vncDisplay: number;
  /** QEMU's human monitor: a unix socket path, or a loopback TCP port (Windows hosts). */
  monitor: string | number;
  /** Firmware/serial console output (the install boot watches it for the "Press any key" prompt). */
  serialLog: string;
  pidFile: string;
  mac: string;
}

/**
 * QEMU arguments for a Windows guest, following what dockur runs inside its container (dockurr/windows
 * on a q35 machine, dockurr/windows-arm on virt), but with host-side user networking (ssh forwarded to
 * 127.0.0.1) and the host's accelerator.
 */
export function qemuArgs(o: QemuArgsInput): string[] {
  const x86 = o.arch === "x86_64";
  // O_DIRECT (cache=none) and Linux native AIO don't exist on macOS or Windows.
  const diskCache = o.platform === "linux" ? "cache=none,aio=native" : "cache=writeback";
  const monitor = typeof o.monitor === "number" ? `tcp:127.0.0.1:${o.monitor}` : `unix:${o.monitor}`;
  const args = [
    "-nodefaults",
    "-machine", x86 ? "type=q35,smm=off,vmport=off,dump-guest-core=off,hpet=off" : `type=virt,secure=off,gic-version=${o.accel === "whpx" ? "3" : "max"},msi=gicv2m,dump-guest-core=off`,
    "-accel", o.accel === "tcg" ? "tcg,thread=multi" : o.accel,
    "-cpu", cpuModel(o.arch, o.accel),
    ...(o.accel === "kvm" && x86 ? ["-global", "kvm-pit.lost_tick_policy=discard"] : []),
    "-smp", `${o.cpus},sockets=1,cores=${o.cpus},threads=1`,
    "-m", o.memory.replace(/i?B$/i, ""),
    "-name", "Windows,process=osmatrix-windows",
    "-pidfile", o.pidFile,
    "-display", `vnc=127.0.0.1:${o.vncDisplay}`,
    "-device", x86 ? "virtio-vga" : "ramfb",
    "-monitor", `${monitor},server=on,wait=off`,
    "-serial", `file:${o.serialLog}`,
    "-device", "qemu-xhci,id=xhci,p2=7,p3=7",
    // q35 has a PS/2 keyboard; virt has none.
    ...(x86 ? [] : ["-device", "usb-kbd"]),
    "-device", "usb-tablet",
    "-netdev", `user,id=hostnet0,hostfwd=tcp:127.0.0.1:${o.sshPort}-:22`,
    "-device", `virtio-net-pci,id=net0,netdev=hostnet0,romfile=,mac=${o.mac}`,
    "-object", "iothread,id=io2",
    "-drive", `file=${path.join(o.storage, "data.img")},id=data3,format=raw,${diskCache},discard=unmap,detect-zeroes=on,if=none`,
    "-device", "virtio-scsi-pci,id=data3,bus=pcie.0,addr=0xa,iothread=io2,hotplug=off",
    "-device", "scsi-hd,drive=data3,bus=data3.0,channel=0,scsi-id=0,lun=0,rotation_rate=1,bootindex=3",
  ];
  if (o.installMedia) {
    args.push("-drive", `file=${o.installMedia.iso},id=boot,format=raw,cache=unsafe,readonly=on,media=cdrom,if=none`);
    // A SATA CD drive on q35, as dockur attaches it; virt has no SATA.
    if (x86) args.push("-device", "ich9-ahci,id=ahciboot,addr=0x5", "-device", "ide-cd,drive=boot,bus=ahciboot.0,bootindex=9");
    else args.push("-device", "usb-storage,drive=boot,bootindex=9,removable=on");
    args.push(
      "-drive", `file=${o.installMedia.setup},id=setup,format=raw,cache=unsafe,media=disk,if=none`,
      "-device", "usb-storage,drive=setup,removable=on",
    );
  }
  args.push("-rtc", "base=localtime");
  // As in dockur/windows: no sleep states (they don't resume reliably in a VM) and a hardware RNG.
  if (x86) args.push("-global", "ICH9-LPC.disable_s3=1", "-global", "ICH9-LPC.disable_s4=1");
  args.push(
    "-drive", `file=${path.join(o.storage, "windows.rom")},if=pflash,unit=0,format=raw,readonly=on`,
    "-drive", `file=${path.join(o.storage, "windows.vars")},if=pflash,unit=1,format=raw`,
  );
  if (x86) args.push("-object", "rng-builtin,id=objrng0", "-device", "virtio-rng-pci,rng=objrng0,id=rng0,bus=pcie.0");
  args.push("-fw_cfg", "name=opt/org.tianocore/UninstallMemAttrProtocol,string=y");
  return args;
}

/** The host CPU under a hypervisor (with Hyper-V enlightenments on KVM, as dockur does); a recent model under emulation. */
function cpuModel(arch: GuestArch, accel: Accel): string {
  if (accel === "tcg") return arch === "x86_64" ? "max" : "cortex-a76";
  if (accel === "kvm" && arch === "x86_64") return "host,kvm=on,l3-cache=on,+hypervisor,migratable=no,-vmx,+invtsc,hv_passthrough";
  return "host";
}

interface Runtime {
  ssh: number;
  vnc: number;
  /** Monitor port on Windows hosts, which use TCP instead of a unix socket. */
  monitor?: number;
}

/**
 * Windows guests run by the host's own QEMU: Windows on ARM with Hypervisor.framework on Apple Silicon
 * Macs, KVM on arm64 Linux or the Windows Hypervisor Platform on Windows on ARM; x64 Windows with
 * Hypervisor.framework on Intel Macs; software emulation elsewhere. Install media are prepared once by
 * running dockur's scripts in a container (dockurr/windows or dockurr/windows-arm), so the unattended
 * install matches the dockur backend.
 */
export class QemuBackend implements Backend {
  readonly cfg: GuestConfig;
  constructor(cfg: GuestConfig) {
    this.cfg = cfg;
  }

  private get dir() {
    return ensureDir(paths.guestDir(this.cfg.name));
  }
  private get storage() {
    return path.join(this.dir, "disk");
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
  private get installedFile() {
    return path.join(this.dir, ".installed");
  }
  private get image() {
    return windowsImage(this.cfg);
  }
  private get arch(): GuestArch {
    return windowsArch(this.cfg);
  }
  private get accel(): Accel {
    return (this.cfg.accel as Accel | undefined) ?? defaultAccel(this.arch);
  }
  private get qemuName() {
    return `qemu-system-${this.arch}`;
  }

  private qemuBin(): string | undefined {
    return qemuBinary(this.qemuName);
  }

  credentials(): { username: string; password: string } {
    const f = path.join(this.dir, "credentials.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    const c = { username: this.cfg.user ?? "osmatrix", password: crypto.randomBytes(9).toString("base64url") };
    fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
    return c;
  }

  private prepared(): boolean {
    return ["data.img", "windows.rom", "windows.vars"].every((f) => fs.existsSync(path.join(this.storage, f)));
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

  async supported(): Promise<Support> {
    if (this.cfg.os !== "windows") return { ok: false, reason: "the qemu backend runs Windows guests only" };
    if (!this.qemuBin()) {
      const install =
        process.platform === "darwin" ? "brew install qemu" : process.platform === "win32" ? "install QEMU 11 or later from https://qemu.weilnetz.de" : `install your distribution's QEMU ${this.arch} package`;
      return { ok: false, reason: `${this.qemuName} not found (${install})` };
    }
    if (!this.prepared() && !dockerOk()) return { ok: false, reason: "Docker is needed once, to prepare the Windows install media with dockur" };
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
      if (!fs.existsSync(this.installedFile)) fs.writeFileSync(this.installedFile, new Date().toISOString());
      return { ...base, state: "ready", urls, ports };
    }
    const detail = fs.existsSync(this.installedFile)
      ? `booting (accelerator: ${this.accel})`
      : `installing and provisioning Windows (accelerator: ${this.accel}${this.accel === "tcg" ? ", software emulation: expect hours" : ", ~20-60 min"}). Watch in a browser with env_viewer, or with env_screenshot`;
    return { ...base, state: p === "auth" ? "needs-ssh-setup" : "booting", urls, ports, detail };
  }

  /** Download Windows and build the install media with dockur's scripts, in a throwaway container. */
  private async prepare(): Promise<void> {
    ensureDir(this.storage);
    const oem = ensureDir(path.join(this.dir, "oem"));
    for (const f of fs.readdirSync(path.join(assetsDir, "oem", "windows"))) fs.copyFileSync(path.join(assetsDir, "oem", "windows", f), path.join(oem, f));
    const { publicKey } = await ensureKey();
    fs.writeFileSync(path.join(oem, "authorized_keys"), publicKey + "\r\n");
    fs.writeFileSync(path.join(oem, "options.json"), JSON.stringify(windowsOemOptions(this.cfg)));
    const prep = writePrepScript(this.dir);
    const c = this.credentials();
    const r = await run(
      dockerBin(),
      [
        "run", "--rm",
        "--name", `osmatrix-${this.cfg.name}-prep-${process.pid}`,
        "-e", `VERSION=${this.cfg.version ?? "11"}`,
        "-e", `USERNAME=${c.username}`,
        "-e", `PASSWORD=${c.password}`,
        "-e", `DISK_SIZE=${this.cfg.disk ?? "64G"}`,
        // No VM runs in this container; this only skips dockur's /dev/kvm check.
        "-e", "KVM=N",
        ...(process.getuid && process.getgid ? ["-e", `HOST_UID=${process.getuid()}`, "-e", `HOST_GID=${process.getgid()}`] : []),
        // :z relabels for SELinux hosts; ignored elsewhere.
        "-v", `${this.storage}:/storage:z`,
        "-v", `${oem}:/oem:ro,z`,
        "-v", `${prep}:/osmatrix-prep.sh:ro,z`,
        "--entrypoint", "bash",
        this.image,
        "/osmatrix-prep.sh",
      ],
      { timeoutMs: 2 * 60 * 60_000 },
    );
    fs.writeFileSync(path.join(this.dir, "prep.log"), r.stdout + r.stderr);
    if (r.code !== 0 || !this.prepared()) {
      throw new Error(`preparing the Windows install media failed (exit ${r.code}); see ${path.join(this.dir, "prep.log")}: ${(r.stderr || r.stdout).trim().slice(-800)}`);
    }
  }

  private installMedia(): { iso: string; setup: string } | undefined {
    if (fs.existsSync(this.installedFile)) return undefined;
    const iso = fs.readdirSync(this.storage).find((f) => f.endsWith(".iso"));
    const setup = path.join(this.storage, "setup.img");
    return iso && fs.existsSync(setup) ? { iso: path.join(this.storage, iso), setup } : undefined;
  }

  private mac(): string {
    const f = path.join(this.storage, "windows.mac");
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
    const b = crypto.randomBytes(4).toString("hex").toUpperCase().match(/../g)!;
    const mac = ["02", "05", ...b].join(":");
    fs.writeFileSync(f, mac);
    return mac;
  }

  async up(): Promise<void> {
    if (this.pid()) return;
    const qemu = this.qemuBin();
    if (!qemu) throw new Error((await this.supported()).reason);
    if (!this.prepared()) await this.prepare();
    const ssh = await freePort(this.cfg.ssh_port ?? 2222);
    const vnc = await freeVncPort(this.cfg.vnc_port ?? 5901);
    // QEMU for Windows has no unix-socket monitor; use a loopback TCP port there.
    const monitorPort = process.platform === "win32" ? await freePort(ssh + 1) : undefined;
    fs.rmSync(this.monitorSocket, { force: true });
    fs.rmSync(this.serialLog, { force: true });
    const media = this.installMedia();
    const args = qemuArgs({
      arch: this.arch,
      accel: this.accel,
      platform: process.platform,
      cpus: this.cfg.cpus ?? 4,
      memory: this.cfg.memory ?? "8G",
      storage: this.storage,
      installMedia: media,
      sshPort: ssh,
      vncDisplay: vnc - 5900,
      monitor: monitorPort ?? this.monitorSocket,
      serialLog: this.serialLog,
      pidFile: this.pidFile,
      mac: this.mac(),
    });
    fs.writeFileSync(this.runtimeFile, JSON.stringify({ ssh, vnc, ...(monitorPort ? { monitor: monitorPort } : {}) } satisfies Runtime));
    const log = path.join(this.dir, "qemu.log");
    fs.writeFileSync(log, `${qemu} ${args.join(" ")}\n`);
    const child = spawnDetached(qemu, args, { logFile: log });
    // QEMU writes its pidfile once the machine is set up; fail fast on bad arguments.
    for (let i = 0; i < 40 && !this.pid(); i++) {
      if (!isAlive(child)) throw new Error(`qemu exited at start: ${fs.readFileSync(log, "utf8").trim().split("\n").slice(-5).join(" | ")}`);
      await sleep(250);
    }
    if (media) await this.pressBootKey();
  }

  /** Where QEMU's monitor listens: the TCP port on Windows hosts, else the unix socket. */
  private get monitor(): string | number {
    return this.runtime()?.monitor ?? this.monitorSocket;
  }

  /**
   * The Windows ISO's boot loader waits a few seconds for "Press any key to boot from CD or DVD" and
   * otherwise gives up. The prompt only shows on the display, so like dockur, press Enter a few times
   * as soon as the firmware starts the install media (USB on virt, the SATA DVD on q35), or if the
   * prompt does reach the serial log.
   */
  private async pressBootKey(): Promise<void> {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && this.pid()) {
      const out = fs.existsSync(this.serialLog) ? fs.readFileSync(this.serialLog, "latin1") : "";
      if (out.includes("Press any key to boot from") || /starting Boot\d+ "[^"]*(USB|DVD-ROM)/.test(out)) {
        for (let i = 0; i < 6; i++) {
          await monitorCommand(this.monitor, "sendkey ret 100").catch(() => undefined);
          await sleep(250);
        }
        return;
      }
      await sleep(200);
    }
  }

  /** Ask the guest to shut down through the QEMU monitor; kill it if it hasn't after the grace period. */
  async down(): Promise<void> {
    const pid = this.pid();
    if (!pid) return;
    await monitorCommand(this.monitor, "system_powerdown").catch(() => undefined);
    const deadline = Date.now() + 120_000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(1000);
    await stopProcess(pid);
    fs.rmSync(this.runtimeFile, { force: true });
  }

  async snapshot(): Promise<void> {
    if (!this.prepared()) throw new Error(`${this.cfg.name} has no disk yet; run setup first`);
    const wasRunning = !!this.pid();
    await this.down();
    ensureDir(this.golden);
    for (const f of ["data.img", "windows.vars"]) await cloneFile(path.join(this.storage, f), path.join(this.golden, f));
    if (wasRunning) await this.up();
  }

  async reset(): Promise<void> {
    await this.down();
    if (fs.existsSync(path.join(this.golden, "data.img"))) {
      for (const f of ["data.img", "windows.vars"]) await cloneFile(path.join(this.golden, f), path.join(this.storage, f));
    } else {
      fs.rmSync(this.storage, { recursive: true, force: true });
      fs.rmSync(this.installedFile, { force: true });
    }
    await this.up();
  }

  async destroy(): Promise<void> {
    await this.down();
    for (const p of [this.storage, this.golden, this.installedFile]) fs.rmSync(p, { recursive: true, force: true });
  }

  async endpoint(): Promise<Endpoint> {
    const { privateKey } = await ensureKey();
    return {
      host: "127.0.0.1",
      port: this.runtime()?.ssh ?? this.cfg.ssh_port ?? 2222,
      user: this.cfg.user ?? this.credentials().username,
      identity: privateKey,
      os: this.cfg.os,
      shell: guestShell(this.cfg),
      checkHostKey: false,
    };
  }

  async vnc() {
    const rt = this.runtime();
    if (!rt || !this.pid()) return undefined; // not running
    return { host: "127.0.0.1", port: rt.vnc };
  }
}

/** QEMU takes a VNC display number, so the port has to be 5900 + n. */
export async function freeVncPort(preferred: number): Promise<number> {
  for (let p = Math.max(5900, preferred); p < 6000; p++) if (await canBind(p)) return p;
  throw new Error("no free VNC port between 5900 and 5999");
}

export function dockerOk(): boolean {
  try {
    dockerBin();
    return true;
  } catch {
    return false;
  }
}

/**
 * End a QEMU process that hasn't exited by itself: SIGTERM, then SIGKILL, and wait until it is gone, so
 * the next start doesn't find it still running (and leave it, thinking the guest is up).
 */
export async function stopProcess(pid: number): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!isAlive(pid)) return;
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(250);
  }
  if (isAlive(pid)) throw new Error(`qemu (pid ${pid}) did not exit`);
}

/**
 * Copy prep.sh next to a guest for the dockur container, with LF line endings: a Windows checkout with
 * core.autocrlf gives it CRLF, which bash in the Linux container fails on.
 */
export function writePrepScript(dir: string): string {
  const prep = path.join(dir, "prep.sh");
  fs.writeFileSync(prep, fs.readFileSync(path.join(assetsDir, "qemu", "prep.sh"), "utf8").replace(/\r\n/g, "\n"));
  return prep;
}

/** QEMU on PATH, or in the QEMU for Windows installer's default folder. */
export function qemuBinary(name: string): string | undefined {
  const found = which(name);
  if (found || process.platform !== "win32") return found;
  const p = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "qemu", `${name}.exe`);
  return fs.existsSync(p) ? p : undefined;
}

/** Copy-on-write clone where the filesystem supports it (APFS, btrfs, XFS, ReFS), else a sparse copy. */
export async function cloneFile(from: string, to: string): Promise<void> {
  fs.rmSync(to, { force: true });
  if (process.platform === "win32") {
    fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
    return;
  }
  const args = process.platform === "darwin" ? ["-c", from, to] : ["--reflink=auto", "--sparse=always", from, to];
  const r = await run("cp", args, { timeoutMs: 60 * 60_000 });
  if (r.code !== 0) fs.copyFileSync(from, to);
}

/** Send one command to QEMU's human monitor over its unix socket or loopback TCP port. */
export async function monitorCommand(monitor: string | number, cmd: string): Promise<void> {
  await monitorQuery(monitor, cmd);
}

/** Send one command to QEMU's human monitor and return what it printed (after its banner). */
export function monitorQuery(monitor: string | number, cmd: string, waitMs = 500): Promise<string> {
  return new Promise((resolve, reject) => {
    const target: net.NetConnectOpts = typeof monitor === "number" ? { host: "127.0.0.1", port: monitor } : { path: monitor };
    let out = "";
    const s = net.createConnection(target, () => {
      s.write(cmd + "\n");
      setTimeout(() => {
        s.end();
        // The monitor echoes the command line (with terminal escapes) before its output.
        const text = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
        const at = text.lastIndexOf(cmd);
        resolve((at >= 0 ? text.slice(at + cmd.length) : text).replace(/\(qemu\)\s*$/, "").trim());
      }, waitMs);
    });
    s.on("data", (d) => (out += d.toString("latin1")));
    s.on("error", reject);
  });
}
