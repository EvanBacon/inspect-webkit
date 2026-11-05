// WebSocket frame-limit hardening for both CDP servers:
//   - the resolved `ws` is a release with fragment/chunk limits (>= 8.21.1)
//   - every CDP WebSocketServer sets maxPayload / maxFragments /
//     maxBufferedChunks explicitly instead of relying on ws defaults
//   - a client that never finishes a fragmented message is disconnected
//     (1008) and the server keeps serving HTTP afterward
//
// The close-on-limit assertions run the servers under Node via a
// node-targeted bundle (fixtures/ws-limits-harness.ts): that's what the
// published CLI ships, and it exercises the real `ws` package. Under the Bun
// runtime `import "ws"` is Bun's built-in shim, so the in-process tests only
// assert that the process survives.

import { test, expect, afterEach, afterAll, beforeAll } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
import { startCdpServer } from "../server";
import { startBunCdpServer } from "../bun-server";
import {
  WS_MAX_BUFFERED_CHUNKS,
  WS_MAX_FRAGMENTS,
  WS_MAX_PAYLOAD,
  WS_SERVER_LIMITS,
} from "../http";
import {
  freePort,
  httpGet,
  makeFakeWir,
  seedApp,
  statusOf,
  waitUntil,
} from "../../__tests__/helpers/fake-wir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

function cmpSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

test("resolved ws is >= 8.21.1", () => {
  const req = createRequire(import.meta.url);
  const version: string = req("ws/package.json").version;
  expect(cmpSemver(version, "8.21.1")).toBeGreaterThanOrEqual(0);
});

test("CDP WebSocketServer limits are explicit and tight", () => {
  expect(WS_SERVER_LIMITS).toEqual({
    maxPayload: WS_MAX_PAYLOAD,
    maxFragments: WS_MAX_FRAGMENTS,
    maxBufferedChunks: WS_MAX_BUFFERED_CHUNKS,
  });
  expect(WS_MAX_PAYLOAD).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(WS_MAX_FRAGMENTS).toBeGreaterThan(0);
  expect(WS_MAX_FRAGMENTS).toBeLessThanOrEqual(4096);
  expect(WS_MAX_BUFFERED_CHUNKS).toBeGreaterThan(0);
});

type Started = { port: number; pagePath: string };

async function startSafari(): Promise<Started> {
  const port = await freePort();
  const rig = makeFakeWir();
  const server = await startCdpServer({
    port,
    openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: rig.wi }],
  });
  cleanups.push(() => server.stop());
  seedApp(rig, [{ id: 1 }]);
  await waitUntil(() => server.getTargets().length === 1);
  return { port, pagePath: "/devtools/page/sim:fake:PID:1:1" };
}

async function startBun(): Promise<Started> {
  // A silent upstream that accepts and never closes, so the DevTools-side
  // socket stays attached for the whole test.
  const upPort = await freePort();
  const upstreamWss = new WebSocketServer({ host: "127.0.0.1", port: upPort });
  await new Promise<void>((r) => upstreamWss.once("listening", () => r()));
  cleanups.push(() => {
    for (const c of upstreamWss.clients) c.terminate();
    upstreamWss.close();
  });
  const upstream = `ws://127.0.0.1:${upPort}/inspector`;
  const port = await freePort();
  const server = await startBunCdpServer({ port, upstreams: [{ url: upstream }] });
  cleanups.push(() => server.stop());
  return { port, pagePath: `/devtools/page/${encodeURIComponent(upstream)}` };
}

/** One masked client frame with a 1-byte payload. */
function tinyFrame(opcode: number, fin: boolean): Buffer {
  // FIN|opcode, MASK|len=1, 4-byte zero mask, 1 payload byte.
  return Buffer.from([(fin ? 0x80 : 0) | opcode, 0x81, 0, 0, 0, 0, 0x61]);
}

/**
 * Open a WS on `path`, then send `count` 1-byte fragments of a single
 * never-finished text message. Resolves with whether the server closed the
 * connection and the close code it sent (if any).
 */
