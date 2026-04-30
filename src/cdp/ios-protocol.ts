// Translation filters between Chrome DevTools Protocol (what tools send) and
// Safari's remote inspector wire protocol — the surface whose IPC keys are
// all prefixed `WIR*` (WIRApplicationDictionaryKey, WIRSocketDataKey, …).
// We shorten that to "WIR" throughout the codebase.
//
// Coverage spans every CDP domain a Chrome DevTools attach exercises:
// Runtime, Debugger, Console/Log, Page, DOM, DOMDebugger, CSS, Network,
// Emulation, Overlay, Browser, Input, IO, Accessibility, Inspector, Target,
// plus a swath of CDP-only methods iOS 26 doesn't recognize (those go
// through cdp-only-stubs.ts and never reach Safari).
//
// Per-domain filters live in ./domains/<name>.ts. This file is a thin
// orchestrator that wires up shared per-session state and installs each
// domain in the original registration order.

import type { Target } from "./target";
import { makeDomainCtx } from "./domain";
import { installDebuggerFilters } from "./domains/debugger";
import { installRuntimeFilters } from "./domains/runtime";
import { installConsoleLogFilters } from "./domains/console-log";
import { installDomFilters } from "./domains/dom";
import { installDomDebuggerFilters } from "./domains/dom-debugger";
import { installPageFilters } from "./domains/page";
import { installOverlayFilters } from "./domains/overlay";
import { installEmulationFilters } from "./domains/emulation";
import { installNetworkFilters } from "./domains/network";
import { installTargetFilters } from "./domains/target";
import { installInspectorFilters } from "./domains/inspector";
import { installCssFilters } from "./domains/css";
import { installBrowserFilters } from "./domains/browser";
import { installInputFilters } from "./domains/input";
import { installIoFilters } from "./domains/io";
import { installAccessibilityFilters } from "./domains/accessibility";
import { installCdpOnlyStubs } from "./domains/cdp-only-stubs";

export function installIOSFilters(t: Target) {
  // Per-session state — kept on a closure-local context object (NOT
  // module-level) so multiple concurrent DevTools sessions don't stomp
  // each other. State used by exactly one domain stays inside that
  // domain's installer instead.
  const ctx = makeDomainCtx();

  // CDP-only stubs FIRST. These are commands DevTools sends at attach
  // that iOS 26 doesn't recognize — and forwarding even one of them
  // (notably CSS.trackComputedStyleUpdates) wedges the inner page
  // target so subsequent unrelated commands silently drop. Installing
  // first means later domain-specific filters can't accidentally let
  // them through.
  installCdpOnlyStubs(t);

  // Install IO next so we can hand its cache to Network's
  // loadNetworkResource — that method writes blobs that DevTools later
  // drains via IO.read.
  const ioCache = installIoFilters(t);

  installDebuggerFilters(t, ctx);
  installRuntimeFilters(t, ctx);
  installConsoleLogFilters(t, ctx);
  installDomFilters(t);
  installDomDebuggerFilters(t);
  installPageFilters(t, ctx);
  installOverlayFilters(t);
  installEmulationFilters(t);
  installNetworkFilters(t, ioCache);
  installTargetFilters(t);
  installInspectorFilters(t);
  installCssFilters(t);
  installBrowserFilters(t);
  installInputFilters(t);
  installAccessibilityFilters(t);
}
