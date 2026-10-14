import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { ISSUES_URL, compatibility, differsFromMatrix, hostKind, type Outcome } from "./core/compat.ts";
import { doctor } from "./core/host.ts";
import { ensureDir, paths, pkgRoot } from "./core/paths.ts";
import { run, which, type RunResult } from "./core/proc.ts";
import { getGuest } from "./env.ts";

export type { Outcome } from "./core/compat.ts";

/** Disclosure per AI_POLICY.md: the report is generated, possibly by an agent for the user. */
export const DISCLOSURE = "_Drafted with `osmatrix report`._";

export interface Report {
  /** Shown to the user before anything is filed; nothing is sent by building a report. */
  title: string;
  body: string;
  labels: string[];
  /** New-issue link with the compatibility form prefilled (no account token involved). */
  url: string;
  /**
   * The saved draft: `osmatrix report-file <draft>` (MCP: host_report_file) files exactly this title and
   * body once the user agrees.
   */
  draft: string;
  compatibility: string;
  /**
   * True when this outcome is news relative to the compatibility matrix. Only then offer the report
   * to the user; a tested combination that works needs none.
   */
  differsFromMatrix: boolean;
}

export interface Identifiers {
  home: string;
  user: string;
  host: string;
  /** Other identifying strings (ssh guest endpoints, a remote DOCKER_HOST, key paths): removed verbatim. */
  secrets?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Remove what identifies the user or their machines: home directory, user and host names, endpoints. */
export function sanitize(text: string, ids: Identifiers = localIds()): string {
  let t = text;
  // Longest first, so "me@box:22" goes before "box".
  for (const s of [...new Set(ids.secrets ?? [])].filter((s) => s.length >= 2).sort((a, b) => b.length - a.length)) t = t.split(s).join("<redacted>");
  if (ids.home) t = t.split(ids.home).join("~");
  if (ids.host && ids.host.length >= 3) t = t.replace(new RegExp(`\\b${escapeRe(ids.host)}\\b`, "g"), "<host>");
  if (ids.user) {
    const u = escapeRe(ids.user);
    // A name as short as "u" can't be replaced everywhere without mangling text, so short names are
    // removed where user names appear: path segments and user@host.
    t =
      ids.user.length >= 3
        ? t.replace(new RegExp(`\\b${u}\\b`, "g"), "<user>")
        : t.replace(new RegExp(`(?<=[\\\\/])${u}(?=[\\\\/]|\\s|$)`, "gm"), "<user>").replace(new RegExp(`\\b${u}(?=@)`, "g"), "<user>");
  }
  return t;
}

function localIds(): Identifiers {
  return { home: os.homedir(), user: os.userInfo().username, host: os.hostname() };
}

/** The parts of an endpoint such as "ssh://me@box:22" or "tcp://10.0.0.2:2375" worth redacting. */
function endpointParts(e: string | undefined): string[] {
  if (!e) return [];
  const parts = [e];
  try {
    const u = new URL(e);
    parts.push(u.host, u.hostname, ...(u.username ? [u.username, `${u.username}@${u.hostname}`] : []));
  } catch {
    /* not a URL */
  }
  return parts.filter(Boolean);
}

/**
 * A compatibility report about one guest on this host, for the user to review before it is filed as a
 * GitHub issue (the osmatrix-setup skill asks for consent first). Building it sends nothing.
 */
export async function compatReport(guest: string, opts: { outcome: Outcome; notes?: string }): Promise<Report> {
  const g = getGuest(guest);
  const version = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version as string;
  const [doc, status] = await Promise.all([doctor(), g.backend.status().catch((e: Error) => ({ state: "unknown", detail: e.message }))]);
  const kind = hostKind(process.platform, process.arch, doc.host.kvm);
  const compat = compatibility(g.cfg, process.platform, process.arch, doc.host.kvm);
  const ids: Identifiers = {
    ...localIds(),
    secrets: [
      ...(g.cfg.backend === "ssh" && g.cfg.host ? [`${g.cfg.host}:${g.cfg.port ?? 22}`, g.cfg.host, ...(g.cfg.user ? [`${g.cfg.user}@${g.cfg.host}`] : [])] : []),
      ...(g.cfg.identity ? [g.cfg.identity] : []),
      ...endpointParts(doc.nesting?.dockerHost),
      ...endpointParts(process.env.DOCKER_HOST),
    ],
  };
  const { setupState } = await import("./setup.ts");
  const setup = setupState(guest);
  const hostLine = `${os.type()} ${os.release()} ${process.arch}, ${doc.host.cpus} CPUs, ${doc.host.memoryGB}G RAM`;
  const guestKind = g.cfg.backend === "ssh" ? "ssh guest" : g.cfg.os === "linux" ? "ubuntu" : g.cfg.os;

  const details = sanitize(
    [
      `**Host:** ${hostLine}`,
      `**Guest:** \`${guest}\` (${g.cfg.os}, backend \`${g.cfg.backend}\`${g.cfg.image ? `, image \`${g.cfg.image}\`` : ""}${g.cfg.accel ? `, accel \`${g.cfg.accel}\`` : ""}), compatibility matrix: ${compat}`,
      `**State:** ${status.state}${status.detail ? ` (${status.detail})` : ""}`,
      setup ? `**Setup:** phase "${setup.phase}"${setup.error ? `, error: ${setup.error}` : ""}` : "",
      "",
      opts.notes ?? "",
    ]
      .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
      .join("\n"),
    ids,
  );
  const doctorText = sanitize(YAML.stringify({ host: doc.host, tools: doc.tools, guests: doc.guests, notes: doc.notes }), ids);
  const title = `Compatibility: ${guestKind} on ${kind?.label ?? `${process.platform} ${process.arch}`}: ${opts.outcome}`;
  const body = [
    `### Outcome\n\n${opts.outcome}`,
    `### Host (row in the compatibility matrix)\n\n${kind?.label ?? "Other"}`,
    `### Guest\n\n${guestKind}`,
    `### osmatrix version\n\n${version}`,
    `### What happened\n\n${details}`,
    "### osmatrix doctor and guest status\n\n```text\n" + doctorText.trim() + "\n```",
    DISCLOSURE,
  ].join("\n\n");

