import net from "node:net";
import zlib from "node:zlib";
import { getGuest } from "./env.ts";

/**
 * Minimal RFB (VNC) client: unauthenticated, raw encoding. Enough for QEMU's built-in VNC server (dockur).
 * Used for screenshots and keyboard/mouse input when a guest has no usable ssh yet (installers, GUI apps).
 */
class Rfb {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private closed?: Error;
  width = 0;
  height = 0;

  async connect(host: string, port: number, timeoutMs = 10_000): Promise<void> {
    this.sock = net.connect({ host, port });
    this.sock.setTimeout(timeoutMs, () => this.sock.destroy(new Error("VNC timeout")));
    this.sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    this.sock.on("error", (e) => {
      this.closed = e;
      this.wake();
    });
    this.sock.on("close", () => {
      this.closed ??= new Error("VNC connection closed");
      this.wake();
    });

    const ver = (await this.read(12)).toString("latin1");
    if (!ver.startsWith("RFB ")) throw new Error(`not a VNC server: ${JSON.stringify(ver)}`);
    const minor = parseInt(ver.slice(8, 11), 10);
    const proto = minor >= 8 ? "RFB 003.008\n" : minor >= 7 ? "RFB 003.007\n" : "RFB 003.003\n";
    this.sock.write(proto);
    if (proto === "RFB 003.003\n") {
      const t = (await this.read(4)).readUInt32BE(0);
      if (t !== 1) throw new Error(`VNC requires authentication (type ${t}); only unauthenticated VNC is supported`);
    } else {
      const n = (await this.read(1))[0];
      if (n === 0) throw new Error("VNC refused connection");
      const types = [...(await this.read(n))];
      if (!types.includes(1)) throw new Error(`VNC requires authentication (types ${types.join(",")}); only unauthenticated VNC is supported`);
      this.sock.write(Buffer.from([1]));
      if (proto === "RFB 003.008\n") {
        const res = (await this.read(4)).readUInt32BE(0);
        if (res !== 0) throw new Error("VNC security handshake failed");
      }
    }
    this.sock.write(Buffer.from([1])); // ClientInit: shared
    const init = await this.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    const nameLen = init.readUInt32BE(20);
    await this.read(nameLen);

    // SetPixelFormat: 32bpp, depth 24, little endian, true colour, R<<16 G<<8 B
    const pf = Buffer.alloc(20);
    pf[0] = 0;
    pf[4] = 32;
    pf[5] = 24;
    pf[6] = 0;
    pf[7] = 1;
    pf.writeUInt16BE(255, 8);
    pf.writeUInt16BE(255, 10);
    pf.writeUInt16BE(255, 12);
    pf[14] = 16;
    pf[15] = 8;
    pf[16] = 0;
    this.sock.write(pf);
    // SetEncodings: raw, DesktopSize pseudo-encoding
    const enc = Buffer.alloc(4 + 8);
    enc[0] = 2;
    enc.writeUInt16BE(2, 2);
    enc.writeInt32BE(0, 4);
    enc.writeInt32BE(-223, 8);
    this.sock.write(enc);
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.closed) throw this.closed;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }

  /** Request a full frame and return RGBA pixels. */
  async capture(): Promise<{ width: number; height: number; rgba: Buffer }> {
    const req = Buffer.alloc(10);
    req[0] = 3;
    req[1] = 0; // non-incremental
    req.writeUInt16BE(this.width, 6);
    req.writeUInt16BE(this.height, 8);
    this.sock.write(req);
    let rgba = Buffer.alloc(this.width * this.height * 4, 255);
    for (;;) {
      const type = (await this.read(1))[0];
      if (type === 0) {
        const hdr = await this.read(3);
        const rects = hdr.readUInt16BE(1);
        let gotPixels = false;
        for (let i = 0; i < rects; i++) {
          const r = await this.read(12);
          const x = r.readUInt16BE(0);
          const y = r.readUInt16BE(2);
          const w = r.readUInt16BE(4);
          const h = r.readUInt16BE(6);
          const e = r.readInt32BE(8);
          if (e === -223) {
            this.width = w;
            this.height = h;
            rgba = Buffer.alloc(w * h * 4, 255);
            continue;
          }
          if (e !== 0) throw new Error(`unexpected VNC encoding ${e}`);
          const px = await this.read(w * h * 4);
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const s = (row * w + col) * 4;
              const d = ((y + row) * this.width + (x + col)) * 4;
              rgba[d] = px[s + 2];
              rgba[d + 1] = px[s + 1];
              rgba[d + 2] = px[s];
              rgba[d + 3] = 255;
            }
          }
          gotPixels = true;
        }
        if (gotPixels) return { width: this.width, height: this.height, rgba };
        // Only a resize arrived; ask again for the new size.
        req.writeUInt16BE(this.width, 6);
        req.writeUInt16BE(this.height, 8);
        this.sock.write(req);
      } else if (type === 1) {
        const h = await this.read(5);
        await this.read(h.readUInt16BE(3) * 6);
      } else if (type === 2) {
        /* bell */
      } else if (type === 3) {
        const h = await this.read(7);
        await this.read(h.readUInt32BE(3));
      } else {
        throw new Error(`unexpected VNC message ${type}`);
      }
    }
  }

  key(keysym: number, down: boolean) {
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.sock.write(b);
  }

  pointer(x: number, y: number, mask: number) {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(Math.max(0, Math.round(x)), 2);
    b.writeUInt16BE(Math.max(0, Math.round(y)), 4);
    this.sock.write(b);
  }

  async close() {
    await new Promise<void>((r) => this.sock.end(r));
  }
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const KEYSYMS: Record<string, number> = {
  enter: 0xff0d, return: 0xff0d, tab: 0xff09, escape: 0xff1b, esc: 0xff1b, backspace: 0xff08, delete: 0xffff, del: 0xffff,
  insert: 0xff63, home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, space: 0x20,
  shift: 0xffe1, ctrl: 0xffe3, control: 0xffe3, alt: 0xffe9, option: 0xffe9,
  super: 0xffeb, win: 0xffeb, meta: 0xffeb, cmd: 0xffeb, command: 0xffeb,
};
for (let i = 1; i <= 12; i++) KEYSYMS[`f${i}`] = 0xffbe + i - 1;

