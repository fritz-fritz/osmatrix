import { timingSafeEqual } from "node:crypto";
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
 * The bridge only opens for a random token the server is started with, which reaches the page in its URL's
 * fragment (never sent in a request): other local processes and users can't drive the guest through it.
 */

export type VncTarget = () => Promise<{ host: string; port: number; password?: string } | undefined>;

export interface ViewerOptions {
  /** Answered in a header, so osmatrix can tell its own server from another program on the port. */
  id?: string;
  /** Required to open the bridge; the page reads it from its URL's fragment (`#t=<token>`). */
  token: string;
}

/** Above this many bytes queued for the browser, stop reading from the guest until the browser catches up. */
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
/** How long the guest's VNC server gets to finish its handshake. */
const HANDSHAKE_MS = 10_000;

/** The noVNC package's root (it exports only core/rfb.js), looked up on first use. */
let novncRoot: string | undefined;
const novncDir = () => (novncRoot ??= path.dirname(path.dirname(createRequire(import.meta.url).resolve("@novnc/novnc"))));

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
const token = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
// A new URL for the same server (a fresh token) only changes the fragment: reload to use it.
addEventListener("hashchange", () => location.reload());
let retry = 1000;
let failures = 0;
function connect() {
  const rfb = new RFB(document.getElementById("screen"), (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/websockify?t=" + encodeURIComponent(token));
  rfb.scaleViewport = true;
  rfb.addEventListener("connect", () => { status.textContent = ""; retry = 1000; failures = 0; });
  rfb.addEventListener("disconnect", async () => {
    failures++;
    let why = "";
    try {
      const r = await fetch("/status?t=" + encodeURIComponent(token), { cache: "no-store" });
      why = r.ok ? (await r.json()).error : "this link is out of date";
    } catch {
      why = "the viewer server isn't running any more";
    }
    status.textContent = (why ? "Can't show the guest's screen: " + why + (/[.?!]$/.test(why) ? " " : ". ") : "Disconnected. ") +
      (failures < 4 ? "Retrying…" : "If the guest was stopped or restarted, ask for its viewer again (env_viewer, or osmatrix viewer <guest>) and open the new link. Still retrying…");
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10000);
  });
}
connect();
</script></body></html>`;
}

/** The request's URL, or undefined for a target `new URL` can't parse. */
function requestUrl(req: http.IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? "/", "http://x");
  } catch {
    return undefined;
  }
}

function tokenMatches(given: string | null, token: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(token);
  return token.length > 0 && a.length === b.length && timingSafeEqual(a, b);
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

export function viewerServer(title: string, target: VncTarget, opts: ViewerOptions): http.Server {
  const server = http.createServer((req, res) => {
    const port = (server.address() as net.AddressInfo).port;
    if (!sameOrigin(req, port) || req.method !== "GET") {
      res.writeHead(403).end();
      return;
    }
    const url = requestUrl(req);
    const p = url?.pathname;
    if (!url || p === undefined) {
      res.writeHead(400).end();
      return;
    }
    if (p === "/status") {
      if (!tokenMatches(url.searchParams.get("t"), opts.token)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: lastFailure }));
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
          // Lets osmatrix tell its own server from another program that took the port.
          "x-osmatrix-viewer": opts.id ?? "",
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
    // Node's HTTP error handling no longer covers an upgraded socket: a client resetting it (after a
    // 403, say) must not crash the server.
    socket.on("error", () => socket.destroy());
    const port = (server.address() as net.AddressInfo).port;
    const url = requestUrl(req);
    if (!sameOrigin(req, port) || url?.pathname !== "/websockify" || !tokenMatches(url.searchParams.get("t"), opts.token)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void bridge(ws, target));
  });
  return server;
}

/** Browsers connected through this process's bridges right now. */
let activeBridges = 0;
/** Why the last bridge failed, for the page to show (served at /status to holders of the token). */
let lastFailure = "";

/** Connect a browser's WebSocket to the guest's VNC server, standing in for the guest's security handshake. */
export async function bridge(ws: WebSocket, target: VncTarget): Promise<void> {
  let vnc: net.Socket | undefined;
  let closed = false;
  activeBridges++;
  // Registered before anything is awaited: a browser that goes away mid-handshake takes the guest
  // connection with it, and a bad frame closes this connection instead of crashing the server.
  ws.on("close", () => {
    closed = true;
    activeBridges--;
    vnc?.destroy();
  });
  ws.on("error", () => ws.terminate());
  const fail = (e: unknown) => {
    lastFailure = String((e as Error)?.message ?? e);
    vnc?.destroy();
    if (!closed) ws.close(1011, closeReason(String((e as Error)?.message ?? e)));
  };
  try {
    // A hung backend lookup (tart list, say) must not hold the page on "Connecting…" forever.
    const t = await Promise.race([
      target(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("looking up the guest's display timed out")), HANDSHAKE_MS).unref()),
    ]);
    if (closed) return;
    if (!t) throw new Error("the guest has no VNC display right now; is it running?");
    vnc = net.connect({ host: t.host, port: t.port });
    vnc.on("error", fail);
    const sock = vnc;
    // A server that accepts and then says nothing (a guest still starting) must not hold the page forever.
    sock.setTimeout(HANDSHAKE_MS, () => sock.destroy(new Error("the guest's VNC server didn't answer")));
    const reader = new SocketReader(sock);
    await clientHandshake((n) => reader.read(n), (b) => sock.write(b), t.password);
    sock.setTimeout(0);
    if (closed) return void sock.destroy();
    // The guest says nothing more until the browser's ClientInit; the reader keeps listening meanwhile,
    // so a guest that drops the connection now closes the browser's at once.
    sock.on("close", () => ws.close());

    // To the browser: RFB 3.8, one security type, None; then its ClientInit and the guest's ServerInit pass through.
    let pending = Buffer.alloc(0);
    let need = 12;
    let step: "version" | "security" | "relay" = "version";
    // A guest that stops reading: hold the browser's input back rather than queue it without limit.
    let inputHeld = false;
    const toGuest = (data: Buffer) => {
      if (!sock.write(data) && !inputHeld) {
        inputHeld = true;
        ws.pause();
        sock.once("drain", () => {
          inputHeld = false;
          ws.resume();
        });
      }
    };
    const onMessage = (data: Buffer) => {
      if (step === "relay") {
        toGuest(data);
        return;
      }
      let buf = Buffer.concat([pending, data]);
      pending = Buffer.alloc(0);
      while (step !== "relay" && buf.length >= need) {
        buf = buf.subarray(need);
        if (step === "version") {
          ws.send(Buffer.from([1, 1]));
          step = "security";
          need = 1;
        } else {
          ws.send(Buffer.alloc(4)); // SecurityResult: OK
          lastFailure = "";
          step = "relay";
          const rest = reader.detach();
          if (rest.length) ws.send(rest);
          // A slow browser: hold the guest's output back rather than queue it without limit, and let
          // the sends' completions resume it once the queue has drained.
          const sent = () => {
            if (!closed && sock.isPaused() && ws.bufferedAmount < LOW_WATER) sock.resume();
          };
          sock.on("data", (d: Buffer) => {
            ws.send(d, sent);
            if (ws.bufferedAmount > HIGH_WATER) sock.pause();
          });
        }
      }
      if (buf.length) {
        if (step === "relay") toGuest(buf);
        else pending = buf;
      }
    };
    ws.on("message", (d: Buffer) => onMessage(d));
    ws.send(Buffer.from("RFB 003.008\n", "latin1"));
  } catch (e) {
    fail(e);
  }
}

/** A WebSocket close reason: at most 123 UTF-8 bytes, cut between code points. */
export function closeReason(msg: string): string {
  let out = "";
  for (const ch of msg) {
    if (Buffer.byteLength(out + ch) > 123) break;
    out += ch;
  }
  return out;
}

/**
 * The `osmatrix _viewer` process: serve until killed, or until `keepAlive` says the server is no longer
 * wanted (checked every few seconds; e.g. osmatrix dropped its record, or the guest stopped). It is told
 * whether a browser is connected, in which case the guest's display is plainly there.
 */
export async function serveViewer(
  title: string,
  port: number,
  opts: ViewerOptions,
  target: VncTarget,
  keepAlive: (connected: boolean) => Promise<boolean>,
): Promise<void> {
  const server = viewerServer(title, target, opts);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  // Once listening, an error accepting a connection (e.g. out of file descriptors) is logged, not fatal.
  server.on("error", (e) => console.error(`viewer server: ${e.message}`));
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    let keep = true;
    try {
      keep = await keepAlive(activeBridges > 0);
    } catch {
      /* keep serving */
    }
    if (!keep) process.exit(0);
  }
}
