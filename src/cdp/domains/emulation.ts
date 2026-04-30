import type { Target } from "../target";
import { swallowWith } from "../domain";

export function installEmulationFilters(t: Target) {
  // ---- Emulation / Rendering renames -----------------------------------
  t.addMessageFilter("tools::Emulation.canEmulate", (msg) =>
    swallowWith(t, msg, { result: true }),
  );
  t.addMessageFilter("tools::Emulation.setTouchEmulationEnabled", (msg) => {
    msg.method = "Page.setTouchEmulationEnabled";
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Emulation.setScriptExecutionDisabled", (msg) => {
    msg.method = "Page.setScriptExecutionDisabled";
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Emulation.setEmulatedMedia", (msg) => {
    msg.method = "Page.setEmulatedMedia";
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Rendering.setShowPaintRects", (msg) => {
    msg.method = "Page.setShowPaintRects";
    return Promise.resolve(msg);
  });

  // Emulation.setDeviceMetricsOverride / clearDeviceMetricsOverride.
  // WebKit historically mapped these to Page.setScreenSizeOverride, but
  // iOS 26 has removed that method (verified live: "method not found").
  // Page.overrideSetting exists but doesn't accept a device-metrics
  // setting name. There is no working WIR equivalent on iOS 26 — swallow
  // so DevTools doesn't surface a "command failed" toast every time the
  // user toggles device emulation in the UI.
  t.addMessageFilter("tools::Emulation.setDeviceMetricsOverride", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Emulation.clearDeviceMetricsOverride", (msg) =>
    swallowWith(t, msg, {}),
  );

  // Emulation.setUserAgentOverride: DevTools' device toolbar sends the
  // override through the Emulation domain (the "Network conditions" panel
  // sends through Network — handled separately in network.ts). Both end
  // up at Page.overrideUserAgent in WIR with `{value: userAgent}`.
  t.addMessageFilter("tools::Emulation.setUserAgentOverride", (msg) => {
    const ua = msg.params?.userAgent ?? "";
    msg.method = "Page.overrideUserAgent";
    msg.params = { value: ua };
    return Promise.resolve(msg);
  });

  // Stubs DevTools probes on attach.
  t.addMessageFilter("tools::Emulation.setFocusEmulationEnabled", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Emulation.setDefaultBackgroundColorOverride", (msg) =>
    swallowWith(t, msg, {}),
  );
}
