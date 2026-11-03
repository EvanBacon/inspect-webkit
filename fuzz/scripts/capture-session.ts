#!/usr/bin/env bun
// Drive a real bridge + simulator through a DevTools-like session with
// INSPECT_WEBKIT_CAPTURE on, to collect a fuzz seed corpus.
//
//   bun fuzz/scripts/capture-session.ts <captureDir> [--port 9350] [--sim <udid>] [--kill]
//
// Exercises: page attach (two clients), the browser endpoint, Runtime
// evaluate / getProperties / callFunctionOn / console / exceptions,
// DOM + CSS reads and edits, Network (fetch + getResponseBody), Debugger
// (breakpoints, a `debugger;` pause, stepping), Page.navigate cross-origin,
// Page.reload, and with --kill a Safari terminate while attached.

import { $ } from "bun";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) {
  console.error("usage: capture-session.ts <captureDir> [--port N] [--sim UDID] [--kill]");
  process.exit(2);
}
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : dflt;
};
const PORT = Number(opt("--port", "9350"));
const SIM = opt("--sim", "2DD68D49-7354-48AC-A4AF-C6B4462BF6B7");
const KILL = args.includes("--kill");
const base = `http://127.0.0.1:${PORT}`;
const repo = new URL("../..", import.meta.url).pathname;

const bridge = Bun.spawn(["bun", "bin/cli.ts", "--port", String(PORT)], {
  cwd: repo,
  env: { ...process.env, INSPECT_WEBKIT_CAPTURE: dir },
  stdout: "ignore",
  stderr: "pipe",
});
process.on("exit", () => bridge.kill());

async function safariPage(): Promise<any> {
  for (let i = 0; i < 200; i++) {
    try {
      const list = (await (await fetch(`${base}/json/list`)).json()) as any[];
      const p = list.find((t) => /^https?:/.test(t.url) && t.type === "page");
      if (p) return p;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("no Safari page");
}

type Client = {
  ws: WebSocket;
  send(method: string, params?: any, sessionId?: string, timeoutMs?: number): Promise<any>;
  events: any[];
  waitEvent(method: string, timeoutMs?: number): Promise<any>;
};

function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map<number, (v: any) => void>();
  const events: any[] = [];
  const waiters: Array<{ method: string; resolve: (v: any) => void }> = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
      return;
    }
    events.push(m);
    for (const w of [...waiters]) {
      if (w.method === m.method) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };
  const c: Client = {
    ws,
    events,
    send(method, params = {}, sessionId, timeoutMs = 3000) {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => {
          if (pending.delete(id)) resolve({ id, timeout: true });
        }, timeoutMs);
      });
    },
    waitEvent(method, timeoutMs = 3000) {
      return new Promise((resolve) => {
        const w = { method, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1), resolve(null);
        }, timeoutMs);
      });
    },
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error(`ws error ${url}`));
  });
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function devtoolsAttach(c: Client) {
  // Roughly what Chrome DevTools sends on attach.
  for (const [m, p] of [
    ["Network.enable", { maxPostDataSize: 65536 }],
    ["Page.enable"],
    ["Page.getResourceTree"],
    ["Runtime.enable"],
    ["Debugger.enable", { maxScriptsCacheSize: 10000000 }],
    ["Debugger.setPauseOnExceptions", { state: "none" }],
    ["Debugger.setAsyncCallStackDepth", { maxDepth: 32 }],
    ["DOM.enable"],
    ["CSS.enable"],
    ["Overlay.enable"],
    ["Overlay.setShowViewportSizeOnResize", { show: true }],
    ["Log.enable"],
    ["Log.startViolationsReport", { config: [{ name: "longTask", threshold: 200 }] }],
    ["Emulation.setEmulatedMedia", { media: "", features: [] }],
    ["Emulation.setFocusEmulationEnabled", { enabled: false }],
    ["Page.setAdBlockingEnabled", { enabled: false }],
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
    ["Runtime.runIfWaitingForDebugger"],
    ["Inspector.enable"],
    ["Accessibility.enable"],
  ] as Array<[string, any?]>) {
    await c.send(m, p ?? {});
  }
}

