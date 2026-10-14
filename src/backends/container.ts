import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LINUX_IMAGE, guestShell, type GuestConfig } from "../core/config.ts";
import { assertLocalGuestsReachable, dockerReach, localGuestBlockReason } from "../core/nesting.ts";
import { assetsDir, resourcePrefix } from "../core/paths.ts";
import { run } from "../core/proc.ts";
import { ensureKey, sshProbe, type Endpoint } from "../core/ssh.ts";
import { containerState, docker, dockerBin, imageExists, isPortConflict, portBinding, publishedPort } from "./docker.ts";
import { ensureLinuxImage, expectedLinuxImage } from "./linux-image.ts";
import type { Backend, GuestStatus, Support } from "./types.ts";
import { sizeMiB } from "../core/sizing.ts";

/** Label on the guest's ssh image (and so its containers and golden snapshots) naming the base image. */
const BASE_LABEL = "osmatrix.base";

/**
 * Linux guest as a long-lived container with sshd added, on the image act uses for ubuntu-* legs
 * (including the parity layer over act's default image).
 */
export class ContainerBackend implements Backend {
  readonly cfg: GuestConfig;
  constructor(cfg: GuestConfig) {
    this.cfg = cfg;
  }

  private get container() {
    return `${resourcePrefix}-${this.cfg.name}`;
  }
  private get goldenTag() {
    return `${resourcePrefix}/${this.cfg.name}:golden`;
  }
  private get port() {
    return this.cfg.ssh_port ?? 2221;
  }

  private sshImageTag(base: string): string {
    const dir = path.join(assetsDir, "container");
    const h = crypto.createHash("sha256").update(base);
    for (const f of ["Dockerfile", "entrypoint.sh"]) h.update(fs.readFileSync(path.join(dir, f)));
    return `osmatrix/ssh:${h.digest("hex").slice(0, 12)}`;
  }

  async supported(): Promise<Support> {
    const r = await run(dockerBin(), ["version", "--format", "{{.Server.Version}}"]).catch(() => undefined);
    if (!r || r.code !== 0) return { ok: false, reason: "docker daemon not reachable" };
    const blocked = localGuestBlockReason(await dockerReach(), this.cfg.os);
    return blocked ? { ok: false, reason: blocked } : { ok: true };
  }

  async status(): Promise<GuestStatus> {
    const st = await containerState(this.container);
    const base: GuestStatus = {
      name: this.cfg.name,
      os: this.cfg.os,
      backend: "container",
      state: "absent",
      hasSnapshot: await imageExists(this.goldenTag),
    };
    if (st === "absent" && !base.hasSnapshot) return base;
    // status() is polled (waitReady) and shouldn't wait on the network: the last runner lookup is enough here.
    const stale = await this.staleBase({ cachedOnly: true });
    if (stale) base.detail = stale;
    if (st === "absent") return base;
    if (st === "stopped") return { ...base, state: "stopped" };
    const p = await sshProbe(await this.endpoint());
    const ssh = await publishedPort(this.container, 22);
    return {
      ...base,
      state: p === "ok" ? "ready" : p === "auth" ? "needs-ssh-setup" : "booting",
      ...(ssh ? { ports: { ssh } } : {}),
    };
  }

  private get configuredBase(): string {
    return this.cfg.image ?? DEFAULT_LINUX_IMAGE;
  }

  /**
   * The base image a container or image of this guest was built on, from the label ensureImage puts on the
   * ssh image (containers and golden snapshots inherit it). Unlabeled ones predate the parity image and
   * were built on the configured image itself. Undefined when `ref` doesn't exist.
   */
  private async baseOf(ref: string): Promise<string | undefined> {
    const r = await run(dockerBin(), ["inspect", "-f", `{{index .Config.Labels "${BASE_LABEL}"}}`, ref]);
    if (r.code !== 0) return undefined;
    const v = r.stdout.trim();
    return v && v !== "<no value>" ? v : this.configuredBase;
  }

  /**
   * Why the guest runs on an older base image than Linux CI legs use now (a new runner Rust version, or a
   * guest set up before osmatrix added Rust), or undefined. A golden snapshot may hold the user's changes,
   * so it's only reported; a guest without one is recreated by `up`.
   */
  async staleBase(opts: { cachedOnly?: boolean } = {}): Promise<string | undefined> {
    const expected = await expectedLinuxImage(this.configuredBase, undefined, opts);
    if (!expected) return undefined;
    const name = this.cfg.name;
    const golden = await this.baseOf(this.goldenTag);
    if (golden !== undefined) {
      if (golden === expected) return undefined;
      return `its golden snapshot is built on ${golden}, not on ${expected} like Linux CI legs; it's kept because it may hold your changes. To rebuild the guest on the new image: osmatrix destroy ${name} --yes && osmatrix setup ${name}`;
    }
    const c = await this.baseOf(this.container);
    if (c === undefined || c === expected) return undefined;
    return `its container is built on ${c}, not on ${expected} like Linux CI legs; the next env_up after env_down recreates it on the new image (changes made inside it are lost)`;
  }

