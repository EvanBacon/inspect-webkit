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

async function readMessage(stream: ByteStream): Promise<Record<string, PlistValue>> {
  const lenBuf = await stream.read(4);
  const len = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0, false);
  const body = await stream.read(len);
  return decode(body) as Record<string, PlistValue>;
}

function writeMessage(socket: WISocket, msg: Record<string, PlistValue>) {
  const body = encodeXml(msg);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, body.length, false);
  socket.write(header);
  socket.write(body);
}

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

export class WebInspectorClient {
  private connectionId = uuid();
  private subscribers = new Set<Subscriber>();
  private reading: Promise<void>;

  constructor(
    private socket: WISocket,
    private stream: ByteStream,
  ) {
    this.reading = (async () => {
      try {
        while (!stream.closed) {
          const msg = await readMessage(stream);
          for (const fn of [...this.subscribers]) {
            try {
              fn(msg);
            } catch {
              // never let a subscriber kill the read loop
            }
          }
        }
      } catch {
        // stream closed
      }
    })();
  }

  /** Subscribe to every message the inspector emits. Returns unsubscribe. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Resolve with the first message whose `__selector` matches. */
  private waitFor(selector: string, timeoutMs = 5000): Promise<WIMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`timeout waiting for ${selector} after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsub = this.subscribe((m) => {
        if (m.__selector === selector) {
          clearTimeout(timer);
          unsub();
          resolve(m);
        }
      });
    });
  }

  send(selector: string, argument: Record<string, PlistValue>) {
    writeMessage(this.socket, {
      __selector: selector,
      __argument: { WIRConnectionIdentifierKey: this.connectionId, ...argument },
    });
  }

  async reportIdentifier(): Promise<void> {
    this.send("_rpc_reportIdentifier:", {});
  }

  async listApplications(): Promise<WIApplication[]> {
    // The device pushes the app list automatically after reportIdentifier.
    // Some iOS versions also reply to _rpc_getConnectedApplications: — try both.
    this.send("_rpc_getConnectedApplications:", {});
    const m = await this.waitFor("_rpc_reportConnectedApplicationList:", 3000).catch(() => null);
    if (!m) return [];
    const arg = m.__argument as Record<string, PlistValue>;
    const dict = (arg.WIRApplicationDictionaryKey as Record<string, PlistValue>) ?? {};
    const apps: WIApplication[] = [];
    for (const [appId, raw] of Object.entries(dict)) {
      const a = raw as Record<string, PlistValue>;
      apps.push({
        appId,
        bundleId: a.WIRApplicationBundleIdentifierKey as string | undefined,
        name: a.WIRApplicationNameKey as string | undefined,
        isProxy: Boolean(a.WIRIsApplicationProxyKey),
        isActive: Boolean(a.WIRIsApplicationActiveKey),
        hostAppId: a.WIRHostApplicationIdentifierKey as string | undefined,
      });
    }
    return apps;
  }

  async getListing(appId: string): Promise<WIPage[]> {
    this.send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: appId });
    const m = await this.waitFor("_rpc_applicationSentListing:", 3000).catch(() => null);
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
    this.socket.end();
  }
}
