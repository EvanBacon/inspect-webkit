# End-to-end verification guide

How to verify that a change to `inspect-webkit` actually works against a real
iOS Web Inspector — without resorting to "open Chrome and squint" every time.

The bridge has three layers of state, and your tests should match. Don't
skip to the visual layer: each lower layer is faster, more reliable, and
gives a better error message when it breaks.

```
  L1  unit tests             — bun test (parsers, framing)            ms
  L3  protocol e2e           — scripts/e2e/cdp-{probe,domains}.ts     ~2s
  L4  visual e2e             — Chrome DevTools or chrome-MCP          ~10s
```

Always run L1+L3 before L4. L4 is for "does the user-facing UX still feel
right" — it's not for catching protocol bugs.

---

## L1 — Unit tests

```bash
bun test
```

Covers parsers and pure logic in `src/`. Add a `*.test.ts` next to any new
pure module. Sub-50ms today — keep it that way.

## L3 — Protocol e2e (the layer most changes need)

This is where you verify CDP ↔ WIR translation. No vision, no UI, just
JSON-RPC over a WebSocket. Fast, deterministic, scriptable.

### Setup (one-time per session)

```bash
# 1. Boot a sim and open a known page
scripts/e2e/sim-boot.sh https://example.com/

# 2. Start the bridge and block until ready (no blind sleep)
bun bin/cli.ts cdp --port 9222 &
scripts/e2e/wait-ready.sh 9222

# 3. Confirm the bridge sees the page and grab its ws URL
WS=$(curl -s http://localhost:9222/json/list | jq -r '.[0].webSocketDebuggerUrl')
echo "$WS"
```

### Probes

```bash
# Sanity check — Runtime.evaluate, DOM.getDocument, Page.getResourceTree
bun scripts/e2e/cdp-probe.ts "$WS"

# Domain survey — every domain we claim to support, OK/ERR matrix
bun scripts/e2e/cdp-domains.ts "$WS"

# Scenario — Debugger.paused fires on `debugger;`, callFrames well-formed,
# Debugger.resume completes the eval. Exits non-zero on regression.
bun scripts/e2e/cdp-debugger-paused.ts "$WS"
```

`cdp-domains.ts` is the regression check after changes to `src/cdp/`. The
expected baseline (last verified 2026-05-03; identical on iOS 26.2 and 26.5
Safari — re-verify only when a new major iOS appears):

