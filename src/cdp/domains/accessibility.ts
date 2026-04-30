import type { Target } from "../target";
import { swallowWith } from "../domain";

// CDP `Accessibility` ↔ WIR. WIR exposes accessibility through the DOM
// domain (`DOM.getAccessibilityPropertiesForNode`), not a top-level
// Accessibility domain. enable/disable are no-ops on the WIR side.
//
// `getPartialAXTree` is the only method DevTools' Elements panel actually
// calls today. We forward to DOM.getAccessibilityPropertiesForNode and
// translate the response into the AXNode shape DevTools expects. The full
// fidelity translation (childIds, ignoredReasons, role/name AXValue typing)
// is large; we return a minimal node so the panel renders rather than
// erroring out. Phase 2 can flesh out the property mapping.

export function installAccessibilityFilters(t: Target) {
  t.addMessageFilter("tools::Accessibility.enable", (msg) => swallowWith(t, msg, {}));
  t.addMessageFilter("tools::Accessibility.disable", (msg) => swallowWith(t, msg, {}));

  t.addMessageFilter("tools::Accessibility.getPartialAXTree", async (msg) => {
    const params = msg.params ?? {};
    const nodeId = params.nodeId ?? params.backendNodeId;
    if (typeof nodeId !== "number") {
      t.fireResultToTools(msg.id!, { nodes: [] });
      return null;
    }
    try {
      const r = await t.callTarget("DOM.getAccessibilityPropertiesForNode", {
        nodeId,
      });
      const props = r?.properties ?? {};
      const axNode = {
        nodeId: String(nodeId),
        ignored: Boolean(props.ignored),
        role: props.role
          ? { type: "role", value: String(props.role) }
          : undefined,
        name: props.label
          ? { type: "computedString", value: String(props.label) }
          : undefined,
        backendDOMNodeId: nodeId,
        childIds: [],
        properties: [],
      };
      t.fireResultToTools(msg.id!, { nodes: [axNode] });
    } catch (e: any) {
      // Soft-fail: return an empty tree so the panel doesn't throw.
      t.fireResultToTools(msg.id!, { nodes: [] });
    }
    return null;
  });
}
