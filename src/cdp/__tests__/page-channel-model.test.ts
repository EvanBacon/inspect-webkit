// Stateful model of a PageChannel shared by up to three clients: clients
// attach and detach at random, send interleaved commands (with colliding
// ids — every client counts from 1), enable and disable domains, issue
// bridge callTarget()s, while Safari answers in arbitrary order, emits
// events and creates / destroys / swaps inner targets.
//
// Invariants:
//   - every request gets exactly one reply, on the client that sent it,
//     carrying that client's own id (a client that left gets at most one);
//   - every callTarget() settles;
//   - Safari has a domain enabled on the page iff some attached client
//     last asked for it to be enabled;
//   - a client that never enabled a domain never sees its events, and one
//     whose enable was acknowledged sees every later event of it;
//   - nothing is left in the routing table once everything is answered.

import { test, expect } from "bun:test";
import fc from "fast-check";
import { PageChannel } from "../page-channel";
import { Target } from "../target";

const DOMAINS = ["Runtime", "Debugger", "Network"] as const;
type Domain = (typeof DOMAINS)[number];
const METHODS = [
  "Runtime.evaluate",
  "DOM.getDocument",
  ...DOMAINS.flatMap((d) => [`${d}.enable`, `${d}.disable`]),
];

type Action =
  | { kind: "attach" }
  | { kind: "detach"; pick: number }
  | { kind: "send"; pick: number; method: number }
  | { kind: "call"; pick: number }
  | { kind: "deliver"; pick: number }
  | { kind: "event"; domain: number }
  | { kind: "create"; type: "page" | "worker"; provisional: boolean }
  | { kind: "destroy"; pick: number }
  | { kind: "commit"; pick: number }
  | { kind: "errorNext" };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<Action>({ kind: "attach" }) },
  { weight: 1, arbitrary: fc.nat(5).map<Action>((pick) => ({ kind: "detach", pick })) },
  {
    weight: 6,
    arbitrary: fc
      .record({ pick: fc.nat(5), method: fc.nat(METHODS.length - 1) })
      .map<Action>((r) => ({ kind: "send", ...r })),
  },
  { weight: 1, arbitrary: fc.nat(5).map<Action>((pick) => ({ kind: "call", pick })) },
  { weight: 8, arbitrary: fc.nat(60).map<Action>((pick) => ({ kind: "deliver", pick })) },
  { weight: 2, arbitrary: fc.nat(DOMAINS.length - 1).map<Action>((domain) => ({ kind: "event", domain })) },
  {
    weight: 1,
    arbitrary: fc
      .record({ type: fc.constantFrom("page" as const, "worker" as const), provisional: fc.boolean() })
      .map<Action>((r) => ({ kind: "create", ...r })),
  },
  { weight: 1, arbitrary: fc.nat(10).map<Action>((pick) => ({ kind: "destroy", pick })) },
  { weight: 1, arbitrary: fc.nat(10).map<Action>((pick) => ({ kind: "commit", pick })) },
  { weight: 1, arbitrary: fc.constant<Action>({ kind: "errorNext" }) },
);

type ModelClient = {
  name: number;
  t: Target;
  detach: () => void;
  attached: boolean;
  got: any[];
  /** id → method, for every request sent. */
  sent: Map<number, string>;
  nextId: number;
  /** Domain → id of the client's last enable/disable for it. */
  last: Map<Domain, { verb: "enable" | "disable"; id: number }>;
  everEnabled: Set<Domain>;
  calls: Array<{ settled: boolean }>;
};

