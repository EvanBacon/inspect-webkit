// Unit tests for the browser-level CDP multiplexer driven by a fake ws.
// Exercises the protocol shape vscode-js-debug's pwa-chrome attach uses:
//   1. Target.attachToBrowserTarget     — allocate browser session
//   2. Target.setDiscoverTargets        — emit Target.targetCreated for each
//   3. Target.attachToTarget            — allocate page session
//   4. flatten-mode routing             — sessionId at top level
//   5. Target.detachFromTarget          — teardown

import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  attachBrowserWs,
  type BrowserEntry,
  type PageSessionHandle,
} from "../browser-endpoint";

type Frame = Record<string, any>;

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: Frame[] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  // Driven from the test side: simulate a frame arriving from the client.
  feed(frame: Frame) {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }
  byMethod(method: string): Frame[] {
    return this.sent.filter((f) => f.method === method);
  }
  byId(id: number): Frame | undefined {
    return this.sent.find((f) => f.id === id);
  }
}

type FakePage = {
  targetId: string;
  closed: boolean;
  inbox: string[];
  send: (text: string) => void;
};

function makeRig(initialEntries: BrowserEntry[]) {
  let entries = [...initialEntries];
  const pages: FakePage[] = [];

  const ws = new FakeWs();
  attachBrowserWs(ws as any, {
    listEntries: () => entries,
    createPageSession: (targetId, send): PageSessionHandle => {
      const page: FakePage = { targetId, closed: false, inbox: [], send };
      pages.push(page);
      return {
        onMessageFromTools(text: string) {
          page.inbox.push(text);
        },
        close() {
          page.closed = true;
        },
      };
    },
    refreshMs: 60_000, // disable polling churn during tests
  });

  return {
    ws,
    pages,
    setEntries(next: BrowserEntry[]) {
      entries = [...next];
    },
  };
}

const PAGE_A: BrowserEntry = {
  targetId: "sim:1:app:1",
  type: "page",
  title: "Vite",
  url: "http://localhost:5173/",
};
const PAGE_B: BrowserEntry = {
  targetId: "sim:1:app:2",
  type: "page",
  title: "Other",
  url: "https://example.com/",
};

test("Target.attachToBrowserTarget allocates a stable session id", () => {
  const { ws } = makeRig([]);

  ws.feed({ id: 1, method: "Target.attachToBrowserTarget" });
  ws.feed({ id: 2, method: "Target.attachToBrowserTarget" });

  const r1 = ws.byId(1)!;
  const r2 = ws.byId(2)!;
  expect(typeof r1.result.sessionId).toBe("string");
  expect(r2.result.sessionId).toBe(r1.result.sessionId);
});

test("setDiscoverTargets emits Target.targetCreated for each existing entry", () => {
  const { ws } = makeRig([PAGE_A, PAGE_B]);

  ws.feed({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } });

  expect(ws.byId(1)!.result).toEqual({});
  const created = ws.byMethod("Target.targetCreated");
  expect(created.map((f) => f.params.targetInfo.targetId).sort()).toEqual(
    [PAGE_A.targetId, PAGE_B.targetId].sort(),
  );
  for (const f of created) {
    expect(f.params.targetInfo.type).toBe("page");
    expect(f.params.targetInfo.attached).toBe(false);
  }
});

test("browser-scope events carry the browser sessionId once allocated", () => {
  const { ws } = makeRig([PAGE_A]);

  // Open a browser session first, then enable discovery via that envelope.
  ws.feed({ id: 1, method: "Target.attachToBrowserTarget" });
  const browserSid = ws.byId(1)!.result.sessionId as string;

  ws.feed({
    id: 2,
    sessionId: browserSid,
    method: "Target.setDiscoverTargets",
    params: { discover: true },
  });

  // Reply carries the envelope sessionId.
  expect(ws.byId(2)!.sessionId).toBe(browserSid);
  // Spontaneous targetCreated also carries it.
  const created = ws.byMethod("Target.targetCreated");
  expect(created.length).toBe(1);
  expect(created[0].sessionId).toBe(browserSid);
});

