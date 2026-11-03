// Web Inspector RPC over a (possibly TLS-wrapped) usbmux tunnel.
//
// Frame format:
//   uint32 BE length
//   plist body (Apple sends bplist; the kernel-side CFPropertyList accepts
//   either XML or binary on input, so we send XML for simplicity)
//
// Message shape:
//   { __selector: "_rpc_<verb>:", __argument: { ... } }
//
// To enumerate targets:
//   1. send _rpc_reportIdentifier:           { WIRConnectionIdentifierKey: <uuid> }
//   2. receive _rpc_reportConnectedApplicationList: WIRApplicationDictionaryKey -> apps
//   3. for each app, send _rpc_forwardGetListing: { ConnectionId, AppId }
//   4. receive _rpc_applicationSentListing: WIRListingKey -> pages

import { encodeXml, decode, type PlistValue } from "./plist";
import { ByteStream } from "./stream";
import { type AnySocket } from "./socket";

export type WIPage = {
  pageId: number;
  title: string;
  url: string;
  type: string;
};

export type WIApplication = {
  appId: string;
  bundleId?: string;
  name?: string;
  isProxy: boolean;
  isActive: boolean;
  hostAppId?: string;
};

type WISocket = AnySocket;

/** Upper bound on a single WIR frame. Real frames are far smaller; a bogus
 *  length prefix would otherwise make us buffer up to 4 GiB. */
export const MAX_WIR_FRAME = 256 * 1024 * 1024;

class FrameTooLargeError extends Error {}

/** Read one length-prefixed frame body (undecoded). */
async function readFrameBody(stream: ByteStream): Promise<Uint8Array> {
  const lenBuf = await stream.read(4);
  const len = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0, false);
  if (len > MAX_WIR_FRAME) {
    throw new FrameTooLargeError(`webinspector frame length ${len} exceeds ${MAX_WIR_FRAME}`);
  }
  return stream.read(len);
}

function writeMessage(socket: WISocket, msg: Record<string, PlistValue>) {
  const body = encodeXml(msg);
  // One write per frame: header + body in a single buffer.
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.set(body, 4);
  socket.write(out);
}

const debugLog = (...args: unknown[]) => {
  if (process.env.INSPECT_WEBKIT_DEBUG) console.error("[webinspector]", ...args);
};

