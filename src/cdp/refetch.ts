// Host-side re-fetch of a response body, for Network.getResponseBody when
// WebKit can't supply it.
//
// The URL comes from the inspected page, so this is a confused-deputy risk
// (review #10): a page could point the Mac at its loopback services, the
// LAN, a VPN or a cloud metadata endpoint and read the answer back through
// the debugger (increasingly an AI agent that page content can steer).
// Rules:
//   - http/https only
//   - the destination is checked AFTER DNS resolution and the checked
//     address is the one connected to (no rebinding between check and use)
//   - policy "public": loopback, link-local, private and reserved
//     addresses are refused; policy "any" allows them (local dev servers)
//     but never the bridge's own ports on this machine
//   - redirects are handled manually: same-origin only, at most
//     maxRedirects hops, each hop re-checked
//   - Cookie / Authorization are sent only when the URL is same-origin
//     with the page that made the request
//   - an overall timeout and a response size cap

import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

/** "off": never re-fetch; "public": public internet only (default);
 *  "any": also loopback / LAN (except the bridge itself). */
export type ResponseBodyRefetch = "off" | "public" | "any";
export const RESPONSE_BODY_REFETCH_MODES: readonly ResponseBodyRefetch[] = ["off", "public", "any"];

export type AddressKind = "public" | "loopback" | "private" | "link-local" | "reserved";

export type RefetchOptions = {
  policy: ResponseBodyRefetch;
  /** Request headers observed on the original request. */
  headers: Record<string, string>;
  /** URL of the document that made the request (credential scoping). */
  documentURL?: string;
  /** Ports this bridge listens on; never fetched on a local address. */
  bridgePorts: number[];
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
};

export type RefetchResult = { status: number; mimeType: string; body: Uint8Array };

export type RefetchDeps = {
  lookup(host: string): Promise<Array<{ address: string; family: number }>>;
  /** One GET to `url`, connecting to `address` (already checked). Must not
   *  follow redirects; must enforce maxBytes; must honour `signal`. */
  request(r: {
    url: URL;
    address: string;
    family: number;
    headers: Record<string, string>;
    signal: AbortSignal;
    maxBytes: number;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  /** Addresses of this machine's interfaces. */
  localAddresses(): string[];
};

export class RefetchError extends Error {
  override name = "RefetchError";
}

// ---------- address classification ----------

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

function classifyV4([a, b, c]: number[]): AddressKind {
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b! >= 64 && b! <= 127) return "private"; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return "private"; // benchmarking
  if (a === 169 && b === 254) return "link-local";
  if (a === 0 || a! >= 224) return "reserved"; // this-network, multicast, 240/4, broadcast
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved";
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "reserved";
  return "public";
}

/** Eight 16-bit words, or null. Accepts "::" compression and a dotted tail. */
function parseV6(s: string): number[] | null {
  let str = s;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  let tail: number[] = [];
  if (dotted) {
    const v4 = parseV4(dotted[1]!);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    str = str.slice(0, -dotted[1]!.length);
    if (str.endsWith(":") && !str.endsWith("::")) str = str.slice(0, -1);
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const words = (h: string) => (h === "" ? [] : h.split(":"));
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  const groups = [...head, ...rest];
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const fill = 8 - groups.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  return [
    ...head.map((g) => parseInt(g, 16)),
    ...new Array(halves.length === 2 ? fill : 0).fill(0),
    ...rest.map((g) => parseInt(g, 16)),
    ...tail,
  ];
}

const v4Of = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

/** One spelling per address: brackets and zone stripped, IPv4-mapped IPv6
 *  (::ffff:a.b.c.d, any notation) unwrapped to dotted IPv4. */
export function canonicalAddress(ip: string): string {
  const s = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (parseV4(s)) return s;
  const w = parseV6(s);
  if (w && w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return v4Of(w[6]!, w[7]!).join(".");
  return s.toLowerCase();
}

export function classifyAddress(ip: string): AddressKind {
  const s = canonicalAddress(ip);
  const v4 = parseV4(s);
  if (v4) return classifyV4(v4);
  const w = parseV6(s);
  if (!w) return "reserved";
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 7) && w[7] === 1) return "loopback"; // ::1
  // NAT64 (inside ::/8, so first): classify the embedded IPv4; the
  // local-use 64:ff9b:1::/48 is private.
  if (w[0] === 0x64 && w[1] === 0xff9b) return zero(2, 6) ? classifyV4(v4Of(w[6]!, w[7]!)) : "private";
  // Everything else in ::/8 (::, IPv4-compatible, SIIT ::ffff:0:a.b.c.d, …).
  if (w[0]! <= 0xff) return "reserved";
  if (w[0] === 0x2002) return classifyV4(v4Of(w[1]!, w[2]!)); // 6to4
  const top = w[0]!;
  if ((top & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((top & 0xffc0) === 0xfec0) return "private"; // site-local (deprecated)
  if ((top & 0xfe00) === 0xfc00) return "private"; // unique local fc00::/7
  if ((top & 0xff00) === 0xff00) return "reserved"; // multicast
  if (top === 0x2001 && (w[1] === 0xdb8 || w[1] === 0)) return "reserved"; // documentation, Teredo
  if (top === 0x3fff && w[1]! < 0x1000) return "reserved"; // documentation 3fff::/20
  if (top === 0x100 && zero(1, 4)) return "reserved"; // discard-only 100::/64
  return "public";
}

/** Addresses that reach this machine regardless of interface: ::, 0/8. */
const isUnspecified = (canon: string) => canon === "::" || canon === "0:0:0:0:0:0:0:0" || /^0\./.test(canon);

// ---------- headers ----------

/** Never forwarded: hop-by-hop, conditional / range (we want the full
 *  body), encoding (we don't decompress), and proxy credentials. */
const DROP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "range",
  "if-range",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "proxy-authorization",
  "proxy-connection",
]);
const CREDENTIAL_HEADERS = new Set(["cookie", "authorization"]);

function sanitizeHeaders(h: Record<string, string>, sendCredentials: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const lk = k.toLowerCase();
    if (DROP_HEADERS.has(lk)) continue;
    if (CREDENTIAL_HEADERS.has(lk) && !sendCredentials) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    out[lk] = String(v);
  }
  return out;
}

