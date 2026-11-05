// Network domain — CDP <-> WIR translation.
//
// Most methods are pure renames; cookies and a few methods need param
// reshape; request-lifecycle events need a small per-field rename pass.
// Everything is table-driven on purpose — keeps this file short and makes
// it obvious which fields differ from CDP.

import type { Target, CdpMessage } from "../target";
import { isPlainObject, swallowWith } from "../domain";
import type { IoCache } from "./io";
import { refetch, type RefetchDeps, type ResponseBodyRefetch } from "../refetch";

// CDP -> WIR method renames for pure tools-side passthroughs.
// Param shapes already line up (verified against WebKit Network.json /
// Page.json on main).
const TOOLS_RENAMES: Record<string, string> = {
  "Network.setUserAgentOverride": "Page.overrideUserAgent",
  // The previous mapping (Page.setBypassCSP) was a different feature
  // entirely. Verified in WebKit's Network.json: setResourceCachingDisabled
  // takes { disabled: bool } — same boolean semantics as CDP modulo the
  // param name, handled below.
  "Network.setCacheDisabled": "Network.setResourceCachingDisabled",
};

// WIR Network event field aliases. CDP requestWillBeSent uses `wallTime`,
// WIR uses `walltime`; everything else lines up enough that DevTools
// renders the waterfall. We only rename, never delete: extra fields are
// harmless to the panel.
const EVENT_FIELD_RENAMES: Record<string, Record<string, string>> = {
  "Network.requestWillBeSent": { walltime: "wallTime" },
};

// CDP-required fields that DevTools occasionally checks for. Adding them
// with sane defaults is cheaper than a long list of ?. checks downstream.
const RWBS_DEFAULTS = { hasUserGesture: false, redirectHasExtraInfo: false };
const RR_DEFAULTS = { hasExtraInfo: false };
const LF_DEFAULTS = { encodedDataLength: 0, shouldReportCorbBlocking: false };

// CDP-required Request fields WIR doesn't send. DevTools is forgiving but
// the Network panel renders some columns blank without these.
const REQUEST_DEFAULTS = { initialPriority: "Medium", referrerPolicy: "origin" };
// CDP-required Response fields. fromDiskCache / fromServiceWorker get
// derived from WIR's `source` enum below; others are constants.
const RESPONSE_DEFAULTS = {
  connectionReused: false,
  connectionId: 0,
  fromDiskCache: false,
  fromServiceWorker: false,
  encodedDataLength: 0,
};

// WIR resource type strings → CDP. Almost identity except WIR uses
// "StyleSheet" while CDP wants "Stylesheet" — without this fix the Network
// panel filters CSS into "Other". WIR may emit unknowns (Beacon, etc.);
// fall back to "Other" rather than guessing.
function translateResourceType(t: string | undefined): string {
  switch (t) {
    case "Document":
    case "Image":
    case "Font":
    case "Script":
    case "XHR":
    case "Fetch":
    case "Ping":
    case "WebSocket":
      return t;
    case "StyleSheet":
      return "Stylesheet";
    default:
      return "Other";
  }
}

function transformRequest(req: any): any {
  if (!req) return req;
  return {
    ...REQUEST_DEFAULTS,
    ...req,
    hasPostData: req.postData != null,
  };
}

function transformResponse(res: any): any {
  if (!res) return res;
  // Safari often delivers Content-Length in the response headers but
  // doesn't set encodedDataLength on the event itself. Surface it so the
  // Size column populates without waiting for loadingFinished.
  let encodedDataLength = 0;
  const headers = res.headers ?? {};
  const cl = headers["Content-Length"] ?? headers["content-length"];
  if (cl != null) encodedDataLength = Number(cl) || 0;
  return {
    ...RESPONSE_DEFAULTS,
    ...res,
    fromDiskCache: res.source === "disk-cache",
    fromServiceWorker: res.source === "service-worker",
    encodedDataLength,
  };
}

function renameFields(obj: any, map: Record<string, string>) {
  if (!obj) return;
  for (const [from, to] of Object.entries(map)) {
    if (from in obj && !(to in obj)) {
      obj[to] = obj[from];
      delete obj[from];
    }
  }
}

