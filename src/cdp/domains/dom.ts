import type { Target } from "../target";
import { isPlainObject, swallowWith } from "../domain";

let boxModelSeq = 0;

export function installDomFilters(t: Target) {
  // Guards DOM.discardSearchResults against unknown ids (Safari errors loudly).
  const knownSearches = new Set<string>();

  // WIR has no DOM.enable; DOM methods work regardless. Ack so DevTools' probe is clean.
  t.addMessageFilter("tools::DOM.enable", (msg) => swallowWith(t, msg, {}));

  // CDP uses { mode: "searchForNode" | "none" }; WIR uses { enabled: bool }.
  t.addMessageFilter("tools::DOM.setInspectMode", (msg) => {
    msg.method = "DOM.setInspectModeEnabled";
    if (isPlainObject(msg.params)) {
      msg.params.enabled = msg.params.mode === "searchForNode";
      delete msg.params.mode;
      delete msg.params.highlightConfig;
    }
    return Promise.resolve(msg);
  });

  // CDP DOM.setInspectedNode → WIR Console.addInspectedNode.
  t.addMessageFilter("tools::DOM.setInspectedNode", (msg) => {
    msg.method = "Console.addInspectedNode";
    return Promise.resolve(msg);
  });

  // Search ↔ Safari: rename only the case-sensitivity default. Safari
  // accepts the CDP shape verbatim otherwise.
  t.addMessageFilter("tools::DOM.performSearch", (msg) => {
    if (isPlainObject(msg.params))
      msg.params = { query: msg.params.query, caseSensitive: !!msg.params.caseSensitive };
    return Promise.resolve(msg);
  });
  t.addMessageFilter("target::DOM.performSearch", (msg) => {
    const sid = msg.result?.searchId;
    if (typeof sid === "string") knownSearches.add(sid);
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::DOM.discardSearchResults", (msg) => {
    const sid = msg.params?.searchId;
    if (typeof sid === "string") knownSearches.delete(sid);
    return Promise.resolve(msg);
  });

  // Backend-id → frontend nodeId. WIR has the singular form only.
  t.addMessageFilter("tools::DOM.pushNodesByBackendIdsToFrontend", async (msg) => {
    const raw = isPlainObject(msg.params) ? msg.params.backendNodeIds : undefined;
    if (raw !== undefined && !Array.isArray(raw)) {
      t.fireErrorToTools(msg.id!, { code: -32602, message: "backendNodeIds: array expected" });
      return null;
    }
    const ids: number[] = raw ?? [];
    const results = await Promise.all(
      ids.map((id) =>
        t
          .callTarget("DOM.pushNodeByBackendIdToFrontend", { backendNodeId: id })
          .then((r) => r.nodeId)
          // Some WebKit revisions removed the singular form; fall through
          // to echoing the backendNodeId (clients use it as a hint anyway).
          .catch(() => id),
      ),
    );
    t.fireResultToTools(msg.id!, { nodeIds: results });
    return null;
  });

  // CDP getBoxModel → WIR has no equivalent: compute the model in the page
  // from getBoundingClientRect + computed border / padding / margin. Also
  // flashes the node, best-effort.
  t.addMessageFilter("tools::DOM.getBoxModel", async (msg) => {
    const p = isPlainObject(msg.params) ? msg.params : {};
    const nodeId = typeof p.nodeId === "number" ? p.nodeId : typeof p.backendNodeId === "number" ? p.backendNodeId : undefined;
    if (typeof p.objectId !== "string" && nodeId === undefined) {
      t.fireErrorToTools(msg.id!, { code: -32602, message: "DOM.getBoxModel: nodeId, backendNodeId or objectId is required" });
      return null;
    }
    if (nodeId !== undefined) {
      t.callTarget("DOM.highlightNode", { highlightConfig: BOX_HIGHLIGHT, nodeId }).catch(() => {});
    }
    // One object group per call: concurrent calls must not release each
    // other's handles.
    const group = typeof p.objectId === "string" ? null : `inspect-webkit-boxmodel-${++boxModelSeq}`;
    try {
      const objectId: string =
        group === null
          ? p.objectId
          : (await t.callTarget("DOM.resolveNode", { nodeId, objectGroup: group }))?.object?.objectId;
      if (typeof objectId !== "string") throw new Error("could not resolve the node");
      const r = await t.callTarget("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: BOX_MODEL_FN,
        returnByValue: true,
      });
      const model = r?.result?.value;
      if (r?.wasThrown || !isPlainObject(model)) throw new Error("Could not compute box model.");
      t.fireResultToTools(msg.id!, { model });
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    } finally {
      if (group !== null) t.callTarget("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
    return null;
  });

  // CDP getNodeForLocation → elementFromPoint + DOM.requestNode.
  t.addMessageFilter("tools::DOM.getNodeForLocation", async (msg) => {
    const x = msg.params?.x;
    const y = msg.params?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      t.fireErrorToTools(msg.id!, { code: -32602, message: "DOM.getNodeForLocation: x and y must be numbers" });
      return null;
    }
    try {
      const eval1 = await t.callTarget("Runtime.evaluate", {
        expression: `document.elementFromPoint(${x},${y})`,
      });
      const objectId = eval1.result?.objectId;
      if (!objectId) {
        t.fireResultToTools(msg.id!, { nodeId: 0 });
        return null;
      }
      const node = await t.callTarget("DOM.requestNode", { objectId });
      t.fireResultToTools(msg.id!, { nodeId: node.nodeId, backendNodeId: node.nodeId });
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  });

  // CDP DOM.resolveNode returns { object: RemoteObject }; WIR matches but
  // some Safari versions reject objectGroup=undefined. Drop it if absent.
  t.addMessageFilter("tools::DOM.resolveNode", (msg) => {
    if (isPlainObject(msg.params) && msg.params.objectGroup === undefined) delete msg.params.objectGroup;
    return Promise.resolve(msg);
  });
}

const BOX_HIGHLIGHT = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

/** CDP BoxModel for `this` (an Element or a Text node), quads in viewport
 *  CSS pixels of the node's own frame. Throws, like Chrome, for nodes that
 *  aren't rendered. */
const BOX_MODEL_FN = `function () {
  var el = this.nodeType === 3 ? null : this;
  var rects, r;
  if (el) { rects = el.getClientRects(); r = el.getBoundingClientRect(); }
  else { var range = document.createRange(); range.selectNodeContents(this); rects = range.getClientRects(); r = range.getBoundingClientRect(); }
  if (!rects || rects.length === 0) throw new Error("Could not compute box model.");
  var s = el ? getComputedStyle(el) : null;
  function n(p) { return s ? parseFloat(s[p]) || 0 : 0; }
  function q(x, y, w, h) { return [x, y, x + w, y, x + w, y + h, x, y + h]; }
  var bl = n("borderLeftWidth"), bt = n("borderTopWidth"), br = n("borderRightWidth"), bb = n("borderBottomWidth");
  var pl = n("paddingLeft"), pt = n("paddingTop"), pr = n("paddingRight"), pb = n("paddingBottom");
  var ml = n("marginLeft"), mt = n("marginTop"), mr = n("marginRight"), mb = n("marginBottom");
  return {
    border: q(r.left, r.top, r.width, r.height),
    padding: q(r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb),
    content: q(r.left + bl + pl, r.top + bt + pt, r.width - bl - br - pl - pr, r.height - bt - bb - pt - pb),
    margin: q(r.left - ml, r.top - mt, r.width + ml + mr, r.height + mt + mb),
    width: Math.round(r.width),
    height: Math.round(r.height)
  };
}`;