| Domain method                        | Status | Notes                              |
| ------------------------------------ | ------ | ---------------------------------- |
| `Runtime.enable` / `evaluate`        | OK     | Returns by-value too               |
| `Debugger.enable`                    | OK     | Emits `scriptParsed` events        |
| `Page.enable` / `getResourceTree`    | OK     |                                    |
| `Page.getNavigationHistory`          | OK     | Shimmed (WIR has no equivalent)    |
| `DOM.enable` / `getDocument`         | OK     |                                    |
| `CSS.enable`                         | OK     | Emits `styleSheetAdded` events     |
| `Network.enable` / `getCookies`      | OK     | Cookies via `Page.getCookies` shim |
| `Network.getAllCookies`              | OK     | Same shim, returns CDP shape       |
| `Network.setCookie` / `setCookies`   | OK     | Reshape to `Page.setCookie`        |
| `Network.deleteCookies`              | OK     | Maps to `Page.deleteCookie`        |
| `Network.clearBrowserCookies`        | OK     | Enumerate-and-delete via Page.*    |
| `Network.setCacheDisabled`           | OK     | Fixed: was Page.setBypassCSP, now `Network.setResourceCachingDisabled` |
| `Network.setUserAgentOverride`       | OK     | Renamed to `Page.overrideUserAgent` |
| `Network.setExtraHTTPHeaders`        | OK ack | Stub — no WIR equivalent           |
| `Network.setBlockedURLs`             | OK ack | Stub — no WIR equivalent           |
| `Network.emulateNetworkConditions`   | OK ack | Stub; `canEmulate…` returns false  |
| `Network.setMonitoringXHREnabled`    | OK ack | Stub — `Console.setMonitoringXHREnabled` removed in iOS 26 |
| `Log.enable` / `Console.enable`      | OK     |                                    |
| `Target.setAutoAttach`               | OK     | iOS 13+ target-mode auto-detected  |
| `DOM.performSearch`                  | OK     | Pass-through; results via WIR shape |
| `DOMDebugger.setEventListenerBreakpoint`    | OK ack | Stub — `DOM.setEventBreakpoint` removed in iOS 26 |
| `DOMDebugger.removeEventListenerBreakpoint` | OK ack | Stub — same |
| `DOMDebugger.setXHRBreakpoint`       | OK ack | Stub — `DOM.setURLBreakpoint` removed in iOS 26 |
| `DOMDebugger.removeXHRBreakpoint`    | OK ack | Stub — same |
| `Page.captureScreenshot`             | ERR    | Not exposed by Safari (sharp ERR)  |
| `Page.startScreencast`               | OK ack | No frames actually emitted (TODO)  |
| `Overlay.enable` / `disable`         | OK     | Swallowed (WIR has no Overlay)     |
| `Overlay.hideHighlight`              | OK     | Renamed → `DOM.hideHighlight`      |
| `Overlay.setInspectMode`             | OK     | → `DOM.setInspectModeEnabled`      |
| `Overlay.setShowPaintRects`          | OK     | Renamed → `Page.setShowPaintRects` |
| `Emulation.setDeviceMetricsOverride` | OK ack | Stub — `Page.setScreenSizeOverride` removed in iOS 26; no working WIR equivalent |
| `Emulation.clearDeviceMetricsOverride` | OK ack | Stub — same |
| `Browser.getVersion`                 | OK     | Synthesized (matches `/json/version`) |
| `Input.dispatchMouseEvent`           | OK     | Replayed via `Runtime.evaluate` MouseEvent |
| `IO.read` / `IO.close`               | OK     | In-memory handle cache (empty until producer lands) |
| `Accessibility.getPartialAXTree`     | OK     | Forwarded to `DOM.getAccessibilityPropertiesForNode` |
| `CSS.setStyleTexts` (live edit)      | OK     | Range → WIR ordinal via getStyleSheet (fragile across mid-batch fail) |
| `CSS.getMatchedStylesForNode`        | ERR (probe) | Bridge OK; survey nodeId not registered with CSS yet — works in real DevTools sessions |
| `CSS.getInlineStylesForNode`         | ERR (probe) | Same — probe-side only                |
| `CSS.addRule`                        | ERR (probe) | Survey uses bogus styleSheetId "0"; bridge translation verified |
| `Network.getResponseBody`            | ERR    | Safari doesn't expose bodies — explicit error to avoid DevTools hangs |
| `Runtime.setAsyncCallStackDepth`     | OK     | Swallowed with `{}` ack            |
| `Runtime.releaseObjectGroup`         | OK     | Pure passthrough to WIR            |
| `Debugger.setAsyncCallStackDepth`    | OK     | Swallowed with `{}` ack            |
| `Debugger.setSkipAllPauses`          | OK     | Swallowed (no WIR equivalent)      |
| `Debugger.setBreakpointByUrl`        | OK     | `condition` nested under `options` |
| `Emulation.setUserAgentOverride`     | OK     | Renamed → `Page.overrideUserAgent` |
| `Network.loadNetworkResource`        | OK     | Stashes body in IO cache; DevTools reads via `IO.read`. Verified e2e against `https://example.com/`. |

**Bridge limitations surfaced by L3 testing** (not in the OK/ERR matrix
because the survey only checks one method per domain — these need scenario
tests):

- **Cross-origin navigation: FIXED.** The bridge now handles
  `Target.didCommitProvisionalTarget` (`src/cdp/target.ts`) and re-pins
  `innerTargetId` to the new target so subsequent requests reach the live
  page. Regression test: `bun scripts/e2e/cdp-cross-origin-nav.ts <wsUrl>`
  with the page at `https://example.com/`. Note: Safari does not always
  emit `Page.frameNavigated` / `Page.loadEventFired` on a cross-origin
  swap — that's a separate Safari-side behavior, unrelated to the bridge.
