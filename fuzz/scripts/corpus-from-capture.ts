#!/usr/bin/env bun
// Turn INSPECT_WEBKIT_CAPTURE JSONL files into per-target seed corpora.
//
//   bun fuzz/scripts/corpus-from-capture.ts <outDir> <capture.jsonl...>
//
// Writes <outDir>/<target>/<sha1> files:
//   plist-bplist  every wir-in body (Safari's bplists)
//   plist-xml     every wir-out body (our XML plists)
//   framing       runs of consecutive wir-in frames, length-prefixed
//   cdp-tools     per CDP session: "T" lines (client frames), "W" lines
//                 (Safari's inner frames) and "R" reply templates
//                 (Safari's reply to a method), in capture order
//   page-channel  same line format, several sessions interleaved
//   wir-server    "S" lines: WIR messages as JSON with typed leaves
//   front-door    request lines seen on the wire (paths only)

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "../../src/plist";

const [outDir, ...files] = process.argv.slice(2);
if (!outDir || files.length === 0) {
  console.error("usage: corpus-from-capture.ts <outDir> <capture.jsonl...>");
  process.exit(2);
}

type Rec = { t: number; k: string; b64?: string; s?: string; text?: string };
const recs: Rec[] = files.flatMap((f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec),
);

const counts: Record<string, number> = {};
function put(target: string, data: Uint8Array | string) {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  if (buf.length === 0 || buf.length > 64 * 1024) return;
  const dir = join(outDir!, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, createHash("sha1").update(buf).digest("hex")), buf);
  counts[target] = (counts[target] ?? 0) + 1;
}

const framed = (b: Buffer) => {
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32BE(b.length, 0);
  b.copy(out, 4);
  return out;
};

/** JSON with typed leaves, so the wir-server harness can rebuild plist values. */
function typed(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $data: Buffer.from(v).toString("utf8") };
  if (v instanceof Date) return { $date: v.getTime() };
  if (typeof v === "bigint") return { $big: v.toString() };
  if (Array.isArray(v)) return v.map(typed);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = typed((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

// --- WIR -------------------------------------------------------------------
const wirIn: Buffer[] = [];
const wirMsgs: Array<{ dir: "in" | "out"; m: any }> = [];
for (const r of recs) {
  if (r.k !== "wir-in" && r.k !== "wir-out") continue;
  const body = Buffer.from(r.b64!, "base64");
  put(r.k === "wir-in" ? "plist-bplist" : "plist-xml", body);
  if (r.k === "wir-in") wirIn.push(body);
  try {
    wirMsgs.push({ dir: r.k === "wir-in" ? "in" : "out", m: decode(body) });
  } catch {}
}
for (let i = 0; i < wirIn.length; i += 4) {
  // byte 0: chunking seed, byte 1: reader mix
  put("framing", Buffer.concat([Buffer.from([i % 251, 0]), ...wirIn.slice(i, i + 4).map(framed)]));
}
// wir-server: app/listing/data traffic in windows of 12 messages.
const incoming = wirMsgs.filter((x) => x.dir === "in").map((x) => "S" + JSON.stringify(typed(x.m)));
for (let i = 0; i < incoming.length; i += 12) put("wir-server", incoming.slice(i, i + 12).join("\n"));

// --- CDP (from the WIR side, so W/R lines are pre-translation) -------------
// Map each forwarded inner request id → method, per sender; then Safari's
// reply with that id becomes an R template and events become W lines.
type Line = { t: number; sender: string; line: string };
const lines: Line[] = [];
const methodById = new Map<string, string>();
for (const { dir, m } of wirMsgs) {
  const arg = m?.__argument;
  if (!arg) continue;
  const sender = String(arg.WIRSenderKey ?? arg.WIRDestinationKey ?? "");
  const data = arg.WIRSocketDataKey ?? arg.WIRMessageDataKey;
  if (!(data instanceof Uint8Array)) continue;
  let msg: any;
  try {
    msg = JSON.parse(Buffer.from(data).toString());
  } catch {
    continue;
  }
  if (dir === "out") {
    const inner = msg.method === "Target.sendMessageToTarget" ? JSON.parse(msg.params.message) : msg;
    if (typeof inner.id === "number") methodById.set(`${sender}:${inner.id}`, inner.method);
    if (inner.method && !inner.method.startsWith("Target.")) {
      lines.push({ t: 0, sender, line: "T" + JSON.stringify({ method: inner.method, params: inner.params ?? {} }) });
    }
    continue;
  }
  const inner = msg.method === "Target.dispatchMessageFromTarget" ? safeParse(msg.params?.message) : msg;
  if (!inner) continue;
  if (typeof inner.id === "number") {
    const method = methodById.get(`${sender}:${inner.id}`);
    if (method && method !== "Target.sendMessageToTarget") {
      const tpl: any = { m: method };
      if (inner.error) tpl.error = inner.error;
      else tpl.result = inner.result ?? {};
      lines.push({ t: 0, sender, line: "R" + JSON.stringify(tpl) });
    }
  } else if (inner.method) {
    lines.push({ t: 0, sender, line: "W" + JSON.stringify(inner) });
  }
}
function safeParse(s: unknown): any {
  try {
    return typeof s === "string" ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
/** Byte 0 of a CDP-harness input: reply ordering / policy schedule. */
const sched = (i: number) => String.fromCharCode(0x41 + (i % 26));
// Templates must precede the request that uses them: hoist R lines in each window.
function window(ls: string[]): string {
  const r = ls.filter((l) => l.startsWith("R"));
  return [...r, ...ls.filter((l) => !l.startsWith("R"))].join("\n");
}
const bySender = new Map<string, string[]>();
for (const l of lines) {
  if (!bySender.has(l.sender)) bySender.set(l.sender, []);
  bySender.get(l.sender)!.push(l.line);
}
for (const ls of bySender.values()) {
  for (let i = 0; i < ls.length; i += 24) put("cdp-tools", sched(i) + window(ls.slice(i, i + 24)));
}
// Client-side frames straight from the CDP capture too (post-translation input).
const cdpIn = new Map<string, string[]>();
for (const r of recs) {
  if (r.k !== "cdp-in" || !r.s?.startsWith("page:")) continue;
  if (!cdpIn.has(r.s)) cdpIn.set(r.s, []);
  try {
    const m = JSON.parse(r.text!);
    delete m.id;
    cdpIn.get(r.s)!.push("T" + JSON.stringify(m));
  } catch {}
}
for (const ls of cdpIn.values()) for (let i = 0; i < ls.length; i += 16) put("cdp-tools", sched(i) + ls.slice(i, i + 16).join("\n"));
// page-channel: the same lines, tagged with a client number (0-2).
for (const ls of bySender.values()) {
  for (let i = 0; i < ls.length; i += 30) {
    const w = ls.slice(i, i + 30).map((l, j) => (l.startsWith("T") ? `${j % 3}${l}` : l));
    put("page-channel", sched(i) + window(w));
  }
}

// --- front door ------------------------------------------------------------
for (const p of ["/json/list", "/json", "/json/version", "/json/protocol", "/", "/devtools/page/sim:fuzz:PID:1:1", "/devtools/browser/x"]) {
  put("front-door", `G ${p}\nH 127.0.0.1:9222`);
  put("front-door", `U ${p}\nH localhost:9222\nO devtools://devtools`);
}

console.log(counts);
