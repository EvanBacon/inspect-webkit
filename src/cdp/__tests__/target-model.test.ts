// Stateful model test for Target's wrapped-request routing (review #7/#8,
// fuzz target F8): random interleavings of client requests, bridge
// callTarget()s, outer acks, inner replies, and inner-target create /
// destroy / provisional-commit events, delivered in arbitrary order.
//
// Invariant: every client request gets exactly one reply, every
// callTarget() settles, the client never sees a bridge-internal (negative)
// id, and nothing is left queued or in flight once Safari has answered
// everything it is going to answer.

import { test, expect } from "bun:test";
import fc from "fast-check";
import { fcRuns, fcTimeout } from "../../__tests__/helpers/fc-runs";
import { Target } from "../target";

type Action =
  | { kind: "send" }
  | { kind: "call" }
  | { kind: "deliver"; pick: number }
  | { kind: "create"; type: "page" | "worker"; provisional: boolean }
  | { kind: "destroy"; pick: number }
  | { kind: "commit"; pick: number }
  | { kind: "errorNext" };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Action>({ kind: "send" }) },
  { weight: 1, arbitrary: fc.constant<Action>({ kind: "call" }) },
  { weight: 8, arbitrary: fc.nat(50).map<Action>((pick) => ({ kind: "deliver", pick })) },
  {
    weight: 2,
    arbitrary: fc
      .record({ type: fc.constantFrom("page" as const, "worker" as const), provisional: fc.boolean() })
      .map<Action>((r) => ({ kind: "create", ...r })),
  },
  { weight: 1, arbitrary: fc.nat(10).map<Action>((pick) => ({ kind: "destroy", pick })) },
  { weight: 1, arbitrary: fc.nat(10).map<Action>((pick) => ({ kind: "commit", pick })) },
  { weight: 1, arbitrary: fc.constant<Action>({ kind: "errorNext" }) },
);

const METHODS = ["Runtime.evaluate", "Runtime.enable", "Debugger.enable", "DOM.getDocument", "Network.disable"];

