import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import type { Backend, GuestStatus } from "../src/backends/types.ts";
import type { GuestConfig } from "../src/core/config.ts";
import { desEncrypt, vncAuthResponse } from "../src/core/rfb.ts";
import { viewerFor, type Guest } from "../src/env.ts";
import { closeReason, viewerServer, type VncTarget } from "../src/viewer.ts";

function guest(cfg: Partial<GuestConfig>, status: Partial<GuestStatus>, extra: Partial<Backend> = {}): Guest {
  const full = { name: "g", os: "windows", backend: "dockur", ...cfg } as GuestConfig;
  const backend = { cfg: full, status: async () => ({ name: "g", os: full.os, backend: full.backend, state: "ready", ...status }), ...extra } as unknown as Backend;
  return { cfg: full, backend };
}
const noServer = async (): Promise<string> => assert.fail("no viewer server expected");

test("viewer: dockur's web viewer at the port Docker published, not the configured one", async () => {
  const v = await viewerFor(guest({ web_port: 8006 }, { ports: { web: 8011, vnc: 5901 } }), noServer);
  assert.equal(v.kind, "web");
  assert.equal(v.url, "http://127.0.0.1:8011");
});

test("viewer: qemu and tart guests get osmatrix's browser viewer, not a VNC address", async () => {
  const started: string[] = [];
  const serve = async (name: string) => (started.push(name), "http://127.0.0.1:7123/#t=tok");
  const v = await viewerFor(guest({ backend: "qemu" }, { ports: { ssh: 2222, vnc: 5912 } }, { vnc: async () => ({ host: "127.0.0.1", port: 5912 }) }), serve);
  assert.deepEqual(v, { guest: "g", kind: "web", url: "http://127.0.0.1:7123/#t=tok", how: v.how });
  const t = await viewerFor(guest({ backend: "tart", os: "macos" }, {}, { vnc: async () => ({ host: "127.0.0.1", port: 5999, password: "a-b-c-d" }) }), serve);
  assert.equal(t.url, "http://127.0.0.1:7123/#t=tok");
  assert.deepEqual(started, ["g", "g"]);
});

test("viewer: stopped, absent, container and ssh guests, and guests without a display, are refused", async () => {
  await assert.rejects(viewerFor(guest({}, { state: "stopped" }), noServer), /stopped; start it first/);
  await assert.rejects(viewerFor(guest({}, { state: "absent" }), noServer), /absent/);
  await assert.rejects(viewerFor(guest({ backend: "container", os: "linux" }, {}), noServer), /container guest/);
  await assert.rejects(viewerFor(guest({ backend: "ssh" }, {}), noServer), /ssh guest/);
  await assert.rejects(viewerFor(guest({ backend: "qemu" }, { ports: { ssh: 2222 } }), noServer), /no display/);
});

test("viewer: no login, user or password in what the user is shown", async () => {
  const v = await viewerFor(guest({ backend: "tart", os: "macos", user: "admin" }, {}, { vnc: async () => ({ host: "127.0.0.1", port: 5999, password: "s3cret-pw" }) }), async () => "http://127.0.0.1:7000/#t=tok");
  assert.deepEqual(Object.keys(v).sort(), ["guest", "how", "kind", "url"]);
  assert.doesNotMatch(JSON.stringify(v), /admin|s3cret|password|credentials/i);
});

test("des: FIPS test vectors, and VNC authentication's bit-reversed key", () => {
  assert.equal(desEncrypt(Buffer.from("133457799BBCDFF1", "hex"), Buffer.from("0123456789ABCDEF", "hex")).toString("hex"), "85e813540f0ab405");
  assert.equal(desEncrypt(Buffer.from("0E329232EA6D0D73", "hex"), Buffer.from("8787878787878787", "hex")).toString("hex"), "0000000000000000");
  // Reference: OpenSSL's DES-ECB with "secret" bit-reversed per byte.
  assert.equal(vncAuthResponse(Buffer.from("00112233445566778899aabbccddeeff", "hex"), "secret").toString("hex"), "f19b50471f60f42298e5c0147db50e1e");
});

