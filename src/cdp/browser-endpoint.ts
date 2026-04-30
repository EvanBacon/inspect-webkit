// Browser-level CDP endpoint.
//
// Modern vscode-js-debug ("pwa-chrome" attach) only follows
// /json/version.webSocketDebuggerUrl — a single browser-scope WebSocket
// behind which it expects Target.* discovery + auto-attach. The per-page
// /devtools/page/<id> URLs from /json/list aren't enough on their own.
//
// This endpoint multiplexes any number of page sessions over one socket:
//   - Target.setDiscoverTargets / Target.getTargets / Target.setAutoAttach
//   - Target.attachToTarget   → returns sessionId, fires Target.attachedToTarget
//   - Target.detachFromTarget → tears the session down
//   - Flatten mode (modern js-debug): commands carry top-level sessionId,
//     responses/events carry the same. We strip on inbound forward, inject
//     on outbound. Non-flatten Target.sendMessageToTarget also accepted.

import type { WebSocket as WSWebSocket } from "ws";

export type BrowserEntry = {
  targetId: string;
  type: string; // CDP type ("page", "worker", ...)
  title: string;
  url: string;
};

export type PageSessionHandle = {
  onMessageFromTools(text: string): void;
  close(): void;
};

export type BrowserEndpointOptions = {
  listEntries: () => BrowserEntry[];
  /** Spin up a per-page CDP session that delivers responses/events via `send`. */
  createPageSession: (
    targetId: string,
    send: (text: string) => void,
  ) => PageSessionHandle | null;
  refreshMs?: number;
};

