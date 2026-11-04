// Chrome DevTools Protocol bridge.
//
// HTTP endpoints expected by `chrome://inspect` and the chrome-devtools
// frontend & VS Code's pwa-chrome attach mode:
//   GET /json/version          — browser version blob
//   GET /json/list (= /json)   — list of debuggable targets
//   GET /                      — discovery aid
//
// WebSocket endpoint (one per debugging session):
//   ws://host:port/devtools/page/<targetId>
//
// targetId is "device:<udid>:<appId>:<pageId>" or "sim:<udid>:<appId>:<pageId>".
//
// Architecture:
//   Sources (USB/Wi-Fi devices, simulators) come from the shared
//   SourceManager (core/source-manager.ts), which discovers them, keeps one
//   WebInspectorClient ("backend") per source open for the server's
//   lifetime and reconnects with backoff. The server listens immediately
//   and adds each source as it becomes ready. We periodically refresh each
//   source's target listing. Each inspected page gets one PageChannel (one
//   WIRSenderKey / forwardSocketSetup), shared by every client on that page
//   — DevTools WebSockets, browser-endpoint sessions, hover highlights —
//   each with its own Target session (see page-channel.ts).

import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  type Source,
  type SourceInfo,
  type SourceManager,
  acquireSharedSourceManager,
} from "../core/source-manager";
import { Target as CdpTarget } from "./target";
import { installIOSFilters } from "./ios-protocol";
import { PageChannel } from "./page-channel";
import {
  type CdpHttpServer,
  type CdpServerBaseOptions,
  WS_MAX_PAYLOAD,
  checkResponseBodyRefetch,
  buildJsonTarget,
  createCdpHttpServer,
  logCdpServerBanner,
  rejectUpgrade,
  safeDecode,
} from "./http";
import { attachBrowserWs, type PageSessionHandle } from "./browser-endpoint";
import { isPlistDict, parseApp, parseListing, type WIApplication, type WIListedPage } from "../webinspector";
import { capture } from "../capture";

export type { Source } from "../core/source-manager";

type CdpTargetEntry = {
  targetId: string;
  source: Source;
  appId: string;
  appName: string;
  bundleId?: string;
  pageId: number;
  title: string;
  url: string;
  type: string;
  /**
   * True when WIR reports a debugger connection on this page from a sender
   * we don't own. Safari greys out such entries in its Develop menu — only
   * one inspector may attach to a WebKit page at a time.
   */
  inUseByOtherInspector: boolean;
};

const REFRESH_MS = 1500;
/** A page must be missing from this many consecutive listings of its app… */
const PAGE_GONE_MISSES = 2;
/** …spanning at least this long, before we treat it as gone. Absorbs
 *  back-to-back pushed listings during navigation. */
const PAGE_GONE_GRACE_MS = 1000;

/** WebSocket close code for server-side session teardown. */
const CLOSE_INTERNAL = 1011;
const CLOSE_GOING_AWAY = 1001;

/** The shared WIR sender for one inspected page, and its listing misses. */
type PageRecord = {
  channel: PageChannel;
  source: Source;
  appId: string;
  pageId: number;
  targetId: string;
  misses: number;
  firstMissAt: number;
  /** Warned that another inspector holds this page (reset once it's free). */
  warnedForeignHolder: boolean;
};

export type CdpServerOptions = CdpServerBaseOptions & {
  /**
   * @internal Test seam: supply the inspector sources instead of
   * discovering USB devices and simulators.
   */
  openSources?: () => Promise<Source[]>;
  /**
   * @internal Use this SourceManager instead of the process-wide shared one
   * (tests). The caller owns its lifetime.
   */
  sourceManager?: SourceManager;
  /** @internal Test seam: override PAGE_GONE_GRACE_MS. */
  pageGoneGraceMs?: number;
  /** @internal Fuzzing seam: don't bind any socket (drive it via onHttpServer). */
  listen?: boolean;
  /** @internal Fuzzing seam: receives the HTTP front door for in-process dispatch. */
  onHttpServer?: (server: CdpHttpServer) => void;
};

