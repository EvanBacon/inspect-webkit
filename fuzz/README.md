# Fuzzing inspect-webkit

Two engines drive the same harnesses:

- **fast-check, inside `bun test`**: every target runs its committed seeds,
  its regression inputs and a bounded number of random or mutated inputs on
  each `bun test` (`fuzz/properties/fuzz-targets.test.ts`). The older model
  tests (`target-model`, `page-channel-model`, `plist-property`) use the
  same knob.
- **jazzer.js (libFuzzer, coverage-guided), under Node**: each target is
  bundled with Bun into an ES module (`fuzz/dist/<target>.mjs`). jazzer
  instruments that bundle at load time and drives it.

A target is `fuzz/targets/<name>.ts`. It exports `fuzz(data)`, which throws
when an invariant breaks, and runs unchanged under Bun or Node.

## Targets

| target | what it exercises | key invariants |
|---|---|---|
| `plist-bplist` | `decodeBinary` (+ `decode`), round trip through `encodeXml`/`decodeXml` | throws only `PlistError`; tight limits respected; decode → encode → decode is identity; dicts prototype-less; no amplification (slow decode) |
| `plist-xml` | `decodeXml` (+ `decode`), same round trip | same |
| `framing` | WIR `WebInspectorClient` read loop, `usbmux.readFrame`, `lockdown.readFrame` with fuzz-chosen chunking | same frames whatever the chunking; only `Error` rejections; the loop always ends; a throwing subscriber doesn't stop it |
| `cdp-tools` | `Target.onMessageFromTools` + every iOS domain filter, with a fake Safari that answers everything (reply templates from the input) | **exactly one reply** per request; no leaked bridge/envelope ids; JSON-only output; `getResponseBody` re-fetch never connects to non-public addresses (`public`) or the bridge port (`any`) |
| `page-channel` | `PageChannel` with up to 3 clients (full filters), colliding ids, out-of-order Safari replies, inner-target lifecycle | exactly one reply per request per attached client; no foreign ids; sender set up once and released once; no routes left |
| `wir-server` | a real `CdpServer` (no sockets) fed hostile webinspectord RPC traffic: app lists, connect/disconnect, listings, forwarded data, source loss and reconnect, plus HTTP, page WebSockets and hover highlights | WIR subscribers never throw; `/json/list` and `/` answer 200 with well-typed entries; sessions on a lost source close with 1011; no stale targets |
| `browser-endpoint` | `/devtools/browser` Target.* discovery, auto-attach and flatten-mode routing against a changing target list and fake page sessions | handler never throws; exactly one reply per request (with its sessionId); each page session closed exactly once, no traffic after close |
| `front-door` | HTTP routes and WebSocket upgrades of three server configs (localhost, wildcard + extra origin, LAN IP), then WS frames | any non-localhost domain in `Host` → 403 (DNS rebinding); un-allowlisted `Origin` on an upgrade → 403; 101 only for real endpoints; reflected URLs are clean |

Every target also checks that no error escapes (unhandled rejection,
uncaught exception) and that `Object.prototype`, `Array.prototype`,
`Function.prototype` and `String.prototype` are untouched.

### Input formats

- Codec and framing targets take raw bytes. For `framing`, byte 0 picks
  the chunking and byte 1 the readers.
- CDP targets take text lines (`fuzz/lib/cdp-lines.ts`). Byte 0 is a
  schedule byte (reply order, re-fetch policy). Then:

  | line | meaning |
  |---|---|
  | `T<json>` | client → bridge (`<n>T` addresses client n) |
  | `W<json>` | Safari → bridge |
  | `R{"m":method,"result"\|"error":…}` | how Safari answers `method` |
  | `A` / `D<n>` | attach a client / detach client n (`page-channel`) |
  | any other line | its bytes drive a structured generator: method names from the filter tables, hostile params, lifecycle events |

- `wir-server` takes `S<typed JSON>` WIR messages. The typed JSON uses
  `{"$data":…}`, `{"$date":…}` and `{"$big":…}` for non-JSON plist leaves.
  Any other line drives its generator.
- `front-door` takes these lines: `G path` / `U path` / `M METHOD path`,
  then `H host`, `O origin`, `V` / `K` (WebSocket version / key),
  `X name: value`, `W text` (WebSocket frame), `B raw`.

## Running

```sh
# CI-sized (part of the normal suite)
bun test fuzz/properties

# Long fast-check runs: 100k cases per property, no per-test timeout
FUZZ_RUNS=100000 bun test fuzz/properties src/__tests__/plist-property.test.ts \
  src/cdp/__tests__/target-model.test.ts src/cdp/__tests__/page-channel-model.test.ts

# jazzer.js (Node >= 20)
cd fuzz && npm install && cd ..   # @jazzer.js/core, kept out of the root package
bun fuzz/scripts/build.ts                         # all targets → fuzz/dist/*.mjs
bun fuzz/scripts/run.ts cdp-tools --minutes 60 --round r1
```

`run.ts` wraps jazzer:

- It keeps the working corpus, logs and crash artifacts outside the repo,
  in `../p2/{corpus/work,fuzz-logs,fuzz-artifacts}` by default (see
  `--corpus`, `--logs`, `--artifacts`).
- Seeds come from `fuzz/seeds/<target>` and from the full captured corpus
  `../p2/corpus/<target>` when it exists.
- After a crash it records the signature and **restarts with that
  signature in `FUZZ_IGNORE`**, so one known bug doesn't stop the search for
  the next one.
- When it finishes it writes `<target>-<round>.json`: wall and CPU time,
  executions, the libFuzzer `cov`/`ft` peaks, and the crashes.
- The bridge's handled-error log lines are counted per normalised message
  in `<target>-<round>.soft.txt`.

Reproduce a failing input:

```sh
bun fuzz/scripts/repro.ts <target> <file|dir>          # Bun (fast, no WS accept)
node fuzz/scripts/replay-node.mjs <target> <file|dir>  # Node, real ws (needs a build)
```

## Corpus

1. Capture real traffic: run the bridge with `INSPECT_WEBKIT_CAPTURE=<dir>`.
   `fuzz/scripts/capture-session.ts <dir> [--port N] [--kill]` does this
   against a booted simulator. It drives a scripted DevTools-like session:
   attach, Runtime / DOM / CSS / Network / Debugger / Console, a second
   client, the browser endpoint, a cross-origin `Page.navigate`, a reload,
   and with `--kill` a Safari kill while attached.
2. `bun fuzz/scripts/corpus-from-capture.ts <outDir> <dir>/*.jsonl` splits a
   capture into per-target seed files.
3. `fuzz/scripts/minimize-seeds.sh <target> <N> <maxBytes> <corpus>...`
   rebuilds `fuzz/seeds/<target>` from a corpus. It uses libFuzzer
   `-merge=1`, then keeps the N smallest files.

Commit only `fuzz/seeds/` (a few files per target) and
`fuzz/regressions/` (minimized crash inputs, each under 64 KB). Captures
contain page contents, so keep them out of the repo.

## Adding a regression

Every fuzz finding gets a unit test in `src/**/__tests__` that fails before
the fix. When the minimized input is small and meaningful, also drop it into
`fuzz/regressions/<target>/`; the property test replays it on every
`bun test`.
