// CDP bridge for Bun --inspect.
//
// Mirrors the HTTP/WS surface of cdp/server.ts but skips the WIR multiplex
// layer entirely. Each Bun process exposes a single JSC inspector at a fixed
// ws:// URL; we treat that URL as the target id.

import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import { Target as CdpTarget } from "./target";
import { installIOSFilters } from "./ios-protocol";
import { BunInspectorClient } from "../bun/source";
import type { AddressInfo } from "node:net";
import {
  type CdpServerBaseOptions,
  WS_MAX_PAYLOAD,
  buildJsonTarget,
  createCdpHttpServer,
  logCdpServerBanner,
  rejectUpgrade,
  safeDecode,
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
  /** Addresses the HTTP/WS server is listening on. */
  addresses(): AddressInfo[];
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
  }, { host, allowOrigins: opts.allowOrigins });

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  wss.on("error", (e) => console.error(`# ws server error: ${(e as Error)?.message ?? e}`));

  httpServer.onUpgrade((req, socket, head, pathname) => {
    if (!pathname.startsWith("/devtools/page/")) {
      rejectUpgrade(socket, 404, "not found");
      return;
    }
    const id = safeDecode(pathname.slice("/devtools/page/".length));
    if (id == null) {
      rejectUpgrade(socket, 400, "bad request: invalid percent-encoding");
      return;
    }
    const upstream = upstreams.find((u) => u.url === id);
    if (!upstream) {
      rejectUpgrade(socket, 404, "unknown target");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", (e) => {
        console.error(`# ws error: ${(e as Error)?.message ?? e}`);
        try {
          ws.terminate();
        } catch {}
      });
      attachWs(ws, upstream).catch((e) => {
        console.error(`# bun attach failed: ${(e as Error).message}`);
        try {
          ws.close(1011, Buffer.from(String((e as Error)?.message ?? e)).subarray(0, 120).toString());
        } catch {}
      });
    });
  });

  async function attachWs(ws: WSWebSocket, upstream: BunUpstream) {
    const debug = !!process.env.INSPECT_WEBKIT_DEBUG;
    const bun = new BunInspectorClient(upstream.url);
    let clientGone = false;
    ws.on("close", () => {
      clientGone = true;
      bun.close();
    });
    await bun.ready();
    if (clientGone) return;

    // appId/pageId/senderKey are inert on Bun — Target threads them back into
    // BunInspectorClient.forwardSocketData, which ignores them.
    const senderKey = crypto.randomUUID();
    const cdp = new CdpTarget(ws, bun as any, "bun", 0, senderKey);
    installIOSFilters(cdp);

    const unsub = bun.onFrame((text) => {
      if (debug) console.error(`[bun] target>> ${text.slice(0, 240)}`);
      cdp.onMessageFromTarget(text).catch((e) =>
        console.error(`# cdp: target message failed: ${(e as Error)?.message ?? e}`),
      );
    });
    bun.onClose(() => {
      cdp.close("upstream Bun inspector closed");
      try {
        ws.close(1011, "upstream Bun inspector closed");
      } catch {}
    });

    ws.on("message", (raw, isBinary) => {
      try {
        const text = isBinary ? new TextDecoder().decode(raw as Buffer) : raw.toString();
        if (debug) console.error(`[bun] tools>>  ${text.slice(0, 300)}`);
        cdp.onMessageFromTools(text).catch((e) =>
          console.error(`# cdp: tools message failed: ${(e as Error)?.message ?? e}`),
        );
      } catch (e) {
        console.error(`# ws message error: ${(e as Error)?.message ?? e}`);
      }
    });

    ws.on("close", () => {
      unsub();
      cdp.close("DevTools client disconnected");
    });

    console.error(`# devtools attached: ${upstream.label ?? upstream.url}`);
  }

  await httpServer.listen(host, port);
  logCdpServerBanner({ brand: "bun", host, port: httpServer.addresses()[0]?.port ?? port });

  return {
    stop() {
      for (const c of wss.clients) {
        try {
          c.terminate();
        } catch {}
      }
      wss.close();
      httpServer.close();
    },
    getTargets() {
      return upstreams.slice();
    },
    addresses() {
      return httpServer.addresses();
    },
  };
}