async function runtimeWork(c: Client) {
  await c.send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
  await c.send("Runtime.evaluate", { expression: "document.title", includeCommandLineAPI: true });
  await c.send("Runtime.evaluate", { expression: "console.log('cap', {a:1,b:[1,2]}, 2n ** 70n); console.warn('w'); console.error(new Error('e')); console.table([{x:1}])" });
  await c.send("Runtime.evaluate", { expression: "throw new TypeError('boom')" });
  await c.send("Runtime.evaluate", { expression: "Promise.reject(new Error('rej'))", awaitPromise: true });
  await c.send("Runtime.evaluate", { expression: "new Promise(r => setTimeout(() => r(42), 10))", awaitPromise: true, returnByValue: true });
  await c.send("Runtime.evaluate", { expression: "'x'.repeat(100000)", returnByValue: true });
  await c.send("Runtime.evaluate", { expression: "setTimeout(() => { undefinedFn() }, 0)" });
  const obj = await c.send("Runtime.evaluate", { expression: "({n:1, s:'s', a:[1,{}], f(){}, d:new Date(0), m:new Map([[1,2]]), sym:Symbol('q')})", objectGroup: "console", generatePreview: true });
  const objectId = obj.result?.result?.objectId;
  if (objectId) {
    await c.send("Runtime.getProperties", { objectId, ownProperties: true, generatePreview: true });
    await c.send("Runtime.getProperties", { objectId, accessorPropertiesOnly: true });
    await c.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){ return Object.keys(this) }", returnByValue: true });
    await c.send("Runtime.releaseObject", { objectId });
  }
  await c.send("Runtime.compileScript", { expression: "let q = 1", sourceURL: "", persistScript: false });
  await c.send("Runtime.globalLexicalScopeNames", {});
  await c.send("Runtime.releaseObjectGroup", { objectGroup: "console" });
  await c.send("Runtime.evaluate", { expression: "for (let i=0;i<5;i++) console.log('repeat')" });
  await c.send("Console.clearMessages", {});
}

async function domCssWork(c: Client) {
  const doc = await c.send("DOM.getDocument", { depth: -1, pierce: true });
  const root = doc.result?.root?.nodeId ?? 1;
  const q = await c.send("DOM.querySelector", { nodeId: root, selector: "h1" });
  const h1 = q.result?.nodeId;
  await c.send("DOM.querySelectorAll", { nodeId: root, selector: "p, a" });
  await c.send("DOM.requestChildNodes", { nodeId: root, depth: 2 });
  if (h1) {
    await c.send("DOM.getOuterHTML", { nodeId: h1 });
    await c.send("DOM.getBoxModel", { nodeId: h1 });
    await c.send("DOM.describeNode", { nodeId: h1 });
    await c.send("DOM.setAttributeValue", { nodeId: h1, name: "data-cap", value: "1" });
    await c.send("DOM.setAttributesAsText", { nodeId: h1, text: 'title="t" data-x="y"' });
    await c.send("DOM.removeAttribute", { nodeId: h1, name: "data-x" });
    await c.send("DOM.resolveNode", { nodeId: h1, objectGroup: "dom" });
    await c.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [h1] });
    await c.send("Overlay.highlightNode", { nodeId: h1, highlightConfig: { showInfo: true, contentColor: { r: 1, g: 2, b: 3, a: 0.5 } } });
    await c.send("Overlay.hideHighlight", {});
    await c.send("DOM.setInspectedNode", { nodeId: h1 });
    await c.send("CSS.getMatchedStylesForNode", { nodeId: h1 });
    await c.send("CSS.getComputedStyleForNode", { nodeId: h1 });
    const inl = await c.send("CSS.getInlineStylesForNode", { nodeId: h1 });
    await c.send("CSS.getPlatformFontsForNode", { nodeId: h1 });
    await c.send("CSS.forcePseudoState", { nodeId: h1, forcedPseudoClasses: ["hover"] });
    const sid = inl.result?.inlineStyle?.styleSheetId;
    if (sid) {
      await c.send("CSS.setStyleTexts", { edits: [{ styleSheetId: sid, range: inl.result.inlineStyle.range ?? { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, text: "color: red;" }] });
    }
    await c.send("DOM.setNodeValue", { nodeId: h1, value: "x" });
    await c.send("DOM.getAttributes", { nodeId: h1 });
  }
  const sheet = await c.send("CSS.createStyleSheet", { frameId: "" });
  await c.send("CSS.getStyleSheetText", { styleSheetId: sheet.result?.styleSheetId ?? "0" });
  await c.send("CSS.addRule", { styleSheetId: sheet.result?.styleSheetId ?? "0", ruleText: "h1 { outline: 1px solid red }", location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 } });
  await c.send("CSS.getMediaQueries", {});
  await c.send("CSS.trackComputedStyleUpdates", { propertiesToTrack: [] });
  const s = await c.send("DOM.performSearch", { query: "h1", includeUserAgentShadowDOM: false });
  if (s.result?.searchId) {
    await c.send("DOM.getSearchResults", { searchId: s.result.searchId, fromIndex: 0, toIndex: s.result.resultCount ?? 1 });
    await c.send("DOM.discardSearchResults", { searchId: s.result.searchId });
  }
  await c.send("DOM.setInspectMode", { mode: "searchForNode", highlightConfig: {} });
  await c.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
  await c.send("Accessibility.getPartialAXTree", { nodeId: h1 ?? root, fetchRelatives: true });
  await c.send("DOMDebugger.getEventListeners", { objectId: "x" });
  await c.send("DOMDebugger.setDOMBreakpoint", { nodeId: h1 ?? root, type: "subtree-modified" });
  await c.send("DOMDebugger.removeDOMBreakpoint", { nodeId: h1 ?? root, type: "subtree-modified" });
  await c.send("DOM.undo", {});
}

