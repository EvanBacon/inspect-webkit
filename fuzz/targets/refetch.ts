// Network.getResponseBody host-side re-fetch (review #10, confused deputy):
// page-chosen URLs, attacker-controlled DNS answers and redirect chains.
//
// Every connection refetch() makes is checked against an oracle written
// independently of refetch.ts (WHATWG URL canonicalisation + its own IPv6
// expansion):
//   - "public": never an internal address (loopback, private, link-local,
//     CGNAT, this-network, ULA, site-local, multicast), nor one embedding
//     an internal IPv4 (IPv4-mapped / -compatible, NAT64, 6to4);
//   - "any": never this machine's bridge port;
//   - "off": no connection at all;
//   - only http(s), no userinfo in the URL, Cookie / Authorization only to
//     the page's own origin, same-origin redirects only, at most
//     maxRedirects hops;
//   - it settles (with a RefetchError on refusal) — no hang, no other error.

import { refetch, RefetchError, type RefetchDeps } from "../../src/cdp/refetch";
import { Bytes } from "../lib/bytes";
import { check, checkGlobal, harness, setupHarness } from "../lib/invariants";

setupHarness();

const BRIDGE = 9222;
const LOCAL = ["192.168.1.91", "fe80::1", "2a01:4f8::abcd"];

const HOSTS = [
  "example.com", "localhost", "127.0.0.1", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "0", "0.0.0.0",
  "[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::127.0.0.1]", "[64:ff9b::127.0.0.1]",
  "[64:ff9b::a00:1]", "[2002:7f00:1::]", "[2002:5db8:d822::1]", "[fe80::1]", "[fc00::1]", "[fec0::1]", "[ff02::1]",
  "[2606:2800:220:1::1]", "10.0.0.1", "172.16.5.4", "172.32.0.1", "192.168.1.91", "169.254.169.254", "100.64.0.1",
  "100.128.0.1", "8.8.8.8", "93.184.216.34", "evil.example", "rebind.example", "[2001::1]", "[::]", "[2a01:4f8::abcd]",
];
const DNS = [
  "93.184.216.34", "8.8.8.8", "127.0.0.1", "127.9.9.9", "10.1.2.3", "192.168.1.91", "172.20.0.1", "169.254.169.254",
  "100.100.100.100", "0.0.0.0", "::1", "::", "fe80::1", "fe80::1%en0", "fc12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "64:ff9b::7f00:1", "2002:a00:1::1", "2606:2800:220:1::1", "2a01:4f8::abcd",
  "::ffff:0:7f00:1", "::7f00:1", "FE80::1", "ff02::1", "fec0::1", "2001:db8::1",
];

function v4(s: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? m.slice(1).map(Number) : null;
}

function internalV4([a, b]: number[]): boolean {
  return a === 127 || a === 10 || a === 0 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b! >= 64 && b! <= 127) || a! >= 224;
}

