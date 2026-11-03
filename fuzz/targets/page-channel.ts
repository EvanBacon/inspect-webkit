// PageChannel, stateful, multi-client: up to 3 DevTools sessions (each a
// Target with the full iOS filter set) share one WIR sender. Clients attach,
// detach and send interleaved requests with colliding ids; Safari answers
// them out of order (envelope acks and inner replies separately), injects
// events and inner-target lifecycle.
//
// Invariants:
//   - every request of a client still attached at the end gets exactly
//     one reply, on that client; a detached client's requests at most one;
//   - no client sees a reply id it never sent;
//   - when the last client leaves, the sender is released exactly once and
//     the channel holds no routes;
//   - nothing escapes; no prototype pollution.
//
// Input: byte 0 = schedule, then lines: "<n>T<json>" / "W<json>" /
// "R<json>" (lib/cdp-lines.ts), "A" attach, "D<n>" detach; anything else
// drives the generator below.

import { PageChannel } from "../../src/cdp/page-channel";
import { Target } from "../../src/cdp/target";
import { installIOSFilters } from "../../src/cdp/ios-protocol";
import { Bytes } from "../lib/bytes";
import { parseOps, type Op, type Vocab } from "../lib/cdp-lines";
import { FakeSafari } from "../lib/fake-safari";
import { check, checkGlobal, harness, settle, setupHarness } from "../lib/invariants";

setupHarness();

const MAX_CLIENTS = 3;
let vocab: Vocab | null = null;

type Client = { t: Target; got: string[]; sent: Set<number>; tracked: Map<number, string>; detach: () => void; gone: boolean };

type Step = Op | { k: "attach" } | { k: "detach"; client: number } | { k: "deliver"; pick: number; n: number };

function steps(data: Uint8Array, v: Vocab): Step[] {
  const out: Step[] = [];
  for (const line of Buffer.from(data).toString("utf8").split("\n").slice(0, 300)) {
    if (line === "A") out.push({ k: "attach" });
    else if (/^D\d$/.test(line)) out.push({ k: "detach", client: Number(line[1]) });
    else if (/^([0-9]T|[TWR])/.test(line)) out.push(...parseOps(Buffer.from(line), v, MAX_CLIENTS));
    else {
      const b = new Bytes(Buffer.from(line, "latin1"));
      while (!b.done && out.length < 300) {
        const k = b.u8() % 8;
        if (k === 0) out.push({ k: "attach" });
        else if (k === 1) out.push({ k: "detach", client: b.u8() % MAX_CLIENTS });
        else if (k <= 4) out.push({ k: "deliver", pick: b.u8(), n: 1 + (b.u8() % 4) });
        else out.push(...parseOps(b.bytes(24), v, MAX_CLIENTS));
      }
    }
  }
  return out;
}

