// Target-based mode: wrapped Target.sendMessageToTarget envelopes and the
// inner/provisional target state machine (review #7, #8).
//
// Safari answers a wrapped command twice: an outer `{id, result:{}}` ack for
// the envelope and the real reply inside Target.dispatchMessageFromTarget.
// The two can arrive in either order, the outer one can be an error, and
// the inner target can be created / destroyed / swapped at any point.

import { test, expect } from "bun:test";
import { Target } from "../target";

type Envelope = { id: number; targetId: string; inner: any };

function makeRig() {
  const toTools: any[] = [];
  const raw: any[] = []; // every top-level frame written to WIR
  const envelopes: Envelope[] = [];
  const ws = {
    readyState: 1,
    send(text: string) {
      toTools.push(JSON.parse(text));
    },
  };
  const wi = {
    forwardSocketData(_a: string, _p: number, _s: string, bytes: Uint8Array) {
      const outer = JSON.parse(new TextDecoder().decode(bytes));
      raw.push(outer);
      if (outer.method === "Target.sendMessageToTarget") {
        envelopes.push({
          id: outer.id,
          targetId: outer.params.targetId,
          inner: JSON.parse(outer.params.message),
        });
      }
    },
    forwardDidClose() {},
  };
  const t = new Target(ws as any, wi as any, "PID:1", 1, "sender");
  const fromTarget = (m: unknown) => t.onMessageFromTarget(JSON.stringify(m));
  const rig = {
    t,
    toTools,
    raw,
    envelopes,
    fromTarget,
    tools: (m: unknown) => t.onMessageFromTools(JSON.stringify(m)),
    created: (targetId: string, type = "page", isProvisional = false) =>
      fromTarget({
        method: "Target.targetCreated",
        params: { targetInfo: { targetId, type, isProvisional } },
      }),
    destroyed: (targetId: string) =>
      fromTarget({ method: "Target.targetDestroyed", params: { targetId } }),
    commit: (oldTargetId: string, newTargetId: string) =>
      fromTarget({
        method: "Target.didCommitProvisionalTarget",
        params: { oldTargetId, newTargetId },
      }),
    /** Inner reply, wrapped the way Safari sends it. */
    inner: (targetId: string, m: unknown) =>
      fromTarget({
        method: "Target.dispatchMessageFromTarget",
        params: { targetId, message: JSON.stringify(m) },
      }),
    envelopeFor: (innerId: number) => envelopes.find((e) => e.inner.id === innerId),
    repliesFor: (id: number) => toTools.filter((m) => m.id === id),
  };
  return rig;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- #7 acks

test("inner reply arriving BEFORE the outer ack is delivered, not swapped for the ack (#7b)", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.tools({ id: 5, method: "Runtime.evaluate", params: { expression: "1" } });
  const env = r.envelopeFor(5)!;
  expect(env).toBeDefined();
  await r.inner("page-1", { id: 5, result: { result: { type: "number", value: 1 } } });
  await r.fromTarget({ id: env.id, result: {} });
  expect(r.repliesFor(5)).toEqual([{ id: 5, result: { result: { type: "number", value: 1 } } }]);
});

test("inner reply after the outer ack is delivered exactly once", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.tools({ id: 6, method: "Runtime.evaluate", params: { expression: "2" } });
  const env = r.envelopeFor(6)!;
  await r.fromTarget({ id: env.id, result: {} });
  await r.inner("page-1", { id: 6, result: { v: 2 } });
  expect(r.repliesFor(6)).toEqual([{ id: 6, result: { v: 2 } }]);
});

test("an outer envelope error is propagated to the client (#7a)", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.tools({ id: 7, method: "Runtime.evaluate", params: { expression: "3" } });
  const env = r.envelopeFor(7)!;
  await r.fromTarget({
    id: env.id,
    error: { code: -32000, message: "Missing target for given targetId" },
  });
  const replies = r.repliesFor(7);
  expect(replies.length).toBe(1);
  expect(replies[0].error.message).toContain("Missing target");
});

test("outer envelope ids live in their own id space (never equal a client id)", async () => {
  const r = makeRig();
  await r.created("page-1");
  for (const id of [0, 1, 2, 3]) await r.tools({ id, method: "Runtime.evaluate", params: {} });
  for (const e of r.envelopes) expect(e.id).not.toBe(e.inner.id);
  const outerIds = r.envelopes.map((e) => e.id);
  expect(new Set(outerIds).size).toBe(outerIds.length);
});

test("an unwrapped Target.* request sharing a client id with a wrapped one gets its own reply", async () => {
  const r = makeRig();
  await r.created("page-1");
  // Same id 9 used for a wrapped and an unwrapped (Target.*) command. The
  // unwrapped reply is top-level {id:9}; it must not be eaten as an "ack".
  await r.tools({ id: 9, method: "Target.getTargetInfo", params: {} });
  await r.fromTarget({ id: 9, result: { targetInfo: { targetId: "page-1" } } });
  expect(r.repliesFor(9)).toEqual([{ id: 9, result: { targetInfo: { targetId: "page-1" } } }]);
});

