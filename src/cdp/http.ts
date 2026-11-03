// Shared HTTP scaffolding for the CDP bridges (cdp/server.ts, cdp/bun-server.ts).
// Both expose the same /json/version, /json/list, /json/protocol, /devtools/page/*
// surface that chrome://inspect and VS Code pwa-chrome attach speak.

import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { RESPONSE_BODY_REFETCH_MODES, type ResponseBodyRefetch } from "./refetch";

export type CdpServerBaseOptions = {
  port?: number;
  /**
   * Listen host. "localhost" (default) binds 127.0.0.1 and ::1 only. Pass
   * an explicit address (e.g. "0.0.0.0") to expose the bridge — it has no
   * authentication, so only do that on a trusted network.
   */
  host?: string;
  /**
   * Extra WebSocket `Origin`s to accept (exact match, or "*" for any).
   * Requests without an Origin and from `devtools://devtools` are always
   * accepted.
   */
  allowOrigins?: string[];
  /**
   * Network.getResponseBody falls back to re-fetching the URL from this
   * machine when WebKit can't return the body. The URL is chosen by the
   * inspected page, so the fallback is restricted:
   * - "public" (default): http(s) to public internet addresses only;
   *   loopback, link-local and private networks are refused.
   * - "any": also loopback / LAN (e.g. a local dev server), but never the
   *   bridge's own ports.
   * - "off": never re-fetch; only WebKit's own answer is used.
   */
  responseBodyRefetch?: ResponseBodyRefetch;
};

/** Validate `responseBodyRefetch` (it may come from untyped JS / a CLI). */
export function checkResponseBodyRefetch(v: unknown): ResponseBodyRefetch {
  if (v === undefined) return "public";
  if (typeof v === "string" && (RESPONSE_BODY_REFETCH_MODES as readonly string[]).includes(v)) return v as ResponseBodyRefetch;
  throw new TypeError(`responseBodyRefetch must be one of ${RESPONSE_BODY_REFETCH_MODES.join(", ")} (got ${String(v)})`);
}

export type CdpJsonTarget = {
  description: string;
  devtoolsFrontendUrl: string;
  devtoolsFrontendUrlCompat: string;
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
  faviconUrl: string;
};

export type VersionInfo = {
  Browser: string;
  "Protocol-Version": string;
  "User-Agent": string;
  "WebKit-Version": string;
  webSocketDebuggerUrl?: string;
};

export type CdpHttpRoutes = {
  brand: string;
  version: VersionInfo | ((reqHost: string) => VersionInfo);
  listTargets: (reqHost: string) => CdpJsonTarget[];
  indexNote?: string;
};

export function buildJsonTarget(args: {
  reqHost: string;
  id: string;
  description: string;
  title: string;
  url: string;
  type: string;
}): CdpJsonTarget {
  const wsPath = `${args.reqHost}/devtools/page/${args.id}`;
  return {
    description: args.description,
    devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=${wsPath}`,
    devtoolsFrontendUrlCompat: `devtools://devtools/bundled/inspector.html?ws=${wsPath}`,
    id: args.id,
    title: args.title,
    type: args.type,
    url: args.url,
    webSocketDebuggerUrl: `ws://${wsPath}`,
    faviconUrl: "",
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Max inbound WebSocket message size for every CDP WebSocket we accept. */
export const WS_MAX_PAYLOAD = 256 * 1024 * 1024;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTNAMES.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/**
 * Extract the hostname from a Host header value ("example.com:9222",
 * "[::1]:9222", "localhost"). Returns lowercase, brackets stripped, or
 * null when the header is unparseable.
 */
export function hostnameFromHostHeader(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end < 0) return null;
    const rest = v.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return v.slice(1, end);
  }
  const m = /^([^:\s/]+)(?::\d{1,5})?$/.exec(v);
  return m ? m[1]! : null;
}

export type RequestGuardOptions = {
  /** The --host the server was started with (default "localhost"). */
  host?: string;
  /** Extra WebSocket Origins to accept (exact match, or "*" for any). */
  allowOrigins?: string[];
};

export type RequestGuard = {
  /** Host header allowlist (anti DNS-rebinding). */
  hostAllowed(hostHeader: string | undefined): boolean;
  /** WebSocket Origin allowlist (anti cross-site WebSocket hijacking). */
  originAllowed(origin: string | undefined): boolean;
};

/**
 * Chrome-style request guard:
 *   - Host must be absent, or localhost / 127.0.0.1 / [::1] or the explicit --host
 *     (any port). When the user binds a wildcard (0.0.0.0 / ::) any IP
 *     literal is accepted too — DNS rebinding needs a domain name, so IP
 *     literals are safe, and LAN clients address us by IP.
 *   - Origin (WS only): absent (native clients: chrome://inspect backend,
 *     VS Code, Puppeteer) or devtools://devtools, plus `allowOrigins`.
 */
