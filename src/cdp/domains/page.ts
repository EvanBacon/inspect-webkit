import type { Target } from "../target";
import { swallowWith, type DomainCtx } from "../domain";

// Page domain. Most CDP Page methods either pass straight through to WIR
// (Safari's `Page` domain matches the CDP shape closely) or are pure stubs
// where Safari has no equivalent. We only intervene where the field shape
// differs or where a method needs synthesized state.
export function installPageFilters(t: Target, ctx: DomainCtx) {
  // Aliases that older WebKit builds expected. Harmless to keep — modern
  // Safari accepts `Debugger.setOverlayMessage` and ignores the rest.
  t.addMessageFilter("tools::Page.setOverlayMessage", (msg) => {
    msg.method = "Debugger.setOverlayMessage";
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Page.configureOverlay", (msg) => {
    msg.method = "Debugger.setOverlayMessage";
    return Promise.resolve(msg);
  });

  // Page.getNavigationHistory — WIR has no equivalent. Synthesize a single
  // entry for the current location so the Sources panel's history dropdown
  // doesn't error.
  t.addMessageFilter("tools::Page.getNavigationHistory", async (msg) => {
    try {
      const href = await t.callTarget("Runtime.evaluate", {
        expression: "window.location.href",
      });
      const title = await t.callTarget("Runtime.evaluate", {
        expression: "document.title",
      });
      t.fireResultToTools(msg.id!, {
        currentIndex: 0,
        entries: [
          {
            id: 0,
            url: href.result?.value ?? "",
            userTypedURL: href.result?.value ?? "",
            title: title.result?.value ?? "",
            transitionType: "link",
          },
        ],
      });
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  });

  // Page.disable — WIR accepts it; just pass through. (Older builds erred,
  // but iOS 26 Safari handles it cleanly.) We forward instead of swallow so
  // Safari can release any resources it holds.

  // Page.navigate / Page.reload — pure pass-through. Safari's params shape
  // matches CDP for both (url + transitionType ignored vs. ignoreCache+
  // scriptToEvaluateOnLoad ignored). No filter needed.

  // Schema.getDomains: leave passthrough. Stubbing it caused DevTools to
  // believe we fully implement Network/etc., then call methods we don't
  // translate — which broke unrelated panels.

  // Safari emits Page.frameNavigated with most CDP fields, but DevTools
  // expects `frame.id`, `frame.url`, `frame.securityOrigin`, `frame.mimeType`.
  // Most of those exist; just make sure securityOrigin/mimeType are present.
  t.addMessageFilter("target::Page.frameNavigated", (msg) => {
    fixFrame(msg.params?.frame);
    return Promise.resolve(msg);
  });

  // Page.loadEventFired / Page.domContentEventFired — Safari emits both with
  // a `timestamp` field matching CDP. Pass through; the docs note Safari
  // emits loadEventFired *before* domContentEventFired, but tests should
  // assert on whichever arrives, not the order.

  // Page.getResourceTree — Safari returns a tree but the `frame` shape can
  // be missing fields DevTools relies on for the Sources panel file list.
  t.addMessageFilter("target::Page.getResourceTree", (msg) => {
    fixFrameTree(msg.result?.frameTree);
    return Promise.resolve(msg);
  });

  // Page.getFrameTree (CDP) — WebKit only has Page.getResourceTree, which is
  // a superset (frames + per-frame resources). Translate by calling
  // getResourceTree and stripping `resources`. Puppeteer issues this during
  // every page attach, so without the shim chrome-devtools-mcp can't even
  // open a session against an iOS webview.
  t.addMessageFilter("tools::Page.getFrameTree", async (msg) => {
    if (typeof msg.id !== "number") return null;
    try {
      const r = await t.callTarget("Page.getResourceTree", {});
      const tree = stripResources(r?.frameTree);
      fixFrameTree(tree);
      t.fireResultToTools(msg.id, { frameTree: tree });
    } catch (e: any) {
      t.fireErrorToTools(msg.id, { message: e?.message ?? String(e) });
    }
    return null;
  });

  // Page.createIsolatedWorld (CDP) — Puppeteer creates a per-frame "utility
  // world" so its bookkeeping evaluates can't be observed by page code.
  // WebKit has no equivalent CDP method (it has user worlds via
  // Page.addUserScript, but no synchronous "give me an executionContextId"
  // call). Fall back to the page's main-world contextId — agents lose
  // isolation but every other tool keeps working. Tracked by the Runtime
  // domain via Runtime.executionContextCreated.
  t.addMessageFilter("tools::Page.createIsolatedWorld", (msg) => {
    if (typeof msg.id !== "number") return Promise.resolve(null);
    return swallowWith(t, msg, { executionContextId: ctx.pageExecCtx.id || 1 });
  });

  // Page.addScriptToEvaluateOnNewDocument — WebKit accepts the call but
  // returns identifier:"". Puppeteer treats an empty identifier as a hard
  // failure when it later tries to remove the script. Synthesize a unique
  // identifier; we don't currently honor remove, but Puppeteer only removes
  // on session teardown so this is a non-issue in practice.
  let nextScriptId = 1;
  t.addMessageFilter("tools::Page.addScriptToEvaluateOnNewDocument", (msg) =>
    swallowWith(t, msg, { identifier: `pptr-${nextScriptId++}` }),
  );

  // WebMCP.* — Chrome-internal proprietary domain Puppeteer probes during
  // attach. WebKit doesn't have it; swallow to avoid noisy errors.
  t.addMessageFilter("tools::WebMCP.enable", (msg) => swallowWith(t, msg, {}));
  t.addMessageFilter("tools::WebMCP.disable", (msg) => swallowWith(t, msg, {}));

  // Page.captureScreenshot — Safari does not expose this. Erroring here
  // gives a sharper signal in DevTools than letting the call hang.
  t.addMessageFilter("tools::Page.captureScreenshot", (msg) => {
    t.fireErrorToTools(msg.id!, { message: "Page.captureScreenshot not supported by Safari" });
    return Promise.resolve(null);
  });

  // Page.startScreencast / stopScreencast — Safari ACKs the call but never
  // emits frames on iOS 26 (docs/e2e-verification.md:100). Keep
  // swallow-with-ack so DevTools doesn't error; investigate is upstream-blocked.
  t.addMessageFilter("tools::Page.startScreencast", (msg) => swallowWith(t, msg, {}));
  t.addMessageFilter("tools::Page.stopScreencast", (msg) => swallowWith(t, msg, {}));
  t.addMessageFilter("tools::Page.screencastFrameAck", (msg) => swallowWith(t, msg, {}));

  // Page.setLifecycleEventsEnabled — DevTools sends this on attach in some
  // versions. Safari may not have it; reply success.
  t.addMessageFilter("tools::Page.setLifecycleEventsEnabled", (msg) =>
    swallowWith(t, msg, {}),
  );

  // Synthesize Page.lifecycleEvent (CDP) from WebKit's Page.frameNavigated
  // and Page.loadEventFired/domContentEventFired. Puppeteer's
  // page.goto / page.waitForNavigation block until lifecycle "load" fires;
  // without this synthesis, navigate_page (and any wait-for-nav helper)
  // times out even though the page actually loaded.
  let lastLoaderId = "";
  let lastFrameId = "0.1";
  t.addMessageFilter("target::Page.frameNavigated", (msg) => {
    const f = msg.params?.frame;
    if (f) {
      lastFrameId = f.id ?? lastFrameId;
      lastLoaderId = f.loaderId ?? lastLoaderId;
      // Puppeteer's FrameManager only honors lifecycle events after it has
      // seen Page.frameStartedLoading for the frame (sets
      // frame._hasStartedLoading). WebKit doesn't emit it; synthesize so
      // the subsequent Page.lifecycleEvent("load") actually unblocks
      // page.goto() / waitForNavigation.
      t.fireEventToTools("Page.frameStartedLoading", { frameId: lastFrameId });
      // Emit the "init" / "commit" lifecycle events Puppeteer expects
      // immediately after frameNavigated.
      t.fireEventToTools("Page.lifecycleEvent", {
        frameId: lastFrameId,
        loaderId: lastLoaderId,
        name: "init",
        timestamp: 0,
      });
      t.fireEventToTools("Page.lifecycleEvent", {
        frameId: lastFrameId,
        loaderId: lastLoaderId,
        name: "commit",
        timestamp: 0,
      });
    }
    return Promise.resolve(msg);
  });
  t.addMessageFilter("target::Page.domContentEventFired", (msg) => {
    t.fireEventToTools("Page.lifecycleEvent", {
      frameId: lastFrameId,
      loaderId: lastLoaderId,
      name: "DOMContentLoaded",
      timestamp: msg.params?.timestamp ?? 0,
    });
    return Promise.resolve(msg);
  });
  t.addMessageFilter("target::Page.loadEventFired", (msg) => {
    t.fireEventToTools("Page.lifecycleEvent", {
      frameId: lastFrameId,
      loaderId: lastLoaderId,
      name: "load",
      timestamp: msg.params?.timestamp ?? 0,
    });
    // Networked-resources signals Puppeteer's "networkidle" wait-modes
    // listen for. WebKit doesn't have a direct equivalent — fire them at
    // load, which is correct for static pages and approximate for SPAs.
    t.fireEventToTools("Page.lifecycleEvent", {
      frameId: lastFrameId,
      loaderId: lastLoaderId,
      name: "networkAlmostIdle",
      timestamp: msg.params?.timestamp ?? 0,
    });
    t.fireEventToTools("Page.lifecycleEvent", {
      frameId: lastFrameId,
      loaderId: lastLoaderId,
      name: "networkIdle",
      timestamp: msg.params?.timestamp ?? 0,
    });
    // Pair with the synthetic frameStartedLoading from frameNavigated.
    // Puppeteer uses frameStoppedLoading to clear in-flight nav state.
    t.fireEventToTools("Page.frameStoppedLoading", { frameId: lastFrameId });
    return Promise.resolve(msg);
  });
}

function fixFrame(f: any) {
  if (!f) return;
  if (!f.securityOrigin) {
    try {
      f.securityOrigin = new URL(f.url ?? "").origin;
    } catch {
      f.securityOrigin = "://";
    }
  }
  if (!f.mimeType) f.mimeType = "text/html";
}

function fixFrameTree(node: any) {
  if (!node) return;
  fixFrame(node.frame);
  if (Array.isArray(node.childFrames)) node.childFrames.forEach(fixFrameTree);
}

function stripResources(node: any): any {
  if (!node) return node;
  const out: any = { frame: node.frame };
  if (Array.isArray(node.childFrames)) {
    out.childFrames = node.childFrames.map(stripResources);
  }
  return out;
}
