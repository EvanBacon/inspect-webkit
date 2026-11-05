// One CDP "session" — bridges a single DevTools WebSocket to one Safari page
// via _rpc_forwardSocketSetup / _rpc_forwardSocketData.
//
// Symmetric filter pipeline: a `tools::<method>` filter inspects/rewrites
// outgoing requests from DevTools, a `target::<method>` filter inspects/
// rewrites incoming responses or events from Safari. Per-domain code in
// src/cdp/domains/*.ts hangs translations off these.
//
// Flow:
//   DevTools  --(JSON)-->  onMessageFromTools  --filters-->  sendToTarget
//                                                              |
//                                                              v
//                                          _rpc_forwardSocketData (WIR)
//                                                              |
//   DevTools  <--(JSON)--  filters  <-- onMessageFromTarget <--+
//
// Ids:
//   - tool requests use msg.id from the DevTools client (positive)
//   - adapter-internal callTarget() uses negative ids to disambiguate
//
// Filters return the (possibly rewritten) message, or null to swallow it.

import type { WebSocket as WSWebSocket } from "ws";
import type { WebInspectorClient } from "../webinspector";

export type CdpMessage = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

type Filter = (msg: CdpMessage) => Promise<CdpMessage | null>;

type Pending = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Default deadline for adapter-initiated callTarget() round-trips. */
export const CALL_TARGET_TIMEOUT_MS = 10_000;

const debug = (...args: unknown[]) => {
  if (process.env.INSPECT_WEBKIT_DEBUG) console.error("[cdp]", ...args);
};

/** Parse a CDP frame; null unless it is a plain JSON object. */
function parseFrame(raw: string): CdpMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  return v as CdpMessage;
}