async function run(data: Uint8Array): Promise<void> {
  const safari = new FakeSafari(data[0] ?? 0);
  const handlers = new Set<(m: any) => void>();
  let setups = 0;
  let didCloses = 0;
  const wi = {
    closed: false,
    subscribe(h: (m: any) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    forwardSocketSetup() {
      setups++;
    },
    forwardDidClose() {
      didCloses++;
    },
    forwardSocketData: (_a: string, _p: number, _s: string, bytes: Uint8Array) => safari.onWire(Buffer.from(bytes).toString()),
  };
  const channel = new PageChannel(wi as never, "PID:1", 1);
  const push = (text: string) => {
    for (const h of [...handlers]) {
      h({
        __selector: "_rpc_applicationSentData:",
        __argument: {
          WIRApplicationIdentifierKey: "PID:1",
          WIRPageIdentifierKey: 1,
          WIRDestinationKey: channel.senderKey,
          WIRMessageDataKey: new TextEncoder().encode(text),
        },
      });
    }
  };

  const clients: Client[] = [];
  const attach = () => {
    if (channel.closed || clients.filter((c) => !c.gone).length >= MAX_CLIENTS) return;
    const got: string[] = [];
    const t = new Target({ readyState: 1, send: (s: string) => got.push(s) } as never, wi as never, "PID:1", 1, "unused");
    t.callTimeoutMs = 300;
    t.swapTimeoutMs = 20;
    t.workerGraceMs = 5;
    installIOSFilters(t, { network: { responseBodyRefetch: "off" } });
    vocab ??= vocabOf(t);
    const c: Client = { t, got, sent: new Set(), tracked: new Map(), gone: false, detach: () => {} };
    const detach = channel.attach(t, () => {
      c.gone = true;
    });
    c.detach = () => {
      if (c.gone) return;
      c.gone = true;
      t.close("detached");
      detach();
    };
    clients.push(c);
  };
  const live = () => clients.filter((c) => !c.gone);

  attach();
  safari.lifecycle("create", "page-1", "page", false);
  const inflight = new Set<Promise<void>>();
  const drain = async (all: boolean, pick = 0, n = 1) => {
    for (let round = 0; round < 50; round++) {
      let k = all ? safari.queue.length : n;
      while (k-- > 0 && safari.queue.length) {
        const [text] = safari.queue.splice(all ? 0 : pick % safari.queue.length, 1);
        push(text!);
      }
      await settle(1);
      if (!all || (safari.queue.length === 0 && inflight.size === 0)) return;
    }
  };
  await drain(true);

  let nextId = 1_000_000; // shared sequence: clients collide on purpose
  for (const s of steps(data.subarray(1), vocab!)) {
    switch (s.k) {
      case "attach":
        attach();
        break;
      case "detach":
        live()[s.client % Math.max(1, live().length)]?.detach();
        break;
      case "deliver":
        await drain(false, s.pick, s.n);
        break;
      case "tools": {
        const c = live()[s.client % Math.max(1, live().length)];
        if (!c) break;
        const id = c.tracked.size === 0 ? nextId : nextId + (s.client % 2);
        nextId++;
        if (c.sent.has(id)) break;
        c.sent.add(id);
        c.tracked.set(id, s.msg.method);
        const p = c.t.onMessageFromTools(JSON.stringify({ ...s.msg, id })).finally(() => inflight.delete(p));
        inflight.add(p);
        break;
      }
      case "garbage": {
        const c = live()[s.client % Math.max(1, live().length)];
        if (!c) break;
        try {
          const v = JSON.parse(s.raw);
          if (typeof v?.id === "number") c.sent.add(v.id);
        } catch {}
        void c.t.onMessageFromTools(s.raw);
        break;
      }
      case "event":
        safari.event(s.raw, s.topLevel);
        break;
      case "template":
        safari.setTemplate(s.method, s.reply);
        break;
      case "lifecycle":
        safari.lifecycle(s.what, s.id, s.type, s.provisional, s.old);
        break;
      case "settle":
        await settle(2);
        break;
    }
    await settle(1);
  }

  // Quiescence: deliver everything, let timers fire.
  const deadline = Date.now() + 1500;
  const replies = (c: Client) => {
    const counts = new Map<number, number>();
    for (const s of c.got) {
      const m = JSON.parse(s);
      if (typeof m?.id === "number") counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
    }
    return counts;
  };
  const pending = () => live().some((c) => [...c.tracked.keys()].some((id) => !replies(c).has(id)));
  await drain(true);
  while (pending() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
    await drain(true);
  }

  for (const [i, c] of clients.entries()) {
    const counts = replies(c);
    for (const [id, method] of c.tracked) {
      const n = counts.get(id) ?? 0;
      if (c.gone) check(n <= 1, `client ${i} (detached): ${method} got ${n} replies`);
      else check(n === 1, `client ${i}: ${method} (id ${id}) got ${n} replies`);
    }
    for (const id of counts.keys()) check(c.sent.has(id), `client ${i} got a reply for an id it never sent: ${id}`);
  }
  for (const c of live()) c.detach();
  await drain(true);
  check(setups <= 1, `forwardSocketSetup sent ${setups} times`);
  check(didCloses === (setups ? 1 : 0), `forwardDidClose sent ${didCloses} times`);
  check(channel.closed, "channel still open after its last client left");
  check(channel.debugState().routes === 0, `${channel.debugState().routes} routes left after teardown`);
  checkGlobal();
}

function vocabOf(t: Target): Vocab {
  const keys = [...(t as unknown as { filters: Map<string, unknown> }).filters.keys()];
  const tools = keys.filter((k) => k.startsWith("tools::")).map((k) => k.slice(7));
  const target = keys.filter((k) => k.startsWith("target::") && k !== "target::error").map((k) => k.slice(8));
  for (const d of ["Runtime", "Debugger", "Network", "Console", "CSS", "DOM", "Page"]) tools.push(`${d}.enable`, `${d}.disable`);
  tools.push("Runtime.evaluate", "Debugger.setBreakpointByUrl", "Debugger.removeBreakpoint", "DOM.getDocument");
  target.push("Runtime.executionContextCreated", "Debugger.scriptParsed", "Debugger.paused", "Debugger.resumed", "Console.messageAdded");
  return { toolsMethods: [...new Set(tools)].sort(), targetMethods: [...new Set(target)].sort() };
}

export const fuzz = harness(run);
