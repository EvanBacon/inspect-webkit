// The CDP server on top of a SourceManager: listen() never waits for
// sources, sources that become ready later show up, ids are stable across
// a webinspectord reconnect, and source state is exposed.

import { test, expect, afterEach } from "bun:test";
import { startCdpServer, type CdpServer } from "../server";
import { SourceManager, type SourceDescriptor, type SourceDiscovery } from "../../core/source-manager";
import { freePort, makeFakeDaemon, waitUntil } from "../../__tests__/helpers/fake-wir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

function staticDiscovery(descs: SourceDescriptor[]): SourceDiscovery {
  return { ready: Promise.resolve(), start: (cb) => cb(descs), refresh() {}, stop() {} };
}

async function serverWith(desc: SourceDescriptor) {
  const port = await freePort();
  const manager = new SourceManager({
    discoveries: [staticDiscovery([desc])],
    backoffBaseMs: 20,
    backoffMaxMs: 50,
    connectTimeoutMs: 5_000,
  });
  cleanups.push(() => manager.stop());
  const t0 = Date.now();
  const server: CdpServer = await startCdpServer({ port, sourceManager: manager });
  const startMs = Date.now() - t0;
  cleanups.push(() => server.stop());
  const list = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
  return { port, server, manager, startMs, list };
}

test("listen() does not wait for a slow / stuck source (#6)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const daemons: ReturnType<typeof makeFakeDaemon>[] = [];
  const desc: SourceDescriptor = {
    id: "sim:SLOW",
    kind: "simulator",
    udid: "SLOW",
    label: "Slow Sim",
    endpoint: "/tmp/slow",
    async open() {
      await gate;
      const d = makeFakeDaemon({ pages: [{ id: 1, url: "https://example.com/" }] });
      daemons.push(d);
      return { wi: d.wi };
    },
  };
  const s = await serverWith(desc);
  expect(s.startMs).toBeLessThan(500);
  expect(await s.list()).toEqual([]);
  expect(s.server.getSources().map((x) => [x.id, x.state])).toEqual([["sim:SLOW", "connecting"]]);
  release();
  expect(await waitUntil(() => s.server.getTargets().length === 1, 2000)).toBe(true);
  const [t] = await s.list();
  expect(t.id).toBe("sim:SLOW:PID:1:1");
  expect(t.description).toContain("Slow Sim");
  expect(s.server.getSources()[0]!.state).toBe("ready");
});

test("target ids are stable (UDID-based) across a webinspectord reconnect", async () => {
  const daemons: ReturnType<typeof makeFakeDaemon>[] = [];
  const desc: SourceDescriptor = {
    id: "sim:UDID-1",
    kind: "simulator",
    udid: "UDID-1",
    label: "Sim",
    endpoint: "/tmp/s",
    async open() {
      const d = makeFakeDaemon({ pages: [{ id: 1 }] });
      daemons.push(d);
      return { wi: d.wi };
    },
  };
  const s = await serverWith(desc);
  expect(await waitUntil(() => s.server.getTargets().length === 1, 2000)).toBe(true);
  const before = (await s.list()).map((t) => t.id);
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/devtools/page/${before[0]}`);
  let closed: { code: number } | null = null;
  ws.onclose = (e) => (closed = { code: e.code });
  cleanups.push(() => ws.close());
  await new Promise<void>((r) => (ws.onopen = () => r()));
  daemons[0]!.sock.emit("close"); // daemon died
  expect(await waitUntil(() => closed !== null, 2000)).toBe(true);
  expect(closed!.code).toBe(1011);
  expect(await waitUntil(() => daemons.length === 2 && s.server.getTargets().length === 1, 3000)).toBe(true);
  expect((await s.list()).map((t) => t.id)).toEqual(before);
});

test("stop() detaches the server from sources that outlive it (caller-owned manager)", async () => {
  const daemons: ReturnType<typeof makeFakeDaemon>[] = [];
  const desc: SourceDescriptor = {
    id: "sim:KEEP",
    kind: "simulator",
    udid: "KEEP",
    label: "Sim",
    endpoint: "/tmp/k",
    async open() {
      const d = makeFakeDaemon({ pages: [{ id: 1 }] });
      daemons.push(d);
      return { wi: d.wi };
    },
  };
  const s = await serverWith(desc);
  expect(await waitUntil(() => s.server.getTargets().length === 1, 2000)).toBe(true);
  const wi = daemons[0]!.wi as any;
  const base = { subs: wi.subscribers.size, closes: wi.closeHandlers.size };
  s.server.stop();
  expect(wi.subscribers.size).toBeLessThan(base.subs);
  expect(wi.closeHandlers.size).toBeLessThan(base.closes);
  // The manager (still running) must not see the stopped server react.
  const before = daemons[0]!.sent().filter((m) => m.__selector === "_rpc_forwardGetListing:").length;
  daemons[0]!.push("_rpc_applicationConnected:", {
    WIRApplicationIdentifierKey: "PID:9",
    WIRApplicationBundleIdentifierKey: "com.example",
    WIRIsApplicationProxyKey: false,
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(daemons[0]!.sent().filter((m) => m.__selector === "_rpc_forwardGetListing:").length).toBe(before);
});