- **Initialization-race fix in `src/cdp/target.ts`.** The 250ms "give up
  and assume non-target-based mode" fallback in `sendRaw` now gates on
  `!sawAnyTargetCreated` (previously gated only on `!innerTargetId`). The
  old behavior could flush adapter-internal calls (negative ids) raw to
  the outer target id:-1 if a non-page targetCreated arrived first, which
  silently lost state-changing setup like `Debugger.setBreakpointsActive`.
- **`Debugger.setBreakpointsActive` ordering: FIXED.** Filter relocated
  from `tools::Debugger.enable` to `target::Debugger.enable`
  (`src/cdp/ios-protocol.ts`) so the kick fires AFTER Safari acks
  `Debugger.enable`. Previously it raced ahead and Safari accepted but
  no-oped it.
- **CSS.enable inner-dispatch hang: WORKED AROUND.** iOS 26 acks
  `Target.sendMessageToTarget` for `CSS.enable` with the outer ack only —
  the inner `Target.dispatchMessageFromTarget` reply that carries the
  real CSS.enable response never arrives. The bridge waited forever for
  the unwrap and DevTools' Styles panel never finished attaching.
  Forwarding `CSS.getAllStyleSheets` after a synthetic ack also wedges
  the inner page target (subsequent `DOM.getDocument` /
  `Runtime.evaluate` hang). Workaround: ack `CSS.enable` synthetically
  at the bridge, do not forward, and rely on `CSS.getMatchedStylesForNode`
  / `CSS.getStyleSheetText` working on demand. Verified live: Styles
  panel renders matched rules; clicking the source link fetches the
  actual stylesheet text. Trade-off: the Sources tree won't auto-list
  every stylesheet on attach — sheets become visible via element-driven
  resolution.
- **DOM.getDocument depth: WORKED AROUND.** CDP `depth: -1` means full
  subtree; iOS 26 always clamps to one level. Without recursive
  expansion, DevTools' Elements tree shows only `<html>/<head>/<body>`
  with deeper nodes blank — exactly the user-reported "first div, then
  empty" symptom. Bridge now fans out `DOM.requestChildNodes` up to
  depth 4 after `DOM.getDocument` returns; `DOM.setChildNodes` events
  stream in and DevTools applies them client-side.
- **`Network.getResponseBody`: WORKED AROUND.** Safari's inspector
  socket doesn't carry response bodies. Bridge tracks
  `requestId → {url, frameId}` from `requestWillBeSent` and falls back
  to `Network.loadResource` (a fresh GET from Safari's perspective) on
  `getResponseBody`. The Network panel's Preview / Response tabs now
  populate. Caveat: misses POST bodies and server-set caching headers.
  Untracked requestIds (e.g. ones from before the bridge attached)
  return a sharp error rather than hanging.
- **`alert()` / `confirm()` / `prompt()` in Runtime.evaluate: NOT a
  bridge bug.** iOS Safari renders the dialog on the page; if the sim
  isn't foreground or the dialog can't be dismissed, JavaScript
  execution blocks indefinitely and the eval response never arrives.
  Chrome DevTools attached to a desktop browser has the same behavior.
  Workaround: don't call dialog functions from the inspector REPL.
- **`Debugger.paused` on `debugger;` statements: FIXED.** The bridge now
  also kicks `Debugger.setPauseOnDebuggerStatements({enabled:true})` from
  the `target::Debugger.enable` filter. CDP has no equivalent method —
  DevTools assumes pause-on-debugger is on by default — so the bridge
  has to opt in on the page's behalf. Verified live on iOS 26.5: an
  `eval` of `(function(){ debugger; return 42 })()` now produces a
  `Debugger.paused` event with full callFrames; `Debugger.resume`
  returns the value normally. Pause/step/breakpoints all functional in
  Chrome DevTools and VS Code attach now.
- **CDP-only attach barrage: FIXED.** A real Chrome DevTools attach
  sends ~70 commands in the first second, ~30 of which are CDP-only
  methods iOS 26 Safari doesn't implement (`CSS.trackComputedStyleUpdates`,
  `Storage.getStorageKey`, `Animation.enable`, `Autofill.*`,
  `Profiler.enable`, every `Overlay.setShow*`, …). Forwarding even one
  of these wedges Safari's inner page target — subsequent unrelated
  commands (notably `DOM.getDocument`) silently drop, leaving DevTools
  with an empty Elements panel, dead Console, frozen Network, blank
  Sources. The L3 survey can't surface this because it issues commands
  serially and never triggers the barrage. Fix:
  `src/cdp/domains/cdp-only-stubs.ts` ack-stubs ~80 known CDP-only
  methods at the bridge, installed before all other domain filters
  in `installIOSFilters` so they can't be accidentally let through.
  Verified live: a fresh DevTools attach now reaches `DOM.getDocument`
  cleanly and the Elements / Console / Network / Sources panels all
  populate and update.

