import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { guestShell, loadConfig, windowsOemOptions, type GuestConfig } from "../core/config.ts";
import { assertLocalGuestsReachable, dockerReach, localGuestBlockReason } from "../core/nesting.ts";
import { assetsDir, ensureDir, paths, resourcePrefix } from "../core/paths.ts";
import { run } from "../core/proc.ts";
import { ensureKey, sshExec, sshProbe, type Endpoint } from "../core/ssh.ts";
import { containerState, copyVolume, docker, dockerBin, dockerHasKvm, isPortConflict, portBinding, publishedPort, volumeExists } from "./docker.ts";
import type { Backend, GuestStatus, Support } from "./types.ts";

/** Windows / macOS VMs via dockur (QEMU+KVM inside a container). */
export class DockurBackend implements Backend {
  readonly cfg: GuestConfig;
  constructor(cfg: GuestConfig) {
    this.cfg = cfg;
  }

  private get project() {
    return `${resourcePrefix}-${this.cfg.name}`;
  }
  private get container() {
    return `${resourcePrefix}-${this.cfg.name}`;
  }
  private get storageVol() {
    return `${resourcePrefix}-${this.cfg.name}-storage`;
  }
  private get goldenVol() {
    return `${resourcePrefix}-${this.cfg.name}-golden`;
  }
  private get dir() {
    return ensureDir(paths.guestDir(this.cfg.name));
  }
  private get composeFile() {
    return path.join(this.dir, "compose.yaml");
  }
  private get image() {
    return this.cfg.image ?? (this.cfg.os === "macos" ? "dockurr/macos" : "dockurr/windows");
  }