function originOf(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

// ---------- refetch ----------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseHttpUrl(s: string): URL {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new RefetchError(`invalid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RefetchError(`refusing to re-fetch ${url.protocol} URL (only http/https scheme)`);
  }
  // Page-chosen userinfo would become an Authorization header.
  url.username = "";
  url.password = "";
  return url;
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

async function resolveChecked(url: URL, o: RefetchOptions, deps: RefetchDeps, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const fam = isIP(host);
  const addrs = fam ? [{ address: host, family: fam }] : await abortable(deps.lookup(host), signal);
  if (addrs.length === 0) throw new RefetchError(`${host} did not resolve`);
  const local = new Set(deps.localAddresses().map(canonicalAddress));
  for (const { address } of addrs) {
    const canon = canonicalAddress(address);
    const kind = classifyAddress(canon);
    const onThisMachine = kind === "loopback" || isUnspecified(canon) || local.has(canon);
    if (onThisMachine && o.bridgePorts.includes(port)) {
      throw new RefetchError(`refused: ${host}:${port} is this bridge's own port`);
    }
    if (o.policy !== "any" && kind !== "public") {
      throw new RefetchError(`refused: ${host} resolves to a ${kind} address (${address})`);
    }
    // A public address of this Mac (global IPv6, public IPv4) still reaches
    // services bound to :: / 0.0.0.0 here: local-only for "public".
    if (o.policy !== "any" && onThisMachine) {
      throw new RefetchError(`refused: ${host} is an address of this machine (${address})`);
    }
  }
  return addrs;
}

const CONNECT_ERRORS = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

/** Try each (already checked) address until one accepts the connection. */
async function connectFirst<T>(addrs: Array<{ address: string; family: number }>, fn: (a: { address: string; family: number }) => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn(addrs[i]!);
    } catch (e) {
      if (i + 1 >= addrs.length || !CONNECT_ERRORS.has((e as NodeJS.ErrnoException)?.code ?? "")) throw e;
    }
  }
}

export async function refetch(
  urlString: string,
  o: RefetchOptions,
  deps: RefetchDeps = defaultRefetchDeps,
): Promise<RefetchResult> {
  if (o.policy === "off") throw new RefetchError('host-side re-fetch is disabled (responseBodyRefetch: "off")');
  let url = parseHttpUrl(urlString);
  const origin = url.origin;
  const pageOrigin = originOf(o.documentURL);
  const headers = sanitizeHeaders(o.headers, pageOrigin !== null && pageOrigin === origin);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      const addrs = await resolveChecked(url, o, deps, ac.signal);
      const res = await connectFirst(addrs, (a) =>
        abortable(deps.request({ url, ...a, headers, signal: ac.signal, maxBytes: o.maxBytes }), ac.signal),
      );
      const location = res.headers["location"];
      if (REDIRECT_STATUSES.has(res.status) && location) {
        if (hop >= o.maxRedirects) throw new RefetchError(`too many redirects (> ${o.maxRedirects})`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new RefetchError("invalid redirect Location");
        }
        if (next.origin !== origin) throw new RefetchError(`refused cross-origin redirect to ${next.origin}`);
        url = parseHttpUrl(next.href);
        continue;
      }
      const mimeType = ((res.headers["content-type"] ?? "").split(";")[0] ?? "").trim();
      return { status: res.status, mimeType, body: res.body };
    }
  } catch (e) {
    if (ac.signal.aborted && !(e instanceof RefetchError)) throw new RefetchError(`timed out after ${o.timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- real transport ----------

function tooLarge(max: number, declared?: number) {
  return new RefetchError(`response too large (${declared ?? "more than " + max} bytes; limit ${max})`);
}

export const defaultRefetchDeps: RefetchDeps = {
  lookup: (host) => dns.lookup(host, { all: true, verbatim: true }),
  localAddresses: () =>
    Object.values(networkInterfaces())
      .flat()
      .map((i) => i?.address)
      .filter((a): a is string => !!a),
  request: ({ url, address, family, headers, signal, maxBytes }) =>
    new Promise((resolve, reject) => {
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(
        url,
        {
          method: "GET",
          headers,
          agent: false,
          signal,
          // Pin the connection to the address we checked. TLS still
          // verifies the certificate against the URL's hostname.
          lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: any[]) => void) =>
            opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as any,
        },
        (res) => {
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            req.destroy();
            return reject(tooLarge(maxBytes, declared));
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.length;
            if (total > maxBytes) {
              req.destroy();
              reject(tooLarge(maxBytes));
            } else chunks.push(c);
          });
          res.on("end", () => {
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            const body = Buffer.concat(chunks);
            resolve({ status: res.statusCode ?? 0, headers: h, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) });
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    }),
};