// WIR Page.Cookie -> CDP Network.Cookie. The shapes are nearly identical;
// CDP requires `size`, which WIR never sends.
function wirCookieToCdp(c: any) {
  const size =
    typeof c.size === "number"
      ? c.size
      : (c.name?.length ?? 0) + (c.value?.length ?? 0);
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires ?? -1,
    size,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    session: !!c.session,
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  };
}

export type NetworkFilterOptions = {
  /** Host-side fallback for Network.getResponseBody. Default "public". */
  responseBodyRefetch?: ResponseBodyRefetch;
  /** Ports the bridge listens on (never re-fetched on this machine). */
  bridgePorts?: () => number[];
  /** @internal Test seam: DNS / HTTP for the re-fetch. */
  refetchDeps?: RefetchDeps;
};

/** How long to wait for WebKit's own Network.getResponseBody. */
const NATIVE_BODY_TIMEOUT_MS = 5_000;

export function installNetworkFilters(t: Target, ioCache?: IoCache, opts: NetworkFilterOptions = {}) {
  const policy = opts.responseBodyRefetch ?? "public";
  // Track requestId → {url, method, headers, documentURL} from
  // requestWillBeSent for the getResponseBody re-fetch fallback. (WIR
  // Network.loadResource returns content as a plain JSON string, which
  // mangles binary bodies, so the fallback fetches from the bridge process.)
  // Cap map at 1k entries to bound memory.
  const requestUrls = new Map<
    string,
    {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      frameId?: string;
      /** The requesting document; scopes which credentials may be re-sent. */
      documentURL?: string;
      // Running tally of bytes seen via Network.dataReceived. We use this
      // to short-circuit getResponseBody for empty bodies (preconnects,
      // preloads, 204s) so the re-fetch queue isn't burning slots on them.
      bytes: number;
    }
  >();
  // Per-fetch timeout. One slow/hanging URL otherwise wedges the queue and
  // DevTools drops the WebSocket. 10s is enough for any sane asset.
  const REFETCH_TIMEOUT_MS = 10_000;
  const REQUEST_LIMIT = 1024;
  // Cap re-fetched response size. DevTools' WebSocket frame ceiling kicks in
  // somewhere around ~10 MB on the receiving side; large base64 bodies were
  // observed to drop the connection ("Debugging connection was closed").
  // 4 MB leaves headroom after base64 (~5.4 MB) plus JSON escaping.
  const REFETCH_MAX_BYTES = 4 * 1024 * 1024;
  const REFETCH_MAX_REDIRECTS = 3;
  // Serialize re-fetches so a click-storm in the Network panel can't
  // fan out N concurrent downloads (each buffering a full body in RAM).
  let refetchChain: Promise<unknown> = Promise.resolve();
  const queueRefetch = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = refetchChain.then(fn, fn);
    refetchChain = next.catch(() => {});
    return next;
  };
  // --- Pure renames -------------------------------------------------------
  for (const [from, to] of Object.entries(TOOLS_RENAMES)) {
    t.addMessageFilter(`tools::${from}`, (msg) => {
      msg.method = to;
      return Promise.resolve(msg);
    });
  }

  // setCacheDisabled needs a param key rename: { cacheDisabled } -> { disabled }.
  t.addMessageFilter("tools::Network.setCacheDisabled", (msg) => {
    if (isPlainObject(msg.params) && "cacheDisabled" in msg.params) {
      msg.params = { disabled: !!msg.params.cacheDisabled };
    }
    return Promise.resolve(msg);
  });

  // --- Cookies ------------------------------------------------------------
  // getCookies / getAllCookies -> Page.getCookies, with shape translation
  // on the way back.
  const handleGetCookies = async (msg: CdpMessage) => {
    try {
      const r = await t.callTarget("Page.getCookies", {});
      const cookies = Array.isArray(r?.cookies) ? r.cookies.map(wirCookieToCdp) : [];
      t.fireResultToTools(msg.id!, { cookies });
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  };
  t.addMessageFilter("tools::Network.getCookies", handleGetCookies);
  t.addMessageFilter("tools::Network.getAllCookies", handleGetCookies);

  // setCookie: CDP passes flat fields; WIR wants a nested `cookie` object.
  // sameSite is required by iOS 26 WebKit (rejects with "Invalid value for
  // key sameSite" if omitted) — default to "None" matching CDP's behavior
  // for unspecified.
  t.addMessageFilter("tools::Network.setCookie", (msg) => {
    const p = msg.params ?? {};
    msg.method = "Page.setCookie";
    msg.params = {
      cookie: {
        name: p.name,
        value: p.value,
        domain: p.domain ?? "",
        path: p.path ?? "/",
        expires: p.expires ?? -1,
        session: false,
        httpOnly: !!p.httpOnly,
        secure: !!p.secure,
        sameSite: p.sameSite ?? "None",
      },
    };
    return Promise.resolve(msg);
  });

  // setCookies: fan out to N Page.setCookie calls and ack once.
  t.addMessageFilter("tools::Network.setCookies", async (msg) => {
    const list = Array.isArray(msg.params?.cookies) ? msg.params.cookies : [];
    try {
      await Promise.all(
        list.map((cookie: any) => t.callTarget("Page.setCookie", { cookie })),
      );
      t.fireResultToTools(msg.id!, {});
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  });

  // deleteCookies: CDP {name, url?, domain?, path?} -> WIR {cookieName, url}.
  // WebKit's delete path is keyed off scheme+domain+path, and only matches
  // https URLs (see NetworkStorageSessionCurl) — best-effort here.
  t.addMessageFilter("tools::Network.deleteCookies", (msg) => {
    const p = msg.params ?? {};
    const url =
      p.url ??
      `https://${(p.domain ?? "").replace(/^\./, "")}${p.path ?? "/"}`;
    msg.method = "Page.deleteCookie";
    msg.params = { cookieName: p.name, url };
    return Promise.resolve(msg);
  });
  // Older spelling some clients still emit.
  t.addMessageFilter("tools::Network.deleteCookie", (msg) => {
    msg.method = "Page.deleteCookie";
    return Promise.resolve(msg);
  });

  // clearBrowserCookies: no direct WIR equivalent — enumerate then delete.
  t.addMessageFilter("tools::Network.clearBrowserCookies", async (msg) => {
    try {
      const r = await t.callTarget("Page.getCookies", {});
      const cookies = Array.isArray(r?.cookies) ? r.cookies : [];
      await Promise.all(
        cookies.map((c: any) =>
          t.callTarget("Page.deleteCookie", {
            cookieName: c.name,
            url: `${c.secure ? "https" : "http"}://${(c.domain ?? "").replace(/^\./, "")}${c.path ?? "/"}`,
          }).catch(() => {}),
        ),
      );
      t.fireResultToTools(msg.id!, {});
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  });

  // --- Stubs --------------------------------------------------------------
  // Safari has no equivalent or the shape is too divergent to forward.
  t.addMessageFilter("tools::Network.canEmulateNetworkConditions", (msg) =>
    swallowWith(t, msg, { result: false }),
  );
  t.addMessageFilter("tools::Network.setExtraHTTPHeaders", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Network.setBlockedURLs", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Network.emulateNetworkConditions", (msg) =>
    swallowWith(t, msg, {}),
  );
  // No WIR equivalent on iOS 26 (Console.setMonitoringXHREnabled was removed).
  t.addMessageFilter("tools::Network.setMonitoringXHREnabled", (msg) =>
    swallowWith(t, msg, {}),
  );
  // Network.getResponseBody — ask WebKit first (it has the body for most
  // resources still in memory). Only when that fails do we fall back to
  // re-fetching the URL from the bridge process, which is policy-gated and
  // locked down in ../refetch.ts (review #10: the URL is page-chosen).
  //
  // Caveats of the fallback: it is a fresh GET, not a replay. POST bodies
  // aren't recoverable; Cookie/Authorization are only sent same-origin to
  // the page; the server may answer differently than it did the page.
  t.addMessageFilter("tools::Network.getResponseBody", async (msg) => {
    const requestId = msg.params?.requestId;
    let nativeError: string;
    try {
      const r = await t.callTarget("Network.getResponseBody", { requestId }, NATIVE_BODY_TIMEOUT_MS);
      if (typeof r?.body === "string") {
        t.fireResultToTools(msg.id!, { body: r.body, base64Encoded: !!r.base64Encoded });
        return null;
      }
      nativeError = "WebKit returned no body";
    } catch (e: any) {
      nativeError = e?.message ?? String(e);
    }
    const fail = (message: string) => t.fireErrorToTools(msg.id!, { message: `Network.getResponseBody: ${message}` });
    const known = typeof requestId === "string" ? requestUrls.get(requestId) : undefined;
    if (policy === "off") return fail(nativeError), null;
    if (!known) return fail(`${nativeError} (and the request was not observed, so it can't be re-fetched)`), null;
    if (known.method && known.method.toUpperCase() !== "GET") {
      return fail(`${nativeError} (re-fetch is GET-only; can't recover a ${known.method} body)`), null;
    }
    // Empty bodies (preconnects, 204s, 0-byte preloads): nothing to fetch.
    if (known.bytes === 0) {
      t.fireResultToTools(msg.id!, { body: "", base64Encoded: false });
      return null;
    }
    queueRefetch(async () => {
      try {
        const res = await refetch(
          known.url,
          {
            policy,
            headers: known.headers ?? {},
            documentURL: known.documentURL,
            bridgePorts: opts.bridgePorts?.() ?? [],
            timeoutMs: REFETCH_TIMEOUT_MS,
            maxBytes: REFETCH_MAX_BYTES,
            maxRedirects: REFETCH_MAX_REDIRECTS,
          },
          opts.refetchDeps,
        );
        const buf = Buffer.from(res.body.buffer, res.body.byteOffset, res.body.byteLength);
        // Text-shaped MIMEs that round-trip cleanly as UTF-8. Everything else
        // (images, fonts, video, octet-stream, …) goes back as base64.
        const isText = /^(text\/[^;]*|image\/svg\+xml|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded))$/.test(res.mimeType);
        const body = isText ? buf.toString("utf8") : buf.toString("base64");
        t.fireResultToTools(msg.id!, { body, base64Encoded: !isText });
      } catch (e: any) {
        fail(`${nativeError}; re-fetch failed: ${e?.message ?? String(e)}`);
      }
    });
    return null;
  });

  // --- Events (target -> tools) -------------------------------------------
  for (const [evt, map] of Object.entries(EVENT_FIELD_RENAMES)) {
    t.addMessageFilter(`target::${evt}`, (msg) => {
      renameFields(msg.params, map);
      return Promise.resolve(msg);
    });
  }
  // Top up CDP-required defaults so DevTools' Network panel doesn't bail on
  // missing fields, AND transform the inner request/response objects (CDP
  // requires fields WIR doesn't send: initialPriority, referrerPolicy on
  // requests; connectionReused, fromDiskCache, encodedDataLength on
  // responses). Resource type strings: WIR "StyleSheet" → CDP "Stylesheet".
  t.addMessageFilter("target::Network.requestWillBeSent", (msg) => {
    const p = msg.params;
    if (p) {
      Object.assign(p, { ...RWBS_DEFAULTS, ...p });
      p.request = transformRequest(p.request);
      p.type = translateResourceType(p.type);
      // Remember for getResponseBody fallback.
      if (typeof p.requestId === "string" && typeof p.request?.url === "string") {
        if (requestUrls.size >= REQUEST_LIMIT) {
          const k = requestUrls.keys().next().value;
          if (k !== undefined) requestUrls.delete(k);
        }
        requestUrls.set(p.requestId, {
          url: p.request.url,
          method: p.request.method,
          headers: p.request.headers,
          frameId: p.frameId,
          documentURL: typeof p.documentURL === "string" ? p.documentURL : undefined,
          bytes: 0,
        });
      }
    }
    return Promise.resolve(msg);
  });
  t.addMessageFilter("target::Network.responseReceived", (msg) => {
    const p = msg.params;
    if (p) {
      Object.assign(p, { ...RR_DEFAULTS, ...p });
      p.response = transformResponse(p.response);
      p.type = translateResourceType(p.type);
    }
    return Promise.resolve(msg);
  });
  t.addMessageFilter("target::Network.loadingFinished", (msg) => {
    const p = msg.params;
    if (p) {
      const enc = p.metrics?.responseBodyBytesReceived;
      if (typeof enc === "number" && p.encodedDataLength == null) {
        p.encodedDataLength = enc;
      }
      Object.assign(p, { ...LF_DEFAULTS, ...p });
      // Backfill our byte tally from the authoritative metrics. dataReceived
      // events sometimes arrive with dataLength:0 even for non-empty bodies
      // (Safari batches the actual byte count into loadingFinished.metrics).
      if (typeof p.requestId === "string" && typeof enc === "number") {
        const known = requestUrls.get(p.requestId);
        if (known && enc > known.bytes) known.bytes = enc;
      }
    }
    return Promise.resolve(msg);
  });
  // Tally bytes per requestId so getResponseBody can short-circuit empties.
  t.addMessageFilter("target::Network.dataReceived", (msg) => {
    const p = msg.params;
    if (p && typeof p.requestId === "string") {
      const known = requestUrls.get(p.requestId);
      if (known) {
        const n = Number(p.dataLength) || 0;
        known.bytes += n;
      }
    }
    return Promise.resolve(msg);
  });
  // loadingFailed: CDP requires `type` (resource type) and accepts but
  // doesn't require `canceled`/`blockedReason`/`corsErrorStatus`. WIR
  // doesn't send `type` here — fall back to "Other"; the Network panel
  // still renders the failed entry with the right red-bar treatment.
  t.addMessageFilter("target::Network.loadingFailed", (msg) => {
    const p = msg.params;
    if (p) {
      p.type = translateResourceType(p.type);
      if (!("canceled" in p)) p.canceled = false;
    }
    return Promise.resolve(msg);
  });

  // requestServedFromMemoryCache -> requestServedFromCache (CDP name).
  t.addMessageFilter("target::Network.requestServedFromMemoryCache", (msg) => {
    msg.method = "Network.requestServedFromCache";
    if (msg.params) {
      msg.params = { requestId: msg.params.requestId };
    }
    return Promise.resolve(msg);
  });

  // Network.loadNetworkResource: Sources panel "Override file" / "Load
  // resource" feature. Fetches the URL via WIR Network.loadResource and
  // stashes the body in the IO cache so DevTools reads it back through
  // tools::IO.read. The cache is shared with the IO domain via the
  // ioCache argument; without it (e.g. unit tests) we still ack with a
  // failure so the Sources panel doesn't hang.
  t.addMessageFilter("tools::Network.loadNetworkResource", async (msg) => {
    const p = msg.params ?? {};
    if (!ioCache) {
      t.fireResultToTools(msg.id!, {
        resource: { success: false, netError: 1, netErrorName: "ERR_NOT_IMPLEMENTED" },
      });
      return null;
    }
    try {
      // Large source maps over USB can legitimately take a while.
      const r = await t.callTarget(
        "Network.loadResource",
        { frameId: p.frameId, url: p.url },
        60_000,
      );
      const success = !!r?.content && (r?.status ?? 0) >= 200 && (r?.status ?? 0) < 300;
      let stream: string | undefined;
      if (success) {
        // Deterministic handle — keyed off frame+url so a re-request hits
        // the same cache slot. crypto.randomUUID would also work; this is
        // friendlier when debugging the IO read flow.
        stream = `network-resource:${p.frameId ?? ""}:${p.url}`;
        ioCache.set(stream, String(r.content));
      }
      t.fireResultToTools(msg.id!, {
        resource: {
          success,
          stream,
          httpStatusCode: r?.status,
          headers: r?.headers,
          mimeType: r?.mimeType,
        },
      });
    } catch (e: any) {
      t.fireResultToTools(msg.id!, {
        resource: { success: false, netError: 2, netErrorName: e?.message ?? "ERR_FAILED" },
      });
    }
    return null;
  });
}