/** A VNC server asking for VNC authentication (like tart's), echoing everything after ServerInit. */
async function fakeVnc(password: string): Promise<{ port: number; close: () => void; authed: () => number }> {
  let authed = 0;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let stage = 0;
    const challenge = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    sock.write("RFB 003.008\n");
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0 && buf.length >= 12) {
          buf = buf.subarray(12);
          sock.write(Buffer.from([1, 2]));
          stage = 1;
        } else if (stage === 1 && buf.length >= 1) {
          assert.equal(buf[0], 2);
          buf = buf.subarray(1);
          sock.write(challenge);
          stage = 2;
        } else if (stage === 2 && buf.length >= 16) {
          const ok = buf.subarray(0, 16).equals(vncAuthResponse(challenge, password));
          buf = buf.subarray(16);
          sock.write(Buffer.from([0, 0, 0, ok ? 0 : 1]));
          if (!ok) return void sock.end();
          authed++;
          stage = 3;
        } else if (stage === 3 && buf.length >= 1) {
          buf = buf.subarray(1); // ClientInit
          const init = Buffer.alloc(24 + 4);
          init.writeUInt16BE(800, 0);
          init.writeUInt16BE(600, 2);
          init.writeUInt32BE(4, 20);
          init.write("fake", 24);
          sock.write(init);
          stage = 4;
        } else if (stage === 4 && buf.length) {
          sock.write(buf);
          buf = Buffer.alloc(0);
        } else return;
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close(), authed: () => authed };
}

const TOKEN = "test-token";

async function listen(target: VncTarget) {
  const server = viewerServer("test", target, { token: TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as net.AddressInfo).port };
}

/** Speak RFB as a browser would; resolves with the bytes received after ServerInit for "ping". */
function browser(port: number, origin = `http://127.0.0.1:${port}`, token = TOKEN): Promise<{ security: number[]; name: string; echo: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/websockify?t=${encodeURIComponent(token)}`, { origin });
    let buf = Buffer.alloc(0);
    let stage = 0;
    const out: { security: number[]; name: string; echo: string } = { security: [], name: "", echo: "" };
    ws.on("error", reject);
    ws.on("close", (code, reason) => stage < 5 && reject(new Error(`closed ${code} ${reason}`)));
    ws.on("message", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0 && buf.length >= 12) {
          assert.equal(buf.subarray(0, 12).toString(), "RFB 003.008\n");
          buf = buf.subarray(12);
          ws.send(Buffer.from("RFB 003.008\n"));
          stage = 1;
        } else if (stage === 1 && buf.length >= 1 && buf.length >= 1 + buf[0]) {
          out.security = [...buf.subarray(1, 1 + buf[0])];
          buf = buf.subarray(1 + buf[0]);
          ws.send(Buffer.from([1]));
          stage = 2;
        } else if (stage === 2 && buf.length >= 4) {
          assert.equal(buf.readUInt32BE(0), 0);
          buf = buf.subarray(4);
          ws.send(Buffer.from([1])); // ClientInit
          stage = 3;
        } else if (stage === 3 && buf.length >= 28) {
          out.name = buf.subarray(24, 28).toString();
          buf = buf.subarray(28);
          ws.send(Buffer.from("ping"));
          stage = 4;
        } else if (stage === 4 && buf.length >= 4) {
          out.echo = buf.subarray(0, 4).toString();
          stage = 5;
          ws.close();
          resolve(out);
          return;
        } else return;
      }
    });
  });
}

test("viewer bridge: authenticates to the guest with its password and offers the browser no authentication", async () => {
  const vnc = await fakeVnc("pass-word-four-x");
  const { server, port } = await listen(async () => ({ host: "127.0.0.1", port: vnc.port, password: "pass-word-four-x" }));
  try {
    const r = await browser(port);
    assert.deepEqual(r.security, [1], "only None is offered to the browser");
    assert.equal(r.name, "fake");
    assert.equal(r.echo, "ping");
    assert.equal(vnc.authed(), 1);
  } finally {
    server.close();
    vnc.close();
  }
});

test("viewer bridge: a wrong password closes the browser's connection", async () => {
  const vnc = await fakeVnc("right");
  const { server, port } = await listen(async () => ({ host: "127.0.0.1", port: vnc.port, password: "wrong" }));
  try {
    await assert.rejects(browser(port), /closed 1011/);
  } finally {
    server.close();
    vnc.close();
  }
});

test("viewer server: other sites can't open the bridge or read the page", async () => {
  const vnc = await fakeVnc("pw");
  const { server, port } = await listen(async () => ({ host: "127.0.0.1", port: vnc.port, password: "pw" }));
  try {
    await assert.rejects(browser(port, "https://evil.example"), /403|Unexpected server response/);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /core\/rfb\.js/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/core/rfb.js`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/package.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/core/../package.json`)).status, 404);
    // DNS rebinding: a page served under another host name is refused.
    const rebound = await new Promise<number>((resolve) =>
      net.connect({ host: "127.0.0.1", port }, function (this: net.Socket) {
        this.write("GET / HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n");
        this.once("data", (d) => resolve(parseInt(d.toString().split(" ")[1], 10)));
      }),
    );
    assert.equal(rebound, 403);
  } finally {
    server.close();
    vnc.close();
  }
});

/** Send a raw HTTP request line and return the status code. */
function rawStatus(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => sock.write(request));
    sock.once("data", (d) => (resolve(parseInt(d.toString().split(" ")[1], 10)), sock.destroy()));
    sock.once("error", reject);
  });
}

test("viewer server: malformed request targets get 400 and don't take the server down", async () => {
  const { server, port } = await listen(async () => undefined);
  try {
    assert.equal(await rawStatus(port, `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`), 400);
    const upgrade = `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
    assert.equal(await rawStatus(port, upgrade), 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200, "still serving");
  } finally {
    server.close();
  }
});

