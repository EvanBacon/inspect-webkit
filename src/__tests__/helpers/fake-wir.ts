// Test helpers: an in-memory socket + WebInspectorClient pair, and raw
// HTTP/WS request helpers for exercising the CDP servers without a
// simulator or device.

import { EventEmitter } from "node:events";
import * as net from "node:net";
import { encodeXml, decode, type PlistValue } from "../../plist";
import { ByteStream } from "../../stream";
import { attachStream } from "../../socket";
import { WebInspectorClient, type WIMessage } from "../../webinspector";

/** Minimal net.Socket stand-in: records writes, emits data/close on demand. */
export class FakeSocket extends EventEmitter {
  writes: Uint8Array[] = [];
  destroyed = false;
  ended = false;
  write(chunk: Uint8Array): boolean {
    if (this.destroyed) return false;
    this.writes.push(new Uint8Array(chunk));
    return true;
  }
  end() {
    this.ended = true;
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
  }
  /** Feed raw bytes as if they arrived from the peer. */
  feed(bytes: Uint8Array) {
    this.emit("data", Buffer.from(bytes));
  }
}

export function frame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

export function wirFrame(selector: string, argument: Record<string, PlistValue>): Uint8Array {
  return frame(encodeXml({ __selector: selector, __argument: argument }));
}

/** Decode every length-prefixed plist message written to the fake socket. */
export function decodeWrites(sock: FakeSocket): WIMessage[] {
  const all = Buffer.concat(sock.writes.map((w) => Buffer.from(w)));
  const out: WIMessage[] = [];
  let off = 0;
  while (off + 4 <= all.length) {
    const len = all.readUInt32BE(off);
    if (off + 4 + len > all.length) break;
    out.push(decode(new Uint8Array(all.subarray(off + 4, off + 4 + len))) as WIMessage);
    off += 4 + len;
  }
  return out;
}

export function makeFakeWir() {
  const sock = new FakeSocket();
  const stream = new ByteStream();
  attachStream(sock as unknown as net.Socket, stream);
  const wi = new WebInspectorClient(sock as unknown as net.Socket, stream);
  return {
    sock,
    stream,
    wi,
    push(selector: string, argument: Record<string, PlistValue>) {
      sock.feed(wirFrame(selector, argument));
    },
    sent(): WIMessage[] {
      return decodeWrites(sock);
    },
  };
}

/** Seed a fake WIR with one app ("PID:1") and the given pages. */
export function seedApp(
  rig: ReturnType<typeof makeFakeWir>,
  pages: Array<{ id: number; url?: string; title?: string }>,
  appId = "PID:1",
) {
  rig.push("_rpc_reportConnectedApplicationList:", {
    WIRApplicationDictionaryKey: {
      [appId]: {
        WIRApplicationIdentifierKey: appId,
        WIRApplicationBundleIdentifierKey: "com.apple.mobilesafari",
        WIRApplicationNameKey: "Safari",
        WIRIsApplicationProxyKey: false,
      },
    },
  });
  sendListing(rig, appId, pages);
}

export function sendListing(
  rig: ReturnType<typeof makeFakeWir>,
  appId: string,
  pages: Array<{ id: number; url?: string; title?: string }>,
) {
  const listing: Record<string, PlistValue> = {};
  for (const p of pages) {
    listing[String(p.id)] = {
      WIRPageIdentifierKey: p.id,
      WIRTitleKey: p.title ?? `page ${p.id}`,
      WIRURLKey: p.url ?? `https://example.com/${p.id}`,
      WIRTypeKey: "WIRTypeWebPage",
    };
  }
  rig.push("_rpc_applicationSentListing:", {
    WIRApplicationIdentifierKey: appId,
    WIRListingKey: listing,
  });
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** Send raw bytes over TCP and resolve with whatever comes back before close/timeout. */
export function rawRequest(
  port: number,
  payload: string,
  opts: { host?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: opts.host ?? "127.0.0.1" });
    let buf = "";
    const done = () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(buf);
    };
    const timer = setTimeout(done, opts.timeoutMs ?? 750);
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      // We only care about the status line + headers.
      if (buf.includes("\r\n\r\n")) done();
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      if (buf) resolve(buf);
      else reject(e);
    });
    sock.on("close", done);
    sock.on("connect", () => sock.write(payload));
  });
}

export function httpGet(port: number, path: string, host = `localhost:${port}`): Promise<string> {
  return rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`, {
    timeoutMs: 1500,
  });
}

export function wsUpgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const h: Record<string, string> = {
    Host: `localhost:${port}`,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version": "13",
    ...headers,
  };
  const lines = Object.entries(h)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return rawRequest(port, `GET ${path} HTTP/1.1\r\n${lines}\r\n\r\n`);
}

export function statusOf(resp: string): number | null {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(resp);
  return m ? Number(m[1]) : null;
}

export async function waitUntil(fn: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}
