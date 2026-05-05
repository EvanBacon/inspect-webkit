# inspect-webkit

Headlessly list debuggable Safari / WKWebView targets across iOS devices and
Simulators — no Xcode-developer-menu clicking, no `ios_webkit_debug_proxy`,
no `libimobiledevice`. Pure Bun/TypeScript, written for AI agents and CI.

## Why

Debugging a WKWebView normally requires opening Safari on macOS, enabling the
Develop menu, and clicking through host → app → page. That's fine for a
human; it's hostile to anything programmatic. This tool exposes those
targets as a flat machine-readable list.

## Install

```bash
bun add inspect-webkit          # as a dependency
bunx inspect-webkit             # one-off, no install
```

No native dependencies. Pure Bun/TypeScript end-to-end.

## CLI

```bash
inspect-webkit [--port 9222] # CDP bridge: debug iOS pages from Chrome / VS Code
```

From a checkout, replace `inspect-webkit` with `bun bin/cli.ts`.

## API

```ts
import { listTargets, startCdpServer } from "inspect-webkit";

const targets = await listTargets();          // device + simulator pages

const server = await startCdpServer({ port: 9222 });
// ... later
server.stop();
```

### CDP bridge — debug iOS pages with Chrome DevTools or VS Code

```bash
inspect-webkit                # serves http://localhost:9222
```

This stands up a Chrome DevTools Protocol endpoint backed by Safari's Web
Inspector. Each iOS page (device or simulator) shows up as a CDP target.

**Chrome DevTools.** Open `chrome://inspect/#devices`, click *Configure…*,
add `localhost:9222`, click *Done*. Wait a couple seconds — your iOS target
appears under "Remote Target". Click *inspect* to open DevTools attached.

> Modern Chrome (≥ v147) silently rejects `devtools://` URLs from argv,
> address-bar paste, and link clicks — `chrome://inspect` is the only
> reliable attach path. If you see "Inspect with Chrome Developer Tools"
> open as a regular tab instead of a DevTools window, you've hit that
> block; go through `chrome://inspect` instead.

**VS Code.** Add a launch configuration:

```jsonc
{
  "type": "chrome",
  "request": "attach",
  "name": "iOS Safari (CDP bridge)",
  "port": 9222,
  "urlFilter": "*"
}
```

Run it and pick the page from the dropdown — set breakpoints, evaluate, step
through, exactly like a normal web target.

#### Translation layer

