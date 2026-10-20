import type net from "node:net";

/**
 * The RFB (VNC) version and security handshake, as a client, up to the point where ClientInit is due.
 * Accepts no authentication, or VNC authentication when a password is known (tart's Virtualization.framework
 * server makes up one per run). Shared by the screenshot/input client and the browser viewer's bridge.
 */
export async function clientHandshake(read: (n: number) => Promise<Buffer>, write: (b: Buffer) => void, password?: string): Promise<void> {
  const ver = (await read(12)).toString("latin1");
  if (!ver.startsWith("RFB ")) throw new Error(`not a VNC server: ${JSON.stringify(ver)}`);
  const minor = parseInt(ver.slice(8, 11), 10);
  const proto = minor >= 8 ? "RFB 003.008\n" : minor >= 7 ? "RFB 003.007\n" : "RFB 003.003\n";
  write(Buffer.from(proto, "latin1"));
  let type: number;
  if (proto === "RFB 003.003\n") {
    type = (await read(4)).readUInt32BE(0);
    if (type === 0) throw new Error(`VNC refused connection: ${await reason(read)}`);
  } else {
    const n = (await read(1))[0];
    if (n === 0) throw new Error(`VNC refused connection: ${await reason(read)}`);
    const types = [...(await read(n))];
    if (types.includes(1)) type = 1;
    else if (types.includes(2) && password !== undefined) type = 2;
    else throw new Error(`VNC requires authentication (types ${types.join(",")})${password === undefined ? " and osmatrix has no password for it" : ""}`);
    write(Buffer.from([type]));
  }
  if (type === 2) {
    if (password === undefined) throw new Error("VNC requires a password, and osmatrix has none for it");
    write(vncAuthResponse(await read(16), password));
  } else if (type !== 1) {
    throw new Error(`unsupported VNC security type ${type}`);
  }
  // RFB 3.8 always sends a SecurityResult; older versions only after VNC authentication.
  if (proto === "RFB 003.008\n" || type === 2) {
    const res = (await read(4)).readUInt32BE(0);
    if (res !== 0) throw new Error(`VNC security handshake failed${proto === "RFB 003.008\n" ? `: ${await reason(read)}` : ""}`);
  }
}

async function reason(read: (n: number) => Promise<Buffer>): Promise<string> {
  try {
    const len = (await read(4)).readUInt32BE(0);
    return (await read(Math.min(len, 4096))).toString("utf8");
  } catch {
    return "no reason given";
  }
}

/** Buffered exact-length reads from a socket. */
export class SocketReader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private closed?: Error;
  private readonly sock: net.Socket;
  private readonly onData = (d: Buffer) => {
    this.buf = Buffer.concat([this.buf, d]);
    this.wake();
  };

  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", this.onData);
    sock.on("error", (e) => {
      this.closed = e;
      this.wake();
    });
    sock.on("close", () => {
      this.closed ??= new Error("VNC connection closed");
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.closed) throw this.closed;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Stop reading: returns whatever arrived beyond the reads so far, and leaves the socket's data to the caller. */
  detach(): Buffer {
    this.sock.off("data", this.onData);
    const out = this.buf;
    this.buf = Buffer.alloc(0);
    return out;
  }
}

/**
 * VNC authentication's answer to a 16-byte challenge: DES-encrypt it with the password (first 8 bytes,
 * zero-padded) as the key, each key byte's bits reversed. Node's OpenSSL no longer ships DES, hence the
 * small implementation below.
 */
export function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    let b = key[i];
    let r = 0;
    for (let j = 0; j < 8; j++) {
      r = (r << 1) | (b & 1);
      b >>= 1;
    }
    key[i] = r;
  }
  return Buffer.concat([desEncrypt(key, challenge.subarray(0, 8)), desEncrypt(key, challenge.subarray(8, 16))]);
}

// ---------- DES (FIPS 46-3), encryption of one block ----------

const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

/** Bits as an array of 0/1, most significant first. */
function bits(b: Uint8Array): number[] {
  const out: number[] = [];
  for (const byte of b) for (let i = 7; i >= 0; i--) out.push((byte >> i) & 1);
  return out;
}
const permute = (src: number[], table: number[]) => table.map((p) => src[p - 1]);

export function desEncrypt(key: Uint8Array, block: Uint8Array): Buffer {
  const k = permute(bits(key), PC1);
  let c = k.slice(0, 28);
  let d = k.slice(28);
  const subkeys: number[][] = [];
  for (const s of SHIFTS) {
    c = [...c.slice(s), ...c.slice(0, s)];
    d = [...d.slice(s), ...d.slice(0, s)];
    subkeys.push(permute([...c, ...d], PC2));
  }
  const m = permute(bits(block), IP);
  let l = m.slice(0, 32);
  let r = m.slice(32);
  for (const sk of subkeys) {
    const x = permute(r, E).map((v, i) => v ^ sk[i]);
    const f: number[] = [];
    for (let i = 0; i < 8; i++) {
      const six = x.slice(i * 6, i * 6 + 6);
      const v = S[i][(six[0] << 5) | (six[5] << 4) | (six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4]];
      f.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
    }
    const next = permute(f, P).map((v, i) => v ^ l[i]);
    l = r;
    r = next;
  }
  const out = permute([...r, ...l], FP);
  const buf = Buffer.alloc(8);
  for (let i = 0; i < 64; i++) buf[i >> 3] |= out[i] << (7 - (i & 7));
  return buf;
}
