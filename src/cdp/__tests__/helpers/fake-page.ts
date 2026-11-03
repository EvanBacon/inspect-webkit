// A fake WIR page for PageChannel tests: records what the channel writes
// (socket setup / data / close) and lets the test push frames back as if
// Safari had sent them on the channel's sender.

import { Target } from "../../target";

export type WireFrame = {
  /** The top-level frame as written. */
  outer: any;
  /** For Target.sendMessageToTarget: the parsed inner message. */
  inner?: any;
  targetId?: string;
};

export function makeFakePage(appId = "PID:1", pageId = 1) {
  const handlers = new Set<(m: any) => void>();
  const frames: WireFrame[] = [];
  const setups: string[] = [];
  const didCloses: string[] = [];
  const wi = {
    closed: false,
    subscribe(h: (m: any) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    forwardSocketSetup(_a: string, _p: number, senderKey: string) {
      setups.push(senderKey);
    },
    forwardDidClose(_a: string, _p: number, senderKey: string) {
      didCloses.push(senderKey);
    },
    forwardSocketData(_a: string, _p: number, _s: string, bytes: Uint8Array) {
      const outer = JSON.parse(new TextDecoder().decode(bytes));
      const f: WireFrame = { outer };
      if (outer.method === "Target.sendMessageToTarget") {
        f.inner = JSON.parse(outer.params.message);
        f.targetId = outer.params.targetId;
      }
      frames.push(f);
    },
  };
  let senderKey = "";
  const page = {
    wi,
    frames,
    setups,
    didCloses,
    get subscribers() {
      return handlers.size;
    },
    /** Push a top-level CDP frame from Safari to the channel's sender. */
    push(m: unknown, opts: { senderKey?: string; raw?: string } = {}) {
      const text = opts.raw ?? JSON.stringify(m);
      for (const h of [...handlers]) {
        h({
          __selector: "_rpc_applicationSentData:",
          __argument: {
            WIRApplicationIdentifierKey: appId,
            WIRPageIdentifierKey: pageId,
            WIRDestinationKey: opts.senderKey ?? (senderKey || setups[setups.length - 1]),
            WIRMessageDataKey: new TextEncoder().encode(text),
          },
        });
      }
    },
    /** An inner frame from `targetId`, wrapped like Safari does. */
    pushInner(targetId: string, m: unknown, rawInner?: string) {
      page.push({
        method: "Target.dispatchMessageFromTarget",
        params: { targetId, message: rawInner ?? JSON.stringify(m) },
      });
    },
    created(targetId: string, type = "page", isProvisional = false) {
      page.push({ method: "Target.targetCreated", params: { targetInfo: { targetId, type, isProvisional } } });
    },
    destroyed(targetId: string) {
      page.push({ method: "Target.targetDestroyed", params: { targetId } });
    },
    /** Inner requests written so far (optionally only `method`). */
    innerRequests(method?: string) {
      return frames.filter((f) => f.inner && (!method || f.inner.method === method));
    },
    /** Answer one wrapped request: outer ack + inner reply. */
    answer(f: WireFrame, result: unknown = {}) {
      page.push({ id: f.outer.id, result: {} });
      if (typeof f.inner?.id === "number") page.pushInner(f.targetId!, { result, id: f.inner.id });
    },
    /** Answer every not-yet-answered wrapped request with `result(f)`. */
    answerAll(result: (f: WireFrame) => unknown = () => ({})) {
      for (const f of frames.splice(0)) {
        if (f.inner) page.answer(f, result(f));
        else if (typeof f.outer.id === "number") page.push({ result: result(f), id: f.outer.id });
      }
    },
    setSenderKey(k: string) {
      senderKey = k;
    },
  };
  return page;
}

/** A client session (bare Target, no iOS filters) recording what reaches DevTools. */
export function makeClient(page: ReturnType<typeof makeFakePage>) {
  const got: any[] = [];
  const ws = { readyState: 1, send: (text: string) => got.push(JSON.parse(text)) };
  const t = new Target(ws as any, page.wi as any, "PID:1", 1, "unused");
  return {
    t,
    got,
    send: (m: unknown) => t.onMessageFromTools(JSON.stringify(m)),
    replies: (id: number) => got.filter((m) => m.id === id),
    events: (method: string) => got.filter((m) => m.method === method),
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
