import type { Target } from "../target";
import { swallowWith } from "../domain";

export function installDomDebuggerFilters(t: Target) {
  // CDP DOMDebugger.getEventListeners(objectId) → WIR
  // DOM.getEventListenersForNode(nodeId). WIR returns
  // { listeners: [{ type, useCapture, isAttribute, location, handler, ... }] }
  // so map handler shape and drop fields CDP doesn't define.
  t.addMessageFilter("tools::DOMDebugger.getEventListeners", async (msg) => {
    try {
      const node = await t.callTarget("DOM.requestNode", {
        objectId: msg.params?.objectId,
      });
      const r = await t.callTarget("DOM.getEventListenersForNode", {
        nodeId: node.nodeId,
        objectGroup: "event-listeners-panel",
      });
      const listeners = (r.listeners ?? []).map((l: any) => ({
        type: l.type,
        useCapture: !!l.useCapture,
        passive: !!l.passive, // iOS <16.4 doesn't expose this; default false.
        once: !!l.once,
        location: l.location,
        handler: l.handler,
      }));
      t.fireResultToTools(msg.id!, { listeners });
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  });

  // XHR + event-listener breakpoints. WebKit historically translated these
  // to DOM.set{URL,Event}Breakpoint, but iOS 26 removed that surface
  // (verified live: "method not found"). DevTools doesn't depend on the
  // result of setting a breakpoint here; swallow so the UI doesn't
  // surface a failure every time the user toggles a category in the
  // Sources panel.
  t.addMessageFilter("tools::DOMDebugger.setXHRBreakpoint", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::DOMDebugger.removeXHRBreakpoint", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::DOMDebugger.setEventListenerBreakpoint", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::DOMDebugger.removeEventListenerBreakpoint", (msg) =>
    swallowWith(t, msg, {}),
  );
}