  /** Windows login used for RDP / the web viewer. Generated once per guest. */
  credentials(): { username: string; password: string } {
    const f = path.join(this.dir, "credentials.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    const c = { username: this.cfg.user ?? "osmatrix", password: crypto.randomBytes(9).toString("base64url") };
    fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
    return c;
  }

  /** True once ssh has worked at least once (macOS needs a manual first-time setup before that). */
  everReady(): boolean {
    return fs.existsSync(path.join(this.dir, ".ready-once"));
  }

  async supported(): Promise<Support> {
    if (this.cfg.os === "macos" && !loadConfig().macos_eula_acknowledged) {
      return {
        ok: false,
        reason:
          "installing macOS accepts Apple's macOS Software License Agreement, which only permits macOS on Apple hardware. With the user's consent run `osmatrix setup macos --accept-license` (MCP: env_setup with accept_license).",
      };
    }
    const blocked = localGuestBlockReason(await dockerReach(), this.cfg.os);
    if (blocked) return { ok: false, reason: blocked };
    try {
      if (!(await dockerHasKvm())) return { ok: false, reason: "containers cannot access /dev/kvm (needs Linux+KVM or Windows 11 WSL2 with nested virtualization)" };
    } catch (e) {
      return { ok: false, reason: String((e as Error).message) };
    }
    return { ok: true };
  }

  /** The settings baked into the container at creation; a stopped container whose label differs is recreated. */
  private sizing(): Record<string, string> {
    return {
      VERSION: this.cfg.version ?? (this.cfg.os === "macos" ? "15" : "2025"),
      RAM_SIZE: this.cfg.memory ?? "8G",
      CPU_CORES: String(this.cfg.cpus ?? 4),
      DISK_SIZE: this.cfg.disk ?? "64G",
    };
  }

  private settingsKey(): string {
    return crypto.createHash("sha256").update(JSON.stringify([this.image, this.sizing()])).digest("hex").slice(0, 12);
  }

  /** True when the container exists but was created with other image/version/cpu/memory/disk settings. */
  async settingsChanged(): Promise<boolean> {
    const r = await run(dockerBin(), ["inspect", "-f", '{{index .Config.Labels "osmatrix.settings"}}', this.container]);
    return r.code === 0 && r.stdout.trim() !== this.settingsKey();
  }

  private async writeCompose(opts: { picker?: boolean; anyPorts?: boolean } = {}): Promise<void> {
    const env: Record<string, string> = {
      ...this.sizing(),
      // Only used in user-mode networking fallback; NAT mode forwards all non-reserved ports already.
      USER_PORTS: "22",
    };
    // OpenCore boot menu (used by macOS setup to reach Recovery after installation).
    if (opts.picker) env.PICKER = "Y";
    const volumes = [`${this.storageVol}:/storage`];
    if (this.cfg.os === "windows") {
      const c = this.credentials();
      env.USERNAME = c.username;
      env.PASSWORD = c.password;
      const oem = ensureDir(path.join(this.dir, "oem"));
      for (const f of fs.readdirSync(path.join(assetsDir, "oem", "windows"))) {
        fs.copyFileSync(path.join(assetsDir, "oem", "windows", f), path.join(oem, f));
      }
      const { publicKey } = await ensureKey();
      fs.writeFileSync(path.join(oem, "authorized_keys"), publicKey + "\r\n");
      fs.writeFileSync(path.join(oem, "options.json"), JSON.stringify(windowsOemOptions(this.cfg)));
      // :z relabels for SELinux hosts (Fedora, openSUSE); ignored elsewhere.
      volumes.push(`${oem}:/oem:z`);
    }
    const compose = {
      name: this.project,
      services: {
        guest: {
          image: this.image,
          container_name: this.container,
          environment: env,
          devices: ["/dev/kvm", "/dev/net/tun"],
          cap_add: ["NET_ADMIN"],
          // Configured ports are preferences: a busy one is left to Docker to assign. The real
          // ports are always read back with `docker port` (see hostPorts()).
          ports: opts.anyPorts
            ? ["127.0.0.1::8006", "127.0.0.1::5900", "127.0.0.1::22"]
            : [
                await portBinding(this.cfg.web_port ?? 8006, 8006),
                await portBinding(this.cfg.vnc_port ?? 5900, 5900),
                await portBinding(this.cfg.ssh_port ?? 2222, 22),
              ],
          volumes,
          labels: { "osmatrix.guest": this.cfg.name, "osmatrix.settings": this.settingsKey() },
          restart: "no",
          stop_grace_period: "2m",
        },
      },
      volumes: { [this.storageVol]: { name: this.storageVol } },
    };
    fs.writeFileSync(this.composeFile, YAML.stringify(compose));
  }

  private compose(args: string[], timeoutMs = 10 * 60_000) {
    return docker(["compose", "-f", this.composeFile, "-p", this.project, ...args], timeoutMs);
  }

  /** Host ports currently published for this guest. */
  async hostPorts(): Promise<{ ssh?: number; web?: number; vnc?: number }> {
    const [ssh, web, vnc] = await Promise.all([22, 8006, 5900].map((p) => publishedPort(this.container, p)));
    return { ssh, web, vnc };
  }

  async status(): Promise<GuestStatus> {
    const st = await containerState(this.container);
    const ports = st === "running" ? await this.hostPorts() : {};
    const urls = { web: ports.web ? `http://127.0.0.1:${ports.web}` : "(guest not running)" };
    const base: GuestStatus = {
      name: this.cfg.name,
      os: this.cfg.os,
      backend: "dockur",
      state: "absent",
      hasSnapshot: await volumeExists(this.goldenVol),
    };
    if (st === "absent") return (await volumeExists(this.storageVol)) ? { ...base, state: "stopped" } : base;
    if (st === "stopped") return { ...base, state: "stopped" };
    const p = await sshProbe(await this.endpoint());
    if (p === "ok") {
      if (!this.everReady()) fs.writeFileSync(path.join(this.dir, ".ready-once"), new Date().toISOString());
      // Runs on whichever look at the guest comes first after a boot (env_status, waitReady, a CI leg),
      // so a disk resized for "the next start" grows without anyone having to wait for it.
      // Housekeeping must not make a usable guest look broken: a failure only goes into detail.
      const err = await this.afterReady().then(() => undefined, (e: Error) => e.message);
      return { ...base, state: "ready", urls, ports: ports as Record<string, number>, ...(err ? { detail: err } : {}) };
    }
    if (p === "auth") {
      return {
        ...base,
        state: "needs-ssh-setup",
        urls,
        ports: ports as Record<string, number>,
        detail: `sshd is up but the osmatrix key is not authorized. Run: osmatrix setup-ssh ${this.cfg.name} --user <guest user>`,
      };
    }
    const detail =
      this.cfg.os === "windows"
        ? `booting or installing/provisioning (first boot downloads and installs Windows, ~20-60 min). Watch: ${urls.web}`
        : this.everReady()
          ? `booting (watch: ${urls.web})`
          : `not set up yet, or setup in progress. Fully automatic: \`osmatrix setup ${this.cfg.name} --accept-license\` (MCP: env_setup with accept_license after the user agrees to Apple's macOS license).`;
    return { ...base, state: "booting", urls, ports: ports as Record<string, number>, detail };
  }

  async up(): Promise<void> {
    await assertLocalGuestsReachable(this.cfg.os);
    const st = await containerState(this.container);
    if (st === "running") return;
    // A changed cpus/memory/disk/version only reaches QEMU through a new container (the disk is kept).
    if (st === "stopped" && !(await this.settingsChanged())) {
      // Keep the existing port mapping; if one of its ports got taken meanwhile, recreate with new ports.
      try {
        await docker(["start", this.container]);
        return;
      } catch (e) {
        if (!isPortConflict(e)) throw e;
      }
    }
    await this.recreate();
  }

  /** (Re)create the container (disk kept), optionally with the OpenCore boot menu shown. */
  async recreate(opts: { picker?: boolean } = {}): Promise<void> {
    const s = await this.supported();
    if (!s.ok) throw new Error(`${this.cfg.name}: ${s.reason}`);
    // Remove the old container first so its ports count as free again.
    if ((await containerState(this.container)) !== "absent") await run(dockerBin(), ["rm", "-f", this.container]);
    await this.writeCompose(opts);
    try {
      await this.compose(["up", "-d"], 60 * 60_000);
    } catch (e) {
      // A preferred port was free when checked but taken before Docker bound it: let Docker pick all ports.
      if (!isPortConflict(e)) throw e;
      await run(dockerBin(), ["rm", "-f", this.container]);
      await this.writeCompose({ ...opts, anyPorts: true });
      await this.compose(["up", "-d"], 60 * 60_000);
    }
  }

  get containerName(): string {
    return this.container;
  }

  /** Total bytes read+written by the VM container (a progress signal while installing). */
  async ioBytes(opts: { strict?: boolean } = {}): Promise<number> {
    const r = await run(dockerBin(), ["stats", "--no-stream", "--format", "{{.BlockIO}}", this.container]);
    if (opts.strict && r.code !== 0) throw new Error(`docker stats failed: ${(r.stderr || r.stdout).trim()}`);
    const units: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
    return [...r.stdout.matchAll(/([\d.]+)\s*([kKMGT]?B)/g)].reduce((a, m) => a + Number(m[1]) * (units[m[2]] ?? 1), 0);
  }

  /** Number of times the VM firmware has booted since the container started. */
  async bootCount(opts: { strict?: boolean } = {}): Promise<number> {
    const r = await run(dockerBin(), ["logs", this.container]);
    if (opts.strict && r.code !== 0) throw new Error(`docker logs failed: ${(r.stderr || r.stdout).trim()}`);
    const mark = this.cfg.os === "macos" ? /OC: Loaded configuration/g : /BdsDxe: starting /g;
    return ((r.stdout + r.stderr).match(mark) ?? []).length;
  }

  async bootProbe(): Promise<{ io: number; boots: number } | undefined> {
    if (!this.everReady()) return undefined;
    // Strict: a failed docker call must disable hang detection (waitReady drops a rejected probe),
    // not read as zero disk activity.
    const [io, boots] = await Promise.all([this.ioBytes({ strict: true }), this.bootCount({ strict: true })]);
    return { io, boots };
  }

  async down(): Promise<void> {
    if (!fs.existsSync(this.composeFile)) return;
    await this.compose(["stop", "-t", "120"], 5 * 60_000);
  }

  async snapshot(): Promise<void> {
    if (!(await volumeExists(this.storageVol))) throw new Error(`${this.cfg.name} has no disk yet; run up first`);
    const wasRunning = (await containerState(this.container)) === "running";
    await this.down();
    await copyVolume(this.storageVol, this.goldenVol);
    if (wasRunning) await this.up();
  }

  private get grownFile() {
    return path.join(this.dir, ".disk-grown");
  }

  /**
   * Grows the system partition into space a bigger `disk` setting added (QEMU's disk image grows at
   * start, the partition inside does not). Runs once per disk size; a no-op when there is no new space.
   */
  async afterReady(): Promise<void> {
    const want = this.sizing().DISK_SIZE;
    if (fs.existsSync(this.grownFile) && fs.readFileSync(this.grownFile, "utf8").trim() === want) return;
    const r = await sshExec(await this.endpoint(), this.cfg.os === "windows" ? GROW_WINDOWS : GROW_MACOS, { timeoutMs: 5 * 60_000 });
    if (r.code !== 0) throw new Error(`could not grow the system partition to fill the ${want} disk: ${(r.stderr || r.stdout).trim()}`);
    fs.writeFileSync(this.grownFile, want);
  }

  /** Readiness and boot-time history describe the current disk; a fresh install must not inherit them. */
  private forgetInstall(): void {
    for (const f of [".ready-once", "boot-times.json", ".disk-grown"]) fs.rmSync(path.join(this.dir, f), { force: true });
  }

  async reset(): Promise<void> {
    await this.down();
    // The golden snapshot's partition may predate a disk size change.
    fs.rmSync(this.grownFile, { force: true });
    if (await volumeExists(this.goldenVol)) {
      await copyVolume(this.goldenVol, this.storageVol);
    } else {
      this.forgetInstall();
      if (fs.existsSync(this.composeFile)) await this.compose(["down", "-v"]);
      await run(dockerBin(), ["volume", "rm", "-f", this.storageVol]);
    }
    await this.up();
  }

  async destroy(): Promise<void> {
    if (fs.existsSync(this.composeFile)) await this.compose(["down", "-v"]);
    await run(dockerBin(), ["rm", "-f", this.container]);
    await run(dockerBin(), ["volume", "rm", "-f", this.storageVol, this.goldenVol]);
    this.forgetInstall();
  }

  async endpoint(): Promise<Endpoint> {
    const { privateKey } = await ensureKey();
    return {
      host: "127.0.0.1",
      port: (await publishedPort(this.container, 22)) ?? this.cfg.ssh_port ?? 2222,
      // The account baked into the guest at install time (credentials.json), unless overridden.
      user: this.cfg.user ?? this.credentials().username,
      identity: privateKey,
      os: this.cfg.os,
      shell: guestShell(this.cfg),
      checkHostKey: false,
    };
  }

  async vnc() {
    const port = await publishedPort(this.container, 5900);
    if (!port) throw new Error(`${this.cfg.name} is not running`);
    return { host: "127.0.0.1", port };
  }
}

// C: is followed by the Recovery partition, which blocks growing it. Guests are disposable, so the
// Recovery partition is dropped once the disk has grown (WinRE then lives on C:).
const GROW_WINDOWS = [
  "$ErrorActionPreference = 'Stop'",
  "Update-HostStorageCache",
  "$c = Get-Partition -DriveLetter C",
  "$disk = Get-Disk -Number $c.DiskNumber",
  "$end = (Get-Partition -DiskNumber $c.DiskNumber | ForEach-Object { $_.Offset + $_.Size } | Measure-Object -Maximum).Maximum",
  "if ($disk.Size - $end -lt 100MB -and (Get-PartitionSupportedSize -DriveLetter C).SizeMax -lt $c.Size + 100MB) { 'no new space'; exit 0 }",
  "$rec = Get-Partition -DiskNumber $c.DiskNumber | Where-Object { $_.Offset -gt $c.Offset -and $_.Type -eq 'Recovery' }",
  "if ($rec) { reagentc /disable | Out-Null; $rec | Remove-Partition -Confirm:$false; reagentc /enable | Out-Null }",
  "Resize-Partition -DriveLetter C -Size (Get-PartitionSupportedSize -DriveLetter C).SizeMax",
  "'grown to ' + [math]::Round((Get-Partition -DriveLetter C).Size / 1GB) + 'G'",
].join("; ");

// The APFS container is the last partition. repairDisk first moves the GPT backup header to the new end.
const GROW_MACOS = [
  "set -e",
  "store=$(diskutil info -plist / | plutil -extract APFSPhysicalStores.0.APFSPhysicalStore raw -)",
  "disk=${store%s*}",
  "total=$(diskutil info -plist \"$disk\" | plutil -extract Size raw -)",
  "off=$(diskutil info -plist \"$store\" | plutil -extract PartitionMapPartitionOffset raw -)",
  "size=$(diskutil info -plist \"$store\" | plutil -extract Size raw -)",
  "if [ $((total - off - size)) -lt 104857600 ]; then echo 'no new space'; exit 0; fi",
  "yes | sudo diskutil repairDisk \"$disk\" >/dev/null",
  "sudo diskutil apfs resizeContainer \"$store\" 0 >/dev/null",
  "echo \"grown $store\"",
].join("\n");
