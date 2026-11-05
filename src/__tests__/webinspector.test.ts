// WebInspectorClient regression tests over an in-memory socket.

import { test, expect } from "bun:test";
import { frame, makeFakeWir, sendListing, waitUntil } from "./helpers/fake-wir";

test("getListing(appId) ignores listings for other apps (R9)", async () => {
  const rig = makeFakeWir();
  const pA = rig.wi.getListing("PID:A");
  const pB = rig.wi.getListing("PID:B");
  // B answers first, then A — interleaved.
  sendListing(rig, "PID:B", [{ id: 7, url: "https://b.example/" }]);
  sendListing(rig, "PID:A", [{ id: 1, url: "https://a.example/" }, { id: 2 }]);
  const [a, b] = await Promise.all([pA, pB]);
  expect(a.map((p) => p.pageId).sort()).toEqual([1, 2]);
  expect(b.map((p) => p.pageId)).toEqual([7]);
  expect(b[0]!.url).toBe("https://b.example/");
});

test("an undecodable frame is skipped, not fatal to the read loop (R12)", async () => {
  const rig = makeFakeWir();
  const seen: string[] = [];
  rig.wi.subscribe((m) => seen.push(String(m.__selector)));
  // Garbage body with a valid length prefix.
  rig.sock.feed(frame(new TextEncoder().encode("<<<not a plist>>>")));
  // bplist header with nonsense trailer.
  rig.sock.feed(frame(new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0xff])));
  rig.push("_rpc_applicationConnected:", { WIRApplicationIdentifierKey: "PID:9" });
  expect(await waitUntil(() => seen.includes("_rpc_applicationConnected:"))).toBe(true);
  expect(rig.sock.destroyed).toBe(false);
});

test("stream close emits onClose and destroys the socket (R12)", async () => {
  const rig = makeFakeWir();
  let closed = 0;
  rig.wi.onClose(() => closed++);
  rig.sock.emit("close");
  expect(await waitUntil(() => closed === 1)).toBe(true);
  expect(rig.sock.destroyed).toBe(true);
  expect(rig.wi.closed).toBe(true);
  // onClose after the fact still fires.
  let late = 0;
  rig.wi.onClose(() => late++);
  expect(await waitUntil(() => late === 1)).toBe(true);
});

test("an oversized frame length tears the connection down", async () => {
  const rig = makeFakeWir();
  let closed = false;
  rig.wi.onClose(() => (closed = true));
  const hdr = new Uint8Array(4);
  new DataView(hdr.buffer).setUint32(0, 0xffffffff, false);
  rig.sock.feed(hdr);
  expect(await waitUntil(() => closed)).toBe(true);
  expect(rig.sock.destroyed).toBe(true);
});

test("each outgoing frame is a single socket.write", () => {
  const rig = makeFakeWir();
  const before = rig.sock.writes.length;
  rig.wi.forwardSocketData("PID:1", 1, "s", new Uint8Array(1000));
  expect(rig.sock.writes.length - before).toBe(1);
  const msgs = rig.sent();
  const last = msgs[msgs.length - 1]!;
  expect(last.__selector).toBe("_rpc_forwardSocketData:");
});

test("send after close does not throw", async () => {
  const rig = makeFakeWir();
  rig.sock.emit("close");
  await waitUntil(() => rig.wi.closed);
  expect(() => rig.wi.send("_rpc_reportIdentifier:", {})).not.toThrow();
});
