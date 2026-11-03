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
//   - tool requests use msg.id from the DevTools client (>= 0; negative
//     client ids are rejected)
//   - everything the bridge originates — callTarget(), state replays and
//     the outer Target.sendMessageToTarget envelopes — takes ids from one
//     shared negative counter, so an envelope ack can never be confused
//     with a client reply or another bridge request.
//
// Target-based mode (modern Safari, iOS 13+): the page exposes inner
// targets. Every non-Target.* command is wrapped in
// Target.sendMessageToTarget{targetId: <active>, message}; Safari answers
// twice — an outer ack/error for the envelope (top-level, envelope id) and
// the real reply inside Target.dispatchMessageFromTarget (inner id) — in
// either order. Inner targets come and go (targetCreated / targetDestroyed
// / didCommitProvisionalTarget on cross-origin navigation, WebContent
// crashes); see the "inner target state machine" section below.
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

/**
 * Where a session's wire frames go. By default a Target owns its WIR sender
 * and writes straight to it; a PageChannel substitutes a link so several
 * sessions can share one sender (ids are rewritten there).
 */
export interface TargetLink {
  /** A top-level frame (raw mode, or a Target.* command). */
  send(m: CdpMessage): void;
  /** `inner` wrapped in Target.sendMessageToTarget{targetId} with envelope id `outerId`. */
  sendWrapped(outerId: number, targetId: string, inner: CdpMessage): void;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Default deadline for adapter-initiated callTarget() round-trips. */
export const CALL_TARGET_TIMEOUT_MS = 10_000;
/** How long requests wait for an inner target during a swap before failing. */
export const SWAP_TIMEOUT_MS = 10_000;
/** No Target.targetCreated within this window ⇒ not target-based; send raw. */
const MODE_DETECT_MS = 250;
/** A session with only non-page targets (service worker) adopts one after this. */
const WORKER_GRACE_MS = 250;
/** Cap on requests held while no inner target is available. */
const MAX_QUEUED = 1000;

/** Stateful setters replayed onto a new inner target, besides `*.enable`. */
const REPLAYED_SETTERS = new Set([
  "Debugger.setPauseOnExceptions",
  "Debugger.setBreakpointsActive",
  "Debugger.setAsyncStackTraceDepth",
  "Debugger.setPauseOnDebuggerStatements",
  "Debugger.setPauseOnMicrotasks",
  "Debugger.setPauseForInternalScripts",
  "Network.setExtraHTTPHeaders",
  "Network.setResourceCachingDisabled",
]);

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

type CdpError = { code?: number; message: string };

/** Normalize a CDP error object / thrown value into an Error that keeps `code`. */
function toError(e: unknown): Error & { code?: number } {
  if (e instanceof Error) return e;
  const err = new Error(errMessage(e)) as Error & { code?: number };
  const code = (e as CdpError)?.code;
  if (typeof code === "number") err.code = code;
  return err;
}

type InnerTarget = { type: string; provisional: boolean };
/** An outer Target.sendMessageToTarget envelope awaiting its ack. */
type Envelope = { innerId: number | undefined; targetId: string };
/** A wrapped request awaiting its inner reply. */
type InFlight = { outerId: number; targetId: string };

export class Target {
  private filters = new Map<string, Filter[]>();
  private toolRequestMap = new Map<number, string>();
  private adapterRequestMap = new Map<number, Pending>();
  private lastOwnId = 0;
  private closedReason: string | null = null;

  // --- inner target state machine -------------------------------------
  // mode: "unknown" until the first Target.targetCreated ("target") or
  // MODE_DETECT_MS without one ("raw": old iOS, Bun — send unwrapped).
  private mode: "unknown" | "raw" | "target" = "unknown";
  private targets = new Map<string, InnerTarget>();
  /** Where wrapped commands go; null while waiting for a (new) target. */
  private active: string | null = null;
  /** Outer envelope id → what it carried; cleared by the outer ack/error. */
  private envelopes = new Map<number, Envelope>();
  /** Wrapped request id → its envelope; cleared by the inner reply. */
  private inFlight = new Map<number, InFlight>();
  /** Commands held while no inner target is available (mode unknown / swap). */
  private queue: Array<{ msg: CdpMessage; at: number }> = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private modeTimer: ReturnType<typeof setTimeout> | null = null;
  private workerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Domain enables / setters / URL breakpoints to replay on a new target. */
  private stateLog = new Map<string, CdpMessage>();
  /** Targets that already have the current state (sent live or replayed). */
  private stateSyncedTo = new Set<string>();
  private pendingBreakpoints = new Map<number, string>(); // request id → stateLog key
  private breakpointKeys = new Map<string, string>(); // breakpointId → stateLog key
  /** Client ids we already answered with an error on Safari's behalf; a
   *  late real reply for one of them is dropped, not delivered twice. */
  private failedToolIds = new Set<number>();

