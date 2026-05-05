// Bridge-side stubs for CDP commands iOS 26 Safari does not implement.
//
// Forwarding any of these to Safari causes one of three failure modes:
//   1. Silent drop (no response at all) — DevTools waits forever.
//   2. "method not found" error — DevTools surfaces a console error.
//   3. Inner-page-target WEDGE — subsequent unrelated commands
//      (e.g. DOM.getDocument) also stop receiving responses, freezing
//      the Elements panel and stopping all DOM/Network event flow.
//
// The wedge case is the dangerous one: a single CSS.trackComputedStyleUpdates
// at attach time can prevent DOM.getDocument that comes 1ms later from
// ever responding (verified live trace, May 2026 / iOS 26.5 sim). The
// only safe approach is to never forward these to Safari at all.
//
// Each command here is acked with a sensible empty default so DevTools'
// state machine moves on. The defaults are conservative: most methods
// just need `{}`, but a few need a specific shape to avoid downstream
// confusion (Page.addScriptToEvaluateOnNewDocument needs `{identifier}`).

import type { Target } from "../target";
import { swallowWith } from "../domain";

// Whole CDP-only domains — Safari has no equivalent at all. Any method
// in these domains is swallowed with `{}` regardless of name.
const CDP_ONLY_DOMAINS = [
  "Animation",
  "Autofill",
  "Audits",
  "ServiceWorker",
  "Profiler",
  "HeapProfiler",
  "Storage",
  "Tethering",
  "Tracing",
  "BackgroundService",
  "FedCm",
  "DeviceAccess",
  "WebAuthn",
  "Cast",
  "Database",
  "ApplicationCache",
  "BackgroundFetch",
  "DeviceOrientation",
  "EventBreakpoints",
  "FileSystem",
  "HeadlessExperimental",
  "IndexedDB",
  "Memory",
  "PerformanceTimeline",
  "Performance",
  "Preload",
  "Schema",
  "Security",
  "SystemInfo",
  "WebAudio",
] as const;

