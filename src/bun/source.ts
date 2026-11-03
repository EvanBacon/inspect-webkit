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
  private closeHandlers = new Set<() => void>();
  private openPromise: Promise<void>;
  private opened = false;

  constructor(public readonly url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "nodebuffer";
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once("open", () => {
        this.opened = true;
        resolve();
      });
      // Persistent listener: a second 'error' must not be unhandled.
      this.ws.on("error", (e) => {
        if (!this.opened) reject(e);
        else console.error(`# bun upstream error: ${(e as Error)?.message ?? e}`);
      });
      this.ws.on("close", () => {
        if (!this.opened) reject(new Error(`upstream ${url} closed before open`));
        const hs = [...this.closeHandlers];
        this.closeHandlers.clear();
        for (const h of hs) {
          try {
            h();
          } catch {}
        }
      });
    });
    // ready() may never be awaited if the client leaves first.
    this.openPromise.catch(() => {});
    this.ws.on("message", (data, isBinary) => {
      const text = isBinary
        ? new TextDecoder().decode(data as Buffer)
        : data.toString();
      for (const h of this.handlers) {
        try {
          h(text);
        } catch {}
      }
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

  /** Called once when the upstream inspector socket closes. */
  onClose(h: () => void): () => void {
    this.closeHandlers.add(h);
    return () => this.closeHandlers.delete(h);
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