export function createRequestGuard(opts: RequestGuardOptions = {}): RequestGuard {
  const host = (opts.host ?? "localhost").toLowerCase().replace(/^\[|\]$/g, "");
  const allowedHosts = new Set(LOOPBACK_HOSTNAMES);
  if (!isWildcardHost(host)) allowedHosts.add(host);
  const wildcard = isWildcardHost(host);
  const origins = new Set(["devtools://devtools", ...(opts.allowOrigins ?? [])].map(normOrigin));
  const anyOrigin = origins.has("*");
  return {
    hostAllowed(hostHeader) {
      // No Host at all: not a browser (browsers always send one, which is
      // what DNS rebinding relies on). chrome://inspect's network-target
      // poller and some native clients omit it — same rule as Chrome/Node.
      if (hostHeader === undefined || hostHeader.trim() === "") return true;
      const h = hostnameFromHostHeader(hostHeader);
      if (h == null) return false;
      if (allowedHosts.has(h)) return true;
      if (wildcard && (net.isIP(h) !== 0)) return true;
      return false;
    },
    originAllowed(origin) {
      if (origin === undefined || origin === "") return true;
      if (anyOrigin) return true;
      return origins.has(normOrigin(origin));
    },
  };
}

function normOrigin(o: string): string {
  return o.trim().replace(/\/+$/, "").toLowerCase();
}

/** Parse a request target into a pathname; null when malformed. */
export function safePathname(rawUrl: string | undefined): string | null {
  try {
    return new URL(rawUrl ?? "/", "http://placeholder").pathname;
  } catch {
    return null;
  }
}

