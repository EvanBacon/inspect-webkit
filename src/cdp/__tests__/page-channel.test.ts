// PageChannel: one WIR sender per inspected page shared by several CDP
// clients (R7). Ids are rewritten per client, events fan out, domain
// enable/disable is reference-counted, and a client leaving never breaks
// the others.

import { test, expect } from "bun:test";
import { PageChannel, rewriteReplyId } from "../page-channel";
import { installIOSFilters } from "../ios-protocol";
import { makeClient, makeFakePage, tick } from "./helpers/fake-page";

function rig() {
  const page = makeFakePage();
  let emptied = 0;
  const ch = new PageChannel(page.wi as any, "PID:1", 1, { onEmpty: () => emptied++ });
  const closes: Array<{ who: string; reason: string; code: number }> = [];
  const join = (who: string) => {
    const c = makeClient(page);
    const detach = ch.attach(c.t, (reason, code) => closes.push({ who, reason, code }));
    return { ...c, detach };
  };
  return { page, ch, join, closes, emptied: () => emptied };
}

/** Rig with the main page target already announced. */
async function targetRig() {
  const r = rig();
  const a = r.join("A");
  r.page.created("page-1");
  await tick();
  return { ...r, a };
}

test("two clients sending the same id each get their own reply (R7)", async () => {
  const { page, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Runtime.evaluate", params: { expression: "'A'" } });
  await b.send({ id: 1, method: "Runtime.evaluate", params: { expression: "'B'" } });
  const evals = page.innerRequests("Runtime.evaluate");
  expect(evals.length).toBe(2);
  // Distinct ids on the wire, both inner and outer.
  expect(evals[0]!.inner.id).not.toBe(evals[1]!.inner.id);
  expect(evals[0]!.outer.id).not.toBe(evals[1]!.outer.id);
  // Answer in reverse order.
  page.answer(evals[1]!, { result: { value: evals[1]!.inner.params.expression } });
  page.answer(evals[0]!, { result: { value: evals[0]!.inner.params.expression } });
  await tick();
  expect(a.replies(1)).toEqual([{ id: 1, result: { result: { value: "'A'" } } }]);
  expect(b.replies(1)).toEqual([{ id: 1, result: { result: { value: "'B'" } } }]);
});

test("one socket setup per page; the sender is released only when the last client leaves", async () => {
  const { page, ch, join, a, emptied } = await targetRig();
  const b = join("B");
  expect(page.setups.length).toBe(1);
  expect(ch.senderKey).toBe(page.setups[0]!);
  a.detach();
  expect(page.didCloses).toEqual([]);
  expect(ch.clientCount).toBe(1);
  // B keeps working.
  await b.send({ id: 7, method: "Runtime.evaluate", params: { expression: "1" } });
  page.answerAll(() => ({ ok: true }));
  await tick();
  expect(b.replies(7).length).toBe(1);
  b.detach();
  expect(page.didCloses).toEqual([ch.senderKey]);
  expect(emptied()).toBe(1);
  expect(page.subscribers).toBe(0);
  expect(ch.closed).toBe(true);
});

test("events fan out to every client that enabled the domain", async () => {
  const { page, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Runtime.enable" });
  await b.send({ id: 1, method: "Runtime.enable" });
  page.answerAll();
  await tick();
  page.pushInner("page-1", { method: "Runtime.consoleAPICalled", params: { type: "log", args: [] } });
  await tick();
  expect(a.events("Runtime.consoleAPICalled").length).toBe(1);
  expect(b.events("Runtime.consoleAPICalled").length).toBe(1);
  // Not shared by reference: one client's filters can't mutate another's copy.
  expect(a.events("Runtime.consoleAPICalled")[0]).not.toBe(b.events("Runtime.consoleAPICalled")[0]);
});

test("a disable from one client is answered locally while another still has the domain", async () => {
  const { page, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Debugger.enable" });
  await b.send({ id: 1, method: "Debugger.enable" });
  page.answerAll();
  await tick();
  await a.send({ id: 2, method: "Debugger.disable" });
  await tick();
  expect(page.innerRequests("Debugger.disable")).toEqual([]);
  expect(a.replies(2)).toEqual([{ id: 2, result: {} }]);
  // B still gets Debugger events; A (disabled) does not.
  page.pushInner("page-1", { method: "Debugger.scriptParsed", params: { scriptId: "9", url: "x.js" } });
  await tick();
  expect(b.events("Debugger.scriptParsed").length).toBe(1);
  expect(a.events("Debugger.scriptParsed").length).toBe(0);
  // The last holder's disable goes to Safari.
  await b.send({ id: 2, method: "Debugger.disable" });
  expect(page.innerRequests("Debugger.disable").length).toBe(1);
});

test("only the first enable of a domain goes to Safari", async () => {
  const { page, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Runtime.enable" });
  await b.send({ id: 1, method: "Runtime.enable" });
  await tick();
  expect(page.innerRequests("Runtime.enable").length).toBe(1);
  expect(b.replies(1)).toEqual([{ id: 1, result: {} }]);
});

test("a late joiner learns the existing inner targets and sends wrapped, not raw", async () => {
  const { page, join } = await targetRig();
  const b = join("B");
  await tick();
  expect(b.t.debugState().mode).toBe("target");
  expect(b.t.debugState().active).toBe("page-1");
  await b.send({ id: 3, method: "Runtime.evaluate", params: { expression: "1" } });
  expect(page.innerRequests("Runtime.evaluate").length).toBe(1);
  // Target.* lifecycle events are not leaked to DevTools.
  expect(b.events("Target.targetCreated")).toEqual([]);
});

test("a late joiner enabling Runtime/Debugger gets the current contexts, scripts and pause state", async () => {
  const { page, join, a } = await targetRig();
  await a.send({ id: 1, method: "Runtime.enable" });
  await a.send({ id: 2, method: "Debugger.enable" });
  page.answerAll();
  const ctx = (id: number) => ({ method: "Runtime.executionContextCreated", params: { context: { id, name: `c${id}` } } });
  page.pushInner("page-1", ctx(1));
  page.pushInner("page-1", ctx(2));
  page.pushInner("page-1", { method: "Runtime.executionContextDestroyed", params: { executionContextId: 1 } });
  page.pushInner("page-1", { method: "Debugger.scriptParsed", params: { scriptId: "s1", url: "a.js" } });
  page.pushInner("page-1", { method: "Debugger.paused", params: { callFrames: [], reason: "other" } });
  await tick();
  const b = join("B");
  await tick();
  await b.send({ id: 10, method: "Runtime.enable" });
  await b.send({ id: 11, method: "Debugger.enable" });
  await tick();
  expect(b.events("Runtime.executionContextCreated").map((e) => e.params.context.id)).toEqual([2]);
  expect(b.events("Debugger.scriptParsed").map((e) => e.params.scriptId)).toEqual(["s1"]);
  expect(b.events("Debugger.paused").length).toBe(1);
  // Inventory arrives before the reply, like WebKit's own enable.
  const iCtx = b.got.findIndex((m) => m.method === "Runtime.executionContextCreated");
  expect(iCtx).toBeLessThan(b.got.findIndex((m) => m.id === 10));
  expect(b.replies(10).length).toBe(1);
  expect(b.replies(11).length).toBe(1);
  expect(page.innerRequests("Runtime.enable").length).toBe(0); // answerAll drained A's
  // After a resume, a third joiner is not told the page is paused.
  page.pushInner("page-1", { method: "Debugger.resumed", params: {} });
  await tick();
  const c = join("C");
  await tick();
  await c.send({ id: 1, method: "Debugger.enable" });
  await tick();
  expect(c.events("Debugger.paused")).toEqual([]);
});

test("a detaching client releases domains only it held, and its own breakpoints", async () => {
  const { page, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Debugger.enable" });
  await b.send({ id: 1, method: "Debugger.enable" });
  await a.send({ id: 2, method: "Network.enable" });
  await a.send({ id: 3, method: "Debugger.setBreakpointByUrl", params: { url: "a.js", lineNumber: 1 } });
  await b.send({ id: 3, method: "Debugger.setBreakpointByUrl", params: { url: "b.js", lineNumber: 2 } });
  page.answerAll((f) =>
    f.inner?.method === "Debugger.setBreakpointByUrl"
      ? { breakpointId: `bp:${f.inner.params.url}`, locations: [] }
      : {},
  );
  await tick();
  a.detach();
  const disables = page.innerRequests().map((f) => f.inner.method);
  expect(disables).toContain("Network.disable");
  expect(disables).not.toContain("Debugger.disable");
  const removed = page.innerRequests("Debugger.removeBreakpoint").map((f) => f.inner.params.breakpointId);
  expect(removed).toEqual(["bp:a.js"]);
  // Channel-originated replies never reach B.
  const before = b.got.length;
  page.answerAll();
  await tick();
  expect(b.got.length).toBe(before);
});

test("a reply that arrives after its client left is dropped, never delivered to another client", async () => {
  const { page, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 5, method: "Runtime.evaluate", params: { expression: "slow" } });
  await b.send({ id: 6, method: "Runtime.evaluate", params: { expression: "x" } });
  const [fa] = page.innerRequests("Runtime.evaluate");
  a.detach();
  page.answer(fa!, { result: { value: "late" } });
  await tick();
  expect(b.got.filter((m) => m.id !== undefined)).toEqual([]);
  expect(a.got).toEqual([]);
});

test("an outer envelope error reaches the right client and leaves no routes behind", async () => {
  const { page, ch, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Runtime.evaluate", params: { expression: "1" } });
  await b.send({ id: 1, method: "Runtime.evaluate", params: { expression: "2" } });
  const [fa, fb] = page.innerRequests("Runtime.evaluate");
  page.push({ id: fa!.outer.id, error: { code: -32000, message: "Missing target for given targetId" } });
  page.answer(fb!, { ok: 2 });
  await tick();
  expect(a.replies(1)).toEqual([
    { id: 1, error: { code: -32000, message: "Missing target for given targetId" } },
  ]);
  expect(b.replies(1)).toEqual([{ id: 1, result: { ok: 2 } }]);
  expect(ch.debugState().routes).toBe(0);
});

test("targetDestroyed prunes that target's routes and domain state", async () => {
  const { page, ch, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Runtime.enable" });
  await b.send({ id: 2, method: "Runtime.evaluate", params: { expression: "hang" } });
  page.destroyed("page-1");
  await tick();
  expect(b.replies(2)[0]?.error?.message).toMatch(/went away/);
  expect(ch.debugState().routes).toBe(0);
  expect(ch.debugState().holders).toEqual({});
});

test("close() tells every client why and releases the sender once", async () => {
  const { page, ch, join, closes, emptied } = await targetRig();
  join("B");
  ch.close("application disconnected");
  expect(closes.map((c) => [c.who, c.reason, c.code])).toEqual([
    ["A", "application disconnected", 1011],
    ["B", "application disconnected", 1011],
  ]);
  expect(page.didCloses.length).toBe(1);
  expect(emptied()).toBe(1);
  ch.close("again");
  expect(closes.length).toBe(2);
});

test("frames for other senders, apps or pages are ignored", async () => {
  const { page, a } = await targetRig();
  await a.send({ id: 1, method: "Runtime.evaluate", params: { expression: "1" } });
  const [f] = page.innerRequests("Runtime.evaluate");
  page.push(
    { method: "Target.dispatchMessageFromTarget", params: { targetId: "page-1", message: JSON.stringify({ id: f!.inner.id, result: {} }) } },
    { senderKey: "someone-else" },
  );
  await tick();
  expect(a.replies(1)).toEqual([]);
});

test("raw (non-target) mode: top-level ids are rewritten too", async () => {
  const r = rig();
  const a = r.join("A");
  const b = r.join("B");
  await a.send({ id: 1, method: "Runtime.evaluate", params: { expression: "a" } });
  await b.send({ id: 1, method: "Runtime.evaluate", params: { expression: "b" } });
  await tick(300); // mode detection gives up on targets
  const raw = r.page.frames.filter((f) => f.outer.method === "Runtime.evaluate");
  expect(raw.length).toBe(2);
  expect(raw[0]!.outer.id).not.toBe(raw[1]!.outer.id);
  for (const f of raw) r.page.push({ result: { v: f.outer.params.expression }, id: f.outer.id });
  await tick();
  expect(a.replies(1)).toEqual([{ id: 1, result: { v: "a" } }]);
  expect(b.replies(1)).toEqual([{ id: 1, result: { v: "b" } }]);
});

test("rewriteReplyId swaps WebKit's trailing id without re-serializing; odd layouts fall back", () => {
  expect(rewriteReplyId('{"result":{"id":5},"id":5}', 5, 1)).toBe('{"result":{"id":5},"id":1}');
  expect(rewriteReplyId('{"id":5,"result":{}}', 5, 1)).toBeNull();
  expect(rewriteReplyId('{"result":{},"id":55}', 5, 1)).toBeNull();
  expect(rewriteReplyId('{"result":{}, "id": 5}', 5, 1)).toBeNull();
});

test("a client joining between a provisional commit and the old target's destroy uses the new page", async () => {
  const { page, join } = await targetRig();
  page.created("page-2", "page", true);
  page.push({ method: "Target.didCommitProvisionalTarget", params: { oldTargetId: "page-1", newTargetId: "page-2" } });
  await tick();
  const b = join("B");
  await tick();
  expect(b.t.debugState().active).toBe("page-2");
});

test("with the iOS filters installed, replayed inventory still reaches DevTools before the enable reply", async () => {
  const { page, join, a } = await targetRig();
  await a.send({ id: 1, method: "Runtime.enable" });
  page.answerAll();
  page.pushInner("page-1", { method: "Runtime.executionContextCreated", params: { context: { id: 3, name: "" } } });
  await tick();
  const b = join("B");
  installIOSFilters(b.t);
  await tick();
  await b.send({ id: 1, method: "Runtime.enable" });
  await tick(20);
  const order = b.got.map((m) => m.method ?? `reply ${m.id}`);
  expect(order.indexOf("Runtime.executionContextCreated")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("Runtime.executionContextCreated")).toBeLessThan(order.indexOf("reply 1"));
});

test("Runtime.disable also drops the Console domain the bridge enabled for it; other clients keep console events", async () => {
  const { page, join, a } = await targetRig();
  installIOSFilters(a.t);
  const b = join("B");
  installIOSFilters(b.t);
  await tick();
  await a.send({ id: 1, method: "Runtime.enable" });
  await b.send({ id: 1, method: "Runtime.enable" });
  page.answerAll();
  await tick();
  await a.send({ id: 2, method: "Runtime.disable" });
  page.answerAll();
  await tick();
  const msg = { method: "Console.messageAdded", params: { message: { source: "console-api", level: "log", text: "hi", type: "log", parameters: [] } } };
  page.pushInner("page-1", msg);
  await tick(20);
  expect(a.events("Runtime.consoleAPICalled")).toEqual([]);
  expect(b.events("Runtime.consoleAPICalled").length).toBe(1);
  // B was the last one: its Runtime.disable takes Console down on the wire too.
  await b.send({ id: 2, method: "Runtime.disable" });
  await tick();
  expect(page.innerRequests("Console.disable").length).toBe(1);
});

test("an explicit Log.enable keeps console events flowing after Runtime.disable", async () => {
  const { page, a } = await targetRig();
  installIOSFilters(a.t);
  await a.send({ id: 1, method: "Log.enable" });
  await a.send({ id: 2, method: "Runtime.enable" });
  await a.send({ id: 3, method: "Runtime.disable" });
  await tick();
  expect(page.innerRequests("Console.disable")).toEqual([]);
});

test("a reload's new main-world context replaces that frame's old contexts in the replay", async () => {
  const { page, join, a } = await targetRig();
  await a.send({ id: 1, method: "Runtime.enable" });
  page.answerAll();
  const ctx = (id: number, type: string, frameId = "0.1") => ({
    method: "Runtime.executionContextCreated",
    params: { context: { id, type, name: type === "normal" ? "" : "ext", frameId } },
  });
  page.pushInner("page-1", ctx(1, "normal"));
  page.pushInner("page-1", ctx(2, "internal"));
  page.pushInner("page-1", ctx(3, "normal", "0.2")); // an iframe
  // Reload: WebKit just announces new contexts, never destroys the old ones.
  page.pushInner("page-1", ctx(4, "normal"));
  page.pushInner("page-1", ctx(5, "internal"));
  await tick();
  const b = join("B");
  await tick();
  await b.send({ id: 1, method: "Runtime.enable" });
  await tick();
  expect(b.events("Runtime.executionContextCreated").map((e) => e.params.context.id)).toEqual([3, 4, 5]);
});

test("a first enable that Safari rejects is not counted; the next client's enable goes to Safari", async () => {
  const { page, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Animation.enable" });
  const [f] = page.innerRequests("Animation.enable");
  page.push({ result: {}, id: f!.outer.id });
  page.pushInner("page-1", { error: { code: -32601, message: "'Animation.enable' was not found" }, id: f!.inner.id });
  await tick();
  expect(a.replies(1)[0]?.error).toBeDefined();
  await b.send({ id: 1, method: "Animation.enable" });
  expect(page.innerRequests("Animation.enable").length).toBe(2);
});

test("a first enable whose envelope fails is not counted either", async () => {
  const { page, join, a } = await targetRig();
  const b = join("B");
  await tick();
  await a.send({ id: 1, method: "Network.enable" });
  const [f] = page.innerRequests("Network.enable");
  page.push({ id: f!.outer.id, error: { code: -32000, message: "Missing target for given targetId" } });
  await tick();
  expect(a.replies(1)[0]?.error).toBeDefined();
  await b.send({ id: 1, method: "Network.enable" });
  expect(page.innerRequests("Network.enable").length).toBe(2);
});
