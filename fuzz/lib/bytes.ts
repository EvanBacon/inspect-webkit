// A tiny FuzzedDataProvider: turns fuzzer bytes into structured choices.
// Reading past the end yields zeros, so every input is a valid program.
// (Our own, not @jazzer.js/core's, so harnesses run unchanged under Bun.)

export class Bytes {
  private off = 0;
  constructor(readonly data: Uint8Array) {}

  get done(): boolean {
    return this.off >= this.data.length;
  }
  get left(): number {
    return Math.max(0, this.data.length - this.off);
  }

  u8(): number {
    return this.off < this.data.length ? this.data[this.off++]! : 0;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  bool(): boolean {
    return (this.u8() & 1) === 1;
  }
  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    const span = max - min + 1;
    const r = span <= 256 ? this.u8() : span <= 65536 ? this.u16() : this.u32();
    return min + (r % span);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)]!;
  }
  /** Up to `max` raw bytes. */
  bytes(max: number): Uint8Array {
    const n = Math.min(this.int(0, max), this.left);
    const out = this.data.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  /** Everything not consumed yet. */
  rest(): Uint8Array {
    const out = this.data.subarray(this.off);
    this.off = this.data.length;
    return out;
  }
  /** A short string: either from `dict` or raw latin1/utf8 bytes. */
  str(dict: readonly string[] = INTERESTING_STRINGS, max = 24): string {
    if (this.u8() % 3 !== 0) return this.pick(dict);
    return Buffer.from(this.bytes(max)).toString(this.bool() ? "latin1" : "utf8");
  }

  /** A hostile JSON-compatible value, `depth` levels deep at most. */
  json(depth = 3, keys: readonly string[] = INTERESTING_KEYS): unknown {
    const k = this.u8() % (depth > 0 ? 10 : 7);
    switch (k) {
      case 0:
        return null;
      case 1:
        return this.bool();
      case 2:
        return this.pick(INTERESTING_NUMBERS);
      case 3:
        return this.int(-3, 1000);
      case 4:
      case 5:
        return this.str();
      case 6:
        return this.u8() % 8 === 0 ? "x".repeat(this.int(0, 70000)) : this.str();
      case 7:
      case 8: {
        const o: Record<string, unknown> = {};
        const n = this.int(0, 5);
        for (let i = 0; i < n; i++) {
          Object.defineProperty(o, this.str(keys), {
            value: this.json(depth - 1, keys),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return o;
      }
      default: {
        const n = this.int(0, 4);
        const a: unknown[] = [];
        for (let i = 0; i < n; i++) a.push(this.json(depth - 1, keys));
        return a;
      }
    }
  }
}

export const INTERESTING_NUMBERS = [
  0, -0, 1, -1, 2, 7, 0.5, -1.5, 255, 256, 65535, 65536, 2 ** 31 - 1, -(2 ** 31), 2 ** 32, 2 ** 53 - 1,
  2 ** 53 + 2, -(2 ** 53), 1e21, 1e308, -1e308, 5e-324, Number.MAX_VALUE,
];

export const INTERESTING_STRINGS = [
  "", "x", "0", "1", "-1", "1.5", "NaN", "true", "null", "undefined", "__proto__", "constructor",
  "prototype", "toString", "valueOf", "hasOwnProperty", "page-1", "page-2", "worker-1", "frame-1", "0.1",
  "about:blank", "https://example.com/", "http://127.0.0.1:9222/json", "http://localhost/", "file:///etc/passwd",
  "data:text/html,<b>x", "javascript:alert(1)", "blob:https://example.com/x", "%", "%E0%A4%A", "\u0000",
  "\ud800", "￿", "a\nb", "<>&'\"", "${x}", "../..", "*", "normal", "isolated", "page", "worker",
  "service-worker", "frame", "script", "Document", "Element", "node", "searchForNode", "none", "uncaught",
  "all", "mouseMoved", "mousePressed", "mouseReleased", "keyDown", "char", "left", "console", "1:2", "3",
  "WIRTypeWebPage", "WIRTypeJavaScript", "WIRTypeServiceWorker", "PID:1", "PID:2", "sim:fake",
];

/** Object keys likely to matter (CDP param names + prototype traps). */
export const INTERESTING_KEYS = [
  "__proto__", "constructor", "prototype", "toString", "valueOf", "id", "method", "params", "result",
  "error", "code", "message", "data", "sessionId", "targetId", "targetInfo", "type", "isProvisional",
  "oldTargetId", "newTargetId", "nodeId", "backendNodeId", "backendNodeIds", "objectId", "expression",
  "returnByValue", "awaitPromise", "contextId", "executionContextId", "context", "frameId", "url", "urlRegex",
  "lineNumber", "columnNumber", "scriptId", "breakpointId", "location", "locations", "callFrames",
  "callFrameId", "styleSheetId", "edits", "range", "text", "style", "cssProperties", "rule", "matchedCSSRules",
  "root", "children", "attributes", "name", "value", "selector", "depth", "requestId", "request", "response",
  "headers", "status", "mimeType", "body", "base64Encoded", "timestamp", "level", "source", "args", "stackTrace",
  "parameters", "x", "y", "button", "clickCount", "modifiers", "key", "handle", "offset", "size", "eof",
  "mode", "highlightConfig", "enabled", "state", "userAgent", "media", "features", "width", "height",
  "deviceScaleFactor", "frame", "frameTree", "childFrames", "loaderId", "reason", "hitBreakpoints", "auxData",
  "isDefault", "origin", "uniqueId", "quad", "quads", "model", "content", "border", "nodes", "properties",
  "entries", "entry", "cookies", "query", "searchId", "resultCount", "fromIndex", "toIndex", "outerHTML",
  "pseudoType", "documentURL", "initiator", "redirectResponse", "preview", "subtype", "className",
  "description", "functionDeclaration", "arguments", "objectGroup", "generatePreview", "repeatCount",
  "wallTime", "encodedDataLength", "dataLength", "condition", "autoAttach", "flatten", "discover",
  "waitForDebuggerOnStart", "ignoreCache", "transitionType", "format", "quality", "deltaX", "deltaY",
];
