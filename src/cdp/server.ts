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
//   source's target listing. When a DevTools client opens
//   a WS, we allocate a fresh WIRSenderKey, send forwardSocketSetup, and
//   route _rpc_applicationSentData: frames whose WIRDestinationKey matches
//   to that session's Target.

import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { WIMessage } from "../webinspector";
import {
  type Source,
  type SourceInfo,
  type SourceManager,
  acquireSharedSourceManager,
} from "../core/source-manager";
import { Target as CdpTarget } from "./target";
import { installIOSFilters } from "./ios-protocol";
import {
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

/** One bridge-owned WIR sender attached to a page. */
type ActiveSession = {
  kind: "page" | "browser" | "highlight";
  source: Source;
  appId: string;
  pageId: number;
  targetId: string;
  senderKey: string;
  misses: number;
  firstMissAt: number;
  /** Server-initiated teardown: release the WIR sender and tell the client. */
  terminate(reason: string, code?: number): void;
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
   * closes so we don't keep a WIR connection alive that would block other
   * debuggers from attaching.
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
  const listingsByApp = new Map<string, Map<string, any>>();
  // Track sources that have requested per-app listing notifications already.
  const subscribedAppsBySource = new WeakMap<Source, Set<string>>();
  let appsBySource = new Map<Source, any[]>();

  // Every bridge-owned WIR sender (DevTools WS, browser-endpoint session,
  // hover-highlight session), so source/app/page loss can tear them down.
  const activeSessions = new Set<ActiveSession>();

  function terminateSessions(
    pred: (s: ActiveSession) => boolean,
    reason: string,
    code = CLOSE_INTERNAL,
  ): void {
    for (const s of [...activeSessions]) {
      if (!pred(s)) continue;
      try {
        s.terminate(reason, code);
      } catch (e) {
        console.error(`warn: session teardown failed: ${(e as Error)?.message ?? e}`);
      }
    }
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
        const dict = (arg.WIRApplicationDictionaryKey as Record<string, any>) ?? {};
        const apps = Object.entries(dict).map(([appId, a]) => ({
          appId,
          bundleId: a.WIRApplicationBundleIdentifierKey,
          name: a.WIRApplicationNameKey ?? a.WIRApplicationBundleIdentifierKey ?? appId,
          isProxy: Boolean(a.WIRIsApplicationProxyKey),
        }));
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
        const a = arg;
        const apps = appsBySource.get(src) ?? [];
        if (!apps.find((x) => x.appId === a.WIRApplicationIdentifierKey)) {
          apps.push({
            appId: a.WIRApplicationIdentifierKey,
            bundleId: a.WIRApplicationBundleIdentifierKey,
            name: a.WIRApplicationNameKey ?? a.WIRApplicationBundleIdentifierKey,
            isProxy: Boolean(a.WIRIsApplicationProxyKey),
          });
          appsBySource.set(src, apps);
        }
        if (!a.WIRIsApplicationProxyKey) {
          const subs = subscribedAppsBySource.get(src)!;
          if (!subs.has(a.WIRApplicationIdentifierKey)) {
            subs.add(a.WIRApplicationIdentifierKey);
            src.wi.send("_rpc_forwardGetListing:", {
              WIRApplicationIdentifierKey: a.WIRApplicationIdentifierKey,
            });
          }
        }
      } else if (sel === "_rpc_applicationDisconnected:") {
        const apps = appsBySource.get(src) ?? [];
        appsBySource.set(
          src,
          apps.filter((x) => x.appId !== arg.WIRApplicationIdentifierKey),
        );
        listingsByApp.delete(`${src.id}:${arg.WIRApplicationIdentifierKey}`);
        subscribedAppsBySource.get(src)?.delete(arg.WIRApplicationIdentifierKey);
        terminateSessions(
          (s) => s.source === src && s.appId === arg.WIRApplicationIdentifierKey,
          "application disconnected",
        );
      } else if (sel === "_rpc_applicationSentListing:") {
        const appId = arg.WIRApplicationIdentifierKey as string;
        const listing = (arg.WIRListingKey as Record<string, any>) ?? {};
        const map = new Map<string, any>();
        for (const [k, p] of Object.entries(listing)) {
          map.set(k, {
            pageId: Number(p.WIRPageIdentifierKey ?? 0),
            title: p.WIRTitleKey ?? "",
            url: p.WIRURLKey ?? "",
            type: p.WIRTypeKey ?? "",
            // WIR sets WIRConnectionIdentifierKey on a page once any inspector
            // (Safari Develop menu, chrome://inspect, our own bridge, ...)
            // attaches. Empty/missing → no debugger attached.
            connectionId: typeof p.WIRConnectionIdentifierKey === "string"
              ? p.WIRConnectionIdentifierKey
              : null,
          });
        }
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

  /** Close sessions whose page has dropped out of its app's listing. */
  function notePageListing(src: Source, appId: string, listing: Map<string, any>) {
    const present = new Set<number>();
    for (const p of listing.values()) present.add(p.pageId);
    const now = Date.now();
    for (const s of [...activeSessions]) {
      if (s.source !== src || s.appId !== appId) continue;
      if (present.has(s.pageId)) {
        s.misses = 0;
        continue;
      }
      if (s.misses++ === 0) s.firstMissAt = now;
      if (s.misses >= PAGE_GONE_MISSES && now - s.firstMissAt >= pageGoneGraceMs) {
        s.terminate("inspected page is gone");
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

  const sessions = new Map<string, CdpTarget>(); // senderKey -> session

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
          const otherInspector =
            !!p.connectionId && p.connectionId !== src.wi.connection;
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
          createPageSession: (targetId, send, onServerClose, o) => {
            const entry = listTargets().find((t) => t.targetId === targetId);
            if (!entry) return null;
            if (o?.auto && pageHasClientSession(entry)) return null;
            return createPageSession(entry, "browser", send, onServerClose);
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

  function pageHasClientSession(entry: CdpTargetEntry): boolean {
    for (const s of activeSessions) {
      if (
        s.kind !== "highlight" &&
        s.source === entry.source &&
        s.appId === entry.appId &&
        s.pageId === entry.pageId
      )
        return true;
    }
    return false;
  }

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
    kind: "page" | "browser",
    sendToTools: (text: string) => void,
    onServerClose: (reason: string, code: number) => void,
  ): PageSessionHandle {
    // WIR allows one sender per page. A second attach used to silently
    // steal the page and leave the first client hanging forever (R7);
    // until we multiplex, the newest session wins and the older one is
    // told why.
    terminateSessions(
      (s) => s.source === entry.source && s.appId === entry.appId && s.pageId === entry.pageId,
      "replaced by a newer DevTools session",
    );

    const senderKey = crypto.randomUUID();
    // Virtual ws — CdpTarget only uses readyState + send().
    const fakeWs = {
      readyState: 1,
      send: (text: string) => sendToTools(text),
    } as unknown as WSWebSocket;
    const cdp = new CdpTarget(fakeWs, entry.source.wi, entry.appId, entry.pageId, senderKey);
    installIOSFilters(cdp, filterOpts);
    sessions.set(senderKey, cdp);

    const debug = !!process.env.INSPECT_WEBKIT_DEBUG;
    const unsub = subscribeSessionData(entry, senderKey, (text) => {
      if (debug) console.error(`[cdp] target>> ${text.slice(0, 240)}`);
      return cdp.onMessageFromTarget(text);
    });

    let closed = false;
    const teardown = (reason: string) => {
      if (closed) return false;
      closed = true;
      unsub();
      activeSessions.delete(record);
      cdp.close(reason);
      try {
        cdp.wi.forwardDidClose(cdp.appId, cdp.pageId, cdp.senderKey);
      } catch {}
      sessions.delete(cdp.senderKey);
      return true;
    };
    const record: ActiveSession = {
      kind,
      source: entry.source,
      appId: entry.appId,
      pageId: entry.pageId,
      targetId: entry.targetId,
      senderKey,
      misses: 0,
      firstMissAt: 0,
      terminate(reason, code = CLOSE_INTERNAL) {
        if (!teardown(reason)) return;
        console.error(`# devtools session closed (${reason}): ${entry.targetId}`);
        try {
          onServerClose(reason, code);
        } catch {}
      },
    };
    activeSessions.add(record);

    entry.source.wi.forwardSocketSetup(entry.appId, entry.pageId, senderKey);
    console.error(
      `# devtools attached: ${entry.source.label} :: ${entry.appName} :: ${entry.title || entry.url}`,
    );

    return {
      onMessageFromTools(text: string) {
        if (debug) console.error(`[cdp] tools>>  ${text.slice(0, 300)}`);
        cdp.onMessageFromTools(text).catch((e) =>
          console.error(`# cdp: tools message failed: ${(e as Error)?.message ?? e}`),
        );
      },
      close() {
        teardown("DevTools client disconnected");
      },
    };
  }

  /** Route _rpc_applicationSentData: frames for one sender to `deliver`. */
  function subscribeSessionData(
    entry: CdpTargetEntry,
    senderKey: string,
    deliver: (text: string) => Promise<void>,
  ): () => void {
    return entry.source.wi.subscribe((m: WIMessage) => {
      if (m.__selector !== "_rpc_applicationSentData:") return;
      const arg = m.__argument as Record<string, any> | undefined;
      if (!arg || typeof arg !== "object") return;
      if (arg.WIRDestinationKey && arg.WIRDestinationKey !== senderKey) return;
      if (arg.WIRApplicationIdentifierKey !== entry.appId) return;
      if (
        arg.WIRPageIdentifierKey !== undefined &&
        Number(arg.WIRPageIdentifierKey) !== entry.pageId
      )
        return;
      const data = arg.WIRMessageDataKey ?? arg.WIRSocketDataKey;
      if (!data) return;
      let text: string;
      if (typeof data === "string") text = data;
      else if (data instanceof Uint8Array) text = new TextDecoder().decode(data);
      else return;
      deliver(text).catch((e) =>
        console.error(`# cdp: target message failed: ${(e as Error)?.message ?? e}`),
      );
    });
  }

  // Hover-highlight sessions. Each target keeps its own short-lived CDP
  // session so the host UI can flash an inspectable target the way Safari
  // does when you hover an entry under Develop → device menu. We cache the
  // session per target (DOM.getDocument is non-trivial), and idle-close it
  // after 30s of no highlight activity.
  type HighlightSession = {
    cdp: CdpTarget;
    close: () => void;
    rootNodeIdPromise: Promise<number>;
    idleTimer: ReturnType<typeof setTimeout> | null;
  };
  const highlightSessions = new Map<string, HighlightSession>();
  const HIGHLIGHT_IDLE_MS = 8_000;

  function getOrOpenHighlightSession(targetId: string): HighlightSession | null {
    const existing = highlightSessions.get(targetId);
    if (existing) return existing;
    const entry = listTargets().find((t) => t.targetId === targetId);
    if (!entry) return null;
    // Never steal the page from a real DevTools session just to flash it.
    if (pageHasClientSession(entry)) return null;
    const senderKey = crypto.randomUUID();
    const fakeWs = { readyState: 1, send: () => {} } as unknown as WSWebSocket;
    const cdp = new CdpTarget(fakeWs, entry.source.wi, entry.appId, entry.pageId, senderKey);
    installIOSFilters(cdp, filterOpts);
    sessions.set(senderKey, cdp);
    const unsub = subscribeSessionData(entry, senderKey, (text) => cdp.onMessageFromTarget(text));
    entry.source.wi.forwardSocketSetup(entry.appId, entry.pageId, senderKey);
    // DOM.getDocument can stall if Safari hasn't dispatched Target.targetCreated
    // yet — wrap in 5s so callers don't hang. We close the session below in
    // the .catch on the cached promise.
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const rootNodeIdPromise: Promise<number> = Promise.race([
      cdp.callTarget("DOM.getDocument", { depth: 0 }).then((r: any) => r?.root?.nodeId as number),
      new Promise<number>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error("DOM.getDocument timeout")), 5_000);
      }),
    ]).finally(() => clearTimeout(timeoutTimer));
    let closed = false;
    const session: HighlightSession = {
      cdp,
      rootNodeIdPromise,
      idleTimer: null,
      close() {
        if (closed) return;
        closed = true;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        unsub();
        activeSessions.delete(record);
        cdp.close("highlight session closed");
        try {
          cdp.wi.forwardDidClose(cdp.appId, cdp.pageId, cdp.senderKey);
        } catch {}
        sessions.delete(senderKey);
        if (highlightSessions.get(targetId) === session) highlightSessions.delete(targetId);
      },
    };
    const record: ActiveSession = {
      kind: "highlight",
      source: entry.source,
      appId: entry.appId,
      pageId: entry.pageId,
      targetId,
      senderKey,
      misses: 0,
      firstMissAt: 0,
      terminate: () => session.close(),
    };
    activeSessions.add(record);
    highlightSessions.set(targetId, session);
    rootNodeIdPromise.catch(() => session.close());
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
        const nodeId = await session.rootNodeIdPromise;
        if (!nodeId) return;
        await session.cdp.callTarget("DOM.highlightNode", {
          nodeId,
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
    const sess = createPageSession(
      entry,
      "page",
      (text) => {
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

  try {
    await httpServer.listen(host, port);
  } catch (e) {
    clearInterval(refreshTimer);
    releaseSources();
    throw e;
  }
  logCdpServerBanner({ brand: "safari", host, port: httpServer.addresses()[0]?.port ?? port });

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
