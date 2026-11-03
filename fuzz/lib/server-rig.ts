// A real CdpServer with no sockets: a fake SourceManager hands it in-memory
// WIR sources (FakeSocket + real WebInspectorClient, so every frame goes
// through the real decoder), and HTTP / WebSocket traffic is dispatched
// in-process through CdpHttpServer.dispatch / dispatchUpgrade.

import type * as net from "node:net";
import { startCdpServer, type CdpServer } from "../../src/cdp/server";
import type { CdpHttpServer } from "../../src/cdp/http";
import type { Source, SourceManager } from "../../src/core/source-manager";
import { encodeXml, PlistError, type PlistValue } from "../../src/plist";
import { ByteStream } from "../../src/stream";
import { attachStream } from "../../src/socket";
import { WebInspectorClient } from "../../src/webinspector";
import { FakeSocket, frame } from "../../src/__tests__/helpers/fake-wir";
import {
  clientFrame,
  FakeNetSocket,
  mockRequest,
  mockResponse,
  parseServerOutput,
  upgradeHeaders,
  type MockResponse,
} from "./fake-net";

export type FakeSource = {
  src: Source;
  sock: FakeSocket;
  /** Push one WIR message, plist-encoded and length-prefixed, as the daemon would. */
  push(selector: string, argument: Record<string, PlistValue>): void;
  /** Push raw bytes (already framed or not). */
  pushRaw(bytes: Uint8Array): void;
  close(): void;
};

export function makeFakeSource(id = "sim:fuzz"): FakeSource {
  const sock = new FakeSocket();
  const stream = new ByteStream();
  attachStream(sock as unknown as net.Socket, stream);
  const wi = new WebInspectorClient(sock as unknown as net.Socket, stream);
  const src: Source = { kind: "simulator", id, label: id, udid: id.slice(4), wi };
  return {
    src,
    sock,
    push(selector, argument) {
      let body: Uint8Array;
      try {
        body = encodeXml({ __selector: selector, __argument: argument });
      } catch (e) {
        if (e instanceof PlistError) return; // not representable on the wire (e.g. a year-10000 date)
        throw e;
      }
      sock.feed(frame(body));
    },
    pushRaw(bytes) {
      sock.feed(bytes);
    },
    close() {
      sock.destroy();
    },
  };
}

/** The subset of SourceManager the server uses, fed by hand. */
class FakeManager {
  private ready = new Set<(s: Source) => void>();
  private live: Source[] = [];
  isStopped = false;
  start() {}
  settled() {
    return Promise.resolve();
  }
  list() {
    return [];
  }
  readySources() {
    return this.live.filter((s) => !s.wi.closed);
  }
  onSourceReady(cb: (s: Source) => void) {
    this.ready.add(cb);
    return () => this.ready.delete(cb);
  }
  add(s: Source) {
    this.live = [...this.readySources(), s];
    for (const cb of [...this.ready]) cb(s);
  }
}

export type WsClient = {
  status: number | null;
  sock: FakeNetSocket;
  send(text: string | Uint8Array, opcode?: number): void;
  /** Text frames received so far. */
  texts(): string[];
  /** Close frame (code), if the server sent one. */
  closeCode(): number | null;
  close(): void;
};

export type ServerRig = {
  server: CdpServer;
  http: CdpHttpServer;
  addSource(s: FakeSource): void;
  get(path: string, headers?: Record<string, string>, method?: string): MockResponse;
  upgrade(path: string, headers?: Record<string, string>): WsClient;
};

export async function startServerRig(opts: { allowOrigins?: string[]; host?: string } = {}): Promise<ServerRig> {
  const manager = new FakeManager();
  let http: CdpHttpServer | null = null;
  const server = await startCdpServer({
    port: 9399,
    listen: false,
    pageGoneGraceMs: 0,
    responseBodyRefetch: "off",
    sourceManager: manager as unknown as SourceManager,
    onHttpServer: (h) => (http = h),
    ...(opts.allowOrigins ? { allowOrigins: opts.allowOrigins } : {}),
    ...(opts.host ? { host: opts.host } : {}),
  });
  const front = http as unknown as CdpHttpServer;
  return {
    server,
    http: front,
    addSource: (s) => manager.add(s.src),
    get(path, headers = { host: "127.0.0.1:9222" }, method = "GET") {
      const { res, result } = mockResponse();
      front.dispatch(mockRequest(method, path, headers), res);
      const r = result();
      if (!r) throw new Error(`no response for ${method} ${path}`);
      return r;
    },
    upgrade(path, headers = upgradeHeaders()) {
      const sock = new FakeNetSocket();
      front.dispatchUpgrade(mockRequest("GET", path, headers), sock as never, Buffer.alloc(0));
      const parsed = () => parseServerOutput(sock.written());
      return {
        get status() {
          return parsed().status;
        },
        sock,
        send(text, opcode = 0x1) {
          sock.feed(clientFrame(typeof text === "string" ? Buffer.from(text) : text, opcode));
        },
        texts() {
          return parsed()
            .frames.filter((f) => f.opcode === 0x1)
            .map((f) => f.payload.toString());
        },
        closeCode() {
          const f = parsed().frames.find((x) => x.opcode === 0x8);
          return f ? (f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005) : null;
        },
        close() {
          sock.destroy();
        },
      };
    },
  };
}