  private async ensureImage(): Promise<string> {
    const base = await ensureLinuxImage(this.configuredBase, { pid: process.pid, run: "env", repo: "", leg: `guest ${this.cfg.name}` });
    const tag = this.sshImageTag(base);
    if (!(await imageExists(tag))) {
      await docker(
        ["build", "-t", tag, "--build-arg", `BASE=${base}`, "--label", `${BASE_LABEL}=${base}`, path.join(assetsDir, "container")],
        60 * 60_000,
      );
    }
    return tag;
  }

  async up(): Promise<void> {
    await assertLocalGuestsReachable(this.cfg.os);
    let st = await containerState(this.container);
    if (st === "running") return;
    let image: string | undefined;
    if (st === "stopped" && !(await imageExists(this.goldenTag))) {
      // No golden snapshot to protect: a container on an older base than Linux legs use is recreated.
      const expected = await expectedLinuxImage(this.configuredBase);
      if (expected && (await this.baseOf(this.container)) !== expected) {
        const fresh = await this.ensureImage();
        // Only when the new image was built: offline, ensureImage may fall back to something older.
        if ((await this.baseOf(fresh)) === expected) {
          await docker(["rm", "-f", this.container]);
          image = fresh;
          st = "absent";
        }
      }
    }
    if (st === "stopped") {
      try {
        // cpus/memory may have changed since the container was created.
        const limits = this.limitArgs();
        if (limits.length) await docker(["update", ...limits, this.container]);
        await docker(["start", this.container]);
        return;
      } catch (e) {
        if (!isPortConflict(e)) throw e;
        // Its ssh port was taken meanwhile: keep the container's changes and re-run it on a new port.
        image = `${resourcePrefix}/${this.cfg.name}:carry`;
        await docker(["commit", this.container, image]);
        await docker(["rm", "-f", this.container]);
      }
    }
    image ??= (await imageExists(this.goldenTag)) ? this.goldenTag : await this.ensureImage();
    try {
      await this.run(image, await portBinding(this.port, 22));
    } catch (e) {
      if (!isPortConflict(e)) throw e;
      await run(dockerBin(), ["rm", "-f", this.container]);
      await this.run(image, "127.0.0.1::22");
    }
  }

  private async run(image: string, sshBinding: string): Promise<void> {
    const { publicKey } = await ensureKey();
    const args = [
      "run", "-d",
      "--name", this.container,
      "--hostname", this.cfg.name,
      "-p", sshBinding,
      "-e", `AUTHORIZED_KEY=${publicKey}`,
      "--label", "osmatrix.guest=" + this.cfg.name,
    ];
    args.push(...this.limitArgs(), image);
    await docker(args);
  }

  private limitArgs(): string[] {
    const args: string[] = [];
    if (this.cfg.cpus) args.push("--cpus", String(this.cfg.cpus));
    if (this.cfg.memory) {
      // Same units as the sizing checks (a bare number is GiB); docker would read a bare number as bytes.
      const mem = `${sizeMiB(this.cfg.memory)}m`;
      // docker update refuses a memory limit above the existing swap limit; keep them equal (no extra swap).
      args.push("--memory", mem, "--memory-swap", mem);
    }
    return args;
  }

  async down(): Promise<void> {
    if ((await containerState(this.container)) === "running") await docker(["stop", "-t", "10", this.container]);
  }

  async snapshot(): Promise<void> {
    if ((await containerState(this.container)) === "absent") throw new Error(`${this.cfg.name} does not exist; run up first`);
    await docker(["commit", this.container, this.goldenTag]);
  }

  async reset(): Promise<void> {
    await run(dockerBin(), ["rm", "-f", this.container]);
    await this.up();
  }

  async destroy(): Promise<void> {
    await run(dockerBin(), ["rm", "-f", this.container]);
    await run(dockerBin(), ["rmi", this.goldenTag]);
  }

  async endpoint(): Promise<Endpoint> {
    const { privateKey } = await ensureKey();
    return {
      host: "127.0.0.1",
      port: (await publishedPort(this.container, 22)) ?? this.port,
      user: this.cfg.user ?? "root",
      identity: privateKey,
      os: "linux",
      shell: guestShell(this.cfg),
      checkHostKey: false,
    };
  }
}
