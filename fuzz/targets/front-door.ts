// HTTP / WebSocket front door of the real CdpServer, in-process: request
// paths (percent-encoding, dot segments, garbage), Host and Origin headers,
// upgrade headers, then WebSocket frames on accepted upgrades.
//
// Three servers: the default (localhost), one bound to a wildcard host
// with an extra allowed origin, and one bound to an explicit LAN address.
//
// Invariants (an oracle independent of http.ts):
//   - a Host naming any domain other than localhost is refused with 403
//     (DNS rebinding) — on every server, for requests and upgrades;
//   - an upgrade with an Origin outside {devtools://devtools, allowed} is
//     refused with 403 (cross-site WebSocket hijacking);
//   - every request gets exactly one response; a 101 only for the page /
//     browser endpoints of a known target;
//   - /json/* bodies are JSON; reflected URLs contain no whitespace, quotes
//     or angle brackets;
//   - nothing escapes; no prototype pollution.
//
// Input: requests separated by lines starting with G (GET), U (upgrade) or
// M <method>; header lines H <host>, O <origin>, V <ws version>, K <ws key>,
// X <name>: <value>; W <text> (WS text frame), B (binary/odd frames);
// other lines drive a generator.

import { Bytes } from "../lib/bytes";
import { check, checkGlobal, harness, settle, setupHarness } from "../lib/invariants";
import { makeFakeSource, startServerRig, type ServerRig } from "../lib/server-rig";
import { clientFrame, WS_KEY } from "../lib/fake-net";

setupHarness();

const CAN_UPGRADE = !process.versions.bun;
const PAGE = "sim:fuzz:PID:1:1";
const ALLOWED_ORIGIN = "http://ok.example:3000";

type Server = { rig: ServerRig; allowOrigins: string[]; browserPath: string; trim: () => void };
let serversP: Promise<Server[]> | null = null;

async function servers(): Promise<Server[]> {
  const mk = async (opts: { allowOrigins?: string[]; host?: string }) => {
    const rig = await startServerRig(opts);
    const src = makeFakeSource();
    rig.addSource(src);
    src.push("_rpc_reportConnectedApplicationList:", {
      WIRApplicationDictionaryKey: { "PID:1": { WIRApplicationIdentifierKey: "PID:1", WIRApplicationNameKey: "Safari", WIRIsApplicationProxyKey: false } },
    });
    src.push("_rpc_applicationSentListing:", {
      WIRApplicationIdentifierKey: "PID:1",
      WIRListingKey: { "1": { WIRPageIdentifierKey: 1, WIRTitleKey: "t <b>&", WIRURLKey: "https://example.com/", WIRTypeKey: "WIRTypeWebPage" } },
    });
    await settle(5);
    const v = JSON.parse(rig.get("/json/version").body);
    return { rig, allowOrigins: opts.allowOrigins ?? [], browserPath: new URL(v.webSocketDebuggerUrl).pathname, trim: () => src.trim() };
  };
  return [await mk({}), await mk({ host: "0.0.0.0", allowOrigins: [ALLOWED_ORIGIN] }), await mk({ host: "192.168.1.91" })];
}

type Req = { kind: "G" | "U" | "M"; method: string; path: string; headers: Record<string, string>; frames: Uint8Array[] };

const PATHS = [
  "/", "/json", "/json/list", "/json/version", "/json/protocol", `/devtools/page/${PAGE}`, `/devtools/page/${encodeURIComponent(PAGE)}`,
  "/devtools/page/sim%3Afuzz%3APID%3A1%3A1", "/devtools/page/%E0%A4%A", "/devtools/page/", "/devtools/page/x/../" + PAGE,
  "//[", "/%", "/json/list?x=1#y", "*", "http://evil.example/json/list", "/devtools/browser/", "/DEVTOOLS/page/" + PAGE,
];
const HOSTS = [
  "", "localhost", "localhost:9222", "127.0.0.1:9222", "[::1]:9222", "127.5.6.7", "LOCALHOST:1", "evil.example",
  "evil.example:9222", "localhost.evil.example", "127.0.0.1.nip.io", "192.168.1.91:9222", "10.0.0.1", "[::1]",
  "[fe80::1]:9222", "localhost:", "localhost:99999", "local host", "[::1]x", "0x7f000001", "2130706433", "localhost/evil",
];
const ORIGINS = [
  "", "devtools://devtools", "DEVTOOLS://DEVTOOLS/", "http://evil.example", "null", ALLOWED_ORIGIN, ALLOWED_ORIGIN + "/",
  "http://ok.example", "http://localhost:9222", "file://", "devtools://devtools.evil", "chrome-extension://abc",
];

function parse(data: Uint8Array): Req[] {
  const reqs: Req[] = [];
  let cur: Req | null = null;
  const start = (kind: Req["kind"], method: string, path: string) => {
    cur = { kind, method, path, headers: {}, frames: [] };
    reqs.push(cur);
  };
  for (const line of Buffer.from(data).toString("latin1").split("\n").slice(0, 120)) {
    const t = line[0];
    const rest = line.slice(2);
    if (t === "G") start("G", "GET", rest || "/");
    else if (t === "U") start("U", "GET", rest || "/");
    else if (t === "M") {
      const [m, p] = rest.split(" ");
      start("G", m || "POST", p || "/");
    } else if (cur && t === "H") (cur as Req).headers.host = rest;
    else if (cur && t === "O") (cur as Req).headers.origin = rest;
    else if (cur && t === "V") (cur as Req).headers["sec-websocket-version"] = rest;
    else if (cur && t === "K") (cur as Req).headers["sec-websocket-key"] = rest;
    else if (cur && t === "X") {
      const i = rest.indexOf(":");
      if (i > 0) (cur as Req).headers[rest.slice(0, i).trim().toLowerCase()] = rest.slice(i + 1);
    } else if (cur && t === "W") (cur as Req).frames.push(clientFrame(Buffer.from(rest)));
    else if (cur && t === "B") (cur as Req).frames.push(Buffer.from(rest, "latin1"));
    else generate(new Bytes(Buffer.from(line, "latin1")), reqs);
    cur = reqs.at(-1) ?? null;
  }
  return reqs;
}

