import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { ISSUES_URL, compatibility, hostKind } from "./core/compat.ts";
import { doctor } from "./core/host.ts";
import { pkgRoot } from "./core/paths.ts";
import { getGuest } from "./env.ts";

export type Outcome = "Works" | "Partly works" | "Doesn't work";

export interface Report {
  /** Shown to the user before anything is filed; nothing is sent by building a report. */
  title: string;
  body: string;
  labels: string[];
  /** New-issue link with the compatibility form prefilled (no account token involved). */
  url: string;
  /** Equivalent `gh` command; write `body` to the file first. */
  gh: string;
  compatibility: string;
}

/** Remove what identifies the user or their machine: home directory, user name, host name. */
export function sanitize(text: string, ids = { home: os.homedir(), user: os.userInfo().username, host: os.hostname() }): string {
  let t = text;
  if (ids.home) t = t.split(ids.home).join("~");
  for (const [v, label] of [
    [ids.host, "<host>"],
    [ids.user, "<user>"],
  ] as const) {
    // Whole words only, and never anything so short it would mangle ordinary text.
    if (v && v.length >= 3) t = t.replace(new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), label);
  }
  return t;
}

/**
 * A compatibility report about one guest on this host, for the user to review before it is filed as a
 * GitHub issue (the osmatrix-setup skill asks for consent first). Building it sends nothing.
 */
export async function compatReport(guest: string, opts: { outcome: Outcome; notes?: string }): Promise<Report> {
  const g = getGuest(guest);
  const version = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version as string;
  const kind = hostKind();
  const compat = compatibility(g.cfg);
  const [doc, status] = await Promise.all([doctor(), g.backend.status().catch((e: Error) => ({ state: "unknown", detail: e.message }))]);
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
  );
  const doctorText = sanitize(YAML.stringify({ host: doc.host, tools: doc.tools, guests: doc.guests, notes: doc.notes }));
  const title = `Compatibility: ${guestKind} on ${kind?.label ?? `${process.platform} ${process.arch}`}: ${opts.outcome}`;
  const body = [
    `### Outcome\n\n${opts.outcome}`,
    `### Host (row in the compatibility matrix)\n\n${kind?.label ?? "Other"}`,
    `### Guest\n\n${guestKind}`,
    `### osmatrix version\n\n${version}`,
    `### What happened\n\n${details}`,
    "### osmatrix doctor and guest status\n\n```text\n" + doctorText.trim() + "\n```",
  ].join("\n\n");

  const params = new URLSearchParams({
    template: "compatibility.yml",
    title,
    outcome: opts.outcome,
    host: kind?.label ?? "Other",
    guest: guestKind,
    version,
    details,
    doctor: doctorText,
  });
  // Browsers and GitHub cap URL length; the doctor output is the part worth dropping.
  if (`${ISSUES_URL}/new?${params}`.length > 7000) params.delete("doctor");
  return {
    title,
    body,
    labels: ["compatibility"],
    url: `${ISSUES_URL}/new?${params}`,
    gh: `gh issue create --repo fritz-fritz/osmatrix --label compatibility --title ${JSON.stringify(title)} --body-file <file with body>`,
    compatibility: compat,
  };
}
