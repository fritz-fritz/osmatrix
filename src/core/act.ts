import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { ensureDir, paths } from "./paths.ts";
import { runOk, which } from "./proc.ts";

const exe = process.platform === "win32" ? "act.exe" : "act";

export async function findAct(): Promise<string | undefined> {
  const local = path.join(paths.binDir, exe);
  if (fs.existsSync(local)) return local;
  return which("act");
}

function assetName(): string {
  const os = { linux: "Linux", darwin: "Darwin", win32: "Windows" }[process.platform as string];
  const arch = { x64: "x86_64", arm64: "arm64", ia32: "i386" }[process.arch as string];
  if (!os || !arch) throw new Error(`no act release for ${process.platform}/${process.arch}`);
  return `act_${os}_${arch}.${os === "Windows" ? "zip" : "tar.gz"}`;
}

/** Return a usable act binary, downloading the pinned release (checksum-verified) into the data dir if needed. */
export async function ensureAct(): Promise<string> {
  const found = await findAct();
  if (found) return found;
  const version = loadConfig().act_version;
  const name = assetName();
  const base = `https://github.com/nektos/act/releases/download/${version}`;
  const [archive, sums] = await Promise.all([fetchBuf(`${base}/${name}`), fetchBuf(`${base}/checksums.txt`)]);
  const want = sums
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, f]) => f === name)?.[0];
  const got = crypto.createHash("sha256").update(archive).digest("hex");
  if (!want || want !== got) throw new Error(`act ${version} checksum mismatch for ${name}`);
  ensureDir(paths.binDir);
  const tmp = path.join(paths.binDir, name);
  fs.writeFileSync(tmp, archive);
  try {
    // bsdtar (macOS, Windows) reads zip too.
    await runOk("tar", ["-x", "-f", tmp, "-C", paths.binDir, exe]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const bin = path.join(paths.binDir, exe);
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function fetchBuf(url: string): Promise<Buffer> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