  const params = new URLSearchParams({
    template: "compatibility.yml",
    title,
    outcome: opts.outcome,
    host: kind?.label ?? "Other",
    guest: guestKind,
    version,
    // The form's fields become the issue, so the disclosure rides in the details field too.
    details: `${details}\n\n${DISCLOSURE}`,
    doctor: doctorText,
  });
  // Browsers and GitHub cap URL length: drop the doctor output first, then shorten the details. The
  // body (shown to the user and used with gh) always has everything.
  const LIMIT = 7000;
  const fits = () => `${ISSUES_URL}/new?${params}`.length <= LIMIT;
  if (!fits()) params.delete("doctor");
  for (let keep = details.length; !fits() && keep > 0; keep -= 200) {
    params.set("details", details.slice(0, Math.max(0, keep - 200)) + `\n\n… (shortened; paste the full report)\n\n${DISCLOSURE}`);
  }
  const url = `${ISSUES_URL}/new?${params}`;
  const draft = saveDraft(guest, { title, body, url });
  return {
    title,
    body,
    labels: ["compatibility"],
    url,
    draft,
    compatibility: compat,
    differsFromMatrix: differsFromMatrix(compat, opts.outcome),
  };
}

// ---------- filing ----------

const REPO = "fritz-fritz/osmatrix";
const LABEL = "compatibility";

/** What a draft holds: exactly what the user was shown. */
interface Draft {
  title: string;
  body: string;
  url: string;
}

const draftsDir = () => path.join(paths.dataDir, "reports");

function saveDraft(guest: string, d: Draft): string {
  const file = path.join(ensureDir(draftsDir()), `${guest.replace(/[^\w.-]/g, "_")}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  return file;
}

/** A draft written by compatReport, and only that: the path must lie in osmatrix's reports directory. */
export function readDraft(file: string, dir = draftsDir()): Draft {
  const abs = path.resolve(file);
  if (path.dirname(abs) !== path.resolve(dir) || !abs.endsWith(".json")) {
    throw new Error(`${file} is not a report draft (drafts are saved in ${dir} by \`osmatrix report\`)`);
  }
  const d = JSON.parse(fs.readFileSync(abs, "utf8")) as Partial<Draft>;
  if (typeof d.title !== "string" || typeof d.body !== "string" || !d.title.startsWith("Compatibility: ")) {
    throw new Error(`${file} is not a compatibility report draft`);
  }
  return { title: d.title, body: d.body, url: typeof d.url === "string" ? d.url : `${ISSUES_URL}/new` };
}

export type Gh = (args: string[], input?: string) => Promise<RunResult>;
const ghCli: Gh = (args, input) => run("gh", args, { input, timeoutMs: 60_000 });

/**
 * File a saved draft on GitHub with `gh`, as the user agreed: a comment on the open report with the same
 * title (same host row, guest and outcome) when there is one, else a new issue. Only issue numbers and
 * titles are read for the match, and only the number and URL come back: other people's issue text
 * never reaches the agent.
 */
export async function fileReport(file: string, opts: { gh?: Gh; dir?: string } = {}): Promise<{ action: "created" | "commented"; number?: number; url: string }> {
  const d = readDraft(file, opts.dir);
  const gh = opts.gh ?? (which("gh") ? ghCli : undefined);
  if (!gh) throw new Error(`gh isn't installed; the user can file the report from this prefilled link instead: ${d.url}`);
  const fail = (what: string, r: RunResult) =>
    new Error(`${what} failed (${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`}); the user can file the report from this prefilled link instead: ${d.url}`);
  const list = await gh(["issue", "list", "--repo", REPO, "--label", LABEL, "--state", "open", "--search", `"${d.title}" in:title`, "--json", "number,title,url", "--limit", "50"]);
  if (list.code !== 0) throw fail("gh issue list", list);
  const same = (JSON.parse(list.stdout || "[]") as { number: number; title: string; url: string }[]).find((i) => i.title === d.title);
  if (same) {
    const r = await gh(["issue", "comment", String(same.number), "--repo", REPO, "--body-file", "-"], d.body);
    if (r.code !== 0) throw fail("gh issue comment", r);
    return { action: "commented", number: same.number, url: r.stdout.trim() || same.url };
  }
  const r = await gh(["issue", "create", "--repo", REPO, "--label", LABEL, "--title", d.title, "--body-file", "-"], d.body);
  if (r.code !== 0) throw fail("gh issue create", r);
  const url = r.stdout.trim().split("\n").pop() ?? "";
  const n = /\/issues\/(\d+)$/.exec(url)?.[1];
  return { action: "created", ...(n ? { number: Number(n) } : {}), url };
}
