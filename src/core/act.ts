import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dockerBin } from "../backends/docker.ts";
import { loadConfig, type Config, type GuestConfig, type OsFamily } from "./config.ts";
import { acquireLocks } from "./locks.ts";
import { assetsDir, ensureDir, paths, resourcePrefix } from "./paths.ts";
import { run, runOk, which } from "./proc.ts";

/*
 * Which act osmatrix runs, in order:
 * 1. `act_path` in config.toml: the user's own act (a path, or a command name looked up on PATH, e.g. "act").
 *    Guests then run their own provisioned act.
 * 2. `act_version` other than PATCHED_ACT_VERSION: that stock release, downloaded and checksum-verified.
 * 3. Otherwise (the default) osmatrix's patched act, built from source in Docker (assets/act/*.patch), for
 *    the host and every guest. Without Docker it falls back to the stock release, with a warning.
 * An `act` on PATH is ignored unless act_path names it: stock act differs from GitHub's runners in ways
 * the patch fixes, and a run shouldn't depend on what happens to be installed.
 */

/** The act release the patch applies to. */
export const PATCHED_ACT_VERSION = "v0.2.89";
/** GitHub's source archive of the tag; its sha256 is pinned so a changed archive is refused. */
export const ACT_SOURCE = {
  url: `https://codeload.github.com/nektos/act/tar.gz/refs/tags/${PATCHED_ACT_VERSION}`,
  sha256: "649cd5b91cad870871d2283fb3ad95c8fa1d5ced7a1db8d7b346d1a7dcd3ec71",
};
/** act's go.mod asks for Go 1.25. Pinned by the multi-arch index digest, so every host builds with the same toolchain. */
export const GO_IMAGE = "golang:1.25.14-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437";
export const ACT_PATCH_FILE = path.join(assetsDir, "act", `act-${PATCHED_ACT_VERSION}-osmatrix.patch`);
/** Go module and build caches, shared by every osmatrix install on the host so rebuilds take seconds. */
const GO_CACHE_VOLUME = "osmatrix-act-go-cache";
const BUILD_LOCK = "host:act-build";

/** What stock act gets wrong that the patch fixes; shown whenever a leg runs stock act. */
export const STOCK_ACT_DIFFERENCES =
  "stock act keeps GITHUB_OUTPUT/GITHUB_ENV/GITHUB_PATH/GITHUB_STATE/GITHUB_STEP_SUMMARY outside RUNNER_TEMP, and its artifact server rejects actions/upload-artifact v7 and later (unknown field mime_type, unpadded signatures)";

export type GoTarget = `${"linux" | "darwin" | "windows"}/${"amd64" | "arm64"}`;
const GOOS: Record<OsFamily, "linux" | "darwin" | "windows"> = { linux: "linux", macos: "darwin", windows: "windows" };

export function hostTarget(platform: string = process.platform, arch: string = process.arch): GoTarget | undefined {
  const os = ({ linux: "linux", darwin: "darwin", win32: "windows" } as Record<string, string>)[platform];
  const a = ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[arch];
  return os && a ? (`${os}/${a}` as GoTarget) : undefined;
}

/**
 * The target a guest's act needs, when its configuration tells: dockur's macOS guests are Intel, tart's
 * run on Apple Silicon, Windows follows its image (dockurr/windows-arm, or the qemu backend) and Linux
 * containers share the host's act. ssh guests can be anything, so their target comes from probing them.
 */
export function guestTarget(g: GuestConfig): GoTarget | undefined {
  switch (g.backend) {
    case "tart":
      return "darwin/arm64";
    case "qemu":
      return "windows/arm64";
    case "dockur":
      if (g.os === "macos") return "darwin/amd64";
      return /arm/i.test(g.image ?? "") ? "windows/arm64" : "windows/amd64";
    default:
      return undefined;
  }
}

/** Targets built together on the first build: the host's plus every configured guest's that is known up front. */
export function defaultTargets(cfg: Pick<Config, "guests">, platform: string = process.platform, arch: string = process.arch): GoTarget[] {
  const t = [hostTarget(platform, arch), ...Object.values(cfg.guests).map(guestTarget)];
  return [...new Set(t.filter((x): x is GoTarget => !!x))].sort();
}

