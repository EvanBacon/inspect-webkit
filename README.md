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
server.getSources();                          // [{ id, kind, label, udid, state }]
// ... later
server.stop();
```

Sources (booted simulators, USB / Wi-Fi devices) are discovered
continuously: a simulator booted or a device plugged in after the server
starts shows up on its own, and a dropped connection is re-established with
backoff. Each source is held over **one long-lived connection** shared by
`startCdpServer()` and `listTargets()` in the same process; this keeps the
simulator's `webinspectord_sim` from idle-exiting (it exits when its last
client disconnects, and launchd then delays its restart by ~10 s).
`listTargets()` waits (up to 15 s) for a source that is still connecting
instead of returning an empty list, and keeps its connections warm for 30 s
afterwards without keeping the process alive.

Ids are stable and UDID-based: target ids look like
`sim:<UDID>:<appId>:<pageId>` / `device:<UDID>:<appId>:<pageId>`, and
`Target.udid` is the simulator's real UDID. (Versions up to 0.0.5 used the
unstable `sim:<launchd pid>`.)

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

**Security.** The bridge is unauthenticated and can run JavaScript in every
inspectable page, so by default it listens on loopback only (`127.0.0.1` and
`::1`). It rejects requests whose `Host` header isn't `localhost`, `127.0.0.1`,
`[::1]` or the `--host` you passed (403, which blocks DNS rebinding). It also
rejects WebSocket upgrades that carry an `Origin` other than
`devtools://devtools` (403, so web pages can't drive it). Native clients
(`chrome://inspect`, VS Code, Puppeteer) send no `Origin` and are unaffected.

- `--host 0.0.0.0` exposes the bridge to your network. Only do that on a
  network you trust; the bridge prints a warning when you do.
- `--allow-origin <origin...>` accepts extra WebSocket origins, for example a
  hosted DevTools frontend. Pass `"*"` to accept any origin.
- `--response-body-refetch <public|any|off>` (API: `responseBodyRefetch`)
  controls the fallback for `Network.getResponseBody`. The bridge first asks
  WebKit for the body. Only if WebKit can't supply it does the bridge re-fetch
  the URL from your Mac. That URL is chosen by the inspected page, so the
  re-fetch is restricted:
  - it uses http/https only;
  - addresses are checked after DNS resolution, and the connection is pinned
    to the checked address;
  - it follows only same-origin redirects, at most 3, and checks each hop;
  - it sends `Cookie`/`Authorization` only to the page's own origin;
  - it times out after 10 s and refuses bodies over 4 MB.

  The modes:
  - `public` (default) refuses loopback, link-local (`169.254/16`,
    `fe80::/10`), private (RFC 1918, CGNAT, `fc00::/7`) and reserved
    addresses.
  - `any` also allows localhost and the LAN, for local dev servers, but never
    the bridge's own ports.
  - `off` never re-fetches.

Several clients can debug the same page at once — for example
`chrome://inspect` DevTools and VS Code, a DevTools window reopened while
the old one is still connected, or a Puppeteer script next to DevTools.
WebKit itself allows one inspector connection per page, so the bridge
holds that one connection and shares it:

- every client gets its own replies (request ids are rewritten per client);
- events go to every client that enabled their domain;
- `X.enable` / `X.disable` are reference-counted. Only the first enable and
  the last disable reach Safari. A client that enables a domain someone
  else already enabled is sent the current execution contexts, parsed
  scripts, pending pause and console messages first, like a fresh enable;
- a client that disconnects releases what only it enabled and removes its
  own breakpoints; the others keep working.

Some WebKit state is per page, not per client, and is therefore shared:
the pause state (any client can resume), pause-on-exceptions and other
debugger settings (last writer wins), and DOM node ids. A `DOM.getDocument`
from one client resets the node ids the other clients hold, so two clients
both using an Elements panel on the same page will disturb each other.

Before this release, a second client replaced the first, whose WebSocket
was closed with 1011 "replaced by a newer DevTools session"; that no longer
happens. When the page, its app or the simulator/device goes away, the
bridge closes every client's WebSocket with 1011 and a reason, instead of
leaving it hanging.

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
- `Page` — `navigate` (native, or a `location.href` shim on iOS 27 where
  WebKit dropped it; always replies `{frameId, loaderId}`), `reload`,
  `getResourceTree`, navigation history shim,
  cross-origin nav handling (`Target.didCommitProvisionalTarget`).
- `DOM` — `getDocument`, `performSearch`, `pushNodesByBackendIdsToFrontend`,
  `getBoxModel`, `getNodeForLocation`, `resolveNode`.
- `DOMDebugger` — `getEventListeners`; breakpoint methods accepted (no-op:
  WIR removed `DOM.set{Event,URL}Breakpoint` in iOS 26).
- `CSS` — full Styles panel including **live edit** (`setStyleTexts` with
  range → WIR ordinal mapping), `getMatchedStylesForNode`, `addRule`.
- `Network` — cookies (`getAll/set/delete/clearBrowserCookies`), request
  lifecycle events (`requestWillBeSent`, `responseReceived`,
  `loadingFinished`), `getResponseBody` (WebKit's own, with a restricted
  re-fetch fallback; see `--response-body-refetch`), `setCacheDisabled`,
  `setUserAgentOverride`, `setExtraHTTPHeaders`, `emulateNetworkConditions`.
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

- `Page.captureScreenshot` — not exposed by WIR.
- `Page.startScreencast` — accepted but Safari emits no frames on iOS 26.
- `Emulation.setDeviceMetricsOverride` — `Page.setScreenSizeOverride` was
  removed in iOS 26 and `Page.overrideSetting` doesn't accept a device-
  metrics setting; bridge swallows so DevTools doesn't surface a failure.

Set `INSPECT_WEBKIT_DEBUG=1` to log every CDP frame in either direction.

Set `INSPECT_WEBKIT_CAPTURE=<dir>` to record traffic for fuzzing: every raw
WIR frame (both directions) and every CDP message on a client WebSocket is
appended to `<dir>/capture-<pid>-<time>.jsonl`. It's off by default and
costs nothing when off. Captures hold page contents and whatever you type
into DevTools, so treat them as sensitive. See [`fuzz/README.md`](fuzz/README.md).

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
simulator. Sockets of shut-down simulators are left behind, so a cheap
`readdir` of `/private/var/tmp/com.apple.launchd.*` (every second) only
triggers discovery; the socket is mapped to its simulator with
`xcrun simctl list devices booted` + `xcrun simctl getenv <udid>
RWI_LISTEN_SOCKET` (`lsof -U` is the fallback when `simctl` is missing). We
connect directly: same RPC, no TLS, no usbmux, no lockdown.

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
  sim.ts           Unix-socket transport to webinspectord_sim
  core/
    source-manager.ts  long-lived connection per source, state machine
                       (connecting → ready → closed → backoff), shared
                       by startCdpServer() and listTargets()
    sim-discovery.ts   booted simulators → sockets (readdir + simctl)
    device-discovery.ts usbmuxd ListDevices + Listen (hot-plug), USB/Wi-Fi dedupe
  cdp/
    server.ts      Bun.serve HTTP+WS on :9222; /json/list, /devtools/page/<id>
    target.ts      per-session class — wraps WIR forwardSocket; handles
                   target-based mode (Target.{send,dispatch}MessageFromTarget
                   in their own id space; inner-target state machine for
                   created / destroyed / provisional-commit, with state
                   replay onto the new target). Client request ids must be
                   non-negative: negative ids are reserved for the bridge.
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