test("setAutoAttach attaches existing pages and emits attachedToTarget", () => {
  const { ws, pages } = makeRig([PAGE_A, PAGE_B]);

  ws.feed({
    id: 1,
    method: "Target.setAutoAttach",
    params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
  });

  expect(ws.byId(1)!.result).toEqual({});
  const attached = ws.byMethod("Target.attachedToTarget");
  expect(attached.length).toBe(2);
  expect(pages.length).toBe(2);

  const sids = attached.map((f) => f.params.sessionId);
  expect(new Set(sids).size).toBe(2); // distinct session ids
  for (const f of attached) {
    expect(f.params.targetInfo.attached).toBe(true);
  }
});

test("flatten-mode page command routes to the correct session and reply gets the sessionId", () => {
  const { ws, pages } = makeRig([PAGE_A]);

  ws.feed({ id: 1, method: "Target.attachToTarget", params: { targetId: PAGE_A.targetId } });
  const pageSid = ws.byId(1)!.result.sessionId as string;
  expect(pages.length).toBe(1);

  // Command with flatten sessionId.
  ws.feed({
    id: 99,
    sessionId: pageSid,
    method: "Runtime.evaluate",
    params: { expression: "1+2" },
  });

  // Page session received the command without sessionId.
  expect(pages[0].inbox.length).toBe(1);
  const inner = JSON.parse(pages[0].inbox[0]);
  expect(inner).toEqual({ id: 99, method: "Runtime.evaluate", params: { expression: "1+2" } });

  // Page session response gets sessionId injected on the way out.
  pages[0].send(JSON.stringify({ id: 99, result: { value: 3 } }));
  const reply = ws.sent.find((f) => f.id === 99 && f.sessionId === pageSid);
  expect(reply).toBeTruthy();
  expect(reply!.result).toEqual({ value: 3 });
});

test("legacy Target.sendMessageToTarget forwards the inner payload", () => {
  const { ws, pages } = makeRig([PAGE_A]);

  ws.feed({ id: 1, method: "Target.attachToTarget", params: { targetId: PAGE_A.targetId } });
  const pageSid = ws.byId(1)!.result.sessionId as string;

  const inner = JSON.stringify({ id: 5, method: "Page.enable" });
  ws.feed({
    id: 2,
    method: "Target.sendMessageToTarget",
    params: { sessionId: pageSid, message: inner },
  });

  expect(ws.byId(2)!.result).toEqual({});
  expect(pages[0].inbox).toEqual([inner]);
});

test("Target.detachFromTarget closes the page session and emits detachedFromTarget", () => {
  const { ws, pages } = makeRig([PAGE_A]);

  ws.feed({ id: 1, method: "Target.attachToTarget", params: { targetId: PAGE_A.targetId } });
  const pageSid = ws.byId(1)!.result.sessionId as string;

  ws.feed({ id: 2, method: "Target.detachFromTarget", params: { sessionId: pageSid } });

  expect(ws.byId(2)!.result).toEqual({});
  expect(pages[0].closed).toBe(true);
  const det = ws.byMethod("Target.detachedFromTarget");
  expect(det.length).toBe(1);
  expect(det[0].params).toEqual({ sessionId: pageSid, targetId: PAGE_A.targetId });
});

test("attachToTarget on unknown target id returns -32000", () => {
  const { ws } = makeRig([PAGE_A]);

  ws.feed({ id: 1, method: "Target.attachToTarget", params: { targetId: "nope" } });
  const r = ws.byId(1)!;
  expect(r.error.code).toBe(-32000);
});

test("command with unknown sessionId returns Session not found", () => {
  const { ws } = makeRig([]);

  ws.feed({
    id: 1,
    sessionId: "ghost",
    method: "Runtime.evaluate",
    params: { expression: "1" },
  });
  const r = ws.byId(1)!;
  expect(r.sessionId).toBe("ghost");
  expect(r.error.code).toBe(-32000);
  expect(r.error.message).toMatch(/not found/);
});

test("Browser.getVersion responds with version blob", () => {
  const { ws } = makeRig([]);

  ws.feed({ id: 1, method: "Browser.getVersion" });
  const r = ws.byId(1)!;
  expect(r.result.protocolVersion).toBe("1.3");
  expect(r.result.product).toContain("Safari");
});

test("ws close tears down all page sessions", () => {
  const { ws, pages } = makeRig([PAGE_A, PAGE_B]);

  ws.feed({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } });
  expect(pages.length).toBe(2);
  expect(pages.every((p) => !p.closed)).toBe(true);

  ws.emit("close");

  expect(pages.every((p) => p.closed)).toBe(true);
});