async function networkWork(c: Client) {
  const ev = c.waitEvent("Network.loadingFinished", 5000);
  await c.send("Runtime.evaluate", { expression: "fetch(location.href + '?cap=' + Date.now(), {headers:{'x-cap':'1'}}).then(r => r.text()).then(t => t.length)", awaitPromise: true, returnByValue: true }, undefined, 8000);
  const fin = await ev;
  const rid = fin?.params?.requestId;
  if (rid) await c.send("Network.getResponseBody", { requestId: rid }, undefined, 8000);
  await c.send("Network.getCookies", { urls: ["https://example.com/"] });
  await c.send("Network.setCacheDisabled", { cacheDisabled: true });
  await c.send("Network.setExtraHTTPHeaders", { headers: { "x-cap": "2" } });
  await c.send("Network.setUserAgentOverride", { userAgent: "cap/1" });
  await c.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await c.send("Network.setBlockedURLs", { urls: ["*.png"] });
  await c.send("Network.clearBrowserCache", {});
  await c.send("Network.loadNetworkResource", { frameId: "", url: "https://example.com/", options: { disableCache: false, includeCredentials: false } }, undefined, 8000);
}

async function debuggerWork(c: Client) {
  await c.send("Debugger.setBreakpointByUrl", { lineNumber: 0, urlRegex: "cap-bp\\.js", columnNumber: 0, condition: "" });
  const bp = await c.send("Debugger.setBreakpointByUrl", { lineNumber: 1, url: "https://example.com/cap.js" });
  await c.send("Debugger.setPauseOnExceptions", { state: "uncaught" });
  await c.send("Debugger.setBreakpointsActive", { active: true });
  const paused = c.waitEvent("Debugger.paused", 4000);
  await c.send("Runtime.evaluate", { expression: "setTimeout(function capPause(){ var a = 1; debugger; a++; return a }, 0)" });
  const p = await paused;
  if (p) {
    const frame = p.params?.callFrames?.[0];
    if (frame) {
      await c.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: "a", returnByValue: true });
      for (const sc of frame.scopeChain ?? []) {
        if (sc.object?.objectId) await c.send("Runtime.getProperties", { objectId: sc.object.objectId, ownProperties: false });
      }
      await c.send("Debugger.getScriptSource", { scriptId: frame.location?.scriptId ?? "0" });
      await c.send("Debugger.getPossibleBreakpoints", { start: frame.location, restrictToFunction: false });
    }
    await c.send("Debugger.stepOver", {});
    await c.waitEvent("Debugger.paused", 2000);
    await c.send("Debugger.stepInto", {});
    await c.waitEvent("Debugger.paused", 2000);
    await c.send("Debugger.resume", {});
  }
  if (bp.result?.breakpointId) await c.send("Debugger.removeBreakpoint", { breakpointId: bp.result.breakpointId });
  await c.send("Debugger.setPauseOnExceptions", { state: "none" });
  await c.send("Debugger.setSkipAllPauses", { skip: false });
  await c.send("Debugger.searchInContent", { scriptId: "1", query: "a" });
}