export function attachBrowserWs(ws: WSWebSocket, opts: BrowserEndpointOptions): void {
  const debug = !!process.env.INSPECT_WEBKIT_DEBUG;
  const sessions = new Map<string, { handle: PageSessionHandle; targetId: string }>();
  let discoverEnabled = false;
  let autoAttach = false;
  let waitForDebuggerOnStart = false;
  const known = new Map<string, BrowserEntry>();
  // Modern js-debug calls Target.attachToBrowserTarget on connect to obtain
  // a sessionId for the browser itself, then sends every subsequent command
  // with that sessionId in flatten mode. We allocate one per connection and
  // recurse browser-level routing through it.
  let browserSessionId: string | null = null;

  function send(obj: any): void {
    if (ws.readyState !== 1) return;
    const s = JSON.stringify(obj);
    if (debug) console.error(`[browser] tools<< ${s.slice(0, 240)}`);
    ws.send(s);
  }

  /** Emit a browser-scope event, carrying the browser sessionId if allocated. */
  function emitBrowserEvent(method: string, params: any) {
    const evt: any = { method, params };
    if (browserSessionId) evt.sessionId = browserSessionId;
    send(evt);
  }

  function targetInfo(e: BrowserEntry, attached: boolean) {
    return {
      targetId: e.targetId,
      type: e.type === "page" ? "page" : e.type || "other",
      title: e.title || "",
      url: e.url || "",
      attached,
      canAccessOpener: false,
      browserContextId: "default",
    };
  }

  function isAttached(targetId: string): boolean {
    for (const v of sessions.values()) if (v.targetId === targetId) return true;
    return false;
  }

  function attachToTarget(
    targetId: string,
    waitingForDebugger: boolean,
  ): { sessionId: string; entry: BrowserEntry } | null {
    const entry = opts.listEntries().find((e) => e.targetId === targetId);
    if (!entry) return null;
    const sessionId = crypto.randomUUID();
    const sendToTools = (text: string) => {
      let m: any;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      m.sessionId = sessionId;
      send(m);
    };
    const handle = opts.createPageSession(targetId, sendToTools);
    if (!handle) return null;
    sessions.set(sessionId, { handle, targetId });
    emitBrowserEvent("Target.attachedToTarget", {
      sessionId,
      targetInfo: targetInfo(entry, true),
      waitingForDebugger,
    });
    return { sessionId, entry };
  }

  function detach(sessionId: string): boolean {
    const sess = sessions.get(sessionId);
    if (!sess) return false;
    try {
      sess.handle.close();
    } catch {}
    sessions.delete(sessionId);
    emitBrowserEvent("Target.detachedFromTarget", { sessionId, targetId: sess.targetId });
    return true;
  }

  function pumpDiscovery(): void {
    const cur = opts.listEntries();
    const seen = new Set<string>();
    for (const e of cur) {
      seen.add(e.targetId);
      const prev = known.get(e.targetId);
      if (!prev) {
        known.set(e.targetId, e);
        if (discoverEnabled) {
          emitBrowserEvent("Target.targetCreated", {
            targetInfo: targetInfo(e, isAttached(e.targetId)),
          });
        }
        if (autoAttach && !isAttached(e.targetId)) {
          attachToTarget(e.targetId, waitForDebuggerOnStart);
        }
      } else if (prev.title !== e.title || prev.url !== e.url) {
        known.set(e.targetId, e);
        if (discoverEnabled) {
          emitBrowserEvent("Target.targetInfoChanged", {
            targetInfo: targetInfo(e, isAttached(e.targetId)),
          });
        }
      }
    }
    for (const id of [...known.keys()]) {
      if (seen.has(id)) continue;
      known.delete(id);
      for (const [sid, s] of sessions) if (s.targetId === id) detach(sid);
      if (discoverEnabled) {
        emitBrowserEvent("Target.targetDestroyed", { targetId: id });
      }
    }
  }

  const refreshTimer = setInterval(pumpDiscovery, opts.refreshMs ?? 1000);

  function reply(envelopeSessionId: string | undefined, body: any) {
    if (envelopeSessionId) body.sessionId = envelopeSessionId;
    send(body);
  }

  function handleBrowserLevel(msg: any, envelopeSessionId: string | undefined) {
    const id = msg.id;
    const method: string | undefined = msg.method;
    const params = msg.params ?? {};

    switch (method) {
      case "Browser.getVersion":
        return reply(envelopeSessionId, {
          id,
          result: {
            protocolVersion: "1.3",
            product: "Safari/inspect-webkit",
            revision: "@",
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15 Safari/inspect-webkit",
            jsVersion: "",
          },
        });
      case "Target.attachToBrowserTarget": {
        if (!browserSessionId) browserSessionId = crypto.randomUUID();
        return reply(envelopeSessionId, { id, result: { sessionId: browserSessionId } });
      }
      case "Target.setDiscoverTargets": {
        discoverEnabled = !!params.discover;
        // Emit Target.targetCreated BEFORE the result so the events are
        // already in Puppeteer's queue by the time setDiscoverTargets's
        // promise resolves. Otherwise Puppeteer's connect() resolves with
        // an empty target list and clients that immediately call
        // browser.pages() (chrome-devtools-mcp's McpContext does this in
        // its constructor) get back nothing.
        if (discoverEnabled) {
          for (const e of opts.listEntries()) {
            known.set(e.targetId, e);
            emitBrowserEvent("Target.targetCreated", {
              targetInfo: targetInfo(e, isAttached(e.targetId)),
            });
          }
        }
        if (typeof id === "number") reply(envelopeSessionId, { id, result: {} });
        return;
      }
      case "Target.getTargets": {
        const targetInfos = opts.listEntries().map((e) => targetInfo(e, isAttached(e.targetId)));
        return reply(envelopeSessionId, { id, result: { targetInfos } });
      }
      case "Target.setAutoAttach": {
        autoAttach = !!params.autoAttach;
        waitForDebuggerOnStart = !!params.waitForDebuggerOnStart;
        // Emit Target.attachedToTarget BEFORE replying. Puppeteer's
        // TargetManager.initialize() awaits setAutoAttach's reply and then
        // declares "initialAttachDone" — which is what gates browser.pages()
        // from seeing any pages. If attachedToTarget fires after the reply,
        // browser.pages() returns 0 the first time it's called and clients
        // (chrome-devtools-mcp) believe there are no pages.
        if (autoAttach) {
          for (const e of opts.listEntries()) {
            if (!isAttached(e.targetId)) attachToTarget(e.targetId, waitForDebuggerOnStart);
          }
        }
        if (typeof id === "number") reply(envelopeSessionId, { id, result: {} });
        return;
      }
      case "Target.attachToTarget": {
        // WebKit's webinspectord allows only one sender (forwardSocketSetup)
        // per page. If we've already attached (e.g., via setAutoAttach), a
        // second attachToTarget that creates a fresh forwardSocketSetup
        // gets silently ignored by Safari. chrome-devtools-mcp's
        // UniverseManager re-attaches periodically, which used to wedge
        // the Universe's CDP traffic. Reuse the existing sessionId.
        for (const [sid, s] of sessions) {
          if (s.targetId === params.targetId) {
            if (typeof id === "number")
              reply(envelopeSessionId, { id, result: { sessionId: sid } });
            return;
          }
        }
        const r = attachToTarget(params.targetId, false);
        if (!r) {
          if (typeof id === "number") {
            reply(envelopeSessionId, {
              id,
              error: { code: -32000, message: "No target with given id found" },
            });
          }
          return;
        }
        if (typeof id === "number")
          reply(envelopeSessionId, { id, result: { sessionId: r.sessionId } });
        return;
      }
      case "Target.detachFromTarget": {
        detach(params.sessionId);
        if (typeof id === "number") reply(envelopeSessionId, { id, result: {} });
        return;
      }
      case "Target.sendMessageToTarget": {
        const sess = sessions.get(params.sessionId);
        if (sess) sess.handle.onMessageFromTools(params.message);
        if (typeof id === "number") reply(envelopeSessionId, { id, result: {} });
        return;
      }
      case "Target.setRemoteLocations":
      case "Target.exposeDevToolsProtocol":
      case "Target.activateTarget":
      case "Target.closeTarget":
        if (typeof id === "number") reply(envelopeSessionId, { id, result: {} });
        return;
      // Puppeteer's connect() asks for browser contexts during init. WebKit
      // has no concept; expose a single synthetic "default" context so the
      // handshake completes.
      case "Target.getBrowserContexts": {
        if (typeof id === "number")
          reply(envelopeSessionId, { id, result: { browserContextIds: ["default"] } });
        return;
      }
    }

    if (typeof id === "number") {
      reply(envelopeSessionId, {
        id,
        error: {
          code: -32601,
          message: `Browser-level method '${method ?? "?"}' not implemented`,
        },
      });
    }
  }

  ws.on("message", (raw, isBinary) => {
    const text = isBinary ? new TextDecoder().decode(raw as Buffer) : raw.toString();
    if (debug) console.error(`[browser] tools>> ${text.slice(0, 240)}`);
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg.sessionId === "string") {
      // Browser-target sessionId — treat as browser-level command, but echo
      // the sessionId back on responses/events so js-debug routes them.
      if (msg.sessionId === browserSessionId) {
        const inner = { ...msg };
        delete inner.sessionId;
        return handleBrowserLevel(inner, msg.sessionId);
      }
      // Otherwise: page session routing.
      const sess = sessions.get(msg.sessionId);
      if (!sess) {
        if (typeof msg.id === "number") {
          send({
            id: msg.id,
            sessionId: msg.sessionId,
            error: { code: -32000, message: `Session ${msg.sessionId} not found` },
          });
        }
        return;
      }
      const inner = { ...msg };
      delete inner.sessionId;
      sess.handle.onMessageFromTools(JSON.stringify(inner));
      return;
    }

    handleBrowserLevel(msg, undefined);
  });

  ws.on("close", () => {
    clearInterval(refreshTimer);
    for (const [, s] of sessions) {
      try {
        s.handle.close();
      } catch {}
    }
    sessions.clear();
  });
}