  /** Deadline for callTarget(); override per instance (tests, slow devices). */
  callTimeoutMs = CALL_TARGET_TIMEOUT_MS;
  /** Deadline for requests queued while the inner target is swapping. */
  swapTimeoutMs = SWAP_TIMEOUT_MS;
  /** Grace before a worker-only session adopts its worker target. */
  workerGraceMs = WORKER_GRACE_MS;

  constructor(
    private ws: WSWebSocket,
    public readonly wi: WebInspectorClient,
    public readonly appId: string,
    public readonly pageId: number,
    public readonly senderKey: string,
    private link: TargetLink | null = null,
  ) {}

  /** Route wire frames through `link` (a PageChannel) instead of `wi`. */
  setLink(link: TargetLink): void {
    this.link = link;
  }

  addMessageFilter(method: string, filter: Filter) {
    let list = this.filters.get(method);
    if (!list) this.filters.set(method, (list = []));
    list.push(filter);
  }

  private ownId(): number {
    return --this.lastOwnId;
  }

  /** Adapter-initiated call into Safari, awaitable. Uses a negative id.
   *  Rejects after `callTimeoutMs`, when the inner target dies, or when the
   *  session closes. */
  callTarget(method: string, params: any = {}, timeoutMs = this.callTimeoutMs): Promise<any> {
    if (this.closedReason !== null) {
      return Promise.reject(new Error(`${method}: ${this.closedReason}`));
    }
    return new Promise((resolve, reject) => {
      const id = this.ownId();
      const timer = setTimeout(() => {
        if (this.adapterRequestMap.delete(id)) {
          this.inFlight.delete(id);
          // Still held (no target yet)? Then it must never be sent.
          this.queue = this.queue.filter((q) => q.msg.id !== id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.adapterRequestMap.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
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
    for (const t of [this.queueTimer, this.modeTimer, this.workerTimer]) if (t) clearTimeout(t);
    this.queueTimer = this.modeTimer = this.workerTimer = null;
    this.queue = [];
    this.toolRequestMap.clear();
    this.envelopes.clear();
    this.inFlight.clear();
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  /** @internal Bookkeeping sizes, for leak tests. */
  debugState() {
    return {
      mode: this.mode,
      active: this.active,
      targets: [...this.targets.keys()],
      toolRequests: this.toolRequestMap.size,
      adapterRequests: this.adapterRequestMap.size,
      wrapped: this.envelopes.size + this.inFlight.size,
      queued: this.queue.length,
    };
  }

  fireEventToTools(method: string, params: any) {
    this.sendToTools(JSON.stringify({ method, params }));
  }

  fireResultToTools(id: number, result: any) {
    this.toolRequestMap.delete(id);
    this.sendToTools(JSON.stringify({ id, result }));
  }

  fireErrorToTools(id: number, error: { code?: number; message: string }) {
    this.toolRequestMap.delete(id);
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
    if (id !== undefined && id < 0) {
      this.fireErrorToTools(id, {
        code: -32600,
        message: "request ids must be non-negative (negative ids are reserved by the bridge)",
      });
      return;
    }
    try {
      if (typeof msg.method === "string" && id !== undefined) {
        this.toolRequestMap.set(id, msg.method);
        this.failedToolIds.delete(id);
      }
      const list = typeof msg.method === "string" ? this.filters.get(`tools::${msg.method}`) : undefined;
      let outgoing: CdpMessage | null = msg;
      if (list) {
        for (const f of list) {
          if (!outgoing) break;
          outgoing = await f(outgoing);
        }
      }
      if (outgoing) this.send(outgoing);
    } catch (e) {
      console.error(`# cdp: tools filter for ${String(msg.method)} threw: ${errMessage(e)}`);
      if (id !== undefined) {
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
    return this.deliverFromTarget(msg, rawMessage, false);
  }

  /** A frame already parsed by a PageChannel. `fromInner` marks the
   *  unwrapped payload of a Target.dispatchMessageFromTarget. */
  onParsedFromTarget(msg: CdpMessage, rawMessage: string, fromInner: boolean): Promise<void> {
    if (this.closedReason !== null) return Promise.resolve();
    return this.deliverFromTarget(msg, rawMessage, fromInner);
  }

  private async deliverFromTarget(
    msg: CdpMessage,
    rawMessage: string,
    fromInner: boolean,
  ): Promise<void> {
    try {
      await this.handleFromTarget(msg, rawMessage, fromInner);
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

  private async handleFromTarget(
    msg: CdpMessage,
    rawMessage: string,
    fromInner: boolean,
  ): Promise<void> {
    // Inner target lifecycle. Swallowed: DevTools doesn't expect Safari's
    // Target.* events on the top-level connection.
    switch (msg.method) {
      case "Target.targetCreated":
        return this.onTargetCreated(msg.params?.targetInfo);
      case "Target.targetDestroyed":
        return this.onTargetDestroyed(msg.params?.targetId);
      case "Target.didCommitProvisionalTarget":
        return this.onCommitProvisionalTarget(msg.params?.oldTargetId, msg.params?.newTargetId);
      case "Target.dispatchMessageFromTarget": {
        const raw = msg.params?.message;
        if (typeof raw !== "string") return;
        const inner = parseFrame(raw);
        if (!inner) return debug(`ignoring non-object inner frame: ${raw.slice(0, 80)}`);
        return this.deliverFromTarget(inner, raw, true);
      }
    }

    if (typeof msg.id === "number") {
      if (!fromInner) {
        // Outer reply to one of our envelopes: an ack (drop it — the real
        // reply comes wrapped) or an error (the inner command never ran).
        const env = this.envelopes.get(msg.id);
        if (env) {
          this.envelopes.delete(msg.id);
          if (msg.error && env.innerId !== undefined) {
            // Only if the inner reply hasn't already answered it.
            if (this.inFlight.get(env.innerId)?.outerId === msg.id) {
              this.failRequest(env.innerId, msg.error);
            }
          }
          return;
        }
      } else {
        this.inFlight.delete(msg.id);
      }
      this.noteBreakpointReply(msg);

      const adapterPending = this.adapterRequestMap.get(msg.id);
      if (adapterPending) {
        this.adapterRequestMap.delete(msg.id);
        clearTimeout(adapterPending.timer);
        if ("error" in msg && msg.error) adapterPending.reject(toError(msg.error));
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
      if (msg.id < 0) {
        // Late ack / reply for a bridge request that already settled (or
        // timed out). Never leak it to the client.
        debug(`dropping reply for settled bridge id ${msg.id}`);
        return;
      }
      if (this.failedToolIds.delete(msg.id)) {
        debug(`dropping late reply for already-failed request ${msg.id}`);
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

  // --- inner target state machine -------------------------------------

  private onTargetCreated(info: any): void {
    if (!info || typeof info.targetId !== "string") return;
    this.enterTargetMode();
    const type = typeof info.type === "string" ? info.type : "page";
    const provisional = info.isProvisional === true;
    this.targets.set(info.targetId, { type, provisional });
    if (type === "page") {
      // A provisional page (cross-origin navigation in flight) gets the
      // session state right away, like WebKit's own frontend does, so it
      // doesn't miss early events; traffic switches over on commit.
      if (provisional) this.syncState(info.targetId);
      else if (!this.activeIsPage()) this.activate(info.targetId);
      return;
    }
    // Workers never displace a page; a worker-only session (service
    // worker inspection) adopts one after a short grace.
    if (!this.active) this.scheduleWorkerAdoption();
  }

  private onTargetDestroyed(targetId: unknown): void {
    if (typeof targetId !== "string") return;
    this.targets.delete(targetId);
    this.stateSyncedTo.delete(targetId);
    // Anything still in flight on that target will never be answered.
    for (const [outerId, env] of [...this.envelopes]) {
      if (env.targetId === targetId) this.envelopes.delete(outerId);
    }
    for (const [innerId, f] of [...this.inFlight]) {
      if (f.targetId !== targetId) continue;
      this.failRequest(innerId, {
        code: -32000,
        message: `inspected target ${targetId} went away (navigation, crash or close)`,
      });
    }
    if (this.active !== targetId) return;
    this.active = null;
    // Another committed page already around (e.g. commit raced ahead)?
    for (const [id, t] of this.targets) {
      if (t.type === "page" && !t.provisional) return this.activate(id);
    }
    // Otherwise hold traffic (with a deadline) until a new target shows up.
    this.armQueueTimer();
  }

  private onCommitProvisionalTarget(oldTargetId: unknown, newTargetId: unknown): void {
    if (typeof newTargetId !== "string") return;
    this.enterTargetMode();
    const t = this.targets.get(newTargetId);
    if (t) t.provisional = false;
    else this.targets.set(newTargetId, { type: "page", provisional: false });
    if (this.active !== newTargetId) this.activate(newTargetId);
    void oldTargetId; // the old target is torn down by its own targetDestroyed
  }

  private enterTargetMode(): void {
    if (this.mode === "target") return;
    this.mode = "target";
    if (this.modeTimer) clearTimeout(this.modeTimer);
    this.modeTimer = null;
  }

  private activeIsPage(): boolean {
    return this.active !== null && this.targets.get(this.active)?.type === "page";
  }

  private activate(targetId: string): void {
    this.active = targetId;
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = null;
    // State first, then whatever queued up while there was no target.
    this.syncState(targetId);
    this.flushQueue();
  }

  private scheduleWorkerAdoption(): void {
    if (this.workerTimer || this.closedReason !== null) return;
    this.workerTimer = setTimeout(() => {
      this.workerTimer = null;
      if (this.active || this.closedReason !== null) return;
      for (const [id, t] of this.targets) {
        if (!t.provisional) return this.activate(id);
      }
    }, this.workerGraceMs);
  }

  /** Replay the session's state log onto `targetId` (once per target). */
  private syncState(targetId: string): void {
    if (this.stateSyncedTo.has(targetId)) return;
    this.stateSyncedTo.add(targetId);
    for (const m of this.stateLog.values()) this.replayTo(targetId, m);
  }

  /** Fire-and-forget bridge command to a specific inner target. */
  private replayTo(targetId: string, m: CdpMessage): void {
    const id = this.ownId();
    const timer = setTimeout(() => this.adapterRequestMap.delete(id), this.callTimeoutMs);
    const noop = () => {};
    this.adapterRequestMap.set(id, { resolve: noop, reject: noop, timer });
    this.wrapAndSend({ id, method: m.method, params: m.params }, targetId, false);
  }

  /** Track commands whose effect must survive a target swap. */
  private recordState(m: CdpMessage, sentTo: string): void {
    const method = m.method;
    if (typeof method !== "string") return;
    const dot = method.lastIndexOf(".");
    const domain = method.slice(0, dot);
    const verb = method.slice(dot + 1);
    const entry: CdpMessage = { method, params: m.params };
    let key: string | undefined;
    if (verb === "enable") key = `enable:${domain}`;
    else if (verb === "disable") this.stateLog.delete(`enable:${domain}`);
    else if (REPLAYED_SETTERS.has(method)) key = `set:${method}`;
    else if (method === "Debugger.setBreakpointByUrl") {
      const p = m.params ?? {};
      key = `bp:${JSON.stringify([p.url, p.urlRegex, p.lineNumber, p.columnNumber, p.condition])}`;
      if (typeof m.id === "number") this.pendingBreakpoints.set(m.id, key);
    } else if (method === "Debugger.removeBreakpoint") {
      const bpKey = this.breakpointKeys.get(m.params?.breakpointId);
      if (bpKey === undefined) return;
      this.breakpointKeys.delete(m.params.breakpointId);
      this.stateLog.delete(bpKey);
    } else return;
    if (key !== undefined) {
      this.stateLog.delete(key); // re-insert at the end: keep replay order
      this.stateLog.set(key, entry);
    }
    // Provisional targets that already got a snapshot need the change too.
    for (const [id, t] of this.targets) {
      if (id !== sentTo && t.provisional && this.stateSyncedTo.has(id)) this.replayTo(id, entry);
    }
  }

  private noteBreakpointReply(msg: CdpMessage): void {
    const key = this.pendingBreakpoints.get(msg.id!);
    if (key === undefined) return;
    this.pendingBreakpoints.delete(msg.id!);
    const bid = msg.result?.breakpointId;
    if (typeof bid === "string") this.breakpointKeys.set(bid, key);
    else if (msg.error) this.forgetBreakpoint(key);
  }

  /** Drop a URL breakpoint from the replay log unless a live breakpoint
   *  (one Safari acknowledged with an id) still backs it — e.g. a duplicate
   *  set that failed with "already exists". */
  private forgetBreakpoint(key: string): void {
    for (const k of this.breakpointKeys.values()) if (k === key) return;
    this.stateLog.delete(key);
  }

  /** The inner request `innerId` will never be answered: tell its owner. */
  private failRequest(innerId: number | undefined, error: CdpError): void {
    if (innerId === undefined) return;
    this.inFlight.delete(innerId);
    const bpKey = this.pendingBreakpoints.get(innerId);
    if (bpKey !== undefined) {
      this.pendingBreakpoints.delete(innerId);
      this.forgetBreakpoint(bpKey);
    }
    const pending = this.adapterRequestMap.get(innerId);
    if (pending) {
      this.adapterRequestMap.delete(innerId);
      clearTimeout(pending.timer);
      pending.reject(toError(error));
      return;
    }
    if (this.toolRequestMap.has(innerId)) {
      if (this.failedToolIds.size >= MAX_QUEUED) this.failedToolIds.clear();
      this.failedToolIds.add(innerId);
      this.fireErrorToTools(innerId, {
        code: typeof error?.code === "number" ? error.code : -32000,
        message: errMessage(error),
      });
    }
  }

  // --- sending ----------------------------------------------------------

  private send(m: CdpMessage): void {
    if (this.closedReason !== null) return;
    const isTargetDomain = typeof m.method === "string" && m.method.startsWith("Target.");
    if (isTargetDomain || this.mode === "raw") {
      if (this.link) return this.link.send(m);
      return this.writeFrame(JSON.stringify(m));
    }
    if (this.active) return this.wrapAndSend(m, this.active, true);
    this.enqueue(m);
  }

  private wrapAndSend(m: CdpMessage, targetId: string, record: boolean): void {
    const outerId = this.ownId();
    const innerId = typeof m.id === "number" ? m.id : undefined;
    this.envelopes.set(outerId, { innerId, targetId });
    if (innerId !== undefined) this.inFlight.set(innerId, { outerId, targetId });
    if (record) this.recordState(m, targetId);
    if (this.link) {
      if (this.closedReason === null) this.link.sendWrapped(outerId, targetId, m);
      return;
    }
    this.writeFrame(
      JSON.stringify({
        id: outerId,
        method: "Target.sendMessageToTarget",
        params: { targetId, message: JSON.stringify(m) },
      }),
    );
  }

  private enqueue(m: CdpMessage): void {
    if (this.queue.length >= MAX_QUEUED) {
      this.failRequest(typeof m.id === "number" ? m.id : undefined, {
        code: -32000,
        message: "too many requests queued while waiting for the inspected page",
      });
      return;
    }
    this.queue.push({ msg: m, at: Date.now() });
    if (this.mode === "unknown" && !this.modeTimer) {
      // No Target.targetCreated yet. If none arrives soon, the inspector
      // isn't target-based (old iOS, Bun): send everything raw.
      this.modeTimer = setTimeout(() => {
        this.modeTimer = null;
        if (this.mode !== "unknown") return;
        this.mode = "raw";
        this.flushQueue();
      }, MODE_DETECT_MS);
    }
    this.armQueueTimer();
  }

  private armQueueTimer(): void {
    if (this.queueTimer || this.queue.length === 0 || this.closedReason !== null) return;
    const wait = Math.max(0, this.queue[0]!.at + this.swapTimeoutMs - Date.now());
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      const cutoff = Date.now() - this.swapTimeoutMs;
      const expired: CdpMessage[] = [];
      while (this.queue.length && this.queue[0]!.at <= cutoff) expired.push(this.queue.shift()!.msg);
      for (const m of expired) {
        this.failRequest(typeof m.id === "number" ? m.id : undefined, {
          code: -32000,
          message: `no inspectable target available after ${this.swapTimeoutMs}ms (page navigating or gone)`,
        });
      }
      this.armQueueTimer();
    }, wait);
  }

  private flushQueue(): void {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    const queued = this.queue;
    this.queue = [];
    for (const { msg } of queued) this.send(msg);
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