function errMessage(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

export class Target {
  private filters = new Map<string, Filter[]>();
  private toolRequestMap = new Map<number, string>();
  private adapterRequestMap = new Map<number, Pending>();
  private requestId = 0;
  // Target-based mode (modern Safari, iOS 13+): each page exposes inner
  // CDP targets. We auto-detect on the first Target.targetCreated of type
  // "page" and from then on wrap outgoing non-Target.* messages in
  // Target.sendMessageToTarget, and unwrap incoming
  // Target.dispatchMessageFromTarget.
  private innerTargetId: string | null = null;
  private wrappedAckIds = new Set<number>();
  // Outgoing messages sent before we've discovered the inner target. They
  // can't be dispatched yet (Safari would respond with "domain not found"),
  // so we hold them until the first Target.targetCreated arrives.
  private outgoingQueue: string[] = [];
  private sawAnyTargetCreated = false;
  private closedReason: string | null = null;
  /** Deadline for callTarget(); override per instance (tests, slow devices). */
  callTimeoutMs = CALL_TARGET_TIMEOUT_MS;

  constructor(
    private ws: WSWebSocket,
    public readonly wi: WebInspectorClient,
    public readonly appId: string,
    public readonly pageId: number,
    public readonly senderKey: string,
  ) {}

  addMessageFilter(method: string, filter: Filter) {
    let list = this.filters.get(method);
    if (!list) this.filters.set(method, (list = []));
    list.push(filter);
  }

  /** Adapter-initiated call into Safari, awaitable. Uses a negative id.
   *  Rejects after `callTimeoutMs`, or when the session closes. */
  callTarget(method: string, params: any = {}, timeoutMs = this.callTimeoutMs): Promise<any> {
    if (this.closedReason !== null) {
      return Promise.reject(new Error(`${method}: ${this.closedReason}`));
    }
    return new Promise((resolve, reject) => {
      const id = --this.requestId;
      const timer = setTimeout(() => {
        if (this.adapterRequestMap.delete(id)) {
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.adapterRequestMap.set(id, { resolve, reject, timer });
      this.sendRaw(JSON.stringify({ id, method, params }));
    });
  }

  /** Session teardown: reject every pending callTarget and stop sending. */
  close(reason = "session closed") {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    const pending = [...this.adapterRequestMap.values()];
    this.adapterRequestMap.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.outgoingQueue = [];
    this.toolRequestMap.clear();
    this.wrappedAckIds.clear();
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  fireEventToTools(method: string, params: any) {
    this.sendToTools(JSON.stringify({ method, params }));
  }

  fireResultToTools(id: number, result: any) {
    this.sendToTools(JSON.stringify({ id, result }));
  }

  fireErrorToTools(id: number, error: { code?: number; message: string }) {
    this.sendToTools(
      JSON.stringify({ id, error: { code: error.code ?? -32000, message: error.message } }),
    );
  }

  replyEmpty(msg: CdpMessage): Promise<null> {
    if (typeof msg.id === "number") this.fireResultToTools(msg.id, {});
    return Promise.resolve(null);
  }

  /** Called by the server when the DevTools client sends a frame.
   *  Never rejects: a filter that throws turns into a CDP error reply. */
  async onMessageFromTools(rawMessage: string): Promise<void> {
    if (this.closedReason !== null) return;
    const msg = parseFrame(rawMessage);
    if (!msg) {
      debug(`ignoring non-object tools frame: ${String(rawMessage).slice(0, 80)}`);
      return;
    }
    const id = typeof msg.id === "number" ? msg.id : undefined;
    try {
      if (typeof msg.method === "string" && id !== undefined) {
        this.toolRequestMap.set(id, msg.method);
      }
      const list = typeof msg.method === "string" ? this.filters.get(`tools::${msg.method}`) : undefined;
      let outgoing: CdpMessage | null = msg;
      if (list) {
        for (const f of list) {
          if (!outgoing) break;
          outgoing = await f(outgoing);
        }
      }
      if (outgoing) this.sendRaw(JSON.stringify(outgoing));
    } catch (e) {
      console.error(`# cdp: tools filter for ${String(msg.method)} threw: ${errMessage(e)}`);
      if (id !== undefined) {
        this.toolRequestMap.delete(id);
        this.fireErrorToTools(id, {
          code: e instanceof TypeError ? -32602 : -32000,
          message: `${String(msg.method)}: ${errMessage(e)}`,
        });
      }
    }
  }

  /** Called by the WebInspector pump when a forward-socket frame arrives
   *  for THIS sender. */
  async onMessageFromTarget(rawMessage: string): Promise<void> {
    if (this.closedReason !== null) return;
    const msg = parseFrame(rawMessage);
    if (!msg) {
      debug(`ignoring non-object target frame: ${String(rawMessage).slice(0, 80)}`);
      return;
    }
    try {
      await this.handleFromTarget(msg, rawMessage);
    } catch (e) {
      // A target-side filter choked on an unexpected Safari payload. Pass
      // the untranslated message through: an un-translated reply beats a
      // request that never gets answered.
      console.error(
        `# cdp: target filter for ${String(msg.method ?? `id ${msg.id}`)} threw: ${errMessage(e)}`,
      );
      this.sendToTools(rawMessage);
    }
  }

  private async handleFromTarget(msg: CdpMessage, rawMessage: string): Promise<void> {

    // Target-based mode: pick up the inner page targetId once, then
    // unwrap dispatched messages.
    if (msg.method === "Target.targetCreated") {
      this.sawAnyTargetCreated = true;
      const info = msg.params?.targetInfo;
      if (info?.type === "page" && !this.innerTargetId) {
        this.innerTargetId = info.targetId;
        this.flushQueue();
      }
      // Swallow Target.* events — DevTools doesn't expect them on the
      // top-level connection here.
      return;
    }
    if (msg.method === "Target.didCommitProvisionalTarget") {
      // Cross-origin navigation: WebKit swapped the active target. Re-pin
      // innerTargetId so subsequent wraps land on the live target instead
      // of the dead one.
      const newTargetId = msg.params?.newTargetId;
      if (typeof newTargetId === "string") this.innerTargetId = newTargetId;
      return;
    }
    if (msg.method === "Target.targetDestroyed") return;
    if (msg.method === "Target.dispatchMessageFromTarget") {
      const inner = msg.params?.message;
      if (typeof inner === "string") return this.onMessageFromTarget(inner);
      return;
    }

    if (typeof msg.id === "number" && this.wrappedAckIds.has(msg.id)) {
      // Drop the ack of a wrapped Target.sendMessageToTarget — the real
      // response arrives separately via Target.dispatchMessageFromTarget.
      // The outer ack carries `{result: {}}` regardless of the inner
      // command's actual result, so we MUST wait for the unwrap.
      this.wrappedAckIds.delete(msg.id);
      return;
    }

    if (typeof msg.id === "number") {
      const adapterPending = this.adapterRequestMap.get(msg.id);
      if (adapterPending) {
        this.adapterRequestMap.delete(msg.id);
        clearTimeout(adapterPending.timer);
        if ("error" in msg && msg.error) adapterPending.reject(msg.error);
        else adapterPending.resolve(msg.result ?? {});
        return;
      }

      const method = this.toolRequestMap.get(msg.id);
      if (method) {
        this.toolRequestMap.delete(msg.id);
        let eventName = `target::${method}`;
        if ("error" in msg && this.filters.has("target::error")) eventName = "target::error";
        const list = this.filters.get(eventName);
        if (!list) return this.sendToTools(rawMessage);
        let m: CdpMessage | null = msg;
        for (const f of list) {
          if (!m) break;
          m = await f(m);
        }
        if (m) this.sendToTools(JSON.stringify(m));
        return;
      }
      // Unknown id; pass through.
      return this.sendToTools(rawMessage);
    }

    // Event from the target.
    const eventName = `target::${msg.method}`;
    const list = this.filters.get(eventName);
    if (!list) return this.sendToTools(rawMessage);
    let m: CdpMessage | null = msg;
    for (const f of list) {
      if (!m) break;
      m = await f(m);
    }
    if (m) this.sendToTools(JSON.stringify(m));
  }

  private sendRaw(rawMessage: string) {
    // Parse to inspect; if not JSON, pass straight through.
    let m: CdpMessage | null = null;
    try {
      m = JSON.parse(rawMessage);
    } catch {}

    const isTargetDomain =
      m && typeof m.method === "string" && m.method.startsWith("Target.");

    // If target-based mode is in effect, wrap.
    if (this.innerTargetId && m && !isTargetDomain) {
      if (typeof m.id === "number") this.wrappedAckIds.add(m.id);
      const wrapped = {
        id: m.id,
        method: "Target.sendMessageToTarget",
        params: { id: m.id, message: rawMessage, targetId: this.innerTargetId },
      };
      this.writeFrame(JSON.stringify(wrapped));
      return;
    }

    // If we haven't yet learned the inner targetId but the inspector is
    // operating in target-based mode (we'll know once any targetCreated
    // arrives), buffer non-Target.* sends. Adapter calls (negative ids)
    // also buffer — they need the inner target too.
    if (!this.innerTargetId && m && !isTargetDomain) {
      this.outgoingQueue.push(rawMessage);
      // If we haven't seen ANY targetCreated within 250ms, assume the
      // inspector isn't running in target-based mode and flush straight
      // through. If targetCreated *did* arrive but we don't have a page
      // target yet, keep waiting — flushing raw would route adapter calls
      // (negative ids) to the outer target id:-1, where state changes like
      // Debugger.setBreakpointsActive get lost and breakpoint events never
      // fire on the inner page.
      if (this.outgoingQueue.length === 1) {
        setTimeout(() => {
          if (!this.innerTargetId && !this.sawAnyTargetCreated && this.outgoingQueue.length > 0) {
            const queued = this.outgoingQueue;
            this.outgoingQueue = [];
            for (const raw of queued) this.writeFrame(raw);
          }
        }, 250);
      }
      return;
    }

    this.writeFrame(rawMessage);
  }

  private flushQueue() {
    if (this.outgoingQueue.length === 0) return;
    const queued = this.outgoingQueue;
    this.outgoingQueue = [];
    for (const raw of queued) this.sendRaw(raw);
  }

  private writeFrame(payload: string) {
    if (this.closedReason !== null) return;
    this.wi.forwardSocketData(
      this.appId,
      this.pageId,
      this.senderKey,
      new TextEncoder().encode(payload),
    );
  }

  private sendToTools(rawMessage: string) {
    if (this.closedReason !== null) return;
    if (this.ws.readyState === 1) this.ws.send(rawMessage);
  }
}
