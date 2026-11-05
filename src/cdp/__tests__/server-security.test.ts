// HTTP/WS surface hardening for both CDP servers (R1, R4, R5):
//   - loopback-only bind by default
//   - Host header allowlist (DNS rebinding) on HTTP + WS upgrade
//   - Origin allowlist on WS upgrade
//   - malformed request lines / percent-encoding never kill the process

import { test, expect, afterEach } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import { startCdpServer } from "../server";
import { startBunCdpServer } from "../bun-server";
import {
  freePort,
  httpGet,
  makeFakeWir,
  rawRequest,
  seedApp,
  statusOf,
  waitUntil,
  wsUpgrade,
} from "../../__tests__/helpers/fake-wir";

type Started = { stop(): void; port: number; pagePath: string };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

async function startSafari(extra: { allowOrigins?: string[]; host?: string } = {}): Promise<Started> {
  const port = await freePort();
  const rig = makeFakeWir();
  const server = await startCdpServer({
    port,
    ...extra,
    openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: rig.wi }],
  });
  cleanups.push(() => server.stop());
  seedApp(rig, [{ id: 1 }]);
  await waitUntil(() => server.getTargets().length === 1);
  return { stop: () => server.stop(), port, pagePath: "/devtools/page/sim:fake:PID:1:1" };
}

async function startBun(extra: { allowOrigins?: string[] } = {}): Promise<Started> {
  const port = await freePort();
  const upstream = "ws://127.0.0.1:1/never";
  const server = await startBunCdpServer({ port, upstreams: [{ url: upstream }], ...extra });
  cleanups.push(() => server.stop());
  return { stop: () => server.stop(), port, pagePath: `/devtools/page/${encodeURIComponent(upstream)}` };
}

const FACTORIES: Array<[string, (extra?: { allowOrigins?: string[] }) => Promise<Started>]> = [
  ["server", startSafari],
  ["bun-server", startBun],
];

async function aliveOn(port: number): Promise<boolean> {
  try {
    return statusOf(await httpGet(port, "/json/version")) === 200;
  } catch {
    return false;
  }
}

function lanIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, 500);
    s.once("connect", () => {
      clearTimeout(t);
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

for (const [name, start] of FACTORIES) {
  test(`${name}: default bind is loopback only (127.0.0.1 + ::1), not the LAN (R1)`, async () => {
    const s = await start();
    expect(await canConnect("127.0.0.1", s.port)).toBe(true);
    const hasV6 = Object.values(os.networkInterfaces()).some((l) =>
      (l ?? []).some((a) => a.family === "IPv6" && a.internal),
    );
    if (hasV6) expect(await canConnect("::1", s.port)).toBe(true);
    const lan = lanIPv4();
    if (lan) expect(await canConnect(lan, s.port)).toBe(false);
  });

  test(`${name}: HTTP with a foreign Host header is rejected with 403 (DNS rebinding)`, async () => {
    const s = await start();
    expect(statusOf(await httpGet(s.port, "/json/list", `evil.example:${s.port}`))).toBe(403);
    expect(statusOf(await httpGet(s.port, "/json/version", "evil.example"))).toBe(403);
    expect(statusOf(await httpGet(s.port, "/json/list", `localhost:${s.port}`))).toBe(200);
    expect(statusOf(await httpGet(s.port, "/json/list", `127.0.0.1:${s.port}`))).toBe(200);
    expect(statusOf(await httpGet(s.port, "/json/list", `[::1]:${s.port}`))).toBe(200);
    expect(statusOf(await httpGet(s.port, "/json/list", "LOCALHOST"))).toBe(200);
  });

  test(`${name}: requests without a Host header are allowed (chrome://inspect poller)`, async () => {
    const s = await start();
    const r = await rawRequest(s.port, "GET /json/version HTTP/1.0\r\n\r\n", { timeoutMs: 1500 });
    expect(statusOf(r)).toBe(200);
    expect(statusOf(await wsUpgrade(s.port, s.pagePath, { Host: "" }))).toBe(101);
  });

  test(`${name}: WS upgrade to an unknown target is refused with 404`, async () => {
    const s = await start();
    expect(statusOf(await wsUpgrade(s.port, "/devtools/page/nope"))).toBe(404);
    expect(await aliveOn(s.port)).toBe(true);
  });

  test(`${name}: WS upgrade with a foreign Host header is rejected with 403`, async () => {
    const s = await start();
    const r = await wsUpgrade(s.port, s.pagePath, { Host: "evil.example" });
    expect(statusOf(r)).toBe(403);
  });

  test(`${name}: WS upgrade Origin allowlist`, async () => {
    const s = await start();
    expect(statusOf(await wsUpgrade(s.port, s.pagePath, { Origin: "https://evil.example" }))).toBe(403);
    expect(statusOf(await wsUpgrade(s.port, s.pagePath, { Origin: "null" }))).toBe(403);
    expect(statusOf(await wsUpgrade(s.port, s.pagePath, { Origin: "devtools://devtools" }))).toBe(101);
    expect(statusOf(await wsUpgrade(s.port, s.pagePath))).toBe(101);
    expect(await aliveOn(s.port)).toBe(true);
  });

  test(`${name}: allowOrigins opts an extra Origin in`, async () => {
    const s = await start({ allowOrigins: ["https://ok.example"] });
    expect(statusOf(await wsUpgrade(s.port, s.pagePath, { Origin: "https://ok.example" }))).toBe(101);
    expect(statusOf(await wsUpgrade(s.port, s.pagePath, { Origin: "https://evil.example" }))).toBe(403);
  });

  test(`${name}: malformed request URL gets 400 and the server survives (R4)`, async () => {
    const s = await start();
    const r = await rawRequest(s.port, `GET //[ HTTP/1.1\r\nHost: localhost:${s.port}\r\n\r\n`);
    expect(statusOf(r)).toBe(400);
    expect(await aliveOn(s.port)).toBe(true);
  });

  test(`${name}: malformed upgrade URL gets 400 and the server survives`, async () => {
    const s = await start();
    const r = await wsUpgrade(s.port, "//[");
    expect(statusOf(r)).toBe(400);
    expect(await aliveOn(s.port)).toBe(true);
  });

  test(`${name}: bad percent-encoding in the WS path gets 400 and the server survives (R5)`, async () => {
    const s = await start();
    const r = await wsUpgrade(s.port, "/devtools/page/%E0%A4%A");
    expect(statusOf(r)).toBe(400);
    expect(await aliveOn(s.port)).toBe(true);
  });
}

test("server: explicit --host binds only what was asked for", async () => {
  const port = await freePort();
  const server = await startCdpServer({
    port,
    host: "127.0.0.1",
    openSources: async () => [],
  });
  cleanups.push(() => server.stop());
  expect(server.addresses().map((a) => a.address)).toEqual(["127.0.0.1"]);
  expect(await canConnect("::1", port)).toBe(false);
});

test("server: default bind reports exactly the loopback addresses", async () => {
  const port = await freePort();
  const server = await startCdpServer({ port, openSources: async () => [] });
  cleanups.push(() => server.stop());
  const addrs = server.addresses().map((a) => a.address).sort();
  for (const a of addrs) expect(["127.0.0.1", "::1"]).toContain(a);
  expect(addrs).toContain("127.0.0.1");
});
