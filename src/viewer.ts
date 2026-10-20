import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { WebSocketServer, type WebSocket } from "ws";
import { clientHandshake, SocketReader } from "./core/rfb.ts";

/**
 * A browser viewer for guests whose VNC display has no web client of its own (qemu, tart), so they open on
 * the desktop the way dockur's noVNC page does. One small HTTP server per guest on 127.0.0.1 serves a noVNC
 * page; its WebSocket is bridged to the guest's VNC server. The bridge does the guest's security handshake
 * itself (with tart's per-run password) and offers the browser no authentication, so no credential is shown.
 */

export type VncTarget = () => Promise<{ host: string; port: number; password?: string } | undefined>;

/** The noVNC package's root; it exports only core/rfb.js. */
const novncDir = () => path.dirname(path.dirname(createRequire(import.meta.url).resolve("@novnc/novnc")));

const TYPES: Record<string, string> = { ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };

function page(title: string): string {
  const t = title.replace(/[^\w .:-]/g, "");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>html,body{margin:0;height:100%;background:#202124;color:#e8eaed;font:14px system-ui,sans-serif}
#screen{position:absolute;inset:0}#status{position:absolute;top:8px;left:50%;transform:translateX(-50%);
padding:4px 10px;border-radius:4px;background:#000a;z-index:1}#status:empty{display:none}</style></head>
<body><div id="status">Connecting…</div><div id="screen"></div>
<script type="module">
import RFB from "./core/rfb.js";
const status = document.getElementById("status");
let retry = 1000;
function connect() {
  const rfb = new RFB(document.getElementById("screen"), (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/websockify");
  rfb.scaleViewport = true;
  rfb.addEventListener("connect", () => { status.textContent = ""; retry = 1000; });
  rfb.addEventListener("disconnect", () => {
    status.textContent = "Disconnected; reconnecting…";
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10000);
  });
}
connect();
</script></body></html>`;
}

/** The request's path, or undefined for a target `new URL` can't parse. */
function pathname(req: http.IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? "/", "http://x").pathname;
  } catch {
    return undefined;
  }
}

/** Only this page may open the bridge: other sites in the user's browser must not reach the guest's screen. */
function sameOrigin(req: http.IncomingMessage, port: number): boolean {
  const okHost = (h?: string) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  if (!okHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true; // not a browser
  try {
    return okHost(new URL(origin).host);
  } catch {
    return false;
  }
}

export function viewerServer(title: string, target: VncTarget): http.Server {
  const server = http.createServer((req, res) => {
    const port = (server.address() as net.AddressInfo).port;
    if (!sameOrigin(req, port) || req.method !== "GET") {
      res.writeHead(403).end();
      return;
    }
    const p = pathname(req);
    if (p === undefined) {
      res.writeHead(400).end();
      return;
    }
    if (p === "/") {
      // No framing: another site embedding the page could trick the user into clicking in the guest.
      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "frame-ancestors 'none'",
          "x-frame-options": "DENY",
        })
        .end(page(title));
      return;
    }
    // noVNC's library modules, and nothing else from its package.
    const rel = path.posix.normalize(p).replace(/^\/+/, "");
    if (!/^(core|vendor)\//.test(rel) || rel.includes("..")) {
      res.writeHead(404).end();
      return;
    }
    const file = path.join(novncDir(), ...rel.split("/"));
    fs.readFile(file, (err, data) => {
      if (err) res.writeHead(404).end();
      else res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(data);
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const port = (server.address() as net.AddressInfo).port;
    if (!sameOrigin(req, port) || pathname(req) !== "/websockify") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void bridge(ws, target));
  });
  return server;
}

/** Connect a browser's WebSocket to the guest's VNC server, standing in for the guest's security handshake. */
export async function bridge(ws: WebSocket, target: VncTarget): Promise<void> {
  let vnc: net.Socket | undefined;
  let closed = false;
  // Registered before anything is awaited: a browser that goes away mid-handshake takes the guest
  // connection with it, and a bad frame closes this connection instead of crashing the server.
  ws.on("close", () => {
    closed = true;
    vnc?.destroy();
  });
  ws.on("error", () => ws.terminate());
  const fail = (e: unknown) => {
    vnc?.destroy();
    if (!closed) ws.close(1011, String((e as Error)?.message ?? e).slice(0, 120));
  };
  try {
    const t = await target();
    if (closed) return;
    if (!t) throw new Error("the guest has no VNC display right now; is it running?");
    vnc = net.connect({ host: t.host, port: t.port });
    vnc.on("error", fail);
    const sock = vnc;
    const reader = new SocketReader(sock);
    await clientHandshake((n) => reader.read(n), (b) => sock.write(b), t.password);
    if (closed) return void sock.destroy();
    sock.pause();

    // To the browser: RFB 3.8, one security type, None; then its ClientInit and the guest's ServerInit pass through.
    const fromBrowser: Buffer[] = [];
    let need = 12;
    let step: "version" | "security" | "relay" = "version";
    const onMessage = (data: Buffer) => {
      if (step === "relay") {
        sock.write(data);
        return;
      }
      fromBrowser.push(data);
      let buf = Buffer.concat(fromBrowser);
      fromBrowser.length = 0;
      while (step !== "relay" && buf.length >= need) {
        buf = buf.subarray(need);
        if (step === "version") {
          ws.send(Buffer.from([1, 1]));
          step = "security";
          need = 1;
        } else {
          ws.send(Buffer.alloc(4)); // SecurityResult: OK
          step = "relay";
          const rest = reader.detach();
          if (rest.length) ws.send(rest);
          sock.on("data", (d: Buffer) => ws.send(d));
          sock.resume();
        }
      }
      if (buf.length) {
        if (step === "relay") sock.write(buf);
        else fromBrowser.push(buf);
      }
    };
    ws.on("message", (d: Buffer) => onMessage(d));
    sock.on("close", () => ws.close());
    ws.send(Buffer.from("RFB 003.008\n", "latin1"));
  } catch (e) {
    fail(e);
  }
}

/** The `osmatrix _viewer` process: serve until killed. */
export async function serveViewer(title: string, port: number, target: VncTarget): Promise<void> {
  const server = viewerServer(title, target);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise(() => {});
}