function uuid(): string {
  // RFC 4122 v4 — webinspector accepts any UUID-shaped string here.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type WIMessage = Record<string, PlistValue>;
type Subscriber = (m: WIMessage) => void;

function parseApp(appId: string, raw: PlistValue): WIApplication {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, PlistValue>;
  return {
    appId,
    bundleId: a.WIRApplicationBundleIdentifierKey as string | undefined,
    name: a.WIRApplicationNameKey as string | undefined,
    isProxy: Boolean(a.WIRIsApplicationProxyKey),
    isActive: Boolean(a.WIRIsApplicationActiveKey),
    hostAppId: a.WIRHostApplicationIdentifierKey as string | undefined,
  };
}

export class WebInspectorClient {
  private connectionId = uuid();
  private subscribers = new Set<Subscriber>();
  /** Latest application set, kept current from pushed WIR events; null
   *  until the daemon has sent its first list. */
  private apps: Map<string, WIApplication> | null = null;
  private closeHandlers = new Set<() => void>();
  private reading: Promise<void>;
  private _closed = false;

  constructor(
    private socket: WISocket,
    private stream: ByteStream,
  ) {
    this.reading = (async () => {
      try {
        while (!stream.closed) {
          const body = await readFrameBody(stream);
          let msg: Record<string, PlistValue>;
          try {
            const decoded = decode(body);
            if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
              throw new Error("frame is not a dictionary");
            }
            msg = decoded as Record<string, PlistValue>;
          } catch (e) {
            // The length prefix already delimited this frame, so the stream
            // is still in sync — skip it and keep reading.
            debugLog(`skipping undecodable ${body.length}-byte frame: ${(e as Error)?.message ?? e}`);
            continue;
          }
          this.trackApps(msg);
          for (const fn of [...this.subscribers]) {
            try {
              fn(msg);
            } catch {
              // never let a subscriber kill the read loop
            }
          }
        }
      } catch (e) {
        if (e instanceof FrameTooLargeError) console.error(`warn: ${e.message}; closing connection`);
        else debugLog(`stream ended: ${(e as Error)?.message ?? e}`);
      } finally {
        this.markClosed();
      }
    })();
  }

  private trackApps(msg: Record<string, PlistValue>) {
    const arg = msg.__argument as Record<string, PlistValue> | undefined;
    if (!arg || typeof arg !== "object") return;
    const appId = arg.WIRApplicationIdentifierKey;
    switch (msg.__selector) {
      case "_rpc_reportConnectedApplicationList:": {
        const dict = arg.WIRApplicationDictionaryKey;
        this.apps = new Map();
        if (dict && typeof dict === "object" && !Array.isArray(dict)) {
          for (const [id, raw] of Object.entries(dict as Record<string, PlistValue>)) {
            this.apps.set(id, parseApp(id, raw));
          }
        }
        break;
      }
      case "_rpc_applicationConnected:":
      case "_rpc_applicationUpdated:":
        if (this.apps && typeof appId === "string") this.apps.set(appId, parseApp(appId, arg));
        break;
      case "_rpc_applicationDisconnected:":
        if (this.apps && typeof appId === "string") this.apps.delete(appId);
        break;
    }
  }

  private markClosed() {
    if (this._closed) return;
    this._closed = true;
    try {
      this.socket.destroy();
    } catch {}
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const h of handlers) {
      try {
        h();
      } catch (e) {
        console.error(`warn: webinspector close handler threw: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  /** Don't let this connection alone keep the process alive. */
  unref(): void {
    try {
      (this.socket as { unref?: () => void }).unref?.();
    } catch {}
  }

  /** True once the underlying connection has ended (or was torn down). */
  get closed(): boolean {
    return this._closed;
  }

  /** Called once when the connection ends. Fires (async) immediately if already closed. */
  onClose(cb: () => void): () => void {
    if (this._closed) {
      queueMicrotask(cb);
      return () => {};
    }
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  /** Subscribe to every message the inspector emits. Returns unsubscribe. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Resolve with the first message whose `__selector` matches (and `match`, if given). */
  private waitFor(
    selector: string,
    timeoutMs = 5000,
    match?: (m: WIMessage) => boolean,
  ): Promise<WIMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`timeout waiting for ${selector} after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsub = this.subscribe((m) => {
        if (m.__selector === selector && (!match || match(m))) {
          clearTimeout(timer);
          unsub();
          resolve(m);
        }
      });
    });
  }

  send(selector: string, argument: Record<string, PlistValue>) {
    if (this._closed) return;
    writeMessage(this.socket, {
      __selector: selector,
      __argument: { WIRConnectionIdentifierKey: this.connectionId, ...argument },
    });
  }

  async reportIdentifier(): Promise<void> {
    this.send("_rpc_reportIdentifier:", {});
  }

  async listApplications(): Promise<WIApplication[]> {
    // On a long-lived connection the pushed list (kept current by
    // applicationConnected / Disconnected events) is authoritative.
    if (this.apps) return [...this.apps.values()];
    // The device pushes the app list automatically after reportIdentifier.
    // Some iOS versions also reply to _rpc_getConnectedApplications: — try both.
    this.send("_rpc_getConnectedApplications:", {});
    const m = await this.waitFor("_rpc_reportConnectedApplicationList:", 3000).catch(() => null);
    if (!m) return [];
    return [...(this.apps ?? new Map<string, WIApplication>()).values()];
  }

  async getListing(appId: string): Promise<WIPage[]> {
    this.send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: appId });
    const m = await this.waitFor(
      "_rpc_applicationSentListing:",
      3000,
      (msg) =>
        (msg.__argument as Record<string, PlistValue> | undefined)?.WIRApplicationIdentifierKey ===
        appId,
    ).catch(() => null);
    if (!m) return [];
    const arg = m.__argument as Record<string, PlistValue>;
    const listing = (arg.WIRListingKey as Record<string, PlistValue>) ?? {};
    const pages: WIPage[] = [];
    for (const raw of Object.values(listing)) {
      const p = raw as Record<string, PlistValue>;
      pages.push({
        pageId: Number(p.WIRPageIdentifierKey ?? 0),
        title: (p.WIRTitleKey as string) ?? "",
        url: (p.WIRURLKey as string) ?? "",
        type: (p.WIRTypeKey as string) ?? "",
      });
    }
    return pages;
  }

  get connection() {
    return this.connectionId;
  }

  /** Set up a forward socket to a specific page; raw frames flow as
   * WIRSocketDataKey blobs in either direction. */
  forwardSocketSetup(appId: string, pageId: number, senderKey: string) {
    this.send("_rpc_forwardSocketSetup:", {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRSenderKey: senderKey,
      WIRAutomaticallyPause: false,
    });
  }

  forwardSocketData(appId: string, pageId: number, senderKey: string, data: Uint8Array) {
    this.send("_rpc_forwardSocketData:", {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRSenderKey: senderKey,
      WIRSocketDataKey: data,
    });
  }

  /** Tell the inspector this sender is going away so the page can be
   * inspected by a new sender. Without this, Safari treats the prior
   * sender as still attached and ignores subsequent forwardSocketSetup
   * for the same page. */
  forwardDidClose(appId: string, pageId: number, senderKey: string) {
    this.send("_rpc_forwardDidClose:", {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRSenderKey: senderKey,
    });
  }

  /** Backwards-compatible alias for `subscribe`. */
  onMessage(handler: (m: WIMessage) => void) {
    return this.subscribe(handler);
  }

  close() {
    try {
      this.socket.end();
    } catch {}
    this.markClosed();
  }
}