test("adapter callTarget resolves with the inner result even if the ack comes last", async () => {
  const r = makeRig();
  await r.created("page-1");
  const p = r.t.callTarget("DOM.getDocument", { depth: 0 });
  const env = r.envelopes.at(-1)!;
  await r.inner("page-1", { id: env.inner.id, result: { root: { nodeId: 1 } } });
  await r.fromTarget({ id: env.id, result: {} });
  await expect(p).resolves.toEqual({ root: { nodeId: 1 } });
});

test("adapter callTarget rejects on an outer envelope error", async () => {
  const r = makeRig();
  await r.created("page-1");
  const p = r.t.callTarget("DOM.getDocument", { depth: 0 });
  const env = r.envelopes.at(-1)!;
  await r.fromTarget({ id: env.id, error: { code: -32000, message: "Missing target" } });
  await expect(p).rejects.toMatchObject({ message: expect.stringContaining("Missing target") });
});

test("bookkeeping is pruned once every request is answered (#7c)", async () => {
  const r = makeRig();
  await r.created("page-1");
  for (let i = 1; i <= 20; i++) {
    await r.tools({ id: i, method: "Runtime.evaluate", params: {} });
    const env = r.envelopeFor(i)!;
    if (i % 2) {
      await r.fromTarget({ id: env.id, result: {} });
      await r.inner("page-1", { id: i, result: {} });
    } else {
      await r.inner("page-1", { id: i, result: {} });
      await r.fromTarget({ id: env.id, result: {} });
    }
  }
  // Locally-answered requests must not leak either.
  await r.tools({ id: 100, method: "Target.setAutoAttach", params: {} });
  r.t.fireResultToTools(100, {});
  const s = r.t.debugState();
  expect(s.toolRequests).toBe(0);
  expect(s.wrapped).toBe(0);
  expect(s.queued).toBe(0);
  // No stray ack leaked to the client.
  expect(r.toTools.every((m) => m.id === 100 || (m.id >= 1 && m.id <= 20))).toBe(true);
  expect(r.toTools.filter((m) => m.id !== undefined).length).toBe(21);
});

test("negative client ids are rejected (reserved for the bridge's own requests)", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.tools({ id: -1, method: "Runtime.evaluate", params: {} });
  expect(r.repliesFor(-1)[0]?.error).toBeDefined();
  expect(r.envelopes.length).toBe(0);
});

// ---------------------------------------------------------- #8 lifecycle

test("targetDestroyed resets the inner target; a re-created page is used (#8)", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.destroyed("page-1");
  await r.created("page-2");
  await r.tools({ id: 1, method: "Runtime.evaluate", params: {} });
  expect(r.envelopeFor(1)?.targetId).toBe("page-2");
});

test("in-flight requests to a destroyed target get an error instead of hanging", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.tools({ id: 1, method: "Runtime.evaluate", params: {} });
  const callP = r.t.callTarget("DOM.getDocument", {}).catch((e) => e);
  for (const e of r.envelopes) await r.fromTarget({ id: e.id, result: {} });
  await r.destroyed("page-1");
  expect(r.repliesFor(1).length).toBe(1);
  expect(r.repliesFor(1)[0].error).toBeDefined();
  expect(await callP).toBeInstanceOf(Error);
});

test("provisional swap: commit then destroy(old) — new requests go to the new target", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.created("page-2", "page", true);
  // Provisional target is not used before commit.
  await r.tools({ id: 1, method: "Runtime.evaluate", params: {} });
  expect(r.envelopeFor(1)?.targetId).toBe("page-1");
  await r.commit("page-1", "page-2");
  await r.destroyed("page-1");
  await r.tools({ id: 2, method: "Runtime.evaluate", params: {} });
  expect(r.envelopeFor(2)?.targetId).toBe("page-2");
});

test("provisional swap: destroy(old) BEFORE commit queues, then flushes to the new target", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.created("page-2", "page", true);
  await r.destroyed("page-1");
  await r.tools({ id: 3, method: "Runtime.evaluate", params: {} });
  expect(r.envelopeFor(3)).toBeUndefined(); // held, not sent to a dead target
  await r.commit("page-1", "page-2");
  expect(r.envelopeFor(3)?.targetId).toBe("page-2");
});

test("commit for a target we never saw created still switches", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.commit("page-1", "page-9");
  await r.tools({ id: 4, method: "Runtime.evaluate", params: {} });
  expect(r.envelopeFor(4)?.targetId).toBe("page-9");
});

test("requests queued during a swap fail after the swap deadline (never queue forever)", async () => {
  const r = makeRig();
  r.t.swapTimeoutMs = 40;
  await r.created("page-1");
  await r.destroyed("page-1");
  await r.tools({ id: 5, method: "Runtime.evaluate", params: {} });
  const callP = r.t.callTarget("DOM.getDocument", {}).catch((e) => e);
  expect(r.repliesFor(5).length).toBe(0);
  await sleep(120);
  expect(r.repliesFor(5).length).toBe(1);
  expect(r.repliesFor(5)[0].error.message).toMatch(/target/i);
  expect(await callP).toBeInstanceOf(Error);
  expect(r.t.debugState().queued).toBe(0);
});