The bridge translates between Chrome DevTools Protocol (CDP) and Safari's
remote Web Inspector wire protocol — the one whose IPC dictionary keys all
start with `WIR*` (`WIRApplicationDictionaryKey`, `WIRSocketDataKey`, …),
which we shorten to "WIR" throughout this codebase as a label for that
surface. Per-domain filters live in `src/cdp/domains/*.ts`,
each owning a small slice of the surface (Runtime, Debugger, DOM, CSS, …).
The structure is informed by Microsoft's
[`remotedebug-ios-webkit-adapter`](https://github.com/RemoteDebug/remotedebug-ios-webkit-adapter)
inventory, but the code is a from-scratch Bun/TS rewrite — no `lodash`,
`async-lock`, `p-timeout`, or EventEmitter; closures over a `Target`
session, table-driven renames, ~half the LOC.

What works:

- `Runtime` — `evaluate`, `getProperties`, `callFunctionOn`, `releaseObject*`
- `Debugger` — `enable`, breakpoints (incl. `setBreakpointByUrl`),
  stepping/resume/pause, `scriptParsed`. **`debugger;` statements pause
  correctly** (the bridge kicks `setPauseOnDebuggerStatements` on enable —
  CDP has no equivalent because Chrome treats it as on-by-default).
- `Console` / `Log` — `console.log` surfaces as `Runtime.consoleAPICalled`
  (Safari's native channel); `Log.entryAdded` for browser-generated entries.
- `Page` — `navigate`, `reload`, `getResourceTree`, navigation history shim,
  cross-origin nav handling (`Target.didCommitProvisionalTarget`).
- `DOM` — `getDocument`, `performSearch`, `pushNodesByBackendIdsToFrontend`,
  `getBoxModel`, `getNodeForLocation`, `resolveNode`.
- `DOMDebugger` — `getEventListeners`; breakpoint methods accepted (no-op:
  WIR removed `DOM.set{Event,URL}Breakpoint` in iOS 26).
- `CSS` — full Styles panel including **live edit** (`setStyleTexts` with
  range → WIR ordinal mapping), `getMatchedStylesForNode`, `addRule`.
- `Network` — cookies (`getAll/set/delete/clearBrowserCookies`), request
  lifecycle events (`requestWillBeSent`, `responseReceived`,
  `loadingFinished`), `setCacheDisabled`, `setUserAgentOverride`,
  `setExtraHTTPHeaders`, `emulateNetworkConditions`.
- `Emulation` — `setEmulatedMedia`, `setUserAgentOverride`,
  `setTouchEmulationEnabled`, `setScriptExecutionDisabled`.
- `Overlay` — `highlightNode`/`Frame`/`Quad`/`Rect`, `hideHighlight`,
  `setInspectMode`, `setShowPaintRects`.
- `Browser` — `getVersion`. `Input` — `dispatchMouseEvent` via
  `Runtime.evaluate`. `IO` — `read`/`close` for heap snapshot streams.
  `Accessibility` — `getPartialAXTree`.
- Target-based mode (iOS 13+) — auto-detected, transparently wraps in
  `Target.sendMessageToTarget` / unwraps `Target.dispatchMessageFromTarget`.
- **CDP-only attach barrage absorbed at the bridge.** Modern Chrome
  DevTools sends ~70 commands at attach, including ~30 that iOS 26
  doesn't implement (`CSS.trackComputedStyleUpdates`, `Storage.getStorageKey`,
  `Animation.enable`, `Autofill.*`, `Profiler.enable`, `Overlay.setShowFlexOverlays`,
  …). Forwarding any one of these can wedge Safari's inner page target
  so unrelated subsequent commands silently drop, freezing the entire
  inspector. The bridge stubs all known CDP-only commands at the
  bridge in `src/cdp/domains/cdp-only-stubs.ts` (~80 entries) so they
  never reach Safari.

What doesn't (Safari-side gaps, not bridge bugs):

- `Network.getResponseBody` — Safari doesn't expose response bodies.
- `Page.captureScreenshot` — not exposed by WIR.
- `Page.startScreencast` — accepted but Safari emits no frames on iOS 26.
- `Emulation.setDeviceMetricsOverride` — `Page.setScreenSizeOverride` was
  removed in iOS 26 and `Page.overrideSetting` doesn't accept a device-
  metrics setting; bridge swallows so DevTools doesn't surface a failure.

Set `INSPECT_WEBKIT_DEBUG=1` to log every CDP frame in either direction.

#### Verification

The bridge ships with layered e2e probes under `scripts/e2e/` —
`cdp-probe.ts` (sanity), `cdp-domains.ts` (51-method survey), and
`cdp-debugger-paused.ts` (regression guard for the pause-on-debugger
kick). See [`docs/e2e-verification.md`](docs/e2e-verification.md) for the
L1–L4 ladder and the OK/ERR baseline.

Example — list every debuggable target:

```
$ inspect-webkit &
$ curl -s http://localhost:9222/json/list | jq '.[] | {title, url, webSocketDebuggerUrl}'
```

Set `INSPECT_WEBKIT_DEBUG=1` to trace the lockdown / TLS / RPC handshake.

## Requirements

- macOS host
- iOS device paired and "Trust This Computer" accepted
- on the device: **Settings → Safari → Advanced → Web Inspector** ON
- for WKWebView on iOS 16.4+: the host app must set
  `webView.isInspectable = true`

## How it works

Three transports, one shared `_rpc_*` Web Inspector protocol:

| Source        | Transport                                                                              | Status |
| ------------- | -------------------------------------------------------------------------------------- | ------ |
| iOS device    | `/var/run/usbmuxd` → lockdown TLS upgrade → `com.apple.webinspector`                   | ✅     |
| iOS Simulator | `/private/var/tmp/com.apple.launchd.*/com.apple.webinspectord_sim.socket` (Unix)       | ✅     |
| Desktop Safari| Mach `com.apple.webinspector.debugger`                                                 | ❌     |

### Device path

1. Connect to `usbmuxd` over the Unix socket.
2. `ReadPairRecord` to fetch `HostCertificate` / `HostPrivateKey` /
   `RootCertificate` — usbmuxd serves these to non-root processes, sidestepping
   the `/var/db/lockdown/*.plist` permission gate on modern macOS.
3. Tunnel to lockdownd (port 62078), `QueryType` + `StartSession` →
   `EnableSessionSSL: true`, `socket.upgradeTLS()` with the pair record.
4. `StartService("com.apple.webinspector")` returns a fresh service port.
5. Open a new tunnel to that port, upgrade to TLS again with the same cert.
6. Speak length-prefixed plist frames carrying `_rpc_reportIdentifier:`,
   `_rpc_getConnectedApplications:`, `_rpc_forwardGetListing:` — collect
   `WIRApplicationDictionaryKey` and `WIRListingKey` into a flat target list.

### Simulator path

`webinspectord_sim` listens on a launchd-managed Unix socket per booted
runtime. We discover the active socket via `lsof -U` (the daemon process
owns it) and connect directly. Same RPC, no TLS, no usbmux, no lockdown.

### Desktop Safari (not supported)

`com.apple.webinspector.debugger` is gated by Apple's private entitlement
`com.apple.private.webinspector.remote-inspection-debugger`, which only
Apple-signed Safari has — no userland process can enumerate desktop Safari
targets. Use Safari's own Develop menu, a Safari Web Extension, or
`safaridriver` (WebDriver) instead.

## Layout

```
src/
  index.ts         public API (listTargets, listDevices, startCdpServer)
  plist.ts         XML + bplist00 parser
  stream.ts        byte-stream read(n) helper for layered framings
  usbmux.ts        /var/run/usbmuxd: ListDevices, ReadPairRecord, Connect
  lockdown.ts      plist-frame protocol + TLS upgrade with pair record
  webinspector.ts  shared _rpc_* RPC (works for device & simulator)
  sim.ts           lsof-based discovery of webinspectord_sim sockets
  cdp/
    server.ts      Bun.serve HTTP+WS on :9222; /json/list, /devtools/page/<id>
    target.ts      per-session class — wraps WIR forwardSocket; handles
                   target-based mode (Target.{send,dispatch}MessageFromTarget,
                   didCommitProvisionalTarget on cross-origin nav)
    ios-protocol.ts thin orchestrator that wires per-domain filters
    domain.ts      shared helpers (swallowWith, DomainCtx)
    domains/*.ts   one file per CDP domain (Runtime, Debugger, DOM, CSS, …)
                   plus cdp-only-stubs.ts — ack-stubs ~80 commands that
                   iOS 26 doesn't implement, to prevent wedging the inner
                   page target during DevTools' attach barrage
bin/cli.ts         CLI: cdp
scripts/e2e/       L3 protocol probes (see docs/e2e-verification.md)
```

## Tests

Two layers; see [`docs/e2e-verification.md`](docs/e2e-verification.md) for
the full guide.

```bash
# L1 — unit tests (parsers, framing)
bun test

# L3 — CDP↔WIR translation (boot a sim, then)
inspect-webkit --port 9222 &
WS=$(curl -s http://localhost:9222/json/list | jq -r '.[0].webSocketDebuggerUrl')
bun scripts/e2e/cdp-probe.ts "$WS"
bun scripts/e2e/cdp-domains.ts "$WS"
bun scripts/e2e/cdp-debugger-paused.ts "$WS"
```

## License

MIT © [Evan Bacon](https://evanbacon.dev)