// CDP-only methods within domains we partially support. Each gets a
// swallow with a sensible default response shape. Picked from a real
// DevTools attach trace against iOS 26 — anything DevTools sends here
// that Safari doesn't recognize, where forwarding has caused observable
// problems.
const CDP_ONLY_METHODS: Record<string, any> = {
  // Inspector.enable / disable exist in WIR too and MUST be forwarded —
  // WebKit only dispatches `Inspector.inspect` (the click-to-inspect event)
  // after the backend agent has been enabled. Stubbing it locally silently
  // breaks the Elements panel's "select an element" feature.

  "Network.setAttachDebugStack": {},
  // chrome-devtools-frontend's NetworkManager reads response.ruleIds.length
  // unconditionally; returning {} crashes with "Cannot read properties of
  // undefined (reading 'length')". Always include an empty ruleIds array.
  "Network.emulateNetworkConditionsByRule": { ruleIds: [] },
  "Network.overrideNetworkState": {},
  "Network.clearAcceptedEncodingsOverride": {},
  "Network.setAcceptedEncodings": {},
  "Network.enableReportingApi": {},

  // Overlay variants beyond the basic ones we already translate. These
  // are all CDP-only "show this overlay" toggles; DevTools doesn't
  // require a response value.
  "Overlay.setShowHinge": {},
  "Overlay.setShowViewportSizeOnResize": {},
  "Overlay.setShowGridOverlays": {},
  "Overlay.setShowFlexOverlays": {},
  "Overlay.setShowScrollSnapOverlays": {},
  "Overlay.setShowContainerQueryOverlays": {},
  "Overlay.setShowIsolatedElements": {},
  "Overlay.setPausedInDebuggerMessage": {},
  "Overlay.setShowAdHighlights": {},
  "Overlay.setShowDebugBorders": {},
  "Overlay.setShowFPSCounter": {},
  "Overlay.setShowLayoutShiftRegions": {},
  "Overlay.setShowScrollBottleneckRects": {},
  "Overlay.setShowHitTestBorders": {},
  "Overlay.setShowWebVitals": {},

  // CSS computed-style update tracking is a CDP-only mechanism for
  // animating style changes in the Elements panel. iOS 26 wedges
  // catastrophically when these are forwarded — DOM.getDocument that
  // arrives milliseconds later silently drops, freezing the entire
  // Elements panel.
  "CSS.trackComputedStyleUpdates": {},
  "CSS.takeComputedStyleUpdates": { nodeIds: [] },
  "CSS.startRuleUsageTracking": {},
  "CSS.stopRuleUsageTracking": { ruleUsage: [] },
  "CSS.takeCoverageDelta": { coverage: [], timestamp: 0 },

  "Page.setAdBlockingEnabled": {},
  // Page.addScriptToEvaluateOnNewDocument is handled in domains/page.ts —
  // it needs a unique synthetic identifier (not "") so Puppeteer's later
  // removeScriptToEvaluateOnNewDocument bookkeeping doesn't fail.
  "Page.removeScriptToEvaluateOnNewDocument": {},
  "Page.setBypassCSP": {},
  "Page.setInterceptFileChooserDialog": {},
  "Page.setPrerenderingAllowed": {},
  "Page.setRPHRegistrationMode": {},
  "Page.setSPCTransactionMode": {},

  "Emulation.setEmulatedVisionDeficiency": {},
  "Emulation.setFocusEmulationEnabled": {},
  "Emulation.setAutoDarkModeOverride": {},
  "Emulation.setAutomationOverride": {},
  "Emulation.setLocaleOverride": {},
  "Emulation.setTimezoneOverride": {},
  "Emulation.setVisibleSize": {},
  "Emulation.setIdleOverride": {},
  "Emulation.clearIdleOverride": {},
  "Emulation.setGeolocationOverride": {},
  "Emulation.clearGeolocationOverride": {},
  "Emulation.setSensorOverrideEnabled": {},
  "Emulation.setSensorOverrideReadings": {},
  "Emulation.setHardwareConcurrencyOverride": {},
  "Emulation.setNavigatorOverrides": {},
  "Emulation.setPageScaleFactor": {},
  "Emulation.setScrollbarsHidden": {},
  "Emulation.setDocumentCookieDisabled": {},

  "DOMDebugger.setBreakOnCSPViolation": {},

  "Runtime.addBinding": {},
  "Runtime.removeBinding": {},

  "Debugger.setReturnValue": {},
  "Debugger.setBlackboxExecutionContexts": {},
  "Debugger.setInstrumentationBreakpoint": {},

  "DOM.markUndoableState": {},
  "DOM.undo": {},
  "DOM.redo": {},
  "DOM.copyTo": { nodeId: 0 },
  "DOM.collectClassNamesFromSubtree": { classNames: [] },

  // CDP's Accessibility domain doesn't exist on WebKit (a11y info is on
  // DOM.getAccessibilityProperties). chrome-devtools-mcp's take_snapshot
  // calls Accessibility.getFullAXTree first thing — return an empty tree
  // so the tool degrades gracefully instead of hard-erroring. Agents lose
  // a11y-tree-based snapshots but still get DOM and JS evaluation.
  "Accessibility.enable": {},
  "Accessibility.disable": {},
  "Accessibility.getFullAXTree": { nodes: [] },
  "Accessibility.getRootAXNode": { node: null },
  "Accessibility.getPartialAXTree": { nodes: [] },
  "Accessibility.queryAXTree": { nodes: [] },
  "Accessibility.getAXNodeAndAncestors": { nodes: [] },
  "Accessibility.getChildAXNodes": { nodes: [] },
};

export function installCdpOnlyStubs(t: Target) {
  for (const [method, result] of Object.entries(CDP_ONLY_METHODS)) {
    t.addMessageFilter(`tools::${method}`, (msg) => swallowWith(t, msg, result));
  }
  // Domain-level catch: filter machinery only matches exact method names.
  // For whole-CDP-only domains we'd need to register every method, but we
  // don't know them all — register the ones we've actually seen in the
  // wild plus their `enable` / `disable`. Methods we haven't seen will
  // still forward and Safari errors with "method not found", which is
  // verbose but not wedge-causing.
  for (const dom of CDP_ONLY_DOMAINS) {
    for (const m of ["enable", "disable"]) {
      t.addMessageFilter(`tools::${dom}.${m}`, (msg) => swallowWith(t, msg, {}));
    }
  }
  // Specific known sub-methods on CDP-only domains that DevTools sends
  // at attach (from real-world trace).
  const extras: Array<[string, any]> = [
    ["Autofill.setAddresses", {}],
    ["Storage.getStorageKey", { storageKey: "" }],
    ["Storage.trackCacheStorageForOrigin", {}],
    ["Storage.trackIndexedDBForOrigin", {}],
    ["Storage.untrackCacheStorageForOrigin", {}],
    ["Storage.untrackIndexedDBForOrigin", {}],
    ["Storage.getCookies", { cookies: [] }],
    ["ServiceWorker.unregister", {}],
  ];
  for (const [m, r] of extras) {
    t.addMessageFilter(`tools::${m}`, (msg) => swallowWith(t, msg, r));
  }
}
