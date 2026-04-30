// CDP bridge for Bun --inspect.
//
// Mirrors the HTTP/WS surface of cdp/server.ts but skips the WIR multiplex
// layer entirely. Each Bun process exposes a single JSC inspector at a fixed
// ws:// URL; we treat that URL as the target id.

import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import { Target as CdpTarget } from "./target";
import { installIOSFilters } from "./ios-protocol";
import { BunInspectorClient } from "../bun/source";
import {
  type CdpServerBaseOptions,
  buildJsonTarget,
  createCdpHttpServer,
  listen,
  logCdpServerBanner,
} from "./http";

export type BunUpstream = {
  /** Upstream Bun inspector WebSocket URL, e.g. ws://127.0.0.1:6499/abc */
  url: string;
  /** Optional human label shown in chrome://inspect. */
  label?: string;
};

export type BunCdpServerOptions = CdpServerBaseOptions & {
  upstreams: BunUpstream[];
};

export type BunCdpServer = {
  stop(): void;
  getTargets(): BunUpstream[];
};

export async function startBunCdpServer(opts: BunCdpServerOptions): Promise<BunCdpServer> {
  const port = opts.port ?? 9223;
  const host = opts.host ?? "localhost";
  const { upstreams } = opts;

  const httpServer = createCdpHttpServer({
    brand: "bun",
    version: {
      Browser: "Bun/inspect-webkit",
      "Protocol-Version": "1.3",
      "User-Agent": "Bun (via inspect-webkit)",
      "WebKit-Version": "605.1.15",
    },
    listTargets: (reqHost) =>
      upstreams.map((u) =>
        buildJsonTarget({
          reqHost,
          id: encodeURIComponent(u.url),
          description: u.label ?? "bun",
          title: u.label ?? u.url,
          url: u.url,
          type: "node",
        }),
      ),
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (!url.pathname.startsWith("/devtools/page/")) {
      socket.destroy();
      return;
    }
    const id = decodeURIComponent(url.pathname.slice("/devtools/page/".length));
    const upstream = upstreams.find((u) => u.url === id);
    if (!upstream) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachWs(ws, upstream).catch((e) => {
        console.error(`# bun attach failed: ${(e as Error).message}`);
        try {
          ws.close(1011, (e as Error).message);
        } catch {}
      });
    });
  });

  async function attachWs(ws: WSWebSocket, upstream: BunUpstream) {
    const debug = !!process.env.INSPECT_WEBKIT_DEBUG;
    const bun = new BunInspectorClient(upstream.url);
    await bun.ready();

    // appId/pageId/senderKey are inert on Bun — Target threads them back into
    // BunInspectorClient.forwardSocketData, which ignores them.
    const senderKey = crypto.randomUUID();
    const cdp = new CdpTarget(ws, bun as any, "bun", 0, senderKey);
    installIOSFilters(cdp);

    const unsub = bun.onFrame((text) => {
      if (debug) console.error(`[bun] target>> ${text.slice(0, 240)}`);
      cdp.onMessageFromTarget(text);
    });

    ws.on("message", (raw, isBinary) => {
      const text = isBinary ? new TextDecoder().decode(raw as Buffer) : raw.toString();
      if (debug) console.error(`[bun] tools>>  ${text.slice(0, 300)}`);
      cdp.onMessageFromTools(text);
    });

    ws.on("close", () => {
      unsub();
      bun.close();
    });

    console.error(`# devtools attached: ${upstream.label ?? upstream.url}`);
  }

  await listen(httpServer, host, port);
  logCdpServerBanner({ brand: "bun", host, port });

  return {
    stop() {
      wss.close();
      httpServer.close();
    },
    getTargets() {
      return upstreams.slice();
    },
  };
}
