#!/usr/bin/env bun
// Domain-survey probe. Walks every CDP domain we claim to support, sends one
// canonical method, prints OK/ERR/TO with a one-line snippet. Use this as a
// regression check after touching translation filters in src/cdp/.
//
// Usage: bun scripts/e2e/cdp-domains.ts <wsUrl>

const wsUrl = process.argv[2];
if (!wsUrl) {
  console.error("usage: bun scripts/e2e/cdp-domains.ts <wsUrl>");
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map<number, (v: any) => void>();
const events: any[] = [];

function send(method: string, params: any = {}, timeoutMs = 1500): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, timeoutMs);
  });
}

ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
  } else {
    events.push(m);
  }
};

const probes: Array<[string, any?]> = [
  ["Runtime.enable"],
  ["Debugger.enable"],
  ["Page.enable"],
  ["DOM.enable"],
  ["CSS.enable"],
  ["Network.enable"],
  ["Log.enable"],
  ["Console.enable"],
  ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
  ["Page.getResourceTree"],
  ["Page.getNavigationHistory"],
  ["DOM.getDocument", { depth: 1 }],
  ["Network.getCookies"],
  ["Network.getAllCookies"],
  ["Network.setCacheDisabled", { cacheDisabled: true }],
  ["Network.setUserAgentOverride", { userAgent: "inspect-webkit-probe/1" }],
  ["Network.setExtraHTTPHeaders", { headers: { "x-probe": "1" } }],
  ["Network.setBlockedURLs", { urls: [] }],
  ["Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  }],
  ["Network.canEmulateNetworkConditions"],
  ["Network.setMonitoringXHREnabled", { enabled: true }],
  ["Network.setCookie", {
    name: "sdtprobe", value: "1", domain: "example.com", path: "/",
  }],
  ["Network.deleteCookies", { name: "sdtprobe", domain: "example.com", path: "/" }],
  ["Network.clearBrowserCookies"],
  // Safari does not expose response bodies on the forward socket; the
  // bridge replies with an explicit error rather than hanging. Leave as a
  // TODO row in the L3 baseline.
  ["Network.getResponseBody", { requestId: "0" }],
  ["Page.captureScreenshot"],
  ["Page.startScreencast", { format: "png", quality: 50 }],
  ["Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  }],
  // CSS probes resolved against a real nodeId at run time (placeholder
  // resolved in the probe loop below). styleSheetId "0" is intentionally
  // bogus — the row exercises the bridge's error path, not real edits.
  ["CSS.getMatchedStylesForNode", { nodeId: "$rootNodeId" }],
  ["CSS.getInlineStylesForNode", { nodeId: "$rootNodeId" }],
  ["CSS.setStyleTexts", { edits: [] }],
  ["CSS.addRule", {
    styleSheetId: "0", ruleText: ".dummy {}",
    location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
  }],
  ["DOM.performSearch", { query: "body" }],
  ["DOMDebugger.setEventListenerBreakpoint", { eventName: "click" }],
  ["DOMDebugger.removeEventListenerBreakpoint", { eventName: "click" }],
  ["DOMDebugger.setXHRBreakpoint", { url: "" }],
  ["DOMDebugger.removeXHRBreakpoint", { url: "" }],
  ["Runtime.setAsyncCallStackDepth", { maxDepth: 32 }],
  ["Runtime.releaseObjectGroup", { objectGroup: "console" }],
  ["Debugger.setAsyncCallStackDepth", { maxDepth: 32 }],
  ["Debugger.setSkipAllPauses", { skip: false }],
  ["Debugger.setBreakpointByUrl", { lineNumber: 0, url: "about:blank" }],
  ["Overlay.enable"],
  ["Overlay.setShowPaintRects", { result: false }],
  ["Overlay.hideHighlight"],
  ["Overlay.setInspectMode", { mode: "none", highlightConfig: {} }],
  ["Emulation.clearDeviceMetricsOverride"],
  ["Browser.getVersion"],
  ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0, button: "none" }],
  ["IO.read", { handle: "no-such-handle" }],
  ["IO.close", { handle: "no-such-handle" }],
  ["Accessibility.enable"],
  ["Accessibility.getPartialAXTree", { backendNodeId: 1 }],
  ["Emulation.setUserAgentOverride", { userAgent: "inspect-webkit-probe/2" }],
  ["Network.loadNetworkResource", {
    frameId: "0.1", url: "https://example.com/",
    options: { disableCache: false, includeCredentials: false },
  }],
];

ws.onopen = async () => {
  // Resolve a live document so CSS-by-nodeId probes target a real node
  // instead of a guessed nodeId. We must DOM.enable + DOM.getDocument
  // before the survey loop reads back $rootNodeId.
  let rootNodeId: number | undefined;
  try {
    await send("DOM.enable");
    const d = await send("DOM.getDocument", { depth: 1 });
    rootNodeId = d.result?.root?.nodeId;
  } catch {}

  const subst = (v: any): any => {
    if (v === "$rootNodeId") return rootNodeId ?? 1;
    if (Array.isArray(v)) return v.map(subst);
    if (v && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v)) o[k] = subst(v[k]);
      return o;
    }
    return v;
  };

  for (const [m, p] of probes) {
    const params = p ? subst(p) : {};
    try {
      const r = await send(m, params);
      const ok = !r.error;
      const label = ok ? "OK " : "ERR";
      const detail = ok
        ? JSON.stringify(r.result ?? {}).slice(0, 80)
        : `${r.error.code}: ${r.error.message}`;
      console.log(`${label}  ${m.padEnd(40)} ${detail}`);
    } catch (e) {
      console.log(`TO   ${m.padEnd(40)} ${(e as Error).message}`);
    }
  }
  console.log(`\nspontaneous events: ${events.length}`);
  const types = new Map<string, number>();
  for (const e of events) types.set(e.method, (types.get(e.method) ?? 0) + 1);
  for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(4)} ${k}`);
  }
  process.exit(0);
};