**Timing budget for tests** (sim, iOS 26.2, on a quiet machine):

- `Page.navigate` ack: ~7ms median, budget **500ms**.
- Same-origin navigation through `Page.loadEventFired`: ~34ms median,
  budget **2000ms** (50× headroom for cold cache).
- Note: Safari emits `loadEventFired` *before* `domContentEventFired`
  (within 1ms). Don't assume Chromium ordering in test assertions.

**Throughput characterization (Runtime.evaluate)** — sim, iOS 26.5:

| Mode                        | n    | wall   | p95    | req/s  |
| --------------------------- | ---- | ------ | ------ | ------ |
| Serial (await each)         | 500  | 258ms  | 1.3ms  | ~2000  |
| Throttled, concurrency=8    | 500  | 83ms   | 2.3ms  | **~6000** |
| Parallel, all in-flight     | 50   | 8ms    | 7.4ms  | ~6300  |
| Parallel, all in-flight     | 60   | 11ms   | —      | ~5400  |
| Parallel, all in-flight     | 70   | timeout (45/70 dropped) | — | — |
| Parallel, all in-flight     | 80+  | timeout (100% dropped) | — | — |

- **Hard in-flight ceiling around 60–70 requests.** Above that the WS
  session breaks for the rest of its lifetime — even after dropping back
  to n=50 the session remains poisoned. Reconnect a fresh WS to recover.
  Likely Safari (not the bridge) — `WIRSocketDataKey`/`WIRMessageDataKey`
  appears to have a bounded queue per `senderKey`.
- **Best sustained throughput: a worker pool with concurrency 8–32.**
  Going higher gains nothing and risks the cliff.
- **Ordering: not guaranteed.** Responses arrive interleaved by the order
  Safari completes them, not by request id. Always match by `id`.

**Connection pattern that actually works.** When writing CDP probes,
attach `ws.onmessage` *before* awaiting `onopen`. Setting it after the
open promise resolves can drop the first response on Bun, manifesting as
`Runtime.enable` hanging forever. The pattern in `scripts/e2e/cdp-probe.ts`
and `cdp-domains.ts` is correct — copy it verbatim.

**Event channels worth knowing about** (not in the survey, but real):

- `Page.frameNavigated` + `Page.loadEventFired` + `Page.domContentEventFired`
  fire correctly after `Page.navigate`. Use these to gate test assertions.
- `console.log()` calls surface as **`Runtime.consoleAPICalled`**, not
  `Console.messageAdded` and not `Log.entryAdded`. `Console.enable` is
  accepted but doesn't produce `Console.messageAdded` — the bridge routes
  all console output through `Runtime.consoleAPICalled`. `Log.entryAdded`
  fires only for browser-generated log entries (404s, CSP violations, etc.),
  not user `console.*` calls.
- `Network.requestWillBeSent` / `responseReceived` / `dataReceived` /
  `loadingFinished` fire for the main-document request, but **subresource
  Network events appear thin** — a favicon 404 may show up in `Log.entryAdded`
  yet have no matching `Network.requestWillBeSent`. Don't rely on the bridge
  for full Network waterfall coverage; this is a known gap.

If you change `src/cdp/ios-protocol.ts`, the survey must match this table.
If you intentionally fix one of the TODOs, update the table in the same PR.

### Adding a new domain or method