function floodFragments(
  port: number,
  path: string,
  count: number,
  holdMs = 3000,
): Promise<{ upgraded: boolean; closed: boolean; closeCode: number | null }> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let closeCode: number | null = null;
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ upgraded, closed, closeCode });
    };
    // If the server is still holding the connection open after this long,
    // it accepted the whole stream.
    const timer = setTimeout(() => finish(false), holdMs);

    sock.on("connect", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        upgraded = statusOf(buf.subarray(0, end).toString("latin1")) === 101;
        buf = buf.subarray(end + 4);
        if (!upgraded) return finish(true);
        const frames: Buffer[] = [tinyFrame(0x1, false)];
        for (let i = 1; i < count; i++) frames.push(tinyFrame(0x0, false));
        sock.write(Buffer.concat(frames));
      }
      // Look for a server close frame (0x88, len, code).
      const i = buf.indexOf(0x88);
      if (i >= 0 && buf.length >= i + 4) closeCode = buf.readUInt16BE(i + 2);
    });
    sock.on("error", () => finish(true));
    sock.on("close", () => finish(true));
  });
}

async function aliveOn(port: number): Promise<boolean> {
  try {
    return statusOf(await httpGet(port, "/json/version")) === 200;
  } catch {
    return false;
  }
}

for (const [name, start] of [
  ["server", startSafari],
  ["bun-server", startBun],
] as const) {
  test(`${name} (bun runtime): fragment flood does not take the server down`, async () => {
    const s = await start();
    const r = await floodFragments(s.port, s.pagePath, WS_MAX_FRAGMENTS * 4, 1000);
    expect(r.upgraded).toBe(true);
    expect(await aliveOn(s.port)).toBe(true);
    expect(statusOf(await httpGet(s.port, "/json/list"))).toBe(200);
  });
}

// --- Node runtime (real `ws`, as shipped) ---

const NODE = spawnSync("node", ["--version"]).status === 0 ? "node" : null;

let child: ChildProcess | null = null;
let nodeServers: Record<string, Started> = {};
let tmpDir: string | null = null;
let bundleHasFragmentLimit = false;

beforeAll(async () => {
  if (!NODE) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iwk-ws-limits-"));
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixtures/ws-limits-harness.ts")],
    target: "node",
    outdir: tmpDir,
  });
  if (!built.success) throw new AggregateError(built.logs, "harness build failed");
  const out = built.outputs[0]!.path;
  bundleHasFragmentLimit = fs.readFileSync(out, "utf8").includes("Too many message fragments");
  child = spawn(NODE, [out], { stdio: ["ignore", "pipe", "ignore"] });
  nodeServers = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("harness did not start")), 10_000);
    child!.stdout!.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\n").find((l) => l.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line).servers);
      }
    });
    child!.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited early (${code})`));
    });
  });
}, 30_000);

afterAll(() => {
  child?.kill("SIGKILL");
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.skipIf(!NODE)("node bundle carries ws's fragment limit (real ws, not a shim)", () => {
  expect(bundleHasFragmentLimit).toBe(true);
});

for (const name of ["server", "bun-server"] as const) {
  test.skipIf(!NODE)(`${name} (node, real ws): unfinished fragmented message past maxFragments is closed with 1008; server survives`, async () => {
    const s = nodeServers[name]!;
    // Above our explicit limit but well below ws's built-in default (16384),
    // so this fails if the explicit option is ever dropped.
    const r = await floodFragments(s.port, s.pagePath, WS_MAX_FRAGMENTS * 4);
    expect(r.upgraded).toBe(true);
    expect(r.closed).toBe(true);
    expect(r.closeCode).toBe(1008);
    expect(child!.exitCode).toBeNull();
    expect(await aliveOn(s.port)).toBe(true);
    expect(statusOf(await httpGet(s.port, "/json/list"))).toBe(200);
  });

  test.skipIf(!NODE)(`${name} (node, real ws): fragmented message under the limit is not cut off`, async () => {
    const s = nodeServers[name]!;
    const r = await floodFragments(s.port, s.pagePath, 16, 500);
    expect(r.upgraded).toBe(true);
    expect(r.closed).toBe(false);
    expect(await aliveOn(s.port)).toBe(true);
  });
}
