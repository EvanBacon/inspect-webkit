// Shared HTTP scaffolding for the CDP bridges (cdp/server.ts, cdp/bun-server.ts).
// Both expose the same /json/version, /json/list, /json/protocol, /devtools/page/*
// surface that chrome://inspect and VS Code pwa-chrome attach speak.

import * as http from "node:http";

export type CdpServerBaseOptions = {
  port?: number;
  host?: string;
};

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

export function createCdpHttpServer(routes: CdpHttpRoutes): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const reqHost = req.headers.host ?? "";

    if (url.pathname === "/json/version") {
      const v =
        typeof routes.version === "function" ? routes.version(reqHost) : routes.version;
      return sendJson(res, v);
    }
    if (url.pathname === "/json" || url.pathname === "/json/list") {
      return sendJson(res, routes.listTargets(reqHost));
    }
    if (url.pathname === "/json/protocol") return sendJson(res, {});
    if (url.pathname === "/") return sendIndexHtml(res, routes, reqHost);

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
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

export function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // "localhost" resolves to either 127.0.0.1 or ::1 depending on the
    // first DNS answer — half the loopback gets stranded. Bind dual-stack
    // (::, IPV6_V6ONLY off) so both IPv4 and IPv6 clients reach us.
    const bindHost =
      host === "localhost" || host === "::1" || host === "127.0.0.1" ? "::" : host;
    server.listen({ port, host: bindHost, ipv6Only: false }, () => {
      server.off("error", reject);
      resolve();
    });
  });
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
