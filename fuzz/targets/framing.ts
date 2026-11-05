// Length-prefixed frame readers under arbitrary chunking:
//   - WebInspectorClient's read loop (uint32 BE + plist), fed through a
//     FakeSocket in fuzz-chosen chunk sizes vs. in one piece: same messages,
//     every message a dictionary, the loop always ends on close, a throwing
//     subscriber never stops it, and the app list it tracks stays well-typed;
//   - usbmux.readFrame (uint32 LE total length incl. 16-byte header) and
//     lockdown.readFrame (uint32 BE + XML plist): same frames / same error
//     either way, and only Error rejections.
//
// Input: byte 0 picks the chunking, byte 1 the reader mix, the rest is the
// wire stream.

import type * as net from "node:net";
import { ByteStream } from "../../src/stream";
import { attachStream } from "../../src/socket";
import { WebInspectorClient, type WIMessage } from "../../src/webinspector";
import * as usbmux from "../../src/usbmux";
import * as lockdown from "../../src/lockdown";
import { FakeSocket } from "../../src/__tests__/helpers/fake-wir";
import { check, checkGlobal, harness, setupHarness } from "../lib/invariants";
import { norm } from "../lib/plist-check";

setupHarness();

/** Deterministic chunk sizes from a seed byte. */
function chunks(data: Uint8Array, seed: number): Uint8Array[] {
  if (seed === 0) return [data];
  const out: Uint8Array[] = [];
  let x = seed * 2654435761;
  let off = 0;
  const max = seed % 4 === 0 ? 3 : seed % 4 === 1 ? 17 : seed % 4 === 2 ? 300 : 5000;
  while (off < data.length) {
    x = (x * 1103515245 + 12345) >>> 0;
    const n = 1 + (x % max);
    out.push(data.subarray(off, off + n));
    off += n;
  }
  return out;
}

async function runWir(parts: Uint8Array[]): Promise<{ msgs: string[]; apps: unknown }> {
  const sock = new FakeSocket();
  const stream = new ByteStream();
  attachStream(sock as unknown as net.Socket, stream);
  const wi = new WebInspectorClient(sock as unknown as net.Socket, stream);
  const msgs: string[] = [];
  wi.subscribe(() => {
    throw new Error("subscriber failure must not stop the read loop");
  });
  wi.subscribe((m: WIMessage) => {
    check(m !== null && typeof m === "object" && !Array.isArray(m), "WIR message is not a dictionary");
    msgs.push(JSON.stringify(norm(m)));
  });
  for (const p of parts) sock.feed(p);
  sock.destroy();
  await (wi as unknown as { reading: Promise<void> }).reading;
  check(wi.closed, "WebInspectorClient not closed after its socket closed");
  const apps = (wi as unknown as { apps: Map<string, any> | null }).apps;
  if (apps) {
    for (const [id, a] of apps) {
      check(typeof id === "string" && a.appId === id, "tracked app id mismatch");
      check(typeof a.isProxy === "boolean" && typeof a.isActive === "boolean", "tracked app flags not boolean");
    }
  }
  return { msgs, apps: apps ? [...apps.keys()] : null };
}

type FrameResult = { frames: string[]; error: string | null };

async function runReader(
  parts: Uint8Array[],
  read: (s: ByteStream, sock: { destroy(): void }) => Promise<unknown>,
): Promise<FrameResult> {
  const stream = new ByteStream();
  for (const p of parts) stream.push(p);
  stream.close();
  const frames: string[] = [];
  const sock = { destroy() {} };
  for (let i = 0; i < 10_000; i++) {
    try {
      const f = await read(stream, sock);
      frames.push(JSON.stringify(norm(f)));
    } catch (e) {
      check(e instanceof Error, `frame reader rejected with a non-Error: ${String(e)}`);
      // "stream closed" at a frame boundary vs. mid-frame is the same outcome.
      return { frames, error: /stream closed/.test(e.message) ? "closed" : e.message };
    }
  }
  throw new Error("frame reader never stopped");
}

async function run(data: Uint8Array): Promise<void> {
  const seed = data[0] ?? 0;
  const mix = data[1] ?? 0;
  const body = data.subarray(2);
  const parts = chunks(body, seed);

  const a = await runWir(parts);
  const b = await runWir([body]);
  check(JSON.stringify(a) === JSON.stringify(b), "WIR messages depend on chunking");

  if (mix & 1) {
    const x = await runReader(parts, (s, k) => usbmux.readFrame(s, k));
    const y = await runReader([body], (s, k) => usbmux.readFrame(s, k));
    check(JSON.stringify(x) === JSON.stringify(y), "usbmux frames depend on chunking");
  }
  if (mix & 2) {
    const x = await runReader(parts, (s, k) => lockdown.readFrame(s, k));
    const y = await runReader([body], (s, k) => lockdown.readFrame(s, k));
    check(JSON.stringify(x) === JSON.stringify(y), "lockdown frames depend on chunking");
  }
  checkGlobal();
}

export const fuzz = harness(run);