export type CdpServer = {
  stop(): void;
  /** Snapshot of current debuggable targets. */
  getTargets(): CdpTargetEntry[];
  /**
   * Flash an inspectable target on the device — the way Safari does when you
   * hover an entry under Develop → device menu. Pass `on=true` to overlay
   * the page, `on=false` to clear. Safe to call repeatedly.
   */
  highlightTarget(targetId: string, on: boolean): Promise<void>;
  /**
   * Drop the cached hover-highlight session for a target (or all of them
   * when `targetId` is omitted). Hosts should call this when their picker
   * closes so we don't hold the page's inspector connection (and the
   * "in use" mark Safari's Develop menu shows) longer than needed.
   */
  releaseHighlight(targetId?: string): void;
  /** Addresses the HTTP/WS server is listening on. */
  addresses(): AddressInfo[];
  /** Known inspector sources and their connection state. */
  getSources(): SourceInfo[];
};

/** How long to wait for sources before warning that none were found. */
const NO_SOURCES_WARN_MS = 15_000;

export async function startCdpServer(opts: CdpServerOptions = {}): Promise<CdpServer> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "localhost";
  const pageGoneGraceMs = opts.pageGoneGraceMs ?? PAGE_GONE_GRACE_MS;
  // Per-session filter options. bridgePorts is read lazily: the server
  // isn't listening yet.
  const filterOpts = {
    network: {
      responseBodyRefetch: checkResponseBodyRefetch(opts.responseBodyRefetch),
      bridgePorts: () => httpServer.addresses().map((a) => a.port),
    },
  };

  // Ready sources. A reconnect produces a new Source object (same id).
  const sources = new Set<Source>();

  // listing cache: continuously refreshed from each source's WI client.
  const listingsByApp = new Map<string, Map<string, WIListedPage>>();
  // Track sources that have requested per-app listing notifications already.
  const subscribedAppsBySource = new WeakMap<Source, Set<string>>();
  let appsBySource = new Map<Source, ServerApp[]>();

  // One PageChannel per attached page (targetId → record), so source/app/
  // page loss can tear down every client on it.
  const pages = new Map<string, PageRecord>();

  function terminateSessions(
    pred: (p: PageRecord) => boolean,
    reason: string,
    code = CLOSE_INTERNAL,
  ): void {
    for (const p of [...pages.values()]) {
      if (!pred(p)) continue;
      if (p.channel.clientCount > 0) {
        console.error(`# devtools sessions closed (${reason}): ${p.targetId}`);
      }
      p.channel.close(reason, code);
    }
  }

  /** The page's channel, created (not yet set up) if nobody is attached. */
  function channelFor(entry: CdpTargetEntry): PageChannel {
    const cur = pages.get(entry.targetId);
    if (cur && cur.source === entry.source && !cur.channel.closed) return cur.channel;
    const channel = new PageChannel(entry.source.wi, entry.appId, entry.pageId, {
      onEmpty: () => {
        if (pages.get(entry.targetId)?.channel === channel) pages.delete(entry.targetId);
      },
    });
    pages.set(entry.targetId, {
      channel,
      source: entry.source,
      appId: entry.appId,
      pageId: entry.pageId,
      targetId: entry.targetId,
      misses: 0,
      firstMissAt: 0,
      warnedForeignHolder: false,
    });
    return channel;
  }

  /** Per-source listener removers, so stop() detaches from sources that
   *  outlive this server (shared manager). */
  const sourceListeners = new Map<Source, () => void>();

  function addSource(src: Source): void {
    if (sources.has(src) || src.wi.closed) return;
    sources.add(src);
    appsBySource.set(src, []);
    subscribedAppsBySource.set(src, new Set());

    const offClose = src.wi.onClose(() => {
      offSub();
      sourceListeners.delete(src);
      sources.delete(src);
      appsBySource.delete(src);
      for (const k of [...listingsByApp.keys()]) {
        if (k.startsWith(`${src.id}:`)) listingsByApp.delete(k);
      }
      terminateSessions((s) => s.source === src, `inspector source ${src.label} disconnected`);
    });

    const offSub = src.wi.subscribe((m) => {
      const sel = m.__selector as string | undefined;
      const arg = m.__argument as Record<string, any> | undefined;
      if (!sel || !arg) return;

      if (sel === "_rpc_reportConnectedApplicationList:") {
        const dict = isPlistDict(arg.WIRApplicationDictionaryKey) ? arg.WIRApplicationDictionaryKey : {};
        const apps = Object.entries(dict).map(([appId, raw]) => serverApp(parseApp(appId, raw)));
        const prev = appsBySource.get(src) ?? [];
        appsBySource.set(src, apps);
        const subs = subscribedAppsBySource.get(src)!;
        const now = new Set(apps.map((a) => a.appId));
        for (const old of prev) {
          if (now.has(old.appId)) continue;
          listingsByApp.delete(`${src.id}:${old.appId}`);
          subs.delete(old.appId);
          terminateSessions(
            (s) => s.source === src && s.appId === old.appId,
            "application disconnected",
          );
        }
        for (const a of apps) {
          if (a.isProxy || subs.has(a.appId)) continue;
          subs.add(a.appId);
          src.wi.send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: a.appId });
        }
      } else if (sel === "_rpc_applicationConnected:") {
        const appId = arg.WIRApplicationIdentifierKey;
        if (typeof appId !== "string") return;
        const a = serverApp(parseApp(appId, arg));
        const apps = appsBySource.get(src) ?? [];
        if (!apps.find((x) => x.appId === appId)) {
          apps.push(a);
          appsBySource.set(src, apps);
        }
        if (!a.isProxy) {
          const subs = subscribedAppsBySource.get(src)!;
          if (!subs.has(appId)) {
            subs.add(appId);
            src.wi.send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: appId });
          }
        }
      } else if (sel === "_rpc_applicationDisconnected:") {
        const appId = arg.WIRApplicationIdentifierKey;
        if (typeof appId !== "string") return;
        const apps = appsBySource.get(src) ?? [];
        appsBySource.set(
          src,
          apps.filter((x) => x.appId !== appId),
        );
        listingsByApp.delete(`${src.id}:${appId}`);
        subscribedAppsBySource.get(src)?.delete(appId);
        terminateSessions(
          (s) => s.source === src && s.appId === appId,
          "application disconnected",
        );
      } else if (sel === "_rpc_applicationSentListing:") {
        const appId = arg.WIRApplicationIdentifierKey;
        if (typeof appId !== "string") return;
        const map = new Map<string, WIListedPage>();
        for (const p of parseListing(arg.WIRListingKey)) map.set(String(p.pageId), p);
        listingsByApp.set(`${src.id}:${appId}`, map);
        notePageListing(src, appId, map);
      }
    });

    sourceListeners.set(src, () => {
      offSub();
      offClose();
    });
    src.wi.send("_rpc_reportIdentifier:", {});
    src.wi.send("_rpc_getConnectedApplications:", {});
  }

  let manager: SourceManager | null = null;
  let releaseManager = () => {};
  let offSourceReady = () => {};
  if (opts.openSources) {
    for (const src of await opts.openSources()) addSource(src);
  } else {
    if (opts.sourceManager) {
      manager = opts.sourceManager;
    } else {
      const lease = acquireSharedSourceManager();
      manager = lease.manager;
      releaseManager = () => lease.release();
    }
    offSourceReady = manager.onSourceReady(addSource);
    for (const src of manager.readySources()) addSource(src);
    manager.start();
    // Never block listen() on discovery; just tell the user if nothing shows up.
    const m = manager;
    void m.settled(NO_SOURCES_WARN_MS).then(() => {
      if (m.isStopped || m.list().length > 0) return;
      console.error("warn: no inspectable sources found yet (no devices, no booted simulators).");
      console.error("      The server keeps running; new targets will appear when you start one.");
    });
  }

  function heldByOther(src: Source, page: WIListedPage): boolean {
    return !!page.connectionId && page.connectionId !== src.wi.connection;
  }

  /**
   * WebKit keeps the first inspector on a page and silently ignores later
   * ones, so while Safari's Web Inspector (or another bridge) holds a page our
   * clients get no replies at all. Say so, once per takeover.
   */
  function noteHolder(p: PageRecord, foreign: boolean): void {
    if (!foreign) {
      p.warnedForeignHolder = false;
      return;
    }
    if (p.warnedForeignHolder || p.channel.clientCount === 0) return;
    p.warnedForeignHolder = true;
    console.error(
      `warn: ${p.targetId} is held by another inspector (Safari's Web Inspector, or another ` +
        "inspect-webkit / CDP bridge). WebKit won't answer clients here until it detaches.",
    );
  }

  /** Close sessions whose page has dropped out of its app's listing. */
  function notePageListing(src: Source, appId: string, listing: Map<string, WIListedPage>) {
    const listed = new Map<number, WIListedPage>();
    for (const p of listing.values()) listed.set(p.pageId, p);
    const now = Date.now();
    for (const p of [...pages.values()]) {
      if (p.source !== src || p.appId !== appId) continue;
      const page = listed.get(p.pageId);
      if (page) {
        p.misses = 0;
        noteHolder(p, heldByOther(src, page));
        continue;
      }
      if (p.misses++ === 0) p.firstMissAt = now;
      if (p.misses >= PAGE_GONE_MISSES && now - p.firstMissAt >= pageGoneGraceMs) {
        terminateSessions((x) => x === p, "inspected page is gone");
      }
    }
  }

  const refreshTimer = setInterval(() => {
    for (const src of sources) {
      if (src.wi.closed) continue;
      const apps = appsBySource.get(src) ?? [];
      for (const a of apps) {
        if (a.isProxy) continue;
        src.wi.send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: a.appId });
      }
    }
  }, REFRESH_MS);

  function listTargets(): CdpTargetEntry[] {
    const out: CdpTargetEntry[] = [];
    for (const src of sources) {
      const apps = appsBySource.get(src) ?? [];
      for (const a of apps) {
        if (a.isProxy) continue;
        const listing = listingsByApp.get(`${src.id}:${a.appId}`);
        if (!listing) continue;
        for (const p of listing.values()) {
          // WIR allows only one debugger per page. WIRConnectionIdentifierKey
          // on a page is the *host* connection id (one per WebInspectorClient),
          // not our per-WS senderKey — so we compare against this source's
          // own connection id. A match means it's our own attachment (the
          // iframe inspector or a hover-highlight session); anything else is
          // a foreign debugger (Safari Develop menu, chrome://inspect, …).
          const otherInspector = heldByOther(src, p);
          out.push({
            targetId: `${src.id}:${a.appId}:${p.pageId}`,
            source: src,
            appId: a.appId,
            appName: a.name,
            bundleId: a.bundleId,
            pageId: p.pageId,
            title: p.title,
            url: p.url,
            type: p.type,
            inUseByOtherInspector: otherInspector,
          });
        }
      }
    }
    return out;
  }

  const browserId = crypto.randomUUID();

  const httpServer = createCdpHttpServer({
    brand: "",
    version: (reqHost) => ({
      Browser: "Safari/inspect-webkit",
      "Protocol-Version": "1.3",
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15 Safari/inspect-webkit",
      "WebKit-Version": "605.1.15",
      // Required by modern vscode-js-debug (pwa-chrome attach): it follows
      // this URL and expects browser-scope Target.* multiplexing. Served by
      // attachBrowserWs below.
      webSocketDebuggerUrl: `ws://${reqHost}/devtools/browser/${browserId}`,
    }),
    listTargets: (reqHost) =>
      listTargets().map((t) =>
        buildJsonTarget({
          reqHost,
          id: t.targetId,
          description: `${t.source.label}${t.bundleId ? ` (${t.bundleId})` : ""}`,
          title: t.title || t.appName,
          // chrome://inspect silently drops targets whose `url` isn't http(s) —
          // Safari reports `file:///…/Foo.app/` for native WKWebViews, which
          // would hide the entire group. Substitute about:blank so the row
          // still renders. The real bundle path stays in `description`.
          url: /^https?:/i.test(t.url) ? t.url : "about:blank",
          type: mapWIRType(t.type),
        }),
      ),
  }, { host, allowOrigins: opts.allowOrigins });

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  wss.on("error", (e) => console.error(`# ws server error: ${(e as Error)?.message ?? e}`));
  const browserPath = `/devtools/browser/${browserId}`;

  httpServer.onUpgrade((req, socket, head, pathname) => {
    console.error(`# ws upgrade: ${pathname}`);
    if (pathname === browserPath) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        guardWs(ws);
        attachBrowserWs(ws, {
          listEntries: () =>
            listTargets().map((t) => ({
              targetId: t.targetId,
              type: mapWIRType(t.type),
              title: t.title || t.appName,
              url: t.url,
            })),
          createPageSession: (targetId, send, onServerClose) => {
            const entry = listTargets().find((t) => t.targetId === targetId);
            if (!entry) return null;
            return createPageSession(entry, send, onServerClose);
          },
        });
      });
      return;
    }
    if (!pathname.startsWith("/devtools/page/")) {
      console.error(`# ws upgrade rejected: unknown path ${pathname}`);
      rejectUpgrade(socket, 404, "not found");
      return;
    }
    const targetId = safeDecode(pathname.slice("/devtools/page/".length));
    if (targetId == null) {
      console.error(`# ws upgrade rejected: bad percent-encoding in ${pathname}`);
      rejectUpgrade(socket, 400, "bad request: invalid percent-encoding");
      return;
    }
    if (!listTargets().some((t) => t.targetId === targetId)) {
      console.error(`# ws upgrade rejected: unknown target ${targetId}`);
      rejectUpgrade(socket, 404, "unknown target");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      guardWs(ws);
      attachWs(ws, targetId);
    });
  });

  /** A protocol error on one client (bad frame, oversized message, reset)
   *  must only drop that client. */
  function guardWs(ws: WSWebSocket) {
    ws.on("error", (e) => {
      console.error(`# ws error: ${(e as Error)?.message ?? e}`);
      try {
        ws.terminate();
      } catch {}
    });
  }

  function createPageSession(
    entry: CdpTargetEntry,
    sendToTools: (text: string) => void,
    onServerClose: (reason: string, code: number) => void,
  ): PageSessionHandle {
    // Virtual ws — CdpTarget only uses readyState + send().
    const fakeWs = {
      readyState: 1,
      send: (text: string) => sendToTools(text),
    } as unknown as WSWebSocket;
    const channel = channelFor(entry);
    const cdp = new CdpTarget(fakeWs, entry.source.wi, entry.appId, entry.pageId, channel.senderKey);
    installIOSFilters(cdp, filterOpts);
    const detach = channel.attach(cdp, (reason, code) => {
      try {
        onServerClose(reason, code);
      } catch {}
    });
    console.error(
      `# devtools attached (${channel.clientCount} on page): ${entry.source.label} :: ${entry.appName} :: ${entry.title || entry.url}`,
    );
    const record = pages.get(entry.targetId);
    if (record) noteHolder(record, entry.inUseByOtherInspector);
    const debug = !!process.env.INSPECT_WEBKIT_DEBUG;
    return {
      onMessageFromTools(text: string) {
        if (debug) console.error(`[cdp] tools>>  ${text.slice(0, 300)}`);
        cdp.onMessageFromTools(text).catch((e) =>
          console.error(`# cdp: tools message failed: ${(e as Error)?.message ?? e}`),
        );
      },
      close() {
        cdp.close("DevTools client disconnected");
        detach();
      },
    };
  }

  // Hover-highlight sessions. Each target keeps its own short-lived CDP
  // session (a client on the page's shared channel) so the host UI can
  // flash an inspectable target the way Safari does when you hover an
  // entry under Develop → device menu. The session is cached per target and
  // idle-closed after a few seconds without highlight activity.
  //
  // It highlights by object id (Runtime.evaluate → DOM.highlightNode
  // {objectId}) rather than DOM.getDocument + nodeId: WebKit's getDocument
  // resets every DOM node id, which would break a DevTools Elements panel
  // sharing the page.
  type HighlightSession = {
    cdp: CdpTarget;
    close: () => void;
    objectIdPromise: Promise<string>;
    idleTimer: ReturnType<typeof setTimeout> | null;
  };
  const highlightSessions = new Map<string, HighlightSession>();
  const HIGHLIGHT_IDLE_MS = 8_000;
  const HIGHLIGHT_GROUP = "inspect-webkit-highlight";

  function getOrOpenHighlightSession(targetId: string): HighlightSession | null {
    const existing = highlightSessions.get(targetId);
    if (existing) return existing;
    const entry = listTargets().find((t) => t.targetId === targetId);
    if (!entry) return null;
    const channel = channelFor(entry);
    const fakeWs = { readyState: 1, send: () => {} } as unknown as WSWebSocket;
    const cdp = new CdpTarget(fakeWs, entry.source.wi, entry.appId, entry.pageId, channel.senderKey);
    let closed = false;
    const session: HighlightSession = {
      cdp,
      objectIdPromise: Promise.resolve(""),
      idleTimer: null,
      close() {
        if (closed) return;
        closed = true;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (highlightSessions.get(targetId) === session) highlightSessions.delete(targetId);
        // Others may stay on the page: don't leave our remote objects behind.
        if (channel.clientCount > 1) {
          cdp.callTarget("Runtime.releaseObjectGroup", { objectGroup: HIGHLIGHT_GROUP }).catch(() => {});
        }
        cdp.close("highlight session closed");
        detach();
      },
    };
    const detach = channel.attach(cdp, () => session.close());
    // Evaluation can stall if Safari hasn't dispatched Target.targetCreated
    // yet — the 5 s deadline keeps callers from hanging; the session is
    // closed below in the .catch on the cached promise.
    session.objectIdPromise = cdp
      .callTarget(
        "Runtime.evaluate",
        { expression: "document.documentElement", objectGroup: HIGHLIGHT_GROUP },
        5_000,
      )
      .then((r: any) => {
        const id = r?.result?.objectId;
        if (typeof id !== "string") throw new Error("no document element");
        return id;
      });
    highlightSessions.set(targetId, session);
    session.objectIdPromise.catch(() => session.close());
    return session;
  }

  function bumpHighlightIdle(session: HighlightSession) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => session.close(), HIGHLIGHT_IDLE_MS);
  }

  function releaseHighlight(targetId?: string): void {
    if (targetId) {
      highlightSessions.get(targetId)?.close();
      return;
    }
    for (const sess of highlightSessions.values()) sess.close();
  }

  async function highlightTarget(targetId: string, on: boolean): Promise<void> {
    const session = getOrOpenHighlightSession(targetId);
    if (!session) return;
    bumpHighlightIdle(session);
    try {
      if (on) {
        const objectId = await session.objectIdPromise;
        await session.cdp.callTarget("DOM.highlightNode", {
          objectId,
          highlightConfig: {
            showInfo: false,
            contentColor: { r: 111, g: 168, b: 220, a: 0.55 },
            paddingColor: { r: 147, g: 196, b: 125, a: 0 },
            borderColor: { r: 255, g: 229, b: 153, a: 0 },
            marginColor: { r: 246, g: 178, b: 107, a: 0 },
          },
        });
      } else {
        await session.cdp.callTarget("DOM.hideHighlight", {});
      }
    } catch {
      // Stale target — drop the session so the next call reopens.
      session.close();
    }
  }

  function attachWs(ws: WSWebSocket, targetId: string) {
    const entry = listTargets().find((t) => t.targetId === targetId);
    if (!entry) {
      console.error(
        `# ws closed: unknown target ${targetId} (known: ${listTargets()
          .map((t) => t.targetId)
          .join(", ") || "none"})`,
      );
      closeWs(ws, CLOSE_INTERNAL, `unknown target ${targetId}`);
      return;
    }
    const capSession = capture.on ? capture.session(`page:${targetId}`) : "";
    const sess = createPageSession(
      entry,
      (text) => {
        if (capture.on) capture.cdp("out", capSession, text);
        if (ws.readyState === 1) ws.send(text);
      },
      (reason, code) => closeWs(ws, code, reason),
    );
    // Liveness probe: if the peer disappears (browser tab killed, network
    // glitch) the OS may not surface a TCP RST for minutes. Without this,
    // the orphaned session would keep the WIR slot occupied and block other
    // debuggers from attaching. Ping every 15s; tear down after one miss.
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) {
        try { ws.terminate(); } catch {}
        return;
      }
      alive = false;
      try { ws.ping(); } catch {}
    }, 15_000);
    ws.on("message", (raw, isBinary) => {
      try {
        const text = isBinary ? new TextDecoder().decode(raw as Buffer) : raw.toString();
        if (capture.on) capture.cdp("in", capSession, text);
        sess.onMessageFromTools(text);
      } catch (e) {
        console.error(`# ws message error: ${(e as Error)?.message ?? e}`);
      }
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      sess.close();
    });
  }

  function releaseSources() {
    offSourceReady();
    for (const off of sourceListeners.values()) off();
    sourceListeners.clear();
    if (manager) {
      releaseManager();
      return;
    }
    for (const src of [...sources]) {
      try {
        src.wi.close();
        src.lockdown?.close();
      } catch {}
    }
  }

  opts.onHttpServer?.(httpServer);
  if (opts.listen !== false) {
    try {
      await httpServer.listen(host, port);
    } catch (e) {
      clearInterval(refreshTimer);
      releaseSources();
      throw e;
    }
    logCdpServerBanner({ brand: "safari", host, port: httpServer.addresses()[0]?.port ?? port });
  }

  return {
    stop() {
      clearInterval(refreshTimer);
      for (const sess of highlightSessions.values()) sess.close();
      terminateSessions(() => true, "server stopping", CLOSE_GOING_AWAY);
      for (const c of wss.clients) {
        try {
          c.terminate();
        } catch {}
      }
      wss.close();
      httpServer.close();
      releaseSources();
    },
    /** Snapshot of current debuggable targets. */
    getTargets(): CdpTargetEntry[] {
      return listTargets();
    },
    /**
     * Flash an inspectable target on the device — the way Safari does when
     * you hover an entry under Develop → device menu. `on=true` overlays the
     * page; `on=false` clears it. Sessions are cached per-target and idle-
     * closed after a short grace period.
     */
    highlightTarget(targetId: string, on: boolean): Promise<void> {
      return highlightTarget(targetId, on);
    },
    releaseHighlight(targetId?: string): void {
      releaseHighlight(targetId);
    },
    addresses(): AddressInfo[] {
      return httpServer.addresses();
    },
    getSources(): SourceInfo[] {
      if (manager) return manager.list();
      return [...sources].map((s) => ({
        id: s.id,
        kind: s.kind,
        label: s.label,
        udid: s.udid ?? s.id,
        state: s.wi.closed ? ("closed" as const) : ("ready" as const),
        attempts: 0,
      }));
    },
  };
}

// chrome://inspect filters on type==="page" — map page-like Safari categories
// there, and route worker-ish ones to "worker".
/** Close a client WS with a reason (RFC 6455 caps reasons at 123 bytes).
 *  Falls back to terminate() when the socket isn't OPEN yet — some ws
 *  implementations ignore close() while CONNECTING. */
function closeWs(ws: WSWebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === 1) {
      ws.close(code, Buffer.from(reason).subarray(0, 120).toString());
      return;
    }
  } catch {}
  try {
    ws.terminate();
  } catch {}
}

type ServerApp = { appId: string; bundleId?: string; name: string; isProxy: boolean };

function serverApp(a: WIApplication): ServerApp {
  return { appId: a.appId, bundleId: a.bundleId, name: a.name ?? a.bundleId ?? a.appId, isProxy: a.isProxy };
}

function mapWIRType(t: string): string {
  switch (t) {
    case "WIRTypeServiceWorker":
      return "service_worker";
    case "WIRTypeWorker":
    case "WIRTypeJavaScript":
      return "worker";
    default:
      return "page";
  }
}