/** Every platform a guest backend can need (ssh Linux guests share the host's targets or are probed). */
export const ALL_GUEST_TARGETS: GoTarget[] = ["darwin/amd64", "darwin/arm64", "windows/amd64", "windows/arm64"];

/** A guest's target from its OS and what `uname -m` or .NET's OSArchitecture reports. */
export function targetFromArch(os: OsFamily, arch: string): GoTarget | undefined {
  const a = arch.trim().toLowerCase();
  const goarch = a === "x86_64" || a === "amd64" || a === "x64" ? "amd64" : a === "arm64" || a === "aarch64" ? "arm64" : undefined;
  return goarch ? (`${GOOS[os]}/${goarch}` as GoTarget) : undefined;
}

/** Cache key of a patched build: the act version plus a hash of everything that changes the binaries. */
export function patchedActKey(version: string, patch: string | Buffer, image = GO_IMAGE, source = ACT_SOURCE.sha256): string {
  const h = crypto.createHash("sha256").update(`${version}\n${source}\n${image}\n${BUILD_SCRIPT}\n`).update(patch).digest("hex");
  return `${version}-${h.slice(0, 12)}`;
}

/**
 * The version the patched build reports (`act --version`), e.g. "0.2.89+osmatrix.1a2b3c4d5e6f". Build
 * metadata (+…) rather than a pre-release suffix, which act's update notice would call older than 0.2.89.
 */
export function patchedActVersion(key: string): string {
  const [v, h] = key.split("-");
  return `${v.replace(/^v/, "")}+osmatrix.${h}`;
}

const exeName = (target: GoTarget) => (target.startsWith("windows/") ? "act.exe" : "act");

export function patchedActBinary(key: string, target: GoTarget): string {
  return path.join(paths.binDir, "act-patched", key, target.replace("/", "-"), exeName(target));
}

export type ActResolution =
  | { source: "user"; configured: string; path?: string }
  | { source: "patched"; version: string; key: string }
  | { source: "release"; version: string; reason: string };

/** Which act the configuration asks for. Pure apart from reading the patch and the PATH lookup. */
export function resolveAct(cfg: Pick<Config, "act_version" | "act_path">, lookup: (cmd: string) => string | undefined = which): ActResolution {
  if (cfg.act_path) {
    const p = /[\\/]/.test(cfg.act_path) ? (fs.existsSync(cfg.act_path) ? cfg.act_path : undefined) : lookup(cfg.act_path);
    return { source: "user", configured: cfg.act_path, path: p };
  }
  if (cfg.act_version !== PATCHED_ACT_VERSION) {
    return {
      source: "release",
      version: cfg.act_version,
      reason: `act_version is ${cfg.act_version}; osmatrix's patch is for ${PATCHED_ACT_VERSION}, so the stock release runs: ${STOCK_ACT_DIFFERENCES}`,
    };
  }
  return { source: "patched", version: PATCHED_ACT_VERSION, key: patchedActKey(PATCHED_ACT_VERSION, fs.readFileSync(ACT_PATCH_FILE)) };
}

export interface ActChoice {
  path: string;
  source: "user" | "patched" | "release";
  /** act's version, e.g. "0.2.89+osmatrix.1a2b3c4d5e6f" (patched) or "v0.2.89" (release); undefined for the user's own. */
  version?: string;
  /** Set when the run differs from GitHub in ways the patched build would have avoided. */
  warning?: string;
}

type Log = (msg: string) => void;
const stderrLog: Log = (m) => process.stderr.write(`[osmatrix] ${m}\n`);