1. Add a row to `cdp-domains.ts` `probes[]`. Land it red.
2. Find the WIR equivalent. Two ways:
   - Run with `INSPECT_WEBKIT_DEBUG=1` and watch the raw error from Safari —
     it usually names the domain it expected.
   - Look at WebKit's `Source/JavaScriptCore/inspector/protocol/*.json` for
     the canonical WIR surface (`Page.setScreenSizeOverride` for viewport,
     `Page.getCookies` for cookies, etc.).
3. Implement the translation in the appropriate `src/cdp/domains/*.ts`.
   Four patterns, pick the right one:
   - **Pure rename** (`Emulation.setEmulatedMedia` → `Page.setEmulatedMedia`):
     just rewrite `msg.method`.
   - **Param reshape** (`Emulation.setDeviceMetricsOverride` →
     `Page.setScreenSizeOverride`): rewrite `msg.method` AND replace
     `msg.params` (drop CDP-only fields like `deviceScaleFactor`, `mobile`).
   - **Synthesized response** (Safari has no equivalent at all, e.g.
     `Page.getNavigationHistory`): use `fireResultToTools` to ack a fake
     reply, do not forward to Safari.
   - **Wedge-prevention stub** (`CSS.trackComputedStyleUpdates`,
     `Storage.getStorageKey`, `Animation.enable`, etc.): if forwarding
     causes Safari to silently drop subsequent unrelated commands, add
     the method to `cdp-only-stubs.ts` instead of trying to translate
     it. Use `INSPECT_WEBKIT_DEBUG=1` and look for IDs that get only an
     outer `Target.sendMessageToTarget` ack but no inner
     `Target.dispatchMessageFromTarget` reply — those are the wedge
     candidates. If a wedge command is followed by other commands that
     also stop responding, the bridge needs to stub it.
   - For target → tools events, use the `target::` filter prefix; for tools
     → target requests, `tools::`.
4. Run the survey. Row turns green. Update the table above.
5. Only now go to L4 to confirm the DevTools UI presents it sensibly.

### Diagnostics

```bash
INSPECT_WEBKIT_DEBUG=1 bun bin/cli.ts cdp --port 9222
```

Logs every CDP frame in both directions, prefixed `[cdp] tools>>` and
`[cdp] target>>`. Pipe to a file and `grep` for the method you're debugging.

## L4 — Visual e2e (use sparingly)

Use this only when the change affects what a human sees in DevTools — panel
layout, screenshot rendering, network waterfall, etc. Most protocol changes
do **not** need L4. Symptoms that DO need L4: anything DevTools renders
asynchronously from many CDP messages (Elements tree, Styles panel, Network
waterfall, Sources tabs). The L3 survey misses these because it issues
commands serially; DevTools blasts ~70 in the first second of attach.

### Attaching DevTools (Chrome v147+)

**The only reliable path is `chrome://inspect`:**

```
1. Open chrome://inspect/#devices
2. Click "Configure…", add localhost:9222, click "Done"
3. Wait a few seconds — your iOS target appears under "Remote Target"
4. Click "inspect" — DevTools opens attached
```

What does NOT work in current Chrome (verified live, May 2026 / v147):

- Pasting `devtools://devtools/bundled/inspector.html?ws=...` into the
  address bar — Chrome rewrites it to `https://devtools/...` (broken).
- `<a href="devtools://...">` link clicks — Chrome blocks the navigation.
- Argv: `chrome devtools://...` — Chrome silently opens a New Tab on
  `chrome://newtab/` and discards the URL.
  Use `chrome://inspect` instead — that's the only reliable attach path on
  Chrome v147+.

### Option A: chrome://inspect (preferred)

Manual. The path above. Reliable across Chrome versions.

### Option B: Chrome MCP (for agents)

```
1. mcp__claude-in-chrome__navigate  to http://localhost:9222/   — landing page
2. mcp__claude-in-chrome__navigate  to chrome://inspect/#devices
3. instruct the user to add localhost:9222 once (then it persists)
4. mcp__claude-in-chrome__find        — locate the iOS target's "inspect" link
5. mcp__claude-in-chrome__javascript_tool  — click it (devtools:// allowed
   here because the click originates from chrome://inspect itself)
6. mcp__claude-in-chrome__read_page    — assert panel state
```

### Option C: GIF capture for review

```
mcp__claude-in-chrome__gif_creator
```