async function main() {
  log(`bridge on ${PORT}, capturing to ${dir}`);
  await $`xcrun simctl openurl ${SIM} https://example.com/`.quiet().nothrow();
  let page = await safariPage();
  const a = await connect(page.webSocketDebuggerUrl);
  await devtoolsAttach(a);
  log("attached A");
  await runtimeWork(a);
  log("runtime done");
  await domCssWork(a);
  log("dom/css done");
  await networkWork(a);
  log("network done");
  await debuggerWork(a);
  log("debugger done");

  // Second client on the same page (PageChannel sharing) + browser endpoint.
  const b = await connect(page.webSocketDebuggerUrl);
  await b.send("Runtime.enable");
  await b.send("Debugger.enable");
  await b.send("Runtime.evaluate", { expression: "console.log('from B')" });
  const ver = (await (await fetch(`${base}/json/version`)).json()) as any;
  const br = await connect(ver.webSocketDebuggerUrl);
  await br.send("Target.setDiscoverTargets", { discover: true });
  await br.send("Target.getTargets");
  await br.send("Browser.getVersion");
  const att = await br.send("Target.attachToTarget", { targetId: page.id, flatten: true });
  const sid = att.result?.sessionId;
  if (sid) {
    await br.send("Runtime.enable", {}, sid);
    await br.send("Runtime.evaluate", { expression: "location.href" }, sid);
    await br.send("Target.detachFromTarget", { sessionId: sid });
  }
  await br.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await Bun.sleep(300);
  br.ws.close();
  log("multi-client done");

  // Navigation: cross-origin via Page.navigate, back, then reload.
  await a.send("Page.navigate", { url: "https://www.iana.org/help/example-domains" }, undefined, 8000);
  await a.waitEvent("Page.loadEventFired", 8000);
  await Bun.sleep(500);
  await a.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
  await domCssWork(a);
  await a.send("Page.getNavigationHistory");
  await a.send("Page.navigate", { url: "https://example.com/" }, undefined, 8000);
  await a.waitEvent("Page.loadEventFired", 8000);
  await a.send("Page.reload", { ignoreCache: true });
  await a.waitEvent("Page.loadEventFired", 8000);
  await Bun.sleep(500);
  await runtimeWork(a);
  log("navigation done");
  await b.send("Runtime.disable");
  b.ws.close();

  if (KILL) {
    const closed = new Promise((r) => (a.ws.onclose = r));
    await $`xcrun simctl terminate ${SIM} com.apple.mobilesafari`.quiet().nothrow();
    await Promise.race([closed, Bun.sleep(8000)]);
    log("safari killed");
    await $`xcrun simctl openurl ${SIM} https://example.com/`.quiet().nothrow();
    page = await safariPage();
    const c = await connect(page.webSocketDebuggerUrl);
    await devtoolsAttach(c);
    await c.send("Runtime.evaluate", { expression: "navigator.userAgent" });
    c.ws.close();
    log("relaunch attach done");
  } else {
    a.ws.close();
  }
  await Bun.sleep(300);
}

try {
  await main();
} finally {
  bridge.kill();
  await bridge.exited;
}
log("done");
process.exit(0);