/** Return the act binary for the host, building osmatrix's patched act (or downloading a release) when needed. */
export async function ensureAct(opts: { log?: Log; targets?: GoTarget[] } = {}): Promise<ActChoice> {
  const log = opts.log ?? stderrLog;
  const cfg = loadConfig();
  const r = resolveAct(cfg);
  if (r.source === "user") {
    if (!r.path) throw new Error(`act_path is "${r.configured}", but no such act ${/[\\/]/.test(r.configured) ? "file exists" : "is on PATH"}`);
    return { path: r.path, source: "user" };
  }
  if (r.source === "release") return { path: await downloadRelease(r.version), source: "release", version: r.version, warning: r.reason };
  const host = hostTarget();
  if (!host) throw new Error(`no act build for ${process.platform}/${process.arch}`);
  const wanted = [host, ...(opts.targets ?? [])];
  if (wanted.some((t) => !fs.existsSync(patchedActBinary(r.key, t)))) {
    const docker = await dockerAvailable();
    if (!docker.ok) {
      const warning = `osmatrix's patched act needs Docker to build (${docker.reason}); running stock act ${PATCHED_ACT_VERSION} instead, where ${STOCK_ACT_DIFFERENCES}`;
      if (fs.existsSync(patchedActBinary(r.key, host))) throw new Error(warning.split(";")[0]);
      log(`warning: ${warning}`);
      return { path: await downloadRelease(PATCHED_ACT_VERSION), source: "release", version: PATCHED_ACT_VERSION, warning };
    }
    await buildPatchedAct(r.key, wanted, defaultTargets(cfg), log);
  }
  return { path: patchedActBinary(r.key, host), source: "patched", version: patchedActVersion(r.key) };
}

/**
 * The patched act for a guest, building that target if needed. A reason instead when the guest should
 * run its own provisioned act: the user configured their own act or a release, or Docker isn't
 * available to build this target.
 */
export async function patchedActFor(target: GoTarget, log: Log = stderrLog): Promise<{ path: string; sha256: string; version: string } | { reason: string }> {
  const cfg = loadConfig();
  const r = resolveAct(cfg);
  if (r.source === "user") return { reason: `act_path is set, so the guest runs its own act from PATH; with stock act, ${STOCK_ACT_DIFFERENCES}` };
  if (r.source === "release") return { reason: `the guest runs its own act from PATH: ${r.reason}` };
  const bin = patchedActBinary(r.key, target);
  if (!fs.existsSync(bin)) {
    const docker = await dockerAvailable();
    if (!docker.ok) return { reason: `osmatrix's patched act needs Docker to build (${docker.reason}); the guest runs its own act from PATH, where ${STOCK_ACT_DIFFERENCES}` };
    await buildPatchedAct(r.key, [target], defaultTargets(cfg), log);
  }
  return { path: bin, sha256: await sha256File(bin), version: patchedActVersion(r.key) };
}

/** Targets of the current patched build that exist, for doctor. */
export function builtTargets(key: string): GoTarget[] {
  const dir = path.join(paths.binDir, "act-patched", key);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((d) => d.replace("-", "/") as GoTarget)
    .filter((t) => fs.existsSync(patchedActBinary(key, t)))
    .sort();
}

let dockerCheck: Promise<{ ok: boolean; reason?: string }> | undefined;
export function dockerAvailable(): Promise<{ ok: boolean; reason?: string }> {
  dockerCheck ??= (async () => {
    let bin: string;
    try {
      bin = dockerBin();
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    const r = await run(bin, ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 20_000 });
    return r.code === 0 ? { ok: true } : { ok: false, reason: `the Docker daemon isn't reachable: ${(r.stderr || r.stdout).trim().split("\n")[0]}` };
  })();
  return dockerCheck;
}

// The source tree and patch arrive in /in (docker cp, so this also works with a remote daemon); binaries
// go to /out/<goos>-<goarch>/. CGO_ENABLED=0 gives static binaries that cross-compile without a C toolchain.
const BUILD_SCRIPT = `set -eu
mkdir -p /src /out
tar -xzf /in/act.tar.gz -C /src --strip-components=1
cd /src
git apply --verbose /in/act.patch
for t in $TARGETS; do
  os=\${t%/*}; arch=\${t#*/}; ext=; [ "$os" = windows ] && ext=.exe
  echo "building act $ACT_VERSION+osmatrix.$BUILD_ID for $os/$arch"
  GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=$ACT_VERSION+osmatrix.$BUILD_ID" -o "/out/$os-$arch/act$ext" .
done
`;