function generate(b: Bytes, reqs: Req[]): void {
  while (!b.done && reqs.length < 40) {
    const kind = b.bool() ? "U" : "G";
    const path = b.u8() % 4 === 0 ? b.str() : b.pick(PATHS);
    const headers: Record<string, string> = {};
    const h = b.u8() % 5 === 0 ? b.str() : b.pick(HOSTS);
    if (h !== "" || b.bool()) headers.host = h;
    if (kind === "U" || b.u8() % 4 === 0) {
      const o = b.u8() % 5 === 0 ? b.str() : b.pick(ORIGINS);
      if (o !== "") headers.origin = o;
    }
    const frames: Uint8Array[] = [];
    for (let i = b.int(0, 3); i > 0; i--) {
      const k = b.u8() % 5;
      if (k === 0) frames.push(clientFrame(Buffer.from(JSON.stringify({ id: b.int(1, 9), method: b.pick(["Runtime.evaluate", "Page.setAdBlockingEnabled", "Target.getTargets", "Browser.getVersion", "Target.setDiscoverTargets"]), params: b.json(1) }))));
      else if (k === 1) frames.push(clientFrame(b.bytes(40), b.pick([0x1, 0x2, 0x0, 0x8, 0x9, 0xa, 0x3])));
      else if (k === 2) frames.push(clientFrame(Buffer.from(b.str()), 0x1, false));
      else if (k === 3) frames.push(b.bytes(30));
      else frames.push(clientFrame(Buffer.from([0xff, 0xfe, 0xc0, 0x80])));
    }
    reqs.push({ kind, method: b.pick(["GET", "GET", "GET", "POST", "HEAD", "OPTIONS"]), path, headers, frames });
  }
}

/** Node trims optional whitespace around header values and rejects CR/LF/NUL. */
function realistic(headers: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/[\r\n\0]/.test(v) || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(k)) return null;
    out[k] = v.replace(/^[ \t]+|[ \t]+$/g, "");
  }
  return out;
}

/** Oracle: a Host header naming a domain other than localhost. */
function rebinding(host: string | undefined): boolean {
  if (host === undefined || host.trim() === "") return false;
  const h = host.trim().toLowerCase();
  const name = h.startsWith("[") ? h.slice(1, h.indexOf("]") < 0 ? undefined : h.indexOf("]")) : h.split(":")[0]!;
  return /[g-z]/.test(name) && name !== "localhost";
}

function originRejected(origin: string | undefined, allowed: string[]): boolean {
  if (origin === undefined || origin === "") return false;
  const norm = (o: string) => o.trim().replace(/\/+$/, "").toLowerCase();
  return !["devtools://devtools", ...allowed].map(norm).includes(norm(origin));
}

async function run(data: Uint8Array): Promise<void> {
  const all = await (serversP ??= servers());
  for (const s of all) s.trim();
  const reqs = parse(data);
  for (const [i, r] of reqs.entries()) {
    const s = all[(data[0] ?? 0) % 3 === 0 ? i % 3 : (data[0] ?? 0) % 3]!;
    const headers = realistic(r.headers);
    if (!headers) continue;
    if (r.kind === "G") {
      const res = s.rig.get(r.path, headers, r.method);
      if (rebinding(headers.host)) check(res.status === 403, `Host ${JSON.stringify(headers.host)} answered ${res.status}`);
      if (res.status === 200 && String(res.headers["content-type"] ?? "").startsWith("application/json")) {
        const body = JSON.parse(res.body);
        const urls = JSON.stringify(body).match(/(ws|devtools):\/\/[^"]*/g) ?? [];
        for (const u of urls) check(!/[\s<>]|\\"/.test(u), `reflected URL is unsafe: ${u.slice(0, 80)}`);
      }
      continue;
    }
    const up: Record<string, string> = {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": WS_KEY,
      "sec-websocket-version": "13",
      ...headers,
    };
    const ws = s.rig.upgrade(r.path, up);
    await settle(2);
    const status = ws.status;
    if (rebinding(up.host)) check(status === 403, `upgrade with Host ${JSON.stringify(up.host)} answered ${status}`);
    else if (originRejected(up.origin, s.allowOrigins)) {
      check(status === 403, `upgrade with Origin ${JSON.stringify(up.origin)} answered ${status}`);
    }
    if (status === 101) {
      let pathname = "";
      try {
        pathname = new URL(r.path, "http://x").pathname;
      } catch {}
      let decoded: string | null = null;
      try {
        decoded = decodeURIComponent(pathname.slice("/devtools/page/".length));
      } catch {}
      check(pathname === s.browserPath || (pathname.startsWith("/devtools/page/") && decoded === PAGE), `101 for ${r.path}`);
      for (const f of r.frames) ws.sock.feed(f);
      await settle(3);
      for (const t of ws.texts()) JSON.parse(t);
    } else if (CAN_UPGRADE) {
      check(status !== null, `upgrade got no HTTP response (${r.path})`);
    }
    ws.close();
    await settle(1);
  }
  checkGlobal();
}

export const fuzz = harness(run);