async function runScenario(actions: Action[]) {
  const handlers = new Set<(m: any) => void>();
  let pending: Array<{ targetId: string | null; frame: unknown }> = [];
  const alive = new Map<string, { type: string; provisional: boolean }>();
  /** What Safari has enabled, per inner target. */
  const wireEnabled = new Map<string, Set<string>>();
  let mainPage: string | null = null;
  let nextTarget = 0;
  let failNext = false;
  let senderKey = "";

  const push = (m: unknown) => {
    for (const h of [...handlers]) {
      h({
        __selector: "_rpc_applicationSentData:",
        __argument: {
          WIRApplicationIdentifierKey: "PID:1",
          WIRPageIdentifierKey: 1,
          WIRDestinationKey: senderKey,
          WIRMessageDataKey: JSON.stringify(m),
        },
      });
    }
  };
  const wi = {
    subscribe(h: (m: any) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    forwardSocketSetup(_a: string, _p: number, k: string) {
      senderKey = k;
    },
    forwardDidClose() {},
    forwardSocketData(_a: string, _p: number, _s: string, bytes: Uint8Array) {
      const outer = JSON.parse(new TextDecoder().decode(bytes));
      if (outer.method !== "Target.sendMessageToTarget") {
        pending.push({ targetId: null, frame: { result: { raw: true }, id: outer.id } });
        return;
      }
      const targetId = outer.params.targetId as string;
      const inner = JSON.parse(outer.params.message);
      const verb = String(inner.method).split(".")[1];
      const stateful = verb === "enable" || verb === "disable";
      if (!alive.has(targetId) || (failNext && !stateful)) {
        failNext = false;
        pending.push({
          targetId: null,
          frame: { id: outer.id, error: { code: -32000, message: "Missing target for given targetId" } },
        });
        return;
      }
      if (stateful) {
        const set = wireEnabled.get(targetId) ?? new Set();
        wireEnabled.set(targetId, set);
        const domain = String(inner.method).split(".")[0]!;
        if (verb === "enable") set.add(domain);
        else set.delete(domain);
      }
      pending.push({ targetId, frame: { result: {}, id: outer.id } });
      if (typeof inner.id === "number") {
        pending.push({
          targetId,
          frame: {
            method: "Target.dispatchMessageFromTarget",
            params: { targetId, message: JSON.stringify({ result: { echo: inner.method }, id: inner.id }) },
          },
        });
      }
    },
  };

  const ch = new PageChannel(wi as any, "PID:1", 1);
  const clients: ModelClient[] = [];
  let nextName = 0;

  function attach() {
    const got: any[] = [];
    const ws = { readyState: 1, send: (text: string) => got.push(JSON.parse(text)) };
    const t = new Target(ws as any, wi as any, "PID:1", 1, "unused");
    t.workerGraceMs = 1;
    t.swapTimeoutMs = 60_000;
    const detach = ch.attach(t, () => {});
    clients.push({
      name: nextName++,
      t,
      detach,
      attached: true,
      got,
      sent: new Map(),
      nextId: 1,
      last: new Map(),
      everEnabled: new Set(),
      calls: [],
    });
  }
  const live = () => clients.filter((c) => c.attached);
  const pickLive = (n: number) => {
    const l = live();
    return l.length ? l[n % l.length]! : null;
  };

  async function create(type: string, provisional: boolean) {
    const id = `${type}-${nextTarget++}`;
    alive.set(id, { type, provisional });
    if (type === "page" && !provisional && !mainPage) mainPage = id;
    push({ method: "Target.targetCreated", params: { targetInfo: { targetId: id, type, isProvisional: provisional } } });
  }
  async function destroy(id: string) {
    alive.delete(id);
    wireEnabled.delete(id);
    if (mainPage === id) {
      // Like Target: adopt another committed page if there is one.
      mainPage = [...alive].find(([, v]) => v.type === "page" && !v.provisional)?.[0] ?? null;
    }
    pending = pending.filter((p) => p.targetId !== id);
    push({ method: "Target.targetDestroyed", params: { targetId: id } });
  }
  const settle = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };
  const problems: string[] = [];

  async function emit(domain: Domain) {
    if (!mainPage || !wireEnabled.get(mainPage)?.has(domain)) return; // WebKit only emits when enabled
    const method = `${domain}.modelEvent`;
    const before = live().map((c) => ({ c, n: c.got.filter((m) => m.method === method).length }));
    // Expected recipients: last asked for an enable, it was acknowledged,
    // and the client is driving this page.
    const expectGot = live().filter((c) => {
      const l = c.last.get(domain);
      return (
        l?.verb === "enable" &&
        c.got.some((m) => m.id === l.id) &&
        c.t.debugState().active === mainPage
      );
    });
    push({
      method: "Target.dispatchMessageFromTarget",
      params: { targetId: mainPage, message: JSON.stringify({ method, params: {} }) },
    });
    await settle();
    for (const { c, n } of before) {
      const got = c.got.filter((m) => m.method === method).length - n;
      if (!c.everEnabled.has(domain) && got > 0) problems.push(`client ${c.name} got ${method} without enabling`);
      if (expectGot.includes(c) && got !== 1) problems.push(`client ${c.name} got ${got}x ${method}`);
    }
  }

  // Start the way a real attach does: one client, then WebKit announces the page.
  attach();
  await create("page", false);

  for (const a of actions) {
    switch (a.kind) {
      case "attach":
        if (live().length < 3) attach();
        break;
      case "detach": {
        const c = pickLive(a.pick);
        if (!c || live().length === 1) break; // keep the channel alive
        c.attached = false;
        c.t.close("DevTools client disconnected");
        c.detach();
        break;
      }
      case "send": {
        const c = pickLive(a.pick);
        if (!c) break;
        const method = METHODS[a.method]!;
        const id = c.nextId++;
        c.sent.set(id, method);
        const [domain, verb] = method.split(".") as [Domain, string];
        if (verb === "enable" || verb === "disable") {
          c.last.set(domain, { verb, id });
          if (verb === "enable") c.everEnabled.add(domain);
        }
        await c.t.onMessageFromTools(JSON.stringify({ id, method, params: {} }));
        break;
      }
      case "call": {
        const c = pickLive(a.pick);
        if (!c) break;
        const rec = { settled: false };
        c.calls.push(rec);
        c.t.callTarget("DOM.getDocument", {}).then(
          () => (rec.settled = true),
          () => (rec.settled = true),
        );
        break;
      }
      case "deliver":
        if (pending.length) {
          const [p] = pending.splice(a.pick % pending.length, 1);
          push(p!.frame);
        }
        break;
      case "event":
        await emit(DOMAINS[a.domain]!);
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
        const prov = [...alive].filter(([, v]) => v.provisional).map(([k]) => k);
        if (!prov.length) break;
        const next = prov[a.pick % prov.length]!;
        alive.get(next)!.provisional = false;
        const old = mainPage;
        mainPage = next;
        push({ method: "Target.didCommitProvisionalTarget", params: { oldTargetId: old ?? "gone", newTargetId: next } });
        break;
      }
      case "errorNext":
        failNext = true;
        break;
    }
    await settle();
  }

  // Quiesce: a committed page exists, Safari answers everything.
  failNext = false;
  if (!mainPage) await create("page", false);
  for (let round = 0; round < 3; round++) {
    await settle();
    while (pending.length) {
      push(pending.shift()!.frame);
      await settle();
    }
    await new Promise((r) => setTimeout(r, 2));
  }

  // Replies: exactly one per request, on the sender, with its own id.
  for (const c of clients) {
    for (const [id, method] of c.sent) {
      const n = c.got.filter((m) => m.id === id).length;
      if (c.attached ? n !== 1 : n > 1) problems.push(`client ${c.name}: ${n} replies to ${method} #${id}`);
    }
    for (const m of c.got) {
      if (typeof m.id === "number" && !c.sent.has(m.id)) problems.push(`client ${c.name}: foreign reply id ${m.id}`);
    }
    if (c.attached && c.calls.some((x) => !x.settled)) problems.push(`client ${c.name}: callTarget never settled`);
  }
  // Safari's domain state matches the union of what attached clients want.
  const wire = wireEnabled.get(mainPage!) ?? new Set();
  for (const d of DOMAINS) {
    const wanted = live().some((c) => c.last.get(d)?.verb === "enable");
    if (wire.has(d) !== wanted) problems.push(`${d}: Safari enabled=${wire.has(d)}, clients want ${wanted}`);
  }
  if (ch.debugState().routes !== 0) problems.push(`routes left: ${ch.debugState().routes}`);
  return problems;
}

test("N clients share a page: one reply per request on its sender, domains refcounted (fast-check model)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(actionArb, { maxLength: 60 }), async (actions) => {
      const problems = await runScenario(actions);
      expect(problems).toEqual([]);
    }),
    { numRuns: 300 },
  );
}, 60_000);
