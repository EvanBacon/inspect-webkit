// PageChannel: one WIR sender per inspected page, shared by any number of
// CDP clients (DevTools page WebSockets, browser-endpoint sessions, hover
// highlight sessions).
//
// WebKit allows one sender per page: a second _rpc_forwardSocketSetup takes
// the page away from the first (R7). So the channel owns the only sender
// and every client gets its own Target session, linked to the channel
// through a TargetLink instead of writing to the WIR socket itself.
//
//   client Target ──link──▶ PageChannel ──forwardSocketData──▶ Safari
//   client Target ◀─deliver─ PageChannel ◀─applicationSentData── Safari
//
// Ids. Every id a client puts on the wire — its DevTools request ids, its
// own negative bridge ids, the outer Target.sendMessageToTarget envelope
// ids — is replaced by a channel-wide wire id, and the reply is routed back
// to that client with its original id. Replies for clients that have left,
// and for the channel's own requests, are dropped.
//
// Events fan out to every client. Once at least one client has enabled a
// domain on a target, that domain's events only go to the clients that
// enabled it.
//
// Domain enable/disable is reference-counted per (inner target, domain):
//   - the first enable goes to Safari; later ones are answered here, after
//     replaying the domain's current inventory (execution contexts, parsed
//     scripts, a pending pause, console messages) so the new client sees
//     the same initial state WebKit's enable would have sent;
//   - a disable is forwarded only when no other client still holds the
//     domain; otherwise it's answered here (and a Debugger.disable drops
//     that client's own breakpoints);
//   - a client that leaves releases what only it held.
//
// A client joining a live channel is sent synthetic Target.targetCreated
// events for the inner targets that already exist (WebKit announces them
// only once, at socket setup).

import type { WebInspectorClient, WIMessage } from "../webinspector";
import type { CdpMessage, Target, TargetLink } from "./target";

const CLOSE_INTERNAL = 1011;
/** Cap on remembered inventory events per (target, domain). */
const MAX_INVENTORY = 10_000;

const debug = (...args: unknown[]) => {
  if (process.env.INSPECT_WEBKIT_DEBUG) console.error("[channel]", ...args);
};

type Client = {
  target: Target;
  onClose: (reason: string, code: number) => void;
  /** (target, domain) keys this client has enabled. */
  enabled: Set<string>;
  /** breakpointId → the target key it was set on. */
  breakpoints: Map<string, string>;
  gone: boolean;
};

type Route = {
  /** null: the channel's own request, or the client has left. */
  client: Client | null;
  origId: number;
  /** Inner target id, or "" for a top-level (raw / Target.*) frame. */
  targetKey: string;
  method?: string;
  /** Envelope routes: the wire id of the inner request they carry. */
  innerWireId?: number;
  /** A first enable: on an error reply the client never held the domain. */
  countedKey?: string;
};

/**
 * Events that describe a domain's current state, replayed to a client
 * whose enable is answered by the channel. `add` keys an item, `remove`
 * drops one, `clear` drops them all.
 */
type InventorySpec = {
  add: Record<string, (p: any) => unknown>;
  remove?: Record<string, (p: any) => unknown>;
  clear?: string[];
};
const PAUSED = "\0paused";
const INVENTORY: Record<string, InventorySpec> = {
  Runtime: {
    add: { "Runtime.executionContextCreated": (p) => p?.context?.id },
    remove: { "Runtime.executionContextDestroyed": (p) => p?.executionContextId },
    clear: ["Runtime.executionContextsCleared"],
  },
  // WebKit never sends executionContextDestroyed / executionContextsCleared:
  // a reload just announces new contexts. See noteInventory().
  Debugger: {
    add: {
      "Debugger.scriptParsed": (p) => p?.scriptId,
      "Debugger.scriptFailedToParse": () => undefined,
      "Debugger.paused": () => PAUSED,
    },
    remove: { "Debugger.resumed": () => PAUSED },
    clear: ["Debugger.globalObjectCleared"],
  },
  Console: {
    add: { "Console.messageAdded": () => undefined },
    clear: ["Console.messagesCleared"],
  },
};

const BREAKPOINT_SETTERS = new Set(["Debugger.setBreakpointByUrl", "Debugger.setBreakpoint"]);

