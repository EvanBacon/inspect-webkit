// Line-based input format shared by the CDP harnesses. Each input is text;
// each line is one operation:
//
//   T<json>     a DevTools → bridge frame. A JSON object with a string
//               `method` gets a fresh unique id (so "exactly one reply" is
//               checkable); anything else is sent verbatim, untracked.
//   <n>T<json>  the same, from client n (page-channel harness only).
//   W<json>     a Safari → bridge frame: Target.* methods top-level, any
//               other event wrapped in Target.dispatchMessageFromTarget for
//               the active inner target.
//   R<json>     {"m": method, "result"|"error": …}: how Safari answers
//               the next forwarded `method` (default: {"result": {}}).
//   anything else: the line's bytes drive a structured generator (method
//               names from the filter tables, hostile params), so random
//               mutations still produce well-formed traffic.
//
// Real sessions captured with INSPECT_WEBKIT_CAPTURE convert straight into
// this format (fuzz/scripts/corpus-from-capture.ts).

import { Bytes, INTERESTING_KEYS } from "./bytes";

export type Op =
  | { k: "tools"; client: number; msg: any; raw: string; tracked: boolean }
  | { k: "event"; raw: string; topLevel: boolean }
  | { k: "template"; method: string; reply: { result?: unknown; error?: unknown } }
  | { k: "lifecycle"; what: "create" | "destroy" | "commit"; id: string; type?: string; provisional?: boolean; old?: string }
  | { k: "settle" }
  | { k: "garbage"; client: number; raw: string };

export type Vocab = { toolsMethods: string[]; targetMethods: string[] };

const TARGET_IDS = ["page-1", "page-2", "page-3", "worker-1", "sw-1"];
const TYPES = ["page", "page", "page", "worker", "service-worker", "frame", 7 as unknown as string];

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseOps(data: Uint8Array, vocab: Vocab, clients = 1): Op[] {
  const text = Buffer.from(data).toString("utf8");
  const ops: Op[] = [];
  for (const line of text.split("\n").slice(0, 400)) {
    if (line.length === 0) continue;
    let client = 0;
    let body = line;
    if (/^[0-9]T/.test(line)) {
      client = Number(line[0]) % clients;
      body = line.slice(1);
    }
    const tag = body[0];
    const rest = body.slice(1);
    const v = tag === "T" || tag === "W" || tag === "R" ? parseJson(rest) : undefined;
    if (tag === "T" && v !== undefined) {
      if (isObj(v) && typeof v.method === "string") ops.push({ k: "tools", client, msg: v, raw: rest, tracked: true });
      else ops.push({ k: "garbage", client, raw: rest });
      continue;
    }
    if (tag === "W" && isObj(v)) {
      ops.push({ k: "event", raw: rest, topLevel: typeof v.method === "string" && v.method.startsWith("Target.") });
      continue;
    }
    if (tag === "R" && isObj(v) && typeof v.m === "string") {
      ops.push({ k: "template", method: v.m, reply: "error" in v ? { error: v.error } : { result: v.result } });
      continue;
    }
    generate(new Bytes(Buffer.from(line, "latin1")), vocab, clients, ops);
  }
  return ops;
}

/** Structured ops from raw bytes. */
function generate(b: Bytes, vocab: Vocab, clients: number, ops: Op[]): void {
  while (!b.done && ops.length < 400) {
    const op = b.u8() % 16;
    const client = clients > 1 ? b.u8() % clients : 0;
    if (op <= 6) {
      const msg: Record<string, unknown> = { method: b.pick(vocab.toolsMethods) };
      if (b.u8() % 8 !== 0) msg.params = b.u8() % 6 === 0 ? b.json(1) : paramsObject(b);
      ops.push({ k: "tools", client, msg, raw: JSON.stringify(msg), tracked: true });
    } else if (op <= 8) {
      const m: Record<string, unknown> = { method: b.pick(vocab.targetMethods) };
      m.params = paramsObject(b);
      ops.push({ k: "event", raw: JSON.stringify(m), topLevel: false });
    } else if (op === 9) {
      const method = b.pick(vocab.toolsMethods);
      ops.push({ k: "template", method, reply: { result: paramsObject(b) } });
    } else if (op === 10) {
      ops.push({ k: "template", method: b.pick(vocab.toolsMethods), reply: { error: b.bool() ? { code: -32000, message: b.str() } : b.json(1) } });
    } else if (op === 11) {
      const what = b.pick(["create", "create", "destroy", "commit"] as const);
      ops.push({
        k: "lifecycle",
        what,
        id: b.pick(TARGET_IDS),
        type: b.pick(TYPES),
        provisional: b.bool(),
        old: b.pick(TARGET_IDS),
      });
    } else if (op === 12) {
      const raw = b.pick([
        "null", "[]", "1", '"x"', "{", "{}", '{"id":-1,"method":"Runtime.evaluate"}', '{"id":"1","method":"Runtime.evaluate"}',
        '{"id":1.5,"method":"Runtime.evaluate"}', '{"id":1e300,"method":"Page.reload"}', '{"method":5}', '{"id":3}',
        '{"id":null,"method":"DOM.enable"}', '{"__proto__":{"x":1},"method":"Runtime.enable","id":7777}',
      ]);
      ops.push({ k: "garbage", client, raw });
    } else if (op === 13) {
      ops.push({ k: "settle" });
    } else {
      // A request whose params are a near-miss of a plausible shape.
      const msg = { method: b.pick(vocab.toolsMethods), params: paramsObject(b, true) };
      ops.push({ k: "tools", client, msg, raw: JSON.stringify(msg), tracked: true });
    }
  }
}

/** An object of plausible CDP keys with hostile values. */
function paramsObject(b: Bytes, wellTyped = false): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const n = b.int(0, 5);
  for (let i = 0; i < n; i++) {
    const k = b.pick(INTERESTING_KEYS);
    const v = wellTyped ? b.pick([1, 2, "1", "page-1", true, [1, 2], { nodeId: 1 }, "https://example.com/"]) : b.json(2);
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return o;
}
