// Adapter that lets a Bun --inspect WebSocket plug into the same Target
// pipeline iOS uses. Bun speaks raw JSC inspector JSON-RPC over a single
// WebSocket — there's no WIR forwarding wrapper, no app/page multiplex,
// no target-based mode. So this client only needs to satisfy the slice of
// WebInspectorClient that Target itself calls (forwardSocketData, close)
// plus a tiny send/recv surface used by bun-server.

import WebSocket, { type MessageEvent } from "ws";

export type BunFrameHandler = (text: string) => void;

export class BunInspectorClient {
  private ws: WebSocket;
  private handlers = new Set<BunFrameHandler>();
  private openPromise: Promise<void>;

  constructor(public readonly url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "nodebuffer";
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (e) => reject(e));
    });
    this.ws.on("message", (data, isBinary) => {
      const text = isBinary
        ? new TextDecoder().decode(data as Buffer)
        : data.toString();
      for (const h of this.handlers) h(text);
    });
  }

  ready(): Promise<void> {
    return this.openPromise;
  }

  /** Subscribe to inbound JSC frames (raw JSON text). Returns unsub. */
  onFrame(h: BunFrameHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  // --- WebInspectorClient surface used by Target -------------------------

  /** Target calls this to send an outbound JSC frame. The iOS-shaped
   *  (appId, pageId, senderKey) tuple is meaningless on Bun — we ignore
   *  it and just write the bytes to the WebSocket. */
  forwardSocketData(
    _appId: string,
    _pageId: number,
    _senderKey: string,
    bytes: Uint8Array,
  ): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(new TextDecoder().decode(bytes));
  }

  /** Target calls this on DevTools-side close. Bun has no per-session
   *  teardown selector, so closing the WS is the right behavior — but
   *  bun-server owns the WS lifecycle, not Target. No-op here. */
  forwardDidClose(_appId: string, _pageId: number, _senderKey: string): void {}

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}