test("worker-only sessions (service worker) adopt the worker target instead of queueing forever (#8)", async () => {
  const r = makeRig();
  r.t.workerGraceMs = 20;
  await r.created("worker-1", "service-worker");
  await r.tools({ id: 1, method: "Runtime.evaluate", params: {} });
  await sleep(80);
  expect(r.envelopeFor(1)?.targetId).toBe("worker-1");
});

test("a dedicated worker created next to the page never steals page traffic", async () => {
  const r = makeRig();
  r.t.workerGraceMs = 20;
  await r.created("page-1");
  await r.created("worker-1", "worker");
  await sleep(50);
  await r.tools({ id: 1, method: "Runtime.evaluate", params: {} });
  expect(r.envelopeFor(1)?.targetId).toBe("page-1");
  // Worker created first, page right after (within the grace): page wins.
  const r2 = makeRig();
  r2.t.workerGraceMs = 20;
  await r2.created("worker-1", "worker");
  await r2.created("page-1");
  await r2.tools({ id: 1, method: "Runtime.evaluate", params: {} });
  await sleep(50);
  expect(r2.envelopeFor(1)?.targetId).toBe("page-1");
});

test("enabled domains are replayed onto a provisional target before commit; disabled ones are not", async () => {
  const r = makeRig();
  await r.created("page-1");
  for (const [id, method] of [
    [1, "Runtime.enable"],
    [2, "Debugger.enable"],
    [3, "Debugger.setPauseOnExceptions"],
    [4, "Network.enable"],
    [5, "Network.disable"],
  ] as const) {
    await r.tools({ id, method, params: method.includes("Pause") ? { state: "all" } : {} });
    const env = r.envelopeFor(id)!;
    await r.fromTarget({ id: env.id, result: {} });
    await r.inner("page-1", { id, result: {} });
  }
  const before = r.toTools.length;
  await r.created("page-2", "page", true);
  const replayed = r.envelopes.filter((e) => e.targetId === "page-2").map((e) => e.inner);
  expect(replayed.map((m) => m.method)).toEqual([
    "Runtime.enable",
    "Debugger.enable",
    "Debugger.setPauseOnExceptions",
  ]);
  expect(replayed[2].params).toEqual({ state: "all" });
  // Replay replies are internal — the client never sees them.
  for (const e of r.envelopes.filter((e) => e.targetId === "page-2")) {
    await r.fromTarget({ id: e.id, result: {} });
    await r.inner("page-2", { id: e.inner.id, result: {} });
  }
  expect(r.toTools.length).toBe(before);
  // Commit does not replay a second time.
  await r.commit("page-1", "page-2");
  expect(r.envelopes.filter((e) => e.targetId === "page-2").length).toBe(3);
});

test("a page re-created after a crash (no provisional) gets state replayed before queued traffic", async () => {
  const r = makeRig();
  await r.created("page-1");
  await r.tools({ id: 1, method: "Runtime.enable", params: {} });
  await r.destroyed("page-1"); // id 1 fails here
  await r.tools({ id: 2, method: "Runtime.evaluate", params: {} });
  await r.created("page-2");
  const toNew = r.envelopes.filter((e) => e.targetId === "page-2").map((e) => e.inner.method);
  expect(toNew).toEqual(["Runtime.enable", "Runtime.evaluate"]);
});

test("breakpoints set by URL are replayed; removed ones are not", async () => {
  const r = makeRig();
  await r.created("page-1");
  const bp = (id: number, line: number) =>
    r.tools({ id, method: "Debugger.setBreakpointByUrl", params: { url: "https://x/a.js", lineNumber: line } });
  await bp(1, 10);
  await r.inner("page-1", { id: 1, result: { breakpointId: "bp-10", locations: [] } });
  await bp(2, 20);
  await r.inner("page-1", { id: 2, result: { breakpointId: "bp-20", locations: [] } });
  await r.tools({ id: 3, method: "Debugger.removeBreakpoint", params: { breakpointId: "bp-10" } });
  await r.inner("page-1", { id: 3, result: {} });
  await r.created("page-2", "page", true);
  const replayed = r.envelopes.filter((e) => e.targetId === "page-2").map((e) => e.inner);
  expect(replayed.map((m) => [m.method, m.params?.lineNumber])).toEqual([
    ["Debugger.setBreakpointByUrl", 20],
  ]);
});

test("non-target mode (no Target.targetCreated within 250ms) still flushes raw", async () => {
  const r = makeRig();
  await r.tools({ id: 1, method: "Runtime.evaluate", params: {} });
  expect(r.raw.length).toBe(0);
  await sleep(300);
  expect(r.raw.map((m) => m.id)).toEqual([1]);
  expect(r.envelopes.length).toBe(0);
  await r.fromTarget({ id: 1, result: { v: 1 } });
  expect(r.repliesFor(1)).toEqual([{ id: 1, result: { v: 1 } }]);
});