test("viewer server: the page can't be framed by another site", async () => {
  const { server, port } = await listen(async () => undefined);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'none'");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
  } finally {
    server.close();
  }
});

test("viewer bridge: a browser leaving mid-handshake closes the guest connection", async () => {
  let guestClosed!: () => void;
  const closedP = new Promise<void>((r) => (guestClosed = r));
  // A guest that accepts the connection and never speaks.
  const silent = net.createServer((sock) => {
    sock.on("close", guestClosed);
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const { server, port } = await listen(async () => ({ host: "127.0.0.1", port: (silent.address() as net.AddressInfo).port }));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/websockify?t=${TOKEN}`, { origin: `http://127.0.0.1:${port}` });
    await new Promise((r) => ws.once("open", r));
    await new Promise((r) => setTimeout(r, 100));
    ws.terminate();
    await closedP;
  } finally {
    server.close();
    silent.close();
  }
});

test("viewer bridge: close reasons fit WebSocket's 123 bytes without splitting a character", () => {
  const r = closeReason("认证失败".repeat(20));
  assert.ok(Buffer.byteLength(r) <= 123);
  assert.equal(r, "认证失败".repeat(20).slice(0, 41));
  assert.equal(closeReason("short"), "short");
});

test("viewer server: the bridge only opens with the server's token", async () => {
  const vnc = await fakeVnc("pw");
  const { server, port } = await listen(async () => ({ host: "127.0.0.1", port: vnc.port, password: "pw" }));
  try {
    // Another local process: no Origin, right Host, but no token.
    await assert.rejects(browser(port, undefined as unknown as string, ""), /403|Unexpected server response/);
    await assert.rejects(browser(port, `http://127.0.0.1:${port}`, "wrong-token"), /403|Unexpected server response/);
    assert.equal((await browser(port)).echo, "ping");
    assert.equal(vnc.authed(), 1, "only the request with the token reached the guest");
  } finally {
    server.close();
    vnc.close();
  }
});

test("viewer bridge: a slow browser pauses the guest's output instead of queueing it without limit", async () => {
  // A guest that floods 64 MiB right after ServerInit, as fast as the bridge reads it.
  let sent = 0;
  const flood = net.createServer((sock) => {
    let stage = 0;
    sock.write("RFB 003.008\n");
    sock.on("data", () => {
      if (stage === 0) sock.write(Buffer.from([1, 1]));
      else if (stage === 1) sock.write(Buffer.alloc(4));
      else if (stage === 2) {
        const init = Buffer.alloc(28);
        init.writeUInt32BE(4, 20);
        sock.write(init);
        const chunk = Buffer.alloc(1024 * 1024);
        const pump = () => {
          while (sent < 64 && sock.write(chunk)) sent++;
          if (sent < 64) sock.once("drain", () => (sent++, pump()));
        };
        pump();
      }
      stage++;
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => flood.listen(0, "127.0.0.1", r));
  const { server, port } = await listen(async () => ({ host: "127.0.0.1", port: (flood.address() as net.AddressInfo).port }));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/websockify?t=${TOKEN}`, { origin: `http://127.0.0.1:${port}` });
    let got = 0;
    let stage = 0;
    ws.on("message", (d: Buffer) => {
      got += d.length;
      if (stage === 0) ws.send(Buffer.from("RFB 003.008\n"));
      else if (stage === 1) ws.send(Buffer.from([1]));
      else if (stage === 2) {
        ws.send(Buffer.from([1]));
        // Stop reading, like a backgrounded tab.
        (ws as unknown as { _socket: net.Socket })._socket.pause();
      }
      stage++;
    });
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(got < 64 * 1024 * 1024, "the browser hasn't drained everything");
    // Without backpressure the bridge would read all 64 MiB into its queue; with it, the guest is held
    // back at about the high-water mark plus socket buffers.
    assert.ok(sent < 40, `the guest got to send ${sent} MiB`);
    ws.terminate();
  } finally {
    server.close();
    flood.close();
  }
});
