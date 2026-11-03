// CDP tools side: Target.onMessageFromTools through every iOS domain filter,
// against a fake Safari that answers every forwarded command (with reply
// templates from the input) and emits events / inner-target lifecycle.
//
// Invariants:
//   - nothing escapes (no rejection, no throw out of the pipeline);
//   - every tracked request (unique id, string method) gets exactly one
//     reply, and no reply carries an id the client never sent (bridge ids,
//     envelope ids);
//   - everything sent to DevTools is a JSON object;
//   - Network.getResponseBody's re-fetch never connects to a non-public
//     address under "public", nor to the bridge's own port under "any";
//   - no prototype pollution.
//
// Input: byte 0 = schedule (reply orders, re-fetch policy), then lines (see
// lib/cdp-lines.ts).

import { Target } from "../../src/cdp/target";
import { installIOSFilters } from "../../src/cdp/ios-protocol";
import { Bytes } from "../lib/bytes";
import { parseOps, type Vocab } from "../lib/cdp-lines";
import { FakeSafari, fakeRefetchDeps, isNonPublic, type RefetchLog } from "../lib/fake-safari";
import { check, checkGlobal, harness, settle, setupHarness } from "../lib/invariants";

setupHarness();

const BRIDGE_PORT = 9222;

let vocab: Vocab | null = null;
function vocabulary(t: Target): Vocab {
  if (vocab) return vocab;
  const keys = [...(t as unknown as { filters: Map<string, unknown> }).filters.keys()];
  const tools = keys.filter((k) => k.startsWith("tools::")).map((k) => k.slice(7));
  const target = keys.filter((k) => k.startsWith("target::") && k !== "target::error").map((k) => k.slice(8));
  // Requests named after events too (a reply must survive their event filters).
  tools.push(...target);
  // Unfiltered pass-through methods too.
  tools.push("Runtime.getProperties", "DOM.querySelector", "Debugger.resume", "Page.reload", "Nope.nothing");
  target.push("Runtime.executionContextCreated", "Debugger.paused", "Console.messageAdded", "Network.requestWillBeSent");
  vocab = { toolsMethods: [...new Set(tools)].sort(), targetMethods: [...new Set(target)].sort() };
  return vocab;
}

async function run(data: Uint8Array): Promise<void> {
  const schedule = data[0] ?? 0;
  const policy = (["public", "any", "off"] as const)[schedule % 3]!;
  const safari = new FakeSafari(schedule);
  const toTools: string[] = [];
  const ws = { readyState: 1, send: (s: string) => toTools.push(s) };
  const wi = {
    closed: false,
    forwardSocketData: (_a: string, _p: number, _s: string, bytes: Uint8Array) => safari.onWire(Buffer.from(bytes).toString()),
    forwardDidClose() {},
    forwardSocketSetup() {},
    subscribe: () => () => {},
  };
  const t = new Target(ws as never, wi as never, "PID:1", 1, "sender");
  t.callTimeoutMs = 300;
  t.swapTimeoutMs = 20;
  t.workerGraceMs = 5;
  const refetchLog: RefetchLog = [];
  const dnsBytes = new Bytes(data.subarray(1, 64));
  installIOSFilters(t, {
    network: { responseBodyRefetch: policy, bridgePorts: () => [BRIDGE_PORT], refetchDeps: fakeRefetchDeps(dnsBytes, refetchLog) },
  });
  const ops = parseOps(data.subarray(1), vocabulary(t));

  // Tools frames run concurrently with delivery: a filter may be waiting on
  // a callTarget() reply that is still in Safari's queue.
  const inflight = new Set<Promise<void>>();
  const fromTools = (raw: string) => {
    const p = t.onMessageFromTools(raw).finally(() => inflight.delete(p));
    inflight.add(p);
  };
  const deliver = async () => {
    for (let round = 0; round < 50; round++) {
      while (safari.queue.length) await t.onMessageFromTarget(safari.queue.shift()!);
      await settle(1);
      if (safari.queue.length === 0 && inflight.size === 0) return;
    }
  };

  // Target-based mode from the start, like modern Safari.
  safari.lifecycle("create", "page-1", "page", false);
  await deliver();

  const sentIds = new Set<number>();
  const tracked = new Map<number, string>();
  let nextId = 1_000_000; // disjoint from ids in garbage frames
  for (const op of ops) {
    switch (op.k) {
      case "tools": {
        const id = nextId++;
        const msg = { ...op.msg, id };
        tracked.set(id, msg.method);
        sentIds.add(id);
        fromTools(JSON.stringify(msg));
        break;
      }
      case "garbage": {
        try {
          const v = JSON.parse(op.raw);
          if (typeof v?.id === "number") sentIds.add(v.id);
        } catch {}
        fromTools(op.raw);
        break;
      }
      case "event":
        safari.event(op.raw, op.topLevel);
        break;
      case "template":
        safari.setTemplate(op.method, op.reply);
        break;
      case "lifecycle":
        safari.lifecycle(op.what, op.id, op.type, op.provisional, op.old);
        break;
      case "settle":
        await settle(2);
        break;
    }
    await deliver();
  }

  // Quiescence: queued requests fail after swapTimeoutMs, callTarget after callTimeoutMs.
  const deadline = Date.now() + 1500;
  const answered = () => {
    const counts = new Map<number, number>();
    for (const s of toTools) {
      let m: any;
      try {
        m = JSON.parse(s);
      } catch {
        throw new Error(`bridge sent invalid JSON to DevTools: ${s.slice(0, 80)}`);
      }
      check(m !== null && typeof m === "object" && !Array.isArray(m), "bridge sent a non-object to DevTools");
      if (typeof m.id === "number") counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
    }
    return counts;
  };
  let counts = answered();
  while ([...tracked.keys()].some((id) => !counts.has(id)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
    await deliver();
    counts = answered();
  }
  t.close("fuzz input done");
  await settle(1);

  for (const [id, method] of tracked) {
    const n = counts.get(id) ?? 0;
    check(n === 1, `${method} (id ${id}) got ${n} replies`);
  }
  for (const id of counts.keys()) {
    // Garbage frames may carry ids we didn't track; anything else is a leak.
    check(sentIds.has(id), `reply with an id the client never sent: ${id}`);
  }
  for (const r of refetchLog) {
    const port = new URL(r.url).port;
    if (policy === "public") check(!isNonPublic(r.address), `public re-fetch connected to ${r.address} (${r.url})`);
    check(policy !== "off", "re-fetch ran with policy off");
    if (isNonPublic(r.address) || r.address === "192.168.1.91") {
      check(port !== String(BRIDGE_PORT), `re-fetch reached the bridge port: ${r.url} via ${r.address}`);
    }
  }
  checkGlobal();
}

export const fuzz = harness(run);
