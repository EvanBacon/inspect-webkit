// Browser-level endpoint (/devtools/browser/<id>): Target.* discovery,
// auto-attach and flatten-mode session routing, against a fake target list
// that changes under it and fake page sessions that answer what they get.
//
// Invariants:
//   - the message handler never throws (it would only be logged);
//   - every request with a numeric id gets exactly one reply, carrying the
//     sessionId it was sent with (browser session or page session);
//   - every page session handle is closed exactly once by the time the
//     socket closes, and never receives traffic after closing;
//   - nothing escapes; no prototype pollution.
//
// Input lines: T<json> (a frame as sent), else the generator.

import { EventEmitter } from "node:events";
import { attachBrowserWs, type BrowserEntry } from "../../src/cdp/browser-endpoint";
import { Bytes } from "../lib/bytes";
import { check, checkGlobal, harness, settle, setupHarness, softFindings } from "../lib/invariants";

setupHarness();

const METHODS = [
  "Target.setDiscoverTargets", "Target.getTargets", "Target.setAutoAttach", "Target.attachToTarget", "Target.detachFromTarget",
  "Target.sendMessageToTarget", "Target.attachToBrowserTarget", "Target.getBrowserContexts", "Target.activateTarget",
  "Target.closeTarget", "Browser.getVersion", "Runtime.evaluate", "Page.enable", "Nope.nothing",
];
const IDS = ["sim:x:PID:1:1", "sim:x:PID:1:2", "sim:x:PID:2:7", "__proto__", ""];

type Handle = { targetId: string; closed: number; afterClose: number; onServerClose: (r: string) => void };

function failures(): number {
  let n = 0;
  for (const [k, c] of softFindings) if (k.includes("browser endpoint: message failed")) n += c;
  return n;
}

async function run(data: Uint8Array): Promise<void> {
  const failedBefore = failures();
  const out: any[] = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (s: string) => out.push(JSON.parse(s)),
    terminate() {},
  });
  let entries: BrowserEntry[] = [{ targetId: IDS[0]!, type: "page", title: "a", url: "https://a/" }];
  const handles: Handle[] = [];
  attachBrowserWs(ws as never, {
    refreshMs: 1,
    listEntries: () => entries,
    createPageSession: (targetId, send, onServerClose) => {
      if (!entries.some((e) => e.targetId === targetId)) return null;
      const h: Handle = { targetId, closed: 0, afterClose: 0, onServerClose };
      handles.push(h);
      return {
        onMessageFromTools(text: string) {
          if (h.closed) h.afterClose++;
          let m: any;
          try {
            m = JSON.parse(text);
          } catch {
            return;
          }
          if (typeof m?.id === "number") queueMicrotask(() => !h.closed && send(JSON.stringify({ id: m.id, result: { echo: m.method ?? null } })));
        },
        close() {
          h.closed++;
        },
      };
    },
  });

  const expected = new Map<string, number>(); // `${sessionId ?? ""}|${id}` → count of requests
  let nextId = 1_000_000;
  const sessionIds = () => [
    ...new Set(out.flatMap((m) => [m.result?.sessionId, m.params?.sessionId]).filter((s) => typeof s === "string")),
  ];
  const send = (frame: any, track: boolean) => {
    if (track && frame && typeof frame === "object") {
      const key = `${frame.sessionId ?? ""}|${frame.id}`;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    ws.emit("message", Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame)), false);
  };

  for (const line of Buffer.from(data).toString("utf8").split("\n").slice(0, 100)) {
    if (line.startsWith("T")) {
      send(line.slice(1), false);
      continue;
    }
    const b = new Bytes(Buffer.from(line, "latin1"));
    while (!b.done) {
      const op = b.u8() % 10;
      if (op <= 5) {
        const method = b.pick(METHODS);
        const params: Record<string, unknown> = {};
        if (b.bool()) params.targetId = b.pick(IDS);
        if (b.bool()) params.sessionId = b.pick([...sessionIds(), "nope"]);
        if (b.bool()) params.autoAttach = b.bool();
        if (b.bool()) params.discover = b.bool();
        if (b.u8() % 3 === 0) params.message = JSON.stringify({ id: b.int(1, 5), method: "Runtime.evaluate" });
        if (b.u8() % 6 === 0) Object.assign(params, b.json(1) as object);
        const frame: Record<string, unknown> = { id: nextId++, method, params: b.u8() % 8 === 0 ? b.json(1) : params };
        const sids = sessionIds();
        if (sids.length && b.u8() % 3 === 0) frame.sessionId = b.pick(sids);
        send(frame, true);
      } else if (op === 6) {
        send(b.pick(["null", "[]", "{", '{"id":"x"}', '{"sessionId":5,"id":1}', '{"method":"Target.getTargets"}', '{"id":-3,"method":7}']), false);
      } else if (op === 7) {
        // The target list changes (navigation, page gone, new page).
        const n = b.int(0, 3);
        entries = [];
        for (let i = 0; i < n; i++) {
          entries.push({ targetId: b.pick(IDS), type: b.pick(["page", "worker", "", "other"]), title: b.str(), url: b.str() });
        }
      } else if (op === 8) {
        const live = handles.filter((h) => !h.closed);
        if (live.length) b.pick(live).onServerClose("page gone");
      } else {
        await new Promise((r) => setTimeout(r, 1)); // a discovery pump
      }
      await settle(1);
    }
  }
  await settle(3);
  ws.readyState = 3;
  ws.emit("close");

  check(failures() === failedBefore, "browser endpoint message handler threw");
  const got = new Map<string, number>();
  for (const m of out) {
    if (typeof m.id !== "number") continue;
    const key = `${m.sessionId ?? ""}|${m.id}`;
    got.set(key, (got.get(key) ?? 0) + 1);
  }
  for (const [key, n] of expected) {
    // A request routed to a page session that went away mid-flight may go
    // unanswered; everything else is answered exactly once.
    const routed = key.split("|")[0] !== "";
    const g = got.get(key) ?? 0;
    check(routed ? g <= n : g === n, `request ${key} got ${g} replies`);
  }
  for (const h of handles) {
    check(h.closed === 1, `page session for ${h.targetId} closed ${h.closed} times`);
    check(h.afterClose === 0, `page session for ${h.targetId} got traffic after close`);
  }
  checkGlobal();
}

export const fuzz = harness(run);
