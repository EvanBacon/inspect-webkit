// Session lifecycle in the Safari CDP server, driven through a fake WIR
// source: a dead source / disconnected app / vanished page must close the
// DevTools WebSocket (R6) instead of leaving it hanging, and a second
// attach to the same page replaces the first instead of silently wedging
// it (R7).

import { test, expect, afterEach } from "bun:test";
import { startCdpServer, type CdpServer } from "../server";
import {
  freePort,
  makeFakeWir,
  seedApp,
  sendListing,
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

async function rig(pages = [{ id: 1 }, { id: 2 }]) {
  const port = await freePort();
  const wir = makeFakeWir();
  const server: CdpServer = await startCdpServer({
    port,
    pageGoneGraceMs: 0,
    openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: wir.wi }],
  });
  cleanups.push(() => server.stop());
  seedApp(wir, pages);
  await waitUntil(() => server.getTargets().length === pages.length);
  return { port, wir, server };
}

type Client = {
  ws: WebSocket;
  closed: { code: number; reason: string } | null;
  messages: any[];
};

async function connect(port: number, pageId = 1): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/sim:fake:PID:1:${pageId}`);
  const c: Client = { ws, closed: null, messages: [] };
  ws.onmessage = (e) => c.messages.push(JSON.parse(String(e.data)));
  ws.onclose = (e) => (c.closed = { code: e.code, reason: e.reason });
  cleanups.push(() => {
    try {
      ws.close();
    } catch {}
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  return c;
}

function setupsFor(wir: ReturnType<typeof makeFakeWir>, sel: string) {
  return wir
    .sent()
    .filter((m) => m.__selector === sel)
    .map((m) => (m.__argument as any).WIRSenderKey as string);
}

test("source close closes attached DevTools WS with 1011 (R6)", async () => {
  const { port, wir } = await rig();
  const c = await connect(port);
  await waitUntil(() => setupsFor(wir, "_rpc_forwardSocketSetup:").length === 1);
  wir.sock.emit("close");
  expect(await waitUntil(() => c.closed !== null)).toBe(true);
  expect(c.closed!.code).toBe(1011);
  expect(c.closed!.reason).toMatch(/disconnect|closed/i);
});

test("_rpc_applicationDisconnected closes that app's sessions (R6)", async () => {
  const { port, wir, server } = await rig();
  const c = await connect(port);
  wir.push("_rpc_applicationDisconnected:", { WIRApplicationIdentifierKey: "PID:1" });
  expect(await waitUntil(() => c.closed !== null)).toBe(true);
  expect(c.closed!.code).toBe(1011);
  expect(server.getTargets().length).toBe(0);
});

test("page missing from 2 consecutive listings closes its session; 1 miss does not (R6)", async () => {
  const { port, wir } = await rig();
  const c1 = await connect(port, 1);
  const c2 = await connect(port, 2);
  sendListing(wir, "PID:1", [{ id: 2 }]);
  await new Promise((r) => setTimeout(r, 100));
  expect(c1.closed).toBeNull();
  sendListing(wir, "PID:1", [{ id: 2 }]);
  expect(await waitUntil(() => c1.closed !== null)).toBe(true);
  expect(c1.closed!.code).toBe(1011);
  expect(c2.closed).toBeNull();
});

test("a page that reappears resets the miss counter", async () => {
  const { port, wir } = await rig();
  const c1 = await connect(port, 1);
  sendListing(wir, "PID:1", [{ id: 2 }]);
  sendListing(wir, "PID:1", [{ id: 1 }, { id: 2 }]);
  sendListing(wir, "PID:1", [{ id: 2 }]);
  await new Promise((r) => setTimeout(r, 100));
  expect(c1.closed).toBeNull();
});

test("second attach to the same page replaces the first with 1011 (R7)", async () => {
  const { port, wir } = await rig();
  const a = await connect(port, 1);
  await waitUntil(() => setupsFor(wir, "_rpc_forwardSocketSetup:").length === 1);
  const b = await connect(port, 1);
  expect(await waitUntil(() => a.closed !== null)).toBe(true);
  expect(a.closed!.code).toBe(1011);
  expect(a.closed!.reason).toMatch(/replaced by a newer DevTools session/);
  expect(b.closed).toBeNull();
  // Old sender was released before the new one was set up.
  const setups = setupsFor(wir, "_rpc_forwardSocketSetup:");
  const closes = setupsFor(wir, "_rpc_forwardDidClose:");
  expect(setups.length).toBe(2);
  expect(closes).toContain(setups[0]!);
  const msgs = wir.sent().map((m) => `${m.__selector}${(m.__argument as any).WIRSenderKey}`);
  expect(msgs.indexOf(`_rpc_forwardDidClose:${setups[0]}`)).toBeLessThan(
    msgs.indexOf(`_rpc_forwardSocketSetup:${setups[1]}`),
  );
});

test("hostile frames over a real WS do not kill the server (R2/R3)", async () => {
  const { port, server } = await rig();
  const c = await connect(port, 1);
  for (const f of [
    "null",
    "[]",
    "1",
    '{"id":1,"method":"DOM.pushNodesByBackendIdsToFrontend","params":{"backendNodeIds":"x"}}',
    '{"id":2,"method":"DOM.setInspectMode","params":"x"}',
    '{"id":3,"method":"Network.setCacheDisabled","params":"x"}',
    '{"id":4,"method":"Runtime.evaluate","params":"x"}',
  ])
    c.ws.send(f);
  await new Promise((r) => setTimeout(r, 400));
  expect(c.closed).toBeNull();
  expect(server.getTargets().length).toBe(2);
  const r = await fetch(`http://127.0.0.1:${port}/json/version`);
  expect(r.status).toBe(200);
});

test("an app dropped from a full application list closes its sessions", async () => {
  const { port, wir } = await rig();
  const c = await connect(port, 1);
  wir.push("_rpc_reportConnectedApplicationList:", { WIRApplicationDictionaryKey: {} });
  expect(await waitUntil(() => c.closed !== null)).toBe(true);
  expect(c.closed!.code).toBe(1011);
});

test("browser-endpoint auto-attach does not steal a page from a live DevTools session", async () => {
  const { port } = await rig();
  const page = await connect(port, 1);
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any;
  const bws = new WebSocket(version.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"));
  const frames: any[] = [];
  bws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  cleanups.push(() => bws.close());
  await new Promise<void>((r) => (bws.onopen = () => r()));
  bws.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } }));
  expect(await waitUntil(() => frames.some((f) => f.id === 1))).toBe(true);
  const attached = frames
    .filter((f) => f.method === "Target.attachedToTarget")
    .map((f) => f.params.targetInfo.targetId);
  expect(attached).toEqual(["sim:fake:PID:1:2"]);
  await new Promise((r) => setTimeout(r, 100));
  expect(page.closed).toBeNull();
  // An explicit attach still wins (newest explicit session).
  bws.send(JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: "sim:fake:PID:1:1", flatten: true } }));
  expect(await waitUntil(() => page.closed !== null)).toBe(true);
  expect(page.closed!.reason).toMatch(/replaced/);
});
