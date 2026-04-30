import type { Target } from "../target";
import { swallowWith } from "../domain";

// CDP `Browser` domain. Safari/WIR has no equivalent — we synthesize a
// response from the same constants used by the HTTP `/json/version` endpoint
// in src/cdp/server.ts. Keep these in sync if either side changes.
const BROWSER_VERSION = {
  protocolVersion: "1.3",
  product: "Safari/inspect-webkit",
  revision: "605.1.15",
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15 Safari/inspect-webkit",
  jsVersion: "",
};

export function installBrowserFilters(t: Target) {
  t.addMessageFilter("tools::Browser.getVersion", (msg) =>
    swallowWith(t, msg, BROWSER_VERSION),
  );
  // DevTools occasionally probes these; ack-stub so the panel doesn't error.
  t.addMessageFilter("tools::Browser.getWindowForTarget", (msg) =>
    swallowWith(t, msg, { windowId: 1, bounds: {} }),
  );
  t.addMessageFilter("tools::Browser.setWindowBounds", (msg) =>
    swallowWith(t, msg, {}),
  );
}
