import type { Target } from "../target";

// WIR fires `Inspector.inspect` with a RemoteObject when the user clicks an
// element while inspect mode is enabled. CDP's equivalent is
// `Overlay.inspectNodeRequested` — that's the event the frontend's
// OverlayModel listens for to exit inspect mode and reveal the node in
// Elements. Its `backendNodeId` must be an integer node id, not the
// RemoteObject's stringy `objectId`, so we resolve via `DOM.requestNode`.
// We also fire `DOM.inspectNodeRequested` for compatibility with frontends
// that listen on the DOM channel.
export function installInspectorFilters(t: Target) {
  t.addMessageFilter("target::Inspector.inspect", async (msg) => {
    const objectId = msg.params?.object?.objectId;
    if (typeof objectId !== "string") return null;
    try {
      const node = await t.callTarget("DOM.requestNode", { objectId });
      const nodeId = node?.nodeId;
      if (typeof nodeId === "number") {
        t.fireEventToTools("Overlay.inspectNodeRequested", { backendNodeId: nodeId });
        t.fireEventToTools("DOM.inspectNodeRequested", { backendNodeId: nodeId });
      }
    } catch {
      // If resolution fails, swallow — emitting a bogus event would leave
      // the toggle stuck on, same as the bug we're fixing.
    }
    return null;
  });
}