// QEMU's VNC server maps keysyms to physical keys without adding Shift, so shifted characters
// are sent as Shift + the unshifted key of a US layout.
const SHIFTED: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};
const SHIFT_L = 0xffe1;

/** Keysyms to press (in order) for one character, e.g. "A" -> [Shift, a]. */
function charKeys(ch: string): number[] {
  if (/^[A-Z]$/.test(ch)) return [SHIFT_L, charKeysym(ch.toLowerCase())];
  if (SHIFTED[ch]) return [SHIFT_L, charKeysym(SHIFTED[ch])];
  return [charKeysym(ch)];
}

function charKeysym(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (ch === "\n") return 0xff0d;
  if (ch === "\t") return 0xff09;
  return cp < 0x100 ? cp : 0x01000000 | cp;
}

/** "ctrl+alt+delete", "cmd+space", "enter", "a" */
function comboKeysyms(combo: string): number[] {
  return combo.split("+").map((k) => {
    const lk = k.trim().toLowerCase();
    if (KEYSYMS[lk] !== undefined) return KEYSYMS[lk];
    if ([...k].length === 1) return charKeysym(SHIFTED[k] ?? k.toLowerCase());
    throw new Error(`unknown key "${k}"`);
  });
}

async function connectGuest(name: string): Promise<Rfb> {
  const g = getGuest(name);
  const v = g.backend.vnc ? await g.backend.vnc() : undefined;
  if (!v) throw new Error(`guest ${name} (${g.cfg.backend}) has no VNC display; screenshots/input are supported for dockur guests`);
  const rfb = new Rfb();
  await rfb.connect(v.host, v.port);
  return rfb;
}

export async function screenshot(name: string): Promise<{ png: Buffer; width: number; height: number }> {
  const rfb = await connectGuest(name);
  try {
    const f = await rfb.capture();
    return { png: encodePng(f.width, f.height, f.rgba), width: f.width, height: f.height };
  } finally {
    await rfb.close();
  }
}

/** Mean brightness (0-255) of the guest display, sampled on a grid. Cheap way to tell boot phases apart. */
export async function screenBrightness(name: string): Promise<number> {
  const rfb = await connectGuest(name);
  try {
    const f = await rfb.capture();
    let sum = 0;
    let n = 0;
    for (let y = 0; y < f.height; y += 8) {
      for (let x = 0; x < f.width; x += 8) {
        const i = (y * f.width + x) * 4;
        sum += f.rgba[i] + f.rgba[i + 1] + f.rgba[i + 2];
        n++;
      }
    }
    return n ? sum / n / 3 : 0;
  } finally {
    await rfb.close();
  }
}

export interface InputAction {
  /** Key combos pressed in order, e.g. ["ctrl+alt+delete", "enter"]. */
  keys?: string[];
  /** Literal text to type. */
  text?: string;
  /** Click at framebuffer coordinates. */
  click?: { x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean };
  /** Scroll at a position: positive = down. */
  scroll?: { x: number; y: number; amount: number };
}

export async function input(name: string, actions: InputAction[]): Promise<{ performed: number }> {
  const rfb = await connectGuest(name);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    for (const a of actions) {
      for (const combo of a.keys ?? []) {
        const syms = comboKeysyms(combo);
        for (const s of syms) rfb.key(s, true);
        await pause(30);
        for (const s of [...syms].reverse()) rfb.key(s, false);
        await pause(50);
      }
      if (a.text) {
        for (const ch of a.text) {
          const keys = charKeys(ch);
          for (const k of keys) rfb.key(k, true);
          for (const k of [...keys].reverse()) rfb.key(k, false);
          await pause(15);
        }
      }
      if (a.click) {
        const mask = { left: 1, middle: 2, right: 4 }[a.click.button ?? "left"];
        const n = a.click.double ? 2 : 1;
        // Move first and give the guest time to register hover/focus; an immediate press is often
        // swallowed as a window-activation click.
        rfb.pointer(a.click.x, a.click.y, 0);
        await pause(300);
        for (let i = 0; i < n; i++) {
          rfb.pointer(a.click.x, a.click.y, mask);
          await pause(40);
          rfb.pointer(a.click.x, a.click.y, 0);
          await pause(60);
        }
      }
      if (a.scroll) {
        const btn = a.scroll.amount > 0 ? 16 : 8;
        for (let i = 0; i < Math.abs(a.scroll.amount); i++) {
          rfb.pointer(a.scroll.x, a.scroll.y, btn);
          rfb.pointer(a.scroll.x, a.scroll.y, 0);
          await pause(30);
        }
      }
    }
    await pause(100);
    return { performed: actions.length };
  } finally {
    await rfb.close();
  }
}
