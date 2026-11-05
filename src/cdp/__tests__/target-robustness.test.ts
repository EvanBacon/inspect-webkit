// Target pipeline robustness: hostile / malformed frames from either side
// must never reject (an unhandled rejection kills the bridge process), and
// every tools-side request that a filter chokes on gets a CDP error reply.

import { test, expect } from "bun:test";
import { Target } from "../target";
import { installIOSFilters } from "../ios-protocol";

function makeRig(opts: { filters?: boolean; targetBased?: boolean } = {}) {
  const toTools: any[] = [];
  const toTarget: any[] = [];
  const ws = {
    readyState: 1,
    send(text: string) {
      toTools.push(JSON.parse(text));
    },
  };
  const wi = {
    forwardSocketData(_a: string, _p: number, _s: string, bytes: Uint8Array) {
      const outer = JSON.parse(new TextDecoder().decode(bytes));
      // Unwrap Target.sendMessageToTarget so tests see the inner command.
      if (outer.method === "Target.sendMessageToTarget") toTarget.push(JSON.parse(outer.params.message));
      else toTarget.push(outer);
    },
    forwardDidClose() {},
  };
  const t = new Target(ws as any, wi as any, "PID:1", 1, "sender");
  if (opts.filters !== false) installIOSFilters(t);
  return { t, toTools, toTarget };
}

async function targetBased(rig: ReturnType<typeof makeRig>) {
  await rig.t.onMessageFromTarget(
    JSON.stringify({
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "page-1", type: "page" } },
    }),
  );
}

const NON_OBJECT_FRAMES = ["null", "1", "[]", '"s"', "true", "[1,2]"];

for (const f of NON_OBJECT_FRAMES) {
  test(`tools-side frame ${f} is ignored without throwing (R2)`, async () => {
    const rig = makeRig();
    await expect(rig.t.onMessageFromTools(f)).resolves.toBeUndefined();
  });
  test(`target-side frame ${f} is ignored without throwing`, async () => {
    const rig = makeRig();
    await expect(rig.t.onMessageFromTarget(f)).resolves.toBeUndefined();
  });
}

// The exact frames fuzz-lite found that killed the process on main (R3).
const FUZZ_CRASH_FRAMES = [
  { id: 11, method: "DOM.pushNodesByBackendIdsToFrontend", params: { backendNodeIds: "x" } },
  { id: 12, method: "DOM.pushNodesByBackendIdsToFrontend", params: { backendNodeIds: 1 } },
  { id: 13, method: "DOM.setInspectMode", params: "x" },
  { id: 14, method: "Network.setCacheDisabled", params: "x" },
  { id: 15, method: "Runtime.evaluate", params: "x" },
  { id: 16, method: "CSS.setStyleTexts", params: { edits: 5 } },
];

for (const f of FUZZ_CRASH_FRAMES) {
  test(`fuzz crash frame ${f.method} ${JSON.stringify(f.params)} is answered, not thrown (R3)`, async () => {
    const rig = makeRig();
    await targetBased(rig);
    await expect(rig.t.onMessageFromTools(JSON.stringify(f))).resolves.toBeUndefined();
    // Either forwarded to Safari or replied to the client — never dropped.
    const replied = rig.toTools.some((m) => m.id === f.id);
    const forwarded = rig.toTarget.some((m) => m.id === f.id);
    expect(replied || forwarded).toBe(true);
  });
}

test("a throwing tools-side filter replies with a CDP error", async () => {
  const rig = makeRig({ filters: false });
  rig.t.addMessageFilter("tools::Boom.go", () => {
    throw new TypeError("kaboom");
  });
  await expect(
    rig.t.onMessageFromTools(JSON.stringify({ id: 3, method: "Boom.go" })),
  ).resolves.toBeUndefined();
  const r = rig.toTools.find((m) => m.id === 3);
  expect(r?.error?.message).toContain("kaboom");
  expect(typeof r?.error?.code).toBe("number");
});

test("an async-rejecting tools-side filter replies with a CDP error", async () => {
  const rig = makeRig({ filters: false });
  rig.t.addMessageFilter("tools::Boom.go", async () => {
    throw new Error("async kaboom");
  });
  await rig.t.onMessageFromTools(JSON.stringify({ id: 4, method: "Boom.go" }));
  expect(rig.toTools.find((m) => m.id === 4)?.error?.message).toContain("async kaboom");
});

test("a throwing target-side filter passes the raw message through", async () => {
  const rig = makeRig({ filters: false });
  await targetBased(rig);
  rig.t.addMessageFilter("target::Boom.event", () => {
    throw new Error("bad event");
  });
  rig.t.addMessageFilter("target::Boom.go", () => {
    throw new Error("bad reply");
  });
  await expect(
    rig.t.onMessageFromTarget(JSON.stringify({ method: "Boom.event", params: { a: 1 } })),
  ).resolves.toBeUndefined();
  expect(rig.toTools.find((m) => m.method === "Boom.event")?.params).toEqual({ a: 1 });

  await rig.t.onMessageFromTools(JSON.stringify({ id: 9, method: "Boom.go" }));
  // Outer Target.sendMessageToTarget ack first, then the inner reply
  // wrapped — Safari's usual order in target-based mode.
  await rig.t.onMessageFromTarget(JSON.stringify({ id: 9, result: {} }));
  const inner = JSON.stringify({ id: 9, result: { ok: true } });
  await expect(
    rig.t.onMessageFromTarget(
      JSON.stringify({
        method: "Target.dispatchMessageFromTarget",
        params: { targetId: "page-1", message: inner },
      }),
    ),
  ).resolves.toBeUndefined();
  expect(rig.toTools.find((m) => m.id === 9)?.result).toEqual({ ok: true });
});

test("callTarget times out instead of hanging forever", async () => {
  const rig = makeRig({ filters: false });
  rig.t.callTimeoutMs = 50;
  await targetBased(rig);
  await expect(rig.t.callTarget("DOM.getDocument", {})).rejects.toThrow(/timed out/);
});

test("close() rejects pending callTarget promises", async () => {
  const rig = makeRig({ filters: false });
  await targetBased(rig);
  const p = rig.t.callTarget("DOM.getDocument", {});
  rig.t.close("session closed");
  await expect(p).rejects.toThrow(/session closed/);
  // Further calls fail fast.
  await expect(rig.t.callTarget("DOM.getDocument", {})).rejects.toThrow();
});
