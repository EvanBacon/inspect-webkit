// Traffic capture for building fuzz corpora.
//
// INSPECT_WEBKIT_CAPTURE=<dir> appends every raw WIR frame body (both
// directions, before decode / after encode) and every CDP message on a
// client WebSocket to <dir>/capture-<pid>-<time>.jsonl, one JSON record per
// line:
//
//   {"t":<ms>,"k":"wir-in"|"wir-out","b64":"<plist bytes>"}
//   {"t":<ms>,"k":"cdp-in"|"cdp-out","s":"<session>","text":"<frame>"}
//
// Off by default. When off, each hook site costs one property read
// (`capture.on`), and nothing here allocates. Captures contain page
// contents and anything typed into DevTools: treat them as sensitive.

import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

type CdpDir = "cdp-in" | "cdp-out";

let fd: number | null = null;
let sessionSeq = 0;

export const capture = {
  /** True when a capture directory is configured. Check before calling the hooks. */
  on: false,

  wir(dir: "in" | "out", body: Uint8Array): void {
    write({
      t: Date.now(),
      k: dir === "in" ? "wir-in" : "wir-out",
      b64: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64"),
    });
  },

  cdp(dir: "in" | "out", session: string, text: string): void {
    write({ t: Date.now(), k: (dir === "in" ? "cdp-in" : "cdp-out") as CdpDir, s: session, text });
  },

  /** A label for one client connection, unique within this process. */
  session(kind: string): string {
    return `${kind}#${++sessionSeq}`;
  },
};

function write(rec: object): void {
  if (fd === null) return;
  try {
    writeSync(fd, JSON.stringify(rec) + "\n");
  } catch (e) {
    console.error(`warn: capture disabled: ${(e as Error)?.message ?? e}`);
    configureCapture(null);
  }
}

/** Start capturing into `dir` (created if needed), or stop with null. */
export function configureCapture(dir: string | null): void {
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch {}
    fd = null;
  }
  capture.on = false;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(join(dir, `capture-${process.pid}-${Date.now()}.jsonl`), "a", 0o600);
    capture.on = true;
  } catch (e) {
    console.error(`warn: INSPECT_WEBKIT_CAPTURE: ${(e as Error)?.message ?? e}`);
  }
}

if (process.env.INSPECT_WEBKIT_CAPTURE) configureCapture(process.env.INSPECT_WEBKIT_CAPTURE);
