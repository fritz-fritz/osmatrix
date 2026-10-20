import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Host side of the command bridge for a macOS guest that has no ssh yet (Recovery), for VMs on QEMU user
 * networking, where the guest reaches the host's loopback at its default gateway. Same protocol as
 * assets/macos/bridge.py (which runs inside dockur's container): the guest polls /next for a command,
 * runs it and posts the output to /result, and fetches /file/<name>.
 *
 * The host's loopback is shared with every local user and process, and the commands carry the guest
 * account's password, so every path sits under a random token that only the guest (told through its
 * screen) and this process know.
 */
export class HostBridge {
  private server?: http.Server;
  private readonly token = crypto.randomBytes(16).toString("hex");
  private readonly files = new Map<string, string>();
  private pending?: { cmd: string; taken: boolean; done: (out: string) => void };
  private seen = 0;
  port = 0;

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  /** The bridge's base URL for a guest that reaches the host at `host` (a shell expression is fine). */
  url(host: string): string {
    return `http://${host}:${this.port}/${this.token}`;
  }

  /** Offer a host file to the guest as /file/<name>. */
  serveFile(name: string, localPath: string): void {
    this.files.set(name, localPath);
  }

  /** True while the guest's polling loop has asked for work within the last 10 s. */
  alive(): boolean {
    return Date.now() - this.seen < 10_000;
  }

  /** Run a shell command in the guest and return its combined output (ending with "[rc=N]"). */
  run(cmd: string, timeoutSec: number): Promise<string> {
    if (this.pending) return Promise.reject(new Error("bridge: a command is already running"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("bridge: timeout waiting for guest"));
      }, timeoutSec * 1000);
      this.pending = {
        cmd,
        taken: false,
        done: (out) => {
          clearTimeout(timer);
          this.pending = undefined;
          resolve(out);
        },
      };
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const send = (code: number, body: string | Buffer = "") => {
      res.writeHead(code, { "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    const prefix = `/${this.token}/`;
    const url = req.url ?? "";
    if (!url.startsWith(prefix)) return send(404);
    const route = url.slice(prefix.length);
    if (req.method === "GET") {
      this.seen = Date.now();
      if (route === "next") {
        if (this.pending && !this.pending.taken) {
          this.pending.taken = true;
          return send(200, this.pending.cmd);
        }
        return send(204);
      }
      const file = route.startsWith("file/") ? this.files.get(route.slice("file/".length)) : undefined;
      if (file) return send(200, fs.readFileSync(file));
      return send(404);
    }
    if (req.method === "POST" && route === "result") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (this.pending?.taken) this.pending.done(Buffer.concat(chunks).toString("utf8"));
        send(200);
      });
      return;
    }
    send(404);
  }
}
