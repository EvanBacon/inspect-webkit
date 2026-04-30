import type { Target } from "../target";
import { swallowWith } from "../domain";

// Overlay domain. CDP's Overlay maps to WIR's `DOM.highlight*` family, plus
// `Page.setShowPaintRects`. DevTools' Elements panel uses these for hover
// highlights and the "select element" inspector mode.
//
// Most filters are pure renames. Param reshape is only needed for
// highlightNode (drop CDP-only fields) and setInspectMode (CDP `mode`
// string → WIR `enabled` boolean).
export function installOverlayFilters(t: Target) {
  // Overlay.enable / disable — WIR has no Overlay domain at all. Swallow
  // with ack so DevTools' Elements panel can attach without errors.
  t.addMessageFilter("tools::Overlay.enable", (msg) => swallowWith(t, msg, {}));
  t.addMessageFilter("tools::Overlay.disable", (msg) => swallowWith(t, msg, {}));

  // Overlay.highlightNode → DOM.highlightNode. CDP and WIR shapes mostly
  // overlap; pass highlightConfig + nodeId/objectId through and drop the
  // rest (selector, etc.) which WIR doesn't accept.
  t.addMessageFilter("tools::Overlay.highlightNode", (msg) => {
    const p = msg.params ?? {};
    msg.method = "DOM.highlightNode";
    msg.params = {
      highlightConfig: p.highlightConfig,
      nodeId: p.nodeId,
      objectId: p.objectId,
    };
    return Promise.resolve(msg);
  });

  // Overlay.highlightFrame → DOM.highlightFrame. Same param shape
  // (frameId + content/contentOutline colors).
  t.addMessageFilter("tools::Overlay.highlightFrame", (msg) => {
    msg.method = "DOM.highlightFrame";
    return Promise.resolve(msg);
  });

  // Overlay.highlightQuad → DOM.highlightQuad.
  t.addMessageFilter("tools::Overlay.highlightQuad", (msg) => {
    msg.method = "DOM.highlightQuad";
    return Promise.resolve(msg);
  });

  // Overlay.highlightRect → DOM.highlightRect.
  t.addMessageFilter("tools::Overlay.highlightRect", (msg) => {
    msg.method = "DOM.highlightRect";
    return Promise.resolve(msg);
  });

  // Overlay.hideHighlight → DOM.hideHighlight. No params either way.
  t.addMessageFilter("tools::Overlay.hideHighlight", (msg) => {
    msg.method = "DOM.hideHighlight";
    return Promise.resolve(msg);
  });

  // Overlay.setShowPaintRects → Page.setShowPaintRects. WIR and CDP both
  // take `{ result: boolean }` — wait, CDP uses `result`, WIR uses `result`
  // too. Pure rename.
  t.addMessageFilter("tools::Overlay.setShowPaintRects", (msg) => {
    msg.method = "Page.setShowPaintRects";
    return Promise.resolve(msg);
  });

  // Overlay.setInspectMode → DOM.setInspectModeEnabled. CDP sends a `mode`
  // enum ("searchForNode" | "searchForUAShadowDOM" | "captureAreaScreenshot"
  // | "showDistances" | "none"); WIR wants a boolean `enabled`. Treat any
  // mode that isn't "none" as enabled — searchForNode is the only one
  // DevTools sends in practice.
  t.addMessageFilter("tools::Overlay.setInspectMode", (msg) => {
    const p = msg.params ?? {};
    msg.method = "DOM.setInspectModeEnabled";
    msg.params = {
      enabled: typeof p.mode === "string" && p.mode !== "none",
      highlightConfig: p.highlightConfig,
    };
    return Promise.resolve(msg);
  });

  // Note: Overlay.inspectNodeRequested / nodeHighlightRequested events are
  // already covered by inspector.ts which translates target::Inspector.inspect
  // → DOM.inspectNodeRequested. DevTools listens on either channel.
}