/** decodeURIComponent that returns null instead of throwing URIError. */
export function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Write a minimal HTTP error response on a raw upgrade socket and close it. */
export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  try {
    const body = `${message}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n` +
        `Connection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
    );
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

export type UpgradeHandler = (
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathname: string,
) => void;

/**
 * One logical CDP HTTP server that may listen on several addresses (by
 * default 127.0.0.1 and ::1). Every request and upgrade passes the Host /
 * Origin guard, and no handler exception escapes to the process.
 */
export class CdpHttpServer {
  private servers: http.Server[] = [];
  private upgradeHandler: UpgradeHandler | null = null;
  private readonly guard: RequestGuard;
  private readonly requestListener: http.RequestListener;

  constructor(
    private readonly routes: CdpHttpRoutes,
    guardOpts: RequestGuardOptions = {},
  ) {
    this.guard = createRequestGuard(guardOpts);
    this.requestListener = (req, res) => {
      try {
        this.handleRequest(req, res);
      } catch (e) {
        console.error(`# http handler error: ${(e as Error)?.message ?? e}`);
        try {
          if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
          res.end("internal error");
        } catch {}
      }
    };
  }

  /** Register the WebSocket upgrade handler (called with a validated pathname). */
  onUpgrade(handler: UpgradeHandler): void {
    this.upgradeHandler = handler;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reqHost = req.headers.host ?? "";
    if (!this.guard.hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden: Host header not allowed\n");
      return;
    }
    const pathname = safePathname(req.url);
    if (pathname == null) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request\n");
      return;
    }
    const routes = this.routes;
    if (pathname === "/json/version") {
      const v = typeof routes.version === "function" ? routes.version(reqHost) : routes.version;
      return sendJson(res, v);
    }
    if (pathname === "/json" || pathname === "/json/list") {
      return sendJson(res, routes.listTargets(reqHost));
    }
    if (pathname === "/json/protocol") return sendJson(res, {});
    if (pathname === "/") return sendIndexHtml(res, routes, reqHost);

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    // A client that vanishes mid-handshake must not surface as an
    // unhandled 'error' event.
    socket.on("error", () => {});
    try {
      if (!this.guard.hostAllowed(req.headers.host)) {
        console.error(`# ws upgrade rejected: Host ${JSON.stringify(req.headers.host ?? "")}`);
        return rejectUpgrade(socket, 403, "forbidden: Host header not allowed");
      }
      const origin = req.headers.origin;
      if (!this.guard.originAllowed(typeof origin === "string" ? origin : undefined)) {
        console.error(
          `# ws upgrade rejected: Origin ${JSON.stringify(origin)} (allow it with --allow-origin)`,
        );
        return rejectUpgrade(socket, 403, "forbidden: Origin not allowed");
      }
      const pathname = safePathname(req.url);
      if (pathname == null) return rejectUpgrade(socket, 400, "bad request");
      if (!this.upgradeHandler) return rejectUpgrade(socket, 404, "not found");
      this.upgradeHandler(req, socket, head, pathname);
    } catch (e) {
      console.error(`# ws upgrade error: ${(e as Error)?.message ?? e}`);
      rejectUpgrade(socket, 500, "internal error");
    }
  }

  /**
   * Listen on `host:port`. "localhost" (the default) binds 127.0.0.1 and
   * ::1 separately — never the wildcard — tolerating hosts without IPv6
   * loopback. Any other host is bound as given; non-loopback hosts get a
   * warning since the bridge is unauthenticated.
   */
  async listen(host: string, port: number): Promise<void> {
    const h = host.replace(/^\[|\]$/g, "");
    if (h.toLowerCase() === "localhost") {
      // Port 0: the ephemeral port picked on 127.0.0.1 may be taken on ::1;
      // retry a few times with a fresh pick.
      for (let attempt = 0; ; attempt++) {
        const first = await this.listenOne("127.0.0.1", port);
        try {
          await this.listenOne("::1", first);
          return;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EADDRINUSE" || /in use/i.test(String((e as Error).message))) {
            this.close();
            if (port === 0 && attempt < 5) continue;
            throw e;
          }
          // No IPv6 loopback on this host (EADDRNOTAVAIL / EAFNOSUPPORT /
          // runtime-specific errors): IPv4 loopback alone is fine.
          console.error(`warn: not listening on [::1]:${first}: ${(e as Error).message}`);
          return;
        }
      }
    }
    if (!isLoopbackHost(h)) {
      console.error(
        `warn: listening on ${host} — the CDP bridge is unauthenticated; anyone who can reach ` +
          `this address can run JavaScript in your inspectable pages.`,
      );
    }
    await this.listenOne(h, port);
  }

  private listenOne(host: string, port: number): Promise<number> {
    const server = http.createServer(this.requestListener);
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    server.on("clientError", (_err, socket) => {
      try {
        if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      } catch {}
      try {
        socket.destroy();
      } catch {}
    });
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException & { port?: number; host?: string }) => {
        if (err.port == null) err.port = port;
        if (err.host == null) err.host = host;
        reject(err);
      };
      server.once("error", onError);
      server.listen({ port, host, ipv6Only: host.includes(":") && host !== "::" }, () => {
        server.off("error", onError);
        // Runtime errors on a listening server (EMFILE, ...) must not crash.
        server.on("error", (e) => console.error(`# http server error: ${e.message}`));
        this.servers.push(server);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  addresses(): AddressInfo[] {
    const out: AddressInfo[] = [];
    for (const s of this.servers) {
      const a = s.address();
      if (a && typeof a === "object") out.push(a);
    }
    return out;
  }

  close(): void {
    for (const s of this.servers) {
      try {
        s.close();
        (s as { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch {}
    }
    this.servers = [];
  }
}

export function createCdpHttpServer(
  routes: CdpHttpRoutes,
  guardOpts: RequestGuardOptions = {},
): CdpHttpServer {
  return new CdpHttpServer(routes, guardOpts);
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendIndexHtml(
  res: http.ServerResponse,
  routes: CdpHttpRoutes,
  reqHost: string,
): void {
  const targets = routes.listTargets(reqHost);
  const list = targets
    .map(
      (t) =>
        `<li><strong>${escapeHtml(t.title || t.url || t.id)}</strong><br>` +
        `<small>${escapeHtml(t.url)}</small><br>` +
        `<small>copy &amp; paste into Chrome's address bar:</small><br>` +
        `<code style="user-select:all">${escapeHtml(t.devtoolsFrontendUrl)}</code></li>`,
    )
    .join("");
  const heading = `inspect-webkit${routes.brand ? ` (${routes.brand})` : ""}`;
  const note =
    routes.indexNote ??
    `<p>Open <code style="display:inline;padding:1px 4px">chrome://inspect</code> → <em>Configure…</em> → add ` +
      `<code style="display:inline;padding:1px 4px">${escapeHtml(reqHost)}</code>.</p>`;
  const body =
    `<!doctype html><meta charset=utf-8><title>${escapeHtml(heading)}</title>` +
    `<style>body{font:14px -apple-system,sans-serif;max-width:760px;margin:2em auto;padding:0 1em}` +
    `code{display:block;background:#f4f4f4;padding:.5em;border-radius:4px;word-break:break-all;margin:.4em 0 1em}` +
    `li{margin-bottom:1.5em;list-style:none}</style>` +
    `<h1>${escapeHtml(heading)} — ${targets.length} target${targets.length === 1 ? "" : "s"}</h1>` +
    note +
    `<ul>${list}</ul>` +
    `<hr><p>JSON: <a href="/json/list">/json/list</a> · <a href="/json/version">/json/version</a></p>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

export function logCdpServerBanner(opts: { brand: string; host: string; port: number }): void {
  const useColor =
    !process.env.NO_COLOR && (process.stderr as { isTTY?: boolean }).isTTY === true;
  const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = (s: string) => c("1", s);
  const dim = (s: string) => c("2", s);
  const cyan = (s: string) => c("36", s);
  const green = (s: string) => c("32", s);

  const url = `http://${opts.host}:${opts.port}`;
  console.error(`${green("●")} ${bold(`${opts.brand} CDP`)} ${cyan(url)}`);
  console.error(`  ${dim("chrome")}  chrome://inspect → ${opts.host}:${opts.port}`);
  console.error(`  ${dim("vscode")}  "type": "chrome", "port": ${opts.port}`);
}
