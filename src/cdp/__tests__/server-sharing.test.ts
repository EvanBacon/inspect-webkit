// Several CDP clients on one page through the real server (R7): DevTools
// page WebSockets, browser-endpoint sessions and hover-highlight sessions
// share one WIR sender instead of stealing the page from each other.

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

type Client = { ws: WebSocket; closed: { code: number; reason: string } | null; messages: any[] };

async function open(url: string): Promise<Client> {
  const ws = new WebSocket(url);
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
const connect = (port: number, pageId = 1) => open(`ws://127.0.0.1:${port}/devtools/page/sim:fake:PID:1:${pageId}`);

function selectorArgs(wir: ReturnType<typeof makeFakeWir>, sel: string) {
  return wir
    .sent()
    .filter((m) => m.__selector === sel)
    .map((m) => m.__argument as any);
}

/** CDP frames the bridge wrote to `pageId`, decoded. */
function wireFrames(wir: ReturnType<typeof makeFakeWir>, pageId = 1) {
  return selectorArgs(wir, "_rpc_forwardSocketData:")
    .filter((a) => a.WIRPageIdentifierKey === pageId)
    .map((a) => ({ sender: a.WIRSenderKey as string, msg: JSON.parse(Buffer.from(a.WIRSocketDataKey).toString()) }));
}

/** Answer a frame the way Safari does, on the sender that wrote it. */
function reply(wir: ReturnType<typeof makeFakeWir>, sender: string, body: unknown, pageId = 1) {
  wir.push("_rpc_applicationSentData:", {
    WIRApplicationIdentifierKey: "PID:1",
    WIRPageIdentifierKey: pageId,
    WIRDestinationKey: sender,
    WIRMessageDataKey: Buffer.from(JSON.stringify(body)),
  });
}

/** Announce the inner page target so sessions run in target mode. */
async function announceTarget(wir: ReturnType<typeof makeFakeWir>, sender: string) {
  reply(wir, sender, { method: "Target.targetCreated", params: { targetInfo: { targetId: "page-1", type: "page" } } });
  await new Promise((r) => setTimeout(r, 20));
}

/** Answer every wrapped request so far with `result(inner)`. */
function answerWrapped(wir: ReturnType<typeof makeFakeWir>, result: (inner: any) => unknown, seen: Set<number>) {
  for (const { sender, msg } of wireFrames(wir)) {
    if (msg.method !== "Target.sendMessageToTarget" || seen.has(msg.id)) continue;
    seen.add(msg.id);
    const inner = JSON.parse(msg.params.message);
    reply(wir, sender, { result: {}, id: msg.id });
    if (typeof inner.id === "number") {
      reply(wir, sender, {
        method: "Target.dispatchMessageFromTarget",
        params: { targetId: msg.params.targetId, message: JSON.stringify({ result: result(inner), id: inner.id }) },
      });
    }
  }
}

test("two DevTools clients on one page both work concurrently (R7, lifecycle dual)", async () => {
  const { port, wir } = await rig();
  const a = await connect(port);
  await waitUntil(() => selectorArgs(wir, "_rpc_forwardSocketSetup:").length === 1);
  const sender = selectorArgs(wir, "_rpc_forwardSocketSetup:")[0].WIRSenderKey;
  await announceTarget(wir, sender);
  const b = await connect(port);
  await new Promise((r) => setTimeout(r, 30));
  expect(selectorArgs(wir, "_rpc_forwardSocketSetup:").length).toBe(1);
  a.ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "'A'" } }));
  b.ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "'B'" } }));
  const seen = new Set<number>();
  await waitUntil(() => wireFrames(wir).filter((f) => f.msg.method === "Target.sendMessageToTarget").length >= 2);
  answerWrapped(wir, (inner) => ({ result: { type: "string", value: inner.params?.expression } }), seen);
  const value = (c: Client) => c.messages.find((m) => m.id === 1)?.result?.result?.value;
  expect(await waitUntil(() => value(a) !== undefined && value(b) !== undefined)).toBe(true);
  expect([value(a), value(b)]).toEqual(["'A'", "'B'"]);
  expect(a.closed).toBeNull();
  expect(b.closed).toBeNull();

  // A leaves: B keeps the page, the sender stays.
  a.ws.close();
  await waitUntil(() => a.closed !== null);
  await new Promise((r) => setTimeout(r, 30));
  expect(selectorArgs(wir, "_rpc_forwardDidClose:")).toEqual([]);
  b.ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "'B2'" } }));
  await waitUntil(() => wireFrames(wir).filter((f) => f.msg.method === "Target.sendMessageToTarget").length >= 3);
  answerWrapped(wir, (inner) => ({ result: { value: inner.params?.expression } }), seen);
  expect(await waitUntil(() => b.messages.some((m) => m.id === 2))).toBe(true);
  // B leaves: now the sender is released, exactly once.
  b.ws.close();
  expect(await waitUntil(() => selectorArgs(wir, "_rpc_forwardDidClose:").length === 1)).toBe(true);
  expect(selectorArgs(wir, "_rpc_forwardDidClose:")[0].WIRSenderKey).toBe(sender);
});

