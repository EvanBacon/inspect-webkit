// CDP Target.* shim. Note: this file installs filters that ack a few
// Target.* methods locally. It is unrelated to the per-session `Target`
// class in ../target.ts (the type imported below) — only the names overlap.

import type { Target } from "../target";
import { swallowWith } from "../domain";

export function installTargetFilters(t: Target) {
  // Modern Chrome DevTools sends Target.setAutoAttach({autoAttach,flatten})
  // as part of its boot sequence. Safari has its own Target.* (different
  // semantics — reflects inner page targets, not browser-level targets).
  // If we forward this to Safari it errors back and the DevTools client
  // gets a misrouted response, which can wedge subsequent operations.
  // Ack locally; the bridge already auto-detects Safari's target-based
  // mode and wraps/unwraps transparently.
  for (const m of [
    "Target.setAutoAttach",
    "Target.setDiscoverTargets",
    "Target.setRemoteLocations",
  ]) {
    t.addMessageFilter(`tools::${m}`, (msg) => swallowWith(t, msg, {}));
  }
}
