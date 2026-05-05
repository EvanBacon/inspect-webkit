import { test, expect } from "bun:test";
import { installRuntimeFilters } from "../cdp/domains/runtime";
import { makeDomainCtx } from "../cdp/domain";
import type { Target } from "../cdp/target";
import type { CdpMessage } from "../cdp/target";

// Minimal Target stand-in for filter tests. We exercise the filter
// pipeline directly: register filters, hand it a tools-side message,
// observe what it forwards (return value) vs replies synchronously
// (fireResultToTools).
function makeFakeTarget() {
  const filters = new Map<string, ((m: CdpMessage) => Promise<CdpMessage | null>)[]>();
  const replies: Array<{ id: number; result: any }> = [];
  const events: Array<{ method: string; params: any }> = [];
  const fake = {
    addMessageFilter(method: string, f: (m: CdpMessage) => Promise<CdpMessage | null>) {
      let list = filters.get(method);
      if (!list) filters.set(method, (list = []));
      list.push(f);
    },
    fireResultToTools(id: number, result: any) {
      replies.push({ id, result });
    },
    fireEventToTools(method: string, params: any) {
      events.push({ method, params });
    },
  };
  async function runFilters(method: string, msg: CdpMessage) {
    const list = filters.get(method) ?? [];
    let cur: CdpMessage | null = msg;
    for (const f of list) {
      if (!cur) break;
      cur = await f(cur);
    }
    return cur;
  }
  return { fake: fake as unknown as Target, runFilters, replies, events };
}

test("Runtime.evaluate with throwOnSideEffect:true is short-circuited at the bridge", async () => {
  const { fake, runFilters, replies } = makeFakeTarget();
  installRuntimeFilters(fake, makeDomainCtx());

  const msg: CdpMessage = {
    id: 7,
    method: "Runtime.evaluate",
    params: {
      expression: "window.__probe = 42",
      throwOnSideEffect: true,
      timeout: 250,
      silent: true,
    },
  };

  const forwarded = await runFilters("tools::Runtime.evaluate", msg);

  // Must NOT forward to Safari.
  expect(forwarded).toBeNull();

  // Must reply synchronously with a side-effect EvalError, in CDP shape.
  expect(replies).toHaveLength(1);
  expect(replies[0].id).toBe(7);
  const r = replies[0].result;
  expect(r.exceptionDetails).toBeDefined();
  expect(r.exceptionDetails.text).toMatch(/side-effect/);
  expect(r.result.subtype).toBe("error");
  expect(r.result.className).toBe("EvalError");
});

test("Runtime.evaluate without throwOnSideEffect is forwarded (silent/userGesture renamed)", async () => {
  const { fake, runFilters, replies } = makeFakeTarget();
  installRuntimeFilters(fake, makeDomainCtx());

  const msg: CdpMessage = {
    id: 8,
    method: "Runtime.evaluate",
    params: {
      expression: "1 + 1",
      silent: true,
      userGesture: true,
    },
  };

  const forwarded = await runFilters("tools::Runtime.evaluate", msg);

  // Forwarded, no synthetic reply.
  expect(forwarded).not.toBeNull();
  expect(replies).toHaveLength(0);
  // CDP-only field renames applied.
  expect(forwarded!.params.doNotPauseOnExceptionsAndMuteConsole).toBe(true);
  expect(forwarded!.params.emulateUserGesture).toBe(true);
  expect(forwarded!.params.silent).toBeUndefined();
  expect(forwarded!.params.userGesture).toBeUndefined();
});
