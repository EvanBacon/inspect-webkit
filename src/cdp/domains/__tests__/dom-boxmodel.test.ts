// DOM.getBoxModel: WebKit has no such method. The bridge used to swallow the
// request without ever replying (Puppeteer's boundingBox() hung); found by
// the cdp-tools fuzzer's exactly-one-reply invariant. It now computes the
// model in the page.

import { test, expect } from "bun:test";
import { Target } from "../../target";
import { installDomFilters } from "../dom";

function rig(answer: (m: any) => any) {
  const toTools: any[] = [];
  const toTarget: any[] = [];
  const ws = { readyState: 1, send: (s: string) => toTools.push(JSON.parse(s)) };
  let t: Target;
  const wi = {
    forwardSocketData(_a: string, _p: number, _s: string, bytes: Uint8Array) {
      const m = JSON.parse(new TextDecoder().decode(bytes));
      toTarget.push(m);
      const r = answer(m);
      if (r !== undefined && typeof m.id === "number") {
        queueMicrotask(() => void t.onMessageFromTarget(JSON.stringify({ ...r, id: m.id })));
      }
    },
    forwardDidClose() {},
  };
  t = new Target(ws as any, wi as any, "PID:1", 1, "s");
  installDomFilters(t);
  // Raw mode (no inner targets), so frames aren't wrapped.
  (t as any).mode = "raw";
  return { t, toTools, toTarget };
}

async function reply(r: ReturnType<typeof rig>, id: number) {
  for (let i = 0; i < 200; i++) {
    const m = r.toTools.find((x) => x.id === id);
    if (m) return m;
    await Bun.sleep(2);
  }
  throw new Error(`no reply for ${id}`);
}

const MODEL = {
  content: [10, 10, 20, 10, 20, 20, 10, 20],
  padding: [9, 9, 21, 9, 21, 21, 9, 21],
  border: [8, 8, 22, 8, 22, 22, 8, 22],
  margin: [0, 0, 30, 0, 30, 30, 0, 30],
  width: 14,
  height: 14,
};

test("getBoxModel by nodeId replies with the model computed in the page", async () => {
  const r = rig((m) => {
    if (m.method === "DOM.resolveNode") return { result: { object: { objectId: "obj-1" } } };
    if (m.method === "Runtime.callFunctionOn") return { result: { result: { type: "object", value: MODEL } } };
    return { result: {} };
  });
  await r.t.onMessageFromTools(JSON.stringify({ id: 1, method: "DOM.getBoxModel", params: { nodeId: 5 } }));
  const m = await reply(r, 1);
  expect(m.result).toEqual({ model: MODEL });
  const call = r.toTarget.find((x) => x.method === "Runtime.callFunctionOn");
  expect(call.params.objectId).toBe("obj-1");
  expect(call.params.returnByValue).toBe(true);
  expect(r.toTarget.find((x) => x.method === "DOM.resolveNode").params.nodeId).toBe(5);
});

test("getBoxModel by objectId skips resolveNode", async () => {
  const r = rig((m) => (m.method === "Runtime.callFunctionOn" ? { result: { result: { value: MODEL } } } : { result: {} }));
  await r.t.onMessageFromTools(JSON.stringify({ id: 2, method: "DOM.getBoxModel", params: { objectId: "o" } }));
  expect((await reply(r, 2)).result.model).toEqual(MODEL);
  expect(r.toTarget.some((x) => x.method === "DOM.resolveNode")).toBe(false);
});

test("getBoxModel errors (once) when the node can't be resolved", async () => {
  const r = rig((m) =>
    m.method === "DOM.resolveNode" ? { error: { code: -32000, message: "Missing node for given nodeId" } } : { result: {} },
  );
  await r.t.onMessageFromTools(JSON.stringify({ id: 3, method: "DOM.getBoxModel", params: { nodeId: 999 } }));
  const m = await reply(r, 3);
  expect(m.error.message).toContain("Missing node");
  await Bun.sleep(10);
  expect(r.toTools.filter((x) => x.id === 3)).toHaveLength(1);
});

test("getBoxModel errors when the page can't compute a model (text node)", async () => {
  const r = rig((m) => {
    if (m.method === "DOM.resolveNode") return { result: { object: { objectId: "t" } } };
    if (m.method === "Runtime.callFunctionOn") return { result: { result: { type: "undefined" }, wasThrown: true } };
    return { result: {} };
  });
  await r.t.onMessageFromTools(JSON.stringify({ id: 4, method: "DOM.getBoxModel", params: { backendNodeId: 7 } }));
  expect((await reply(r, 4)).error.message).toMatch(/box model/i);
});

test("getBoxModel without a node reference is an invalid-params error", async () => {
  const r = rig(() => ({ result: {} }));
  for (const params of [undefined, {}, "x", { nodeId: "5" }]) {
    const id = 10 + r.toTools.length;
    await r.t.onMessageFromTools(JSON.stringify({ id, method: "DOM.getBoxModel", ...(params !== undefined ? { params } : {}) }));
    expect((await reply(r, id)).error.code).toBe(-32602);
  }
});

// Found while reading the getBoxModel neighbour: x / y went into the
// evaluated expression verbatim.
test("getNodeForLocation only ever evaluates numeric coordinates", async () => {
  const r = rig((m) => (m.method === "Runtime.evaluate" ? { result: { result: { type: "object", subtype: "null" } } } : { result: {} }));
  await r.t.onMessageFromTools(JSON.stringify({ id: 20, method: "DOM.getNodeForLocation", params: { x: "0);globalThis.pwned=1;(0", y: 1 } }));
  expect((await reply(r, 20)).error.code).toBe(-32602);
  expect(r.toTarget.some((m) => m.method === "Runtime.evaluate")).toBe(false);
  await r.t.onMessageFromTools(JSON.stringify({ id: 21, method: "DOM.getNodeForLocation", params: { x: 3.5, y: 4 } }));
  expect((await reply(r, 21)).result).toEqual({ nodeId: 0 });
  expect(r.toTarget.find((m) => m.method === "Runtime.evaluate").params.expression).toBe("document.elementFromPoint(3.5,4)");
});
