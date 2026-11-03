// INSPECT_WEBKIT_CAPTURE=<dir>: raw WIR frames (both directions) and CDP
// messages from real sessions, dumped as JSONL for building fuzz corpora.

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, configureCapture } from "../capture";
import { startCdpServer } from "../cdp/server";
import { freePort, makeFakeWir, seedApp, waitUntil, wirFrame } from "./helpers/fake-wir";

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  configureCapture(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "iwk-capture-"));
  dirs.push(d);
  return d;
}

function records(dir: string): any[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return files.flatMap((f) =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
}

test("capture is off unless configured", () => {
  expect(capture.on).toBe(false);
});

test("WIR frames are captured in both directions, byte-exact", async () => {
  const dir = tmp();
  configureCapture(dir);
  expect(capture.on).toBe(true);
  const wir = makeFakeWir();
  const incoming = wirFrame("_rpc_reportConnectedApplicationList:", { WIRApplicationDictionaryKey: {} });
  wir.sock.feed(incoming);
  wir.wi.send("_rpc_getConnectedApplications:", {});
  await new Promise((r) => setTimeout(r, 10));
  const recs = records(dir);
  const wIn = recs.find((r) => r.k === "wir-in");
  const wOut = recs.find((r) => r.k === "wir-out");
  expect(wIn).toBeDefined();
  expect(Buffer.from(wIn.b64, "base64").equals(Buffer.from(incoming.subarray(4)))).toBe(true);
  expect(Buffer.from(wOut.b64, "base64").toString()).toContain("_rpc_getConnectedApplications:");
  expect(typeof wIn.t).toBe("number");
});

test("CDP messages on a page WebSocket are captured in both directions", async () => {
  const dir = tmp();
  configureCapture(dir);
  const port = await freePort();
  const wir = makeFakeWir();
  const server = await startCdpServer({
    port,
    openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: wir.wi }],
  });
  cleanups.push(() => server.stop());
  seedApp(wir, [{ id: 1 }]);
  await waitUntil(() => server.getTargets().length === 1);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/sim:fake:PID:1:1`);
  cleanups.push(() => ws.close());
  const got: any[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise<void>((r) => (ws.onopen = () => r()));
  // Answered by the bridge itself (CDP-only stub): no Safari round-trip.
  ws.send(JSON.stringify({ id: 7, method: "Page.setAdBlockingEnabled", params: { enabled: true } }));
  await waitUntil(() => got.some((m) => m.id === 7));
  await waitUntil(() => records(dir).some((r) => r.k === "cdp-out"));
  const recs = records(dir);
  const cin = recs.find((r) => r.k === "cdp-in");
  const cout = recs.find((r) => r.k === "cdp-out" && JSON.parse(r.text).id === 7);
  expect(JSON.parse(cin.text)).toEqual({ id: 7, method: "Page.setAdBlockingEnabled", params: { enabled: true } });
  expect(cout).toBeDefined();
  expect(cin.s).toBe(cout.s);
});

test("a capture directory it creates is private to the user", () => {
  const dir = join(tmp(), "new-sub");
  configureCapture(dir);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});