test("page death closes every client on that page with 1011, and only that page's", async () => {
  const { port, wir } = await rig();
  const a = await connect(port, 1);
  const b = await connect(port, 1);
  const other = await connect(port, 2);
  sendListing(wir, "PID:1", [{ id: 2 }]);
  sendListing(wir, "PID:1", [{ id: 2 }]);
  expect(await waitUntil(() => a.closed !== null && b.closed !== null)).toBe(true);
  expect([a.closed!.code, b.closed!.code]).toEqual([1011, 1011]);
  expect(a.closed!.reason).toMatch(/inspected page is gone/);
  expect(other.closed).toBeNull();
  // One sender per page: two setups, one didClose (page 1).
  expect(selectorArgs(wir, "_rpc_forwardSocketSetup:").length).toBe(2);
  expect(selectorArgs(wir, "_rpc_forwardDidClose:").map((x) => x.WIRPageIdentifierKey)).toEqual([1]);
});

test("browser-endpoint sessions share a page with a live DevTools session, auto or explicit", async () => {
  const { port, wir } = await rig();
  const page = await connect(port, 1);
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any;
  const bws = await open(version.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"));
  bws.ws.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } }));
  expect(await waitUntil(() => bws.messages.some((f) => f.id === 1))).toBe(true);
  const attached = bws.messages
    .filter((f) => f.method === "Target.attachedToTarget")
    .map((f) => f.params.targetInfo.targetId)
    .sort();
  expect(attached).toEqual(["sim:fake:PID:1:1", "sim:fake:PID:1:2"]);
  bws.ws.send(JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: "sim:fake:PID:1:1", flatten: true } }));
  expect(await waitUntil(() => bws.messages.some((f) => f.id === 2))).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  expect(page.closed).toBeNull();
  expect(selectorArgs(wir, "_rpc_forwardDidClose:")).toEqual([]);
  // Page 1 has one sender, shared.
  expect(selectorArgs(wir, "_rpc_forwardSocketSetup:").filter((a) => a.WIRPageIdentifierKey === 1).length).toBe(1);
});

test("a hover highlight joins a page DevTools is using without resetting its DOM state", async () => {
  const { port, wir, server } = await rig();
  const page = await connect(port, 1);
  await waitUntil(() => selectorArgs(wir, "_rpc_forwardSocketSetup:").length === 1);
  const sender = selectorArgs(wir, "_rpc_forwardSocketSetup:")[0].WIRSenderKey;
  await announceTarget(wir, sender);
  const seen = new Set<number>();
  const answering = setInterval(
    () =>
      answerWrapped(
        wir,
        (inner) => (inner.method === "Runtime.evaluate" ? { result: { type: "object", objectId: "obj-1" } } : {}),
        seen,
      ),
    5,
  );
  cleanups.push(() => clearInterval(answering));
  await server.highlightTarget("sim:fake:PID:1:1", true);
  const methods = wireFrames(wir)
    .filter((f) => f.msg.method === "Target.sendMessageToTarget")
    .map((f) => JSON.parse(f.msg.params.message));
  // DOM.getDocument would reset WebKit's node ids under DevTools' feet.
  expect(methods.map((m) => m.method)).not.toContain("DOM.getDocument");
  const hl = methods.find((m) => m.method === "DOM.highlightNode");
  expect(hl?.params?.objectId).toBe("obj-1");
  expect(selectorArgs(wir, "_rpc_forwardSocketSetup:").length).toBe(1);
  server.releaseHighlight();
  await new Promise((r) => setTimeout(r, 30));
  expect(page.closed).toBeNull();
  expect(selectorArgs(wir, "_rpc_forwardDidClose:")).toEqual([]);
});

test("browser endpoint keeps an attached session across a single listing miss", async () => {
  const { port, wir } = await rig();
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any;
  const bws = await open(version.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"));
  bws.ws.send(JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } }));
  bws.ws.send(JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: "sim:fake:PID:1:1", flatten: true } }));
  expect(await waitUntil(() => bws.messages.some((f) => f.id === 2))).toBe(true);
  // One miss (e.g. the listing during a navigation): the session survives
  // the browser endpoint's next discovery pump.
  sendListing(wir, "PID:1", [{ id: 2 }]);
  await new Promise((r) => setTimeout(r, 1300));
  expect(bws.messages.filter((f) => f.method === "Target.detachedFromTarget")).toEqual([]);
  expect(bws.messages.filter((f) => f.method === "Target.targetDestroyed")).toEqual([]);
  sendListing(wir, "PID:1", [{ id: 1 }, { id: 2 }]);
  // Gone for good (2 misses): the server ends the session, then the target.
  sendListing(wir, "PID:1", [{ id: 2 }]);
  sendListing(wir, "PID:1", [{ id: 2 }]);
  expect(await waitUntil(() => bws.messages.some((f) => f.method === "Target.targetDestroyed"), 3000)).toBe(true);
  const order = bws.messages.map((f) => f.method).filter((m) => m === "Target.detachedFromTarget" || m === "Target.targetDestroyed");
  expect(order).toEqual(["Target.detachedFromTarget", "Target.targetDestroyed"]);
});
