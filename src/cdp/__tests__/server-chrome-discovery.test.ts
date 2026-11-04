// chrome://inspect "Discover network targets" (issue #1).
//
// Chrome polls each configured host:port with its own minimal HTTP client
// (chrome/browser/devtools/device/android_device_manager.cc), sending exactly
//   GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:<port>\r\n\r\n
// and frames the body by Content-Length only — it doesn't decode
// `Transfer-Encoding: chunked`. A chunked answer reads as an empty body, so
// the target list comes out empty and chrome://inspect shows the
// "Remote Target" header with no pages under it.

import { test, expect, afterEach } from "bun:test";
import * as net from "node:net";
import { startCdpServer } from "../server";
import { startBunCdpServer } from "../bun-server";
import { freePort, makeFakeWir, seedApp, waitUntil } from "../../__tests__/helpers/fake-wir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

type Parsed = { status: number; headers: Map<string, string>; body: string };

/**
 * Model of Chrome's discovery client: Chrome's request bytes, a keep-alive
 * socket, the body framed by Content-Length (missing = empty body).
 */
function chromeGet(port: number, path: string): Promise<Parsed> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    let buf = Buffer.alloc(0);
    const finish = () => {
      clearTimeout(timer);
      sock.destroy();
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return reject(new Error(`no response head: ${JSON.stringify(buf.toString("latin1"))}`));
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(lines[0]!.split(" ")[1]);
      const headers = new Map<string, string>();
      for (const l of lines.slice(1)) {
        const i = l.indexOf(":");
        headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
      }
      const len = Number(headers.get("content-length") ?? 0);
      resolve({ status, headers, body: buf.subarray(end + 4, end + 4 + len).toString("utf8") });
    };
    const timer = setTimeout(finish, 1500);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const m = /\r\ncontent-length:\s*(\d+)/i.exec(buf.subarray(0, end + 2).toString("latin1"));
      if (m && buf.length >= end + 4 + Number(m[1])) finish();
    });
    sock.on("error", reject);
    sock.on("connect", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
  });
}

async function startSafari(): Promise<number> {
  const port = await freePort();
  const rig = makeFakeWir();
  const server = await startCdpServer({
    port,
    openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: rig.wi }],
  });
  cleanups.push(() => server.stop());
  seedApp(rig, [{ id: 1 }]);
  await waitUntil(() => server.getTargets().length === 1);
  return port;
}

async function startBun(): Promise<number> {
  const port = await freePort();
  const server = await startBunCdpServer({ port, upstreams: [{ url: "ws://127.0.0.1:1/never" }] });
  cleanups.push(() => server.stop());
  return port;
}

for (const [name, start] of [
  ["server", startSafari],
  ["bun-server", startBun],
] as const) {
  for (const path of ["/json/version", "/json/list", "/json", "/"]) {
    test(`${name}: ${path} answers with a Content-Length body, not chunked (chrome://inspect)`, async () => {
      const port = await start();
      const r = await chromeGet(port, path);
      expect(r.status).toBe(200);
      expect(r.headers.get("transfer-encoding")).toBeUndefined();
      expect(r.headers.get("content-length")).toBeDefined();
      expect(r.body.length).toBeGreaterThan(0);
      if (path !== "/") JSON.parse(r.body);
    });
  }

  test(`${name}: error answers carry a Content-Length too`, async () => {
    const port = await start();
    const r = await chromeGet(port, "/nope");
    expect(r.status).toBe(404);
    expect(r.headers.get("transfer-encoding")).toBeUndefined();
    expect(r.body).toBe("not found");
  });
}

test("server: chrome://inspect sees the page in /json/list", async () => {
  const port = await startSafari();
  const list = JSON.parse((await chromeGet(port, "/json/list")).body);
  expect(list).toHaveLength(1);
  expect(list[0].webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/devtools/page/sim:fake:PID:1:1`);
});
