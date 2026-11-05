// A fake inspected page behind one or more CDP sessions: answers every
// frame the bridge writes the way Safari does (outer envelope ack + inner
// reply in either order, "Missing target" for dead inner targets), using
// reply templates from the input, and tracks live inner targets.

import { Bytes } from "./bytes";
import type { RefetchDeps } from "../../src/cdp/refetch";
import { check } from "./invariants";

export type Reply = { result?: unknown; error?: unknown };

export class FakeSafari {
  /** Frames waiting to be delivered to the bridge (raw text). */
  queue: string[] = [];
  live = new Map<string, { type: string; provisional: boolean }>();
  active = "page-1";
  private templates = new Map<string, Reply[]>();
  private flip = 0;
  written = 0;

  constructor(private schedule: number) {}

  setTemplate(method: string, r: Reply): void {
    if (!this.templates.has(method)) this.templates.set(method, []);
    const list = this.templates.get(method)!;
    if (list.length < 16) list.push(r);
  }

  private replyFor(method: unknown): Reply {
    const list = typeof method === "string" ? this.templates.get(method) : undefined;
    if (!list || list.length === 0) return { result: {} };
    return list.length > 1 ? list.shift()! : list[0]!;
  }

  private nextFlip(): boolean {
    return ((this.schedule >> (this.flip++ % 8)) & 1) === 1;
  }

  /** What the bridge wrote on the WIR socket. */
  onWire(text: string): void {
    this.written++;
    let outer: any;
    try {
      outer = JSON.parse(text);
    } catch {
      throw new Error(`bridge wrote invalid JSON to Safari: ${text.slice(0, 80)}`);
    }
    check(outer !== null && typeof outer === "object", "bridge wrote a non-object frame");
    if (outer.method === "Target.sendMessageToTarget") {
      const tid = outer.params?.targetId;
      check(typeof outer.params?.message === "string", "envelope without a string message");
      const inner = JSON.parse(outer.params.message);
      if (!this.live.has(tid)) {
        this.queue.push(JSON.stringify({ error: { code: -32601, message: "Missing target for given targetId" }, id: outer.id }));
        return;
      }
      const ack = JSON.stringify({ result: {}, id: outer.id });
      if (typeof inner.id !== "number") {
        this.queue.push(ack);
        return;
      }
      const r = this.replyFor(inner.method);
      const reply = JSON.stringify({ ...(r.error !== undefined ? { error: r.error } : { result: r.result ?? {} }), id: inner.id });
      const wrapped = JSON.stringify({ method: "Target.dispatchMessageFromTarget", params: { targetId: tid, message: reply } });
      if (this.nextFlip()) this.queue.push(ack, wrapped);
      else this.queue.push(wrapped, ack);
      return;
    }
    if (typeof outer.id === "number") {
      const r = this.replyFor(outer.method);
      this.queue.push(JSON.stringify({ ...(r.error !== undefined ? { error: r.error } : { result: r.result ?? {} }), id: outer.id }));
    }
  }

  /** An event from the page's active inner target. */
  event(raw: string, topLevel: boolean): void {
    if (topLevel) {
      this.track(raw);
      this.queue.push(raw);
      return;
    }
    this.queue.push(JSON.stringify({ method: "Target.dispatchMessageFromTarget", params: { targetId: this.active, message: raw } }));
  }

  lifecycle(what: "create" | "destroy" | "commit", id: string, type = "page", provisional = false, old?: string): void {
    let m: unknown;
    if (what === "create") {
      m = { method: "Target.targetCreated", params: { targetInfo: { targetId: id, type, isProvisional: provisional } } };
    } else if (what === "destroy") {
      m = { method: "Target.targetDestroyed", params: { targetId: id } };
    } else {
      m = { method: "Target.didCommitProvisionalTarget", params: { oldTargetId: old ?? this.active, newTargetId: id } };
    }
    const raw = JSON.stringify(m);
    this.track(raw);
    this.queue.push(raw);
  }

  private track(raw: string): void {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const p = m?.params;
    if (m?.method === "Target.targetCreated" && typeof p?.targetInfo?.targetId === "string") {
      this.live.set(p.targetInfo.targetId, { type: String(p.targetInfo.type ?? "page"), provisional: p.targetInfo.isProvisional === true });
      if (p.targetInfo.type === "page" && p.targetInfo.isProvisional !== true) this.active = p.targetInfo.targetId;
    } else if (m?.method === "Target.targetDestroyed" && typeof p?.targetId === "string") {
      this.live.delete(p.targetId);
    } else if (m?.method === "Target.didCommitProvisionalTarget" && typeof p?.newTargetId === "string") {
      this.live.set(p.newTargetId, { type: "page", provisional: false });
      this.active = p.newTargetId;
    }
  }
}

// --- re-fetch fake: DNS answers and responses chosen by the input ----------

const ADDRS = [
  "93.184.216.34", "8.8.8.8", "127.0.0.1", "127.1.2.3", "10.0.0.1", "192.168.1.91", "172.16.0.1", "169.254.169.254",
  "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2606:2800:220:1::1",
];

/** Addresses a "public" re-fetch must never connect to. */
export function isNonPublic(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  return (
    /^(127|10|0)\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a) ||
    a === "::1" ||
    a === "::" ||
    /^f[cd]/.test(a) ||
    /^fe[89ab]/.test(a)
  );
}

export type RefetchLog = Array<{ url: string; address: string }>;

export function fakeRefetchDeps(b: Bytes, log: RefetchLog): RefetchDeps {
  return {
    async lookup(host) {
      if (/^[\d.]+$/.test(host) || host.includes(":")) return [{ address: host.replace(/^\[|\]$/g, ""), family: host.includes(":") ? 6 : 4 }];
      const n = 1 + (b.u8() % 2);
      const out = [];
      for (let i = 0; i < n; i++) {
        const address = b.pick(ADDRS);
        out.push({ address, family: address.includes(":") ? 6 : 4 });
      }
      return out;
    },
    async request(r) {
      log.push({ url: r.url.href, address: r.address });
      const status = b.pick([200, 200, 301, 302, 404, 500]);
      const headers: Record<string, string> = { "content-type": b.pick(["text/html", "application/json", "image/png", "text/plain; charset=utf-8"]) };
      if (status === 301 || status === 302) {
        headers.location = b.pick(["http://127.0.0.1:9222/json", "http://10.0.0.1/", "https://example.com/next", "/relative", "http://[::1]:9222/", "file:///etc/passwd", "http://localhost:9222/"]);
      }
      return { status, headers, body: new TextEncoder().encode("x".repeat(b.int(0, 64))) };
    },
    localAddresses() {
      return ["192.168.1.91", "fe80::1"];
    },
  };
}