/** 8 words via the WHATWG URL parser's canonical IPv6, or null. */
function v6Words(addr: string): number[] | null {
  let host: string;
  try {
    host = new URL(`http://[${addr.replace(/%.*$/, "")}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [l, r] = host.includes("::") ? host.split("::") : [host, undefined];
  const left = l ? l.split(":") : [];
  const right = r ? r.split(":") : [];
  const words = [...left, ...new Array(8 - left.length - right.length).fill("0"), ...right].map((x) => parseInt(x, 16));
  return words.length === 8 ? words : null;
}

/** Oracle: does connecting here reach something internal? */
export function internal(addr: string): boolean {
  const a = v4(addr);
  if (a) return internalV4(a);
  const w = v6Words(addr);
  if (!w) return true; // unparseable: treat as internal
  const emb = [w[6]! >> 8, w[6]! & 0xff, w[7]! >> 8, w[7]! & 0xff];
  if (w.slice(0, 7).every((x) => x === 0)) return true; // ::, ::1
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return true; // mapped / compatible: be strict
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0) return true; // SIIT
  if (w[0] === 0x64 && w[1] === 0xff9b) return internalV4(emb) || w[2] !== 0;
  if (w[0] === 0x2002) return internalV4([w[1]! >> 8, w[1]! & 0xff, w[2]! >> 8, w[2]! & 0xff]);
  const top = w[0]!;
  return (top & 0xfe00) === 0xfc00 || (top & 0xffc0) === 0xfe80 || (top & 0xffc0) === 0xfec0 || (top & 0xff00) === 0xff00;
}

function onThisMachine(addr: string): boolean {
  const a = v4(addr);
  if (a) return a[0] === 127 || a[0] === 0 || LOCAL.includes(addr);
  const w = v6Words(addr);
  if (!w) return true;
  if (w.slice(0, 7).every((x) => x === 0)) return true;
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return onThisMachine(`${w[6]! >> 8}.${w[6]! & 0xff}.${w[7]! >> 8}.${w[7]! & 0xff}`);
  return LOCAL.some((l) => v6Words(l)?.join() === w.join());
}

async function run(data: Uint8Array): Promise<void> {
  const b = new Bytes(data);
  const policy = (["public", "any", "off"] as const)[b.u8() % 3]!;
  const scheme = b.pick(["http", "https", "HTTP", "ftp", "file", "javascript", "ws", "data"]);
  const host = b.u8() % 6 === 0 ? b.str() : b.pick(HOSTS);
  const port = b.pick(["", ":80", ":443", `:${BRIDGE}`, ":9223", ":0", ":65535", ":99999", ":9222/../"]);
  const user = b.pick(["", "u:p@", "admin@", ":@"]);
  const path = b.pick(["/", "/x?y=1", "/%2e%2e/", "", "#frag", "/@evil.example/"]);
  const url = `${scheme}://${user}${host}${port}${path}`;
  const docOrigin = b.pick(["", url, "https://example.com/", "http://evil.example/", "about:blank", "not a url"]);
  const headers: Record<string, string> = {};
  for (const k of ["Cookie", "Authorization", "authorization", "X-Probe", "Host", "Range", "Proxy-Authorization"]) {
    if (b.bool()) headers[k] = "v";
  }
  const maxRedirects = b.int(0, 3);
  const calls: Array<{ url: URL; address: string; headers: Record<string, string> }> = [];
  const deps: RefetchDeps = {
    async lookup() {
      const n = b.int(0, 3);
      const out = [];
      for (let i = 0; i < n; i++) {
        const address = b.pick(DNS);
        out.push({ address, family: address.includes(":") ? 6 : 4 });
      }
      return out;
    },
    async request(r) {
      calls.push({ url: new URL(r.url.href), address: r.address, headers: { ...r.headers } });
      if (b.u8() % 7 === 0) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      const status = b.pick([200, 301, 302, 303, 307, 308, 404]);
      const h: Record<string, string> = { "content-type": "text/plain" };
      if (status >= 300 && status < 400 && b.u8() % 5 !== 0) {
        h.location = b.pick(["/next", "//evil.example/", "http://127.0.0.1:9222/json", r.url.href, `${r.url.origin}/again`, "javascript:1", "::", `http://${b.pick(HOSTS)}/`]);
      }
      return { status, headers: h, body: new Uint8Array(0) };
    },
    localAddresses: () => LOCAL,
  };

  let outcome: unknown = null;
  try {
    await refetch(url, { policy, headers, documentURL: docOrigin, bridgePorts: [BRIDGE], timeoutMs: 1000, maxBytes: 1024, maxRedirects }, deps);
  } catch (e) {
    outcome = e;
    const ok = e instanceof RefetchError || (e as Error)?.message === "refused";
    check(ok, `refetch threw ${(e as Error)?.name}: ${(e as Error)?.message}`);
  }
  void outcome;

  if (policy === "off") check(calls.length === 0, "re-fetch connected with policy off");
  check(calls.length <= maxRedirects + 1 + 3, `${calls.length} requests for ${maxRedirects} redirects`);
  let first: string | null = null;
  try {
    first = new URL(url).origin;
  } catch {}
  for (const c of calls) {
    check(c.url.protocol === "http:" || c.url.protocol === "https:", `fetched a ${c.url.protocol} URL`);
    check(c.url.username === "" && c.url.password === "", "userinfo forwarded");
    check(c.url.origin === first, `cross-origin hop to ${c.url.origin} (from ${first})`);
    const p = Number(c.url.port) || (c.url.protocol === "https:" ? 443 : 80);
    if (policy === "public") check(!internal(c.address), `public re-fetch connected to internal ${c.address} (${c.url.href})`);
    check(!(p === BRIDGE && onThisMachine(c.address)), `re-fetch reached the bridge port: ${c.address}:${p}`);
    let pageOrigin: string | null = null;
    try {
      const d = new URL(docOrigin);
      if (d.protocol === "http:" || d.protocol === "https:") pageOrigin = d.origin;
    } catch {}
    if (c.headers.cookie !== undefined || c.headers.authorization !== undefined) {
      check(pageOrigin === c.url.origin, `credentials sent to ${c.url.origin} for page ${pageOrigin}`);
    }
    for (const k of Object.keys(c.headers)) check(!["host", "range", "proxy-authorization"].includes(k), `forwarded ${k}`);
  }
  checkGlobal();
}

export const fuzz = harness(run);