async function runScenario(actions: Action[]) {
  const toTools: any[] = [];
  /** Frames Safari will send back, delivered in model-chosen order. */
  let pending: Array<{ targetId: string | null; frame: unknown }> = [];
  const alive = new Map<string, { type: string; provisional: boolean }>();
  let mainPage: string | null = null;
  let nextTarget = 0;
  let failNextEnvelope = false;

  const ws = { readyState: 1, send: (text: string) => toTools.push(JSON.parse(text)) };
  const wi = {
    forwardSocketData(_a: string, _p: number, _s: string, bytes: Uint8Array) {
      const outer = JSON.parse(new TextDecoder().decode(bytes));
      if (outer.method !== "Target.sendMessageToTarget") {
        // Raw (non-target mode or Target.*): answer at top level.
        pending.push({ targetId: null, frame: { id: outer.id, result: { raw: true } } });
        return;
      }
      const targetId = outer.params.targetId as string;
      const inner = JSON.parse(outer.params.message);
      if (!alive.has(targetId) || failNextEnvelope) {
        failNextEnvelope = false;
        pending.push({
          targetId: null,
          frame: { id: outer.id, error: { code: -32000, message: "Missing target for given targetId" } },
        });
        return;
      }
      pending.push({ targetId, frame: { id: outer.id, result: {} } });
      if (typeof inner.id === "number") {
        pending.push({
          targetId,
          frame: {
            method: "Target.dispatchMessageFromTarget",
            params: { targetId, message: JSON.stringify({ id: inner.id, result: { echo: inner.id } }) },
          },
        });
      }
    },
    forwardDidClose() {},
  };
  const t = new Target(ws as any, wi as any, "PID:1", 1, "sender");
  t.workerGraceMs = 1;
  t.swapTimeoutMs = 60_000; // the model never relies on the deadline
  const fromTarget = (m: unknown) => t.onMessageFromTarget(JSON.stringify(m));

  let nextToolId = 1;
  const calls: Array<{ settled: boolean }> = [];

  async function create(type: string, provisional: boolean) {
    const id = `${type}-${nextTarget++}`;
    alive.set(id, { type, provisional });
    if (type === "page" && !provisional && !mainPage) mainPage = id;
    await fromTarget({ method: "Target.targetCreated", params: { targetInfo: { targetId: id, type, isProvisional: provisional } } });
  }
  async function destroy(id: string) {
    alive.delete(id);
    if (mainPage === id) mainPage = null;
    // A destroyed target answers nothing further.
    pending = pending.filter((p) => p.targetId !== id);
    await fromTarget({ method: "Target.targetDestroyed", params: { targetId: id } });
  }
  async function deliver(i: number) {
    const [p] = pending.splice(i, 1);
    if (p) await fromTarget(p.frame);
  }

  for (const a of actions) {
    switch (a.kind) {
      case "send":
        await t.onMessageFromTools(
          JSON.stringify({ id: nextToolId, method: METHODS[nextToolId % METHODS.length], params: {} }),
        );
        nextToolId++;
        break;
      case "call": {
        const rec = { settled: false };
        calls.push(rec);
        t.callTarget("DOM.getDocument", {}).then(
          () => (rec.settled = true),
          () => (rec.settled = true),
        );
        break;
      }
      case "deliver":
        if (pending.length) await deliver(a.pick % pending.length);
        break;
      case "create":
        await create(a.type, a.provisional);
        break;
      case "destroy": {
        const ids = [...alive.keys()];
        if (ids.length) await destroy(ids[a.pick % ids.length]!);
        break;
      }
      case "commit": {
        // WebKit only commits provisional pages (a navigation), never workers.
        const prov = [...alive].filter(([, v]) => v.provisional && v.type === "page").map(([k]) => k);
        if (!prov.length) break;
        const next = prov[a.pick % prov.length]!;
        alive.get(next)!.provisional = false;
        const old = mainPage;
        mainPage = next;
        await fromTarget({
          method: "Target.didCommitProvisionalTarget",
          params: { oldTargetId: old ?? "gone", newTargetId: next },
        });
        break;
      }
      case "errorNext":
        failNextEnvelope = true;
        break;
    }
  }

  // Quiesce: make sure a committed page exists (so held requests flush),
  // then let Safari answer everything.
  failNextEnvelope = false;
  if (!mainPage) await create("page", false);
  for (let round = 0; round < 2; round++) {
    while (pending.length) await deliver(0);
    await new Promise((r) => setTimeout(r, 2)); // worker-adoption grace
  }
  await Promise.resolve();

  return { t, toTools, calls, sent: nextToolId - 1 };
}

test("every request is answered exactly once under arbitrary orderings (fast-check model)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(actionArb, { maxLength: 60 }), async (actions) => {
      const { t, toTools, calls, sent } = await runScenario(actions);
      const counts = new Map<number, number>();
      for (const m of toTools) {
        if (typeof m.id !== "number") continue;
        expect(m.id).toBeGreaterThan(0); // no bridge-internal id leaks
        counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
      }
      for (let id = 1; id <= sent; id++) {
        if (counts.get(id) !== 1) {
          throw new Error(`request ${id} got ${counts.get(id) ?? 0} replies; ${JSON.stringify(t.debugState())}`);
        }
      }
      expect(calls.every((c) => c.settled)).toBe(true);
      const s = t.debugState();
      expect(s.queued).toBe(0);
      expect(s.wrapped).toBe(0);
      expect(s.toolRequests).toBe(0);
      t.close();
    }),
    {
      numRuns: fcRuns(300),
      // The page-only form of a 100k-run counterexample whose original
      // committed a provisional worker (WebKit never does): commit a
      // navigation, add a page, destroy one of them, send.
      examples: [0, 1, 2, 3].map((pick): [Action[]] => [
        [
          { kind: "create", type: "page", provisional: true },
          { kind: "commit", pick: 0 },
          { kind: "create", type: "page", provisional: false },
          { kind: "destroy", pick },
          { kind: "send" },
          { kind: "deliver", pick: 0 },
          { kind: "deliver", pick: 0 },
        ],
      ]),
    },
  );
}, fcTimeout(30_000));