function parseObject(raw: string): CdpMessage | null {
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Replace a reply's id in its raw JSON without re-serializing it. WebKit
 * writes replies as `{"result":…,"id":N}`; for that exact tail (the frame
 * is known to parse with id N) the swap is safe. Anything else → null and
 * the caller re-serializes.
 */
export function rewriteReplyId(raw: string, wireId: number, id: number): string | null {
  const tail = `,"id":${wireId}}`;
  if (!raw.endsWith(tail)) return null;
  return `${raw.slice(0, raw.length - tail.length)},"id":${id}}`;
}

function domainOf(method: string): string {
  const dot = method.indexOf(".");
  return dot < 0 ? method : method.slice(0, dot);
}

const keyOf = (targetKey: string, domain: string) => `${targetKey}\0${domain}`;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export type PageChannelOptions = {
  /** Called once when the channel is torn down (last client left, or close()). */
  onEmpty?: () => void;
};

export class PageChannel {
  readonly senderKey: string = crypto.randomUUID();
  private clients = new Set<Client>();
  private routes = new Map<number, Route>();
  private lastWireId = 0;
  /** (target, domain) → number of clients holding it enabled. */
  private holders = new Map<string, number>();
  /** (target, domain) → item key → raw event, in arrival order. */
  private inventory = new Map<string, Map<string, string>>();
  private inventorySeq = 0;
  /** Live inner targets (WebKit announces them once, at socket setup). */
  private targets = new Map<string, Record<string, unknown>>();
  private setUp = false;
  private unsubscribe: (() => void) | null = null;
  private isClosed = false;

  constructor(
    private readonly wi: WebInspectorClient,
    readonly appId: string,
    readonly pageId: number,
    private readonly opts: PageChannelOptions = {},
  ) {}

  get closed(): boolean {
    return this.isClosed;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Add a client session. The first one sets the WIR socket up; later ones
   * are told about the inner targets that already exist. Returns `detach`.
   * `onClose` fires if the channel is torn down under the client (page,
   * app or source gone).
   */
  attach(target: Target, onClose: (reason: string, code: number) => void): () => void {
    if (this.isClosed) throw new Error("page channel is closed");
    const client: Client = { target, onClose, enabled: new Set(), breakpoints: new Map(), gone: false };
    this.clients.add(client);
    const link: TargetLink = {
      send: (m) => this.fromClient(client, m, "", undefined),
      sendWrapped: (outerId, targetId, inner) => this.fromClient(client, inner, targetId, outerId),
    };
    target.setLink(link);
    if (!this.setUp) {
      this.setUp = true;
      this.unsubscribe = this.wi.subscribe((m) => this.onWir(m));
      this.wi.forwardSocketSetup(this.appId, this.pageId, this.senderKey);
    } else {
      for (const info of this.targets.values()) {
        const ev = { method: "Target.targetCreated", params: { targetInfo: { ...info } } };
        this.deliver(client, ev, JSON.stringify(ev), false);
      }
    }
    return () => this.detach(client);
  }

  /** Server-side teardown: every client is told why, then the sender is released. */
  close(reason: string, code = CLOSE_INTERNAL): void {
    if (this.isClosed) return;
    const clients = [...this.clients];
    this.clients.clear();
    for (const c of clients) c.gone = true;
    this.teardown();
    for (const c of clients) {
      try {
        c.target.close(reason);
      } catch {}
      try {
        c.onClose(reason, code);
      } catch (e) {
        console.error(`warn: session teardown failed: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  /** @internal Bookkeeping sizes, for leak tests. */
  debugState() {
    return {
      clients: this.clients.size,
      routes: this.routes.size,
      holders: Object.fromEntries(this.holders),
      targets: [...this.targets.keys()],
    };
  }

  // --- clients -----------------------------------------------------------

  private detach(client: Client): void {
    if (client.gone) return;
    client.gone = true;
    this.clients.delete(client);
    if (this.clients.size === 0) return this.teardown();
    for (const r of this.routes.values()) if (r.client === client) r.client = null;
    // Release whatever only this client held; drop its breakpoints from
    // domains others still use.
    for (const key of client.enabled) {
      const [targetKey, domain] = key.split("\0") as [string, string];
      if (this.release(key) === 0) {
        this.inventory.delete(key);
        this.sendOwn(targetKey, `${domain}.disable`, {});
      } else if (domain === "Debugger") {
        this.dropBreakpoints(client, targetKey);
      }
    }
    client.enabled.clear();
  }

  private teardown(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.routes.clear();
    this.holders.clear();
    this.inventory.clear();
    this.targets.clear();
    if (this.setUp) {
      try {
        this.wi.forwardDidClose(this.appId, this.pageId, this.senderKey);
      } catch {}
    }
    this.opts.onEmpty?.();
  }

  // --- outgoing ------------------------------------------------------------

  private fromClient(client: Client, m: CdpMessage, targetKey: string, outerId: number | undefined): void {
    if (this.isClosed || client.gone) return;
    const gate = typeof m.method === "string" ? this.gate(client, m, targetKey, outerId) : "forward";
    if (gate === "answered") return;
    if (m.method === "Debugger.removeBreakpoint") client.breakpoints.delete(m.params?.breakpointId);
    const innerWire = typeof m.id === "number" ? this.route(client, m.id, targetKey, m.method) : undefined;
    if (innerWire !== undefined && gate !== "forward") this.routes.get(innerWire)!.countedKey = gate.first;
    const inner = innerWire === undefined ? m : { ...m, id: innerWire };
    if (outerId === undefined) return this.write(inner);
    const outerWire = this.route(client, outerId, targetKey, undefined, innerWire);
    this.write({
      id: outerWire,
      method: "Target.sendMessageToTarget",
      params: { targetId: targetKey, message: JSON.stringify(inner) },
    });
  }

  /**
   * Reference-count X.enable / X.disable: "answered" when the request was
   * answered here, `{first}` for a first enable that goes to Safari (undone
   * if Safari rejects it), otherwise "forward".
   */
  private gate(
    client: Client,
    m: CdpMessage,
    targetKey: string,
    outerId: number | undefined,
  ): "answered" | "forward" | { first: string } {
    const method = m.method!;
    const domain = domainOf(method);
    if (domain === "Target") return "forward";
    const verb = method.slice(domain.length + 1);
    if (verb !== "enable" && verb !== "disable") return "forward";
    const key = keyOf(targetKey, domain);
    if (verb === "enable") {
      if (client.enabled.has(key)) return "forward"; // the client's own re-enable: Safari's answer
      client.enabled.add(key);
      const before = this.holders.get(key) ?? 0;
      this.holders.set(key, before + 1);
      if (before === 0) {
        this.inventory.delete(key); // WebKit re-reports it
        return { first: key };
      }
      this.answer(client, m, targetKey, outerId, [...(this.inventory.get(key)?.values() ?? [])]);
      return "answered";
    }
    const mine = client.enabled.delete(key);
    const others = mine ? this.release(key) : (this.holders.get(key) ?? 0);
    if (others > 0) {
      if (mine && domain === "Debugger") this.dropBreakpoints(client, targetKey);
      this.answer(client, m, targetKey, outerId, []);
      return "answered";
    }
    this.inventory.delete(key);
    if (domain === "Debugger") {
      for (const [id, t] of client.breakpoints) if (t === targetKey) client.breakpoints.delete(id);
    }
    return "forward";
  }

  /** One fewer holder of `key`; returns how many remain. */
  private release(key: string): number {
    const n = (this.holders.get(key) ?? 1) - 1;
    if (n > 0) this.holders.set(key, n);
    else this.holders.delete(key);
    return Math.max(0, n);
  }

  /** Reply to `m` from here: replayed inventory events first, then the
   *  outer ack (wrapped) and the reply — the order Safari would use. */
  private answer(client: Client, m: CdpMessage, targetKey: string, outerId: number | undefined, events: string[]): void {
    const inner = targetKey !== "";
    const frames: Array<[string, boolean]> = events.map((raw) => [raw, inner]);
    if (outerId !== undefined) frames.push([JSON.stringify({ result: {}, id: outerId }), false]);
    if (typeof m.id === "number") frames.push([JSON.stringify({ result: {}, id: m.id }), inner]);
    // Async, like a real reply: the client is still inside its send(). One
    // at a time, so a slow event filter can't let the reply overtake.
    queueMicrotask(async () => {
      for (const [raw, fromInner] of frames) {
        const msg = parseObject(raw);
        if (!msg || client.gone) continue;
        await client.target.onParsedFromTarget(msg, raw, fromInner).catch((e) =>
          console.error(`# cdp: target message failed: ${(e as Error)?.message ?? e}`),
        );
      }
    });
  }

  private dropBreakpoints(client: Client, targetKey: string): void {
    for (const [id, t] of client.breakpoints) {
      if (t !== targetKey) continue;
      client.breakpoints.delete(id);
      this.sendOwn(targetKey, "Debugger.removeBreakpoint", { breakpointId: id });
    }
  }

  /** A request of the channel's own; its reply is dropped. */
  private sendOwn(targetKey: string, method: string, params: unknown): void {
    const innerWire = this.route(null, 0, targetKey, method);
    const m = { id: innerWire, method, params };
    if (targetKey === "") return this.write(m);
    this.write({
      id: this.route(null, 0, targetKey, undefined, innerWire),
      method: "Target.sendMessageToTarget",
      params: { targetId: targetKey, message: JSON.stringify(m) },
    });
  }

  private route(client: Client | null, origId: number, targetKey: string, method?: string, innerWireId?: number): number {
    const wireId = ++this.lastWireId;
    this.routes.set(wireId, { client, origId, targetKey, method, innerWireId });
    return wireId;
  }

  private write(frame: unknown): void {
    this.wi.forwardSocketData(this.appId, this.pageId, this.senderKey, textEncoder.encode(JSON.stringify(frame)));
  }

  // --- incoming ------------------------------------------------------------

  private onWir(m: WIMessage): void {
    if (m.__selector !== "_rpc_applicationSentData:") return;
    const arg = m.__argument as Record<string, any> | undefined;
    if (!arg || typeof arg !== "object") return;
    if (arg.WIRDestinationKey && arg.WIRDestinationKey !== this.senderKey) return;
    if (arg.WIRApplicationIdentifierKey !== this.appId) return;
    // Daemon data: the page id must be the very number we set up (a decoded
    // dict here would make Number() throw).
    if (arg.WIRPageIdentifierKey !== undefined && arg.WIRPageIdentifierKey !== this.pageId) return;
    const data = arg.WIRMessageDataKey ?? arg.WIRSocketDataKey;
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof Uint8Array) text = textDecoder.decode(data);
    else return;
    if (process.env.INSPECT_WEBKIT_DEBUG) debug(`target>> ${text.slice(0, 240)}`);
    this.onWireText(text);
  }

  private onWireText(text: string): void {
    if (this.isClosed) return;
    const msg = parseObject(text);
    if (!msg) return debug(`ignoring non-object frame: ${text.slice(0, 80)}`);
    if (msg.method === "Target.dispatchMessageFromTarget") {
      const raw = msg.params?.message;
      if (typeof raw !== "string") return;
      const inner = parseObject(raw);
      if (!inner) return debug(`ignoring non-object inner frame: ${raw.slice(0, 80)}`);
      const targetKey = typeof msg.params.targetId === "string" ? msg.params.targetId : "";
      return this.dispatch(inner, raw, true, targetKey);
    }
    this.dispatch(msg, text, false, "");
  }

  private dispatch(msg: CdpMessage, raw: string, fromInner: boolean, targetKey: string): void {
    if (typeof msg.id === "number") return this.routeReply(msg, raw, fromInner);
    const method = typeof msg.method === "string" ? msg.method : "";
    const p = msg.params;
    if (method === "Target.targetCreated") {
      const info = p?.targetInfo;
      if (info && typeof info.targetId === "string") this.targets.set(info.targetId, { ...info });
    } else if (method === "Target.didCommitProvisionalTarget") {
      if (typeof p?.newTargetId === "string") {
        const prev = this.targets.get(p.newTargetId);
        this.targets.set(p.newTargetId, { targetId: p.newTargetId, type: "page", ...prev, isProvisional: false });
        // The old page is about to be destroyed; a client joining before
        // that must not pick it.
        if (typeof p.oldTargetId === "string" && p.oldTargetId !== p.newTargetId) this.targets.delete(p.oldTargetId);
      }
    }
    this.fanOut(msg, raw, fromInner, targetKey, method);
    if (method === "Target.targetDestroyed" && typeof p?.targetId === "string") this.forgetTarget(p.targetId);
  }

  private routeReply(msg: CdpMessage, raw: string, fromInner: boolean): void {
    const wireId = msg.id!;
    const r = this.routes.get(wireId);
    if (!r) return debug(`dropping reply for unknown wire id ${wireId}`);
    this.routes.delete(wireId);
    const client = r.client;
    if (msg.error) {
      // A failed envelope: its inner request never ran and won't be answered.
      const inner = r.innerWireId !== undefined ? this.routes.get(r.innerWireId) : undefined;
      if (inner) this.routes.delete(r.innerWireId!);
      // A rejected first enable: the client never held the domain.
      const counted = r.countedKey ?? inner?.countedKey;
      if (counted && client && !client.gone && client.enabled.delete(counted)) this.release(counted);
    }
    if (!client || client.gone) return;
    if (r.method && BREAKPOINT_SETTERS.has(r.method)) {
      const bid = msg.result?.breakpointId;
      if (typeof bid === "string") client.breakpoints.set(bid, r.targetKey);
    }
    msg.id = r.origId;
    this.deliver(client, msg, rewriteReplyId(raw, wireId, r.origId) ?? JSON.stringify(msg), fromInner);
  }

  private fanOut(msg: CdpMessage, raw: string, fromInner: boolean, targetKey: string, method: string): void {
    const domain = domainOf(method);
    const key = keyOf(targetKey, domain);
    const scoped = domain !== "Target" && this.holders.has(key);
    if (scoped) this.noteInventory(key, domain, method, msg.params, raw);
    let first = true;
    for (const c of [...this.clients]) {
      if (c.gone || (scoped && !c.enabled.has(key))) continue;
      // Filters may rewrite a message in place: each client gets its own.
      const copy = first ? msg : parseObject(raw);
      first = false;
      if (copy) this.deliver(c, copy, raw, fromInner);
    }
  }

  private noteInventory(key: string, domain: string, method: string, params: any, raw: string): void {
    const spec = INVENTORY[domain];
    if (!spec) return;
    if (spec.clear?.includes(method)) {
      this.inventory.delete(key);
      return;
    }
    const removeKey = spec.remove?.[method];
    if (removeKey) {
      this.inventory.get(key)?.delete(String(removeKey(params)));
      return;
    }
    const addKey = spec.add[method];
    if (!addKey) return;
    let items = this.inventory.get(key);
    if (!items) this.inventory.set(key, (items = new Map()));
    const ctx = method === "Runtime.executionContextCreated" ? params?.context : undefined;
    if (ctx?.type === "normal" && typeof ctx.frameId === "string") {
      // A frame's new main world: its previous contexts (all worlds) are dead.
      for (const [k, r] of [...items]) {
        if (parseObject(r)?.params?.context?.frameId === ctx.frameId) items.delete(k);
      }
    }
    const k = addKey(params);
    const itemKey = k === undefined || k === null ? `\0seq${++this.inventorySeq}` : String(k);
    items.delete(itemKey); // re-insert at the end: replay in arrival order
    items.set(itemKey, raw);
    if (items.size > MAX_INVENTORY) items.delete(items.keys().next().value!);
  }

  private forgetTarget(targetId: string): void {
    this.targets.delete(targetId);
    const prefix = `${targetId}\0`;
    for (const k of [...this.holders.keys()]) if (k.startsWith(prefix)) this.holders.delete(k);
    for (const k of [...this.inventory.keys()]) if (k.startsWith(prefix)) this.inventory.delete(k);
    for (const c of this.clients) {
      for (const k of [...c.enabled]) if (k.startsWith(prefix)) c.enabled.delete(k);
      for (const [id, t] of [...c.breakpoints]) if (t === targetId) c.breakpoints.delete(id);
    }
    // Nothing more will be answered there; each client fails its own requests.
    for (const [id, r] of [...this.routes]) if (r.targetKey === targetId) this.routes.delete(id);
  }

  private deliver(client: Client, msg: CdpMessage, raw: string, fromInner: boolean): void {
    client.target.onParsedFromTarget(msg, raw, fromInner).catch((e) =>
      console.error(`# cdp: target message failed: ${(e as Error)?.message ?? e}`),
    );
  }
}
