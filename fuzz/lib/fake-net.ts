// In-process stand-ins for the HTTP front door: a request/response pair for
// CdpHttpServer.dispatch(), and a Duplex "socket" for dispatchUpgrade()
// that a WebSocket server can really run on, with a minimal client-side
// WS framer. No ports, no TCP.

import { Duplex } from "node:stream";
import type * as http from "node:http";

export type MockResponse = { status: number; headers: Record<string, unknown>; body: string };

export function mockRequest(method: string, url: string, headers: Record<string, string>): http.IncomingMessage {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, url, headers: lower, socket: { remoteAddress: "127.0.0.1" } } as unknown as http.IncomingMessage;
}

/** A ServerResponse that records what the handler wrote. */
export function mockResponse(): { res: http.ServerResponse; result: () => MockResponse | null } {
  let out: MockResponse | null = null;
  let status = 200;
  let headers: Record<string, unknown> = {};
  let headersSent = false;
  const res = {
    get headersSent() {
      return headersSent;
    },
    writeHead(s: number, h?: Record<string, unknown>) {
      if (headersSent) throw new Error("writeHead after headers were sent");
      status = s;
      headers = h ?? {};
      headersSent = true;
      return res;
    },
    setHeader(k: string, v: unknown) {
      headers[k.toLowerCase()] = v;
    },
    end(body?: string | Uint8Array) {
      if (out) throw new Error("end() called twice");
      headersSent = true;
      out = { status, headers, body: body === undefined ? "" : Buffer.from(body as any).toString() };
    },
  };
  return { res: res as unknown as http.ServerResponse, result: () => out };
}

/** A Duplex the server reads client bytes from and writes its bytes to. */
export class FakeNetSocket extends Duplex {
  out: Buffer[] = [];
  remoteAddress = "127.0.0.1";
  remotePort = 50000;
  override _read(): void {}
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.out.push(Buffer.from(chunk));
    cb();
  }
  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  /** Bytes from the "client". */
  feed(b: Uint8Array): void {
    if (!this.destroyed) this.push(Buffer.from(b));
  }
  written(): Buffer {
    return Buffer.concat(this.out);
  }
}

/** A masked (client → server) WebSocket frame. Mask key 0 keeps the payload as-is. */
export function clientFrame(payload: Uint8Array, opcode = 0x1, fin = true): Uint8Array {
  const n = payload.length;
  const head: number[] = [(fin ? 0x80 : 0) | opcode];
  if (n < 126) head.push(0x80 | n);
  else if (n < 65536) head.push(0x80 | 126, n >> 8, n & 0xff);
  else {
    head.push(0x80 | 127, 0, 0, 0, 0);
    head.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  head.push(0, 0, 0, 0);
  const out = new Uint8Array(head.length + n);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

export type ServerFrame = { opcode: number; payload: Buffer };

/** Parse the HTTP response head and the unmasked server frames after it. */
export function parseServerOutput(buf: Buffer): { status: number | null; frames: ServerFrame[] } {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return { status: null, frames: [] };
  const m = /^HTTP\/1\.1 (\d{3})/.exec(buf.subarray(0, end).toString("latin1"));
  const status = m ? Number(m[1]) : null;
  const frames: ServerFrame[] = [];
  let off = end + 4;
  while (off + 2 <= buf.length) {
    const b0 = buf[off]!;
    const b1 = buf[off + 1]!;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    if (b1 & 0x80) p += 4; // servers never mask, but be lenient
    if (p + len > buf.length) break;
    frames.push({ opcode: b0 & 0x0f, payload: buf.subarray(p, p + len) });
    off = p + len;
  }
  return { status, frames };
}

export const WS_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

export function upgradeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: "127.0.0.1:9222",
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": WS_KEY,
    "sec-websocket-version": "13",
    ...extra,
  };
}