/**
 * Build the patched act for the wanted targets unless they exist. A first build also covers `extra`
 * (the configured guests), so one container run serves the host and its guests. A host-wide lock keeps
 * concurrent runs from building twice; whoever waited finds the binaries and returns.
 */
async function buildPatchedAct(key: string, wanted: GoTarget[], extra: GoTarget[], log: Log): Promise<void> {
  const missingOf = (ts: GoTarget[]) => [...new Set(ts)].filter((t) => !fs.existsSync(patchedActBinary(key, t))).sort();
  if (!missingOf(wanted).length) return;
  const release = await acquireLocks([BUILD_LOCK], { pid: process.pid, run: "act-build", repo: "", leg: key }, (_k, h) =>
    log(`waiting for another osmatrix process (pid ${h.pid}) to finish building act`),
  );
  const stage = fs.mkdtempSync(path.join(ensureDir(paths.binDir), ".act-build-"));
  try {
    const missing = missingOf([...wanted, ...extra]);
    if (!missingOf(wanted).length) return;
    const version = patchedActVersion(key);
    log(`building osmatrix's patched act ${version} for ${missing.join(", ")} in Docker (${GO_IMAGE.split("@")[0]}); the first build takes a few minutes`);
    const src = await fetchBuf(ACT_SOURCE.url);
    const got = crypto.createHash("sha256").update(src).digest("hex");
    if (got !== ACT_SOURCE.sha256) throw new Error(`act ${PATCHED_ACT_VERSION} source archive checksum mismatch (got ${got}, want ${ACT_SOURCE.sha256})`);
    const input = ensureDir(path.join(stage, "in"));
    fs.writeFileSync(path.join(input, "act.tar.gz"), src);
    fs.copyFileSync(ACT_PATCH_FILE, path.join(input, "act.patch"));
    const docker = dockerBin();
    const name = `${resourcePrefix}-act-build-${crypto.randomBytes(3).toString("hex")}`;
    await runOk(
      docker,
      [
        "create", "--name", name,
        "-v", `${GO_CACHE_VOLUME}:/cache`,
        "-e", "CGO_ENABLED=0", "-e", "GOTOOLCHAIN=local", "-e", "GOFLAGS=-mod=readonly",
        "-e", "GOMODCACHE=/cache/mod", "-e", "GOCACHE=/cache/build",
        "-e", `TARGETS=${missing.join(" ")}`, "-e", `ACT_VERSION=${PATCHED_ACT_VERSION.replace(/^v/, "")}`, "-e", `BUILD_ID=${key.split("-")[1]}`,
        GO_IMAGE, "sh", "-c", BUILD_SCRIPT,
      ],
      { timeoutMs: 30 * 60_000 }, // includes pulling the image
    );
    try {
      await runOk(docker, ["cp", input, `${name}:/in`]);
      const code = await streamLines(docker, ["start", "-a", name], log, 60 * 60_000);
      if (code !== 0) throw new Error(`building act failed (exit ${code}); the output is above`);
      await runOk(docker, ["cp", `${name}:/out`, path.join(stage, "out")]);
    } finally {
      await run(docker, ["rm", "-f", name]);
    }
    const dir = ensureDir(path.join(paths.binDir, "act-patched", key));
    for (const t of missing) {
      const d = t.replace("/", "-");
      fs.chmodSync(path.join(stage, "out", d, exeName(t)), 0o755);
      fs.rmSync(path.join(dir, d), { recursive: true, force: true });
      fs.renameSync(path.join(stage, "out", d), path.join(dir, d));
    }
    // Builds of an older patch are no longer used.
    for (const old of fs.readdirSync(path.dirname(dir))) {
      if (old !== key) fs.rmSync(path.join(path.dirname(dir), old), { recursive: true, force: true, maxRetries: 2 });
    }
    log(`built act ${version} for ${missing.join(", ")} in ${dir}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    release();
  }
}

function streamLines(cmd: string, args: string[], log: Log, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    for (const s of [child.stdout, child.stderr]) {
      let buf = "";
      s.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          log(`  ${buf.slice(0, i).trimEnd()}`);
          buf = buf.slice(i + 1);
        }
      });
      s.on("end", () => buf && log(`  ${buf.trimEnd()}`));
    }
    child.on("error", (e) => {
      clearTimeout(timer);
      log(`failed to start ${cmd}: ${e.message}`);
      resolve(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

// ---------- stock releases ----------

function assetName(): string {
  const os = { linux: "Linux", darwin: "Darwin", win32: "Windows" }[process.platform as string];
  const arch = { x64: "x86_64", arm64: "arm64", ia32: "i386" }[process.arch as string];
  if (!os || !arch) throw new Error(`no act release for ${process.platform}/${process.arch}`);
  return `act_${os}_${arch}.${os === "Windows" ? "zip" : "tar.gz"}`;
}

/** Download a stock act release (checksum-verified against its checksums.txt) into the data dir. */
async function downloadRelease(version: string): Promise<string> {
  const exe = process.platform === "win32" ? "act.exe" : "act";
  const dir = path.join(paths.binDir, `act-${version}`);
  const bin = path.join(dir, exe);
  if (fs.existsSync(bin)) return bin;
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
  ensureDir(dir);
  const tmp = path.join(dir, name);
  fs.writeFileSync(tmp, archive);
  try {
    // bsdtar (macOS, Windows) reads zip too.
    await runOk("tar", ["-x", "-f", tmp, "-C", dir, exe]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function fetchBuf(url: string): Promise<Buffer> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------- doctor ----------

export interface ActReport {
  source: "patched" | "user" | "release";
  version?: string;
  /** The host's act binary, once it exists. */
  path?: string;
  /** patched: the platforms built so far, and those the host and configured guests still need. */
  built?: GoTarget[];
  missing?: GoTarget[];
  note: string;
}

/** Which act runs, and whether it's ready, without building or downloading anything. */
export async function actReport(cfg: Config = loadConfig()): Promise<ActReport> {
  const r = resolveAct(cfg);
  if (r.source === "user") {
    return {
      source: "user",
      path: r.path,
      note: r.path
        ? `act_path: CI legs on this host run your act (${r.path}) and guests run their own act from PATH; with stock act, ${STOCK_ACT_DIFFERENCES}. Remove act_path to use osmatrix's patched act.`
        : `act_path is "${r.configured}", but no such act ${/[\\/]/.test(r.configured) ? "file exists" : "is on PATH"}; CI legs fail until it does.`,
    };
  }
  if (r.source === "release") {
    const exe = path.join(paths.binDir, `act-${r.version}`, process.platform === "win32" ? "act.exe" : "act");
    return { source: "release", version: r.version, path: fs.existsSync(exe) ? exe : undefined, note: r.reason };
  }
  const version = patchedActVersion(r.key);
  const built = builtTargets(r.key);
  const missing = defaultTargets(cfg).filter((t) => !built.includes(t));
  const host = hostTarget();
  const bin = host && built.includes(host) ? patchedActBinary(r.key, host) : undefined;
  const docker = await dockerAvailable();
  let note: string;
  if (!missing.length) {
    note = `osmatrix's patched act ${version} is built for ${built.join(", ")}; a guest gets its copy pushed before its first leg.`;
  } else if (docker.ok) {
    note = `osmatrix's patched act ${version} is ${built.length ? `built for ${built.join(", ")} but not yet for` : "not built yet for"} ${missing.join(", ")}; it builds in Docker on the first \`ci run\` (a few minutes), or run \`osmatrix install-act\` now.`;
  } else {
    note = `osmatrix's patched act needs Docker to build (${docker.reason}); until it can, legs on platforms not built yet run stock act ${PATCHED_ACT_VERSION}, where ${STOCK_ACT_DIFFERENCES}.`;
  }
  return { source: "patched", version, path: bin, built, missing, note };
}