Useful for PRs that change visible behavior. Capture 2–3s of the interaction;
attach to the PR description.

---

## Working with iOS simulators (`simctl` cheatsheet)

```bash
# what's booted?
xcrun simctl list devices booted

# boot a specific runtime/device
xcrun simctl boot "iPhone 17 Pro"
open -a Simulator

# load a URL in mobile Safari (creates a debuggable target)
xcrun simctl openurl booted https://example.com/

# kill a stuck Safari without killing the sim
xcrun simctl terminate booted com.apple.mobilesafari

# erase + reboot (last resort if Web Inspector socket gets weird)
xcrun simctl shutdown booted && xcrun simctl erase <udid>
```

Web Inspector is on by default in the simulator — no toggle needed, unlike
real devices.

## Working with real devices

Pre-flight (do this once per device, then forget it):

- Cable connected, "Trust This Computer" accepted
- Settings → Safari → Advanced → Web Inspector → ON
- For a WKWebView host app on iOS 16.4+: app sets `webView.isInspectable = true`

Then `curl http://localhost:9222/json/list` (after `bun bin/cli.ts cdp`) should
populate. If empty: check the entitlement / Web Inspector toggle, or read the
transport modules (`src/usbmux.ts`, `src/sim.ts`) directly with `INSPECT_WEBKIT_DEBUG=1`.

---

## Parallel-agent guide

This bridge is a translation layer with three mostly-independent surfaces.
Agents can work on these in parallel without stepping on each other:

| Area                       | Files                       | Owner-of-record for tests          |
| -------------------------- | --------------------------- | ---------------------------------- |
| **Transport**              | `src/usbmux.ts`, `src/lockdown.ts`, `src/sim.ts`, `src/webinspector.ts` | L3 probe (against a real sim) |
| **CDP translation**        | `src/cdp/ios-protocol.ts`, `src/cdp/target.ts` | L3 `cdp-domains.ts`     |
| **Server / discovery**     | `src/cdp/server.ts`, `src/index.ts`, `bin/cli.ts` | `curl /json/list`, L3 probe |
| **Parsers**                | `src/plist.ts`, `src/stream.ts`                | L1 `bun test`           |

### What conflicts

- Two agents editing `ios-protocol.ts` filter pipeline simultaneously will
  conflict. Coordinate on the Slack channel / split by domain (one does
  `Network`, another does `CSS`, etc.).
- The `cdp-domains.ts` baseline table in this doc is the merge point for
  any "I made domain X work" change — update it in the same PR.

### What does not conflict

- New parser features in `src/plist.ts` are independent of CDP work.
- Transport changes are independent of CDP changes — provided the
  `WebInspectorClient` public API is stable.
- Adding a new probe to `cdp-domains.ts` is append-only; no conflict.

### Shared resources to be careful with

- **The CDP server's port (9222).** Two agents running `bun bin/cli.ts cdp`
  will collide. Pass `--port` to disambiguate, or kill the other first
  (`lsof -i :9222`).
- **The simulator.** Two agents both running `simctl openurl` will fight
  over what page is foreground. If the test needs a deterministic URL,
  re-`openurl` it as the first step.
- **A single Safari page can have only one debugger attached at a time.**
  The bridge does *not* enforce this — it allocates a fresh `senderKey` for
  every WS client and forwards both. Safari then silently picks one to
  serve; the loser hangs forever with no error. If your probe hangs on
  `Runtime.enable`, the most likely cause is a second client (another
  agent, a stale Chrome tab, VS Code's debugger) already attached.
- **Repeated dual-attach can wedge `webinspectord_sim`.** Symptom:
  `/json/list` returns empty for minutes even after restarting the
  bridge, even though Safari clearly has pages open. Recovery:
  `xcrun simctl shutdown booted && xcrun simctl boot <udid>`. Avoid
  attaching twice in the first place.

### Hand-off contract

If you finish a feature and pass it to a reviewer or the next agent,
include in the PR description:

1. The L3 survey output before and after (paste the `cdp-domains.ts` block).
2. Any update to the baseline table in this doc.
3. If the change touches L4-visible behavior: a GIF or screenshot.

That gives the next agent enough to keep moving without re-deriving state.
