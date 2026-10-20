import type { GuestConfig } from "../core/config.ts";
import { ContainerBackend } from "./container.ts";
import { DockurBackend } from "./dockur.ts";
import { QemuMacBackend } from "./qemu-macos.ts";
import { QemuBackend } from "./qemu.ts";
import { SshBackend } from "./ssh.ts";
import { TartBackend } from "./tart.ts";
import type { Backend } from "./types.ts";

export function backendFor(cfg: GuestConfig): Backend {
  switch (cfg.backend) {
    case "container":
      return new ContainerBackend(cfg);
    case "dockur":
      return new DockurBackend(cfg);
    case "tart":
      return new TartBackend(cfg);
    case "qemu":
      return cfg.os === "macos" ? new QemuMacBackend(cfg) : new QemuBackend(cfg);
    case "ssh":
      return new SshBackend(cfg);
    default:
      throw new Error(`unknown backend "${(cfg as GuestConfig).backend}" for guest ${cfg.name}`);
  }
}

export type { Backend, GuestStatus, GuestState } from "./types.ts";
