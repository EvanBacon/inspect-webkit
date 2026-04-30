import type { Target } from "../target";

// CDP `Input` ↔ WIR. WIR's Input surface is thin and version-dependent
// (`Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` exist in some
// JSCore protocol revisions, but not all). Rather than guess at WIR shape,
// translate Input.dispatchMouseEvent / Input.emulateTouchFromMouseEvent into
// a synthesized `MouseEvent` dispatched via `Runtime.evaluate`. This is what
// every other CDP↔WIR adapter has historically done; it has the nice
// property of working on every iOS Safari version we care about.
//
// Coverage: dispatchMouseEvent (mousePressed/mouseReleased/mouseMoved) and
// emulateTouchFromMouseEvent share one path. Key events / setIgnoreInputEvents
// are not implemented — wire them up only if a panel actually needs them.

const SIMULATE_FN = `
function __sd_simulate(p){
  var el = document.elementFromPoint(p.x, p.y);
  if (!el) return false;
  var ev = new MouseEvent(p.type, {
    screenX: p.x, screenY: p.y, clientX: p.x, clientY: p.y,
    ctrlKey:  (p.modifiers & 2) === 2,
    altKey:   (p.modifiers & 1) === 1,
    shiftKey: (p.modifiers & 8) === 8,
    metaKey:  (p.modifiers & 4) === 4,
    button: p.button === "left" ? 0 : p.button === "middle" ? 1 : p.button === "right" ? 2 : 0,
    bubbles: true, cancelable: true,
  });
  el.dispatchEvent(ev);
  return true;
}`;

function cdpTypeToDom(t: string): string | null {
  switch (t) {
    case "mousePressed":
      return "mousedown";
    case "mouseReleased":
      return "click";
    case "mouseMoved":
      return "mousemove";
    default:
      return null;
  }
}

export function installInputFilters(t: Target) {
  const dispatch = async (msg: any) => {
    const params = msg.params ?? {};
    const dom = cdpTypeToDom(params.type);
    if (!dom) {
      t.fireResultToTools(msg.id!, {});
      return null;
    }
    const sequence = dom === "click" ? ["mousedown", "click", "mouseup"] : [dom];
    try {
      for (const evType of sequence) {
        const payload = {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          modifiers: Number(params.modifiers) || 0,
          button: params.button ?? "none",
          type: evType,
        };
        const expr = `(${SIMULATE_FN}, __sd_simulate(${JSON.stringify(payload)}))`;
        await t.callTarget("Runtime.evaluate", { expression: expr });
      }
      t.fireResultToTools(msg.id!, {});
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  };

  t.addMessageFilter("tools::Input.dispatchMouseEvent", dispatch);
  t.addMessageFilter("tools::Input.emulateTouchFromMouseEvent", dispatch);

  // Stubs — DevTools sometimes probes these on attach; respond success rather
  // than letting Safari return "domain not found".
  t.addMessageFilter("tools::Input.setIgnoreInputEvents", (msg) => {
    t.fireResultToTools(msg.id!, {});
    return Promise.resolve(null);
  });
}
