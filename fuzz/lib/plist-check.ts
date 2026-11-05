// Shared plist invariants:
//   1. decoders return a value or throw PlistError — nothing else;
//   2. with tight limits, the result respects them (nodes, depth, bytes);
//   3. decode(buf) agrees with the decoder its magic selects;
//   4. whatever decodes re-encodes with encodeXml and decodes back to the
//      same value (XML loses: -0, sub-second dates, null → "").
//   5. no prototype pollution (dict keys like __proto__ stay own data).

import { decode, decodeBinary, decodeXml, encodeXml, PlistError, type PlistValue } from "../../src/plist";
import { check, InvariantError } from "./invariants";

const TIGHT = { maxNodes: 5_000, maxDepth: 40, maxOutputBytes: 1 << 20 };
/** A decode slower than this on a fuzz-sized input is an amplification bug. */
const SLOW_MS = 1_500;

type Decoder = (buf: Uint8Array, limits?: object) => PlistValue;

function attempt(fn: () => PlistValue, what: string): PlistValue | PlistError {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PlistError) return e;
    throw new InvariantError(`${what} threw a non-PlistError: ${(e as Error)?.stack ?? e}`);
  }
}

/** Shape stats of a decoded value. */
function measure(v: unknown, depth = 0, acc = { nodes: 0, depth: 0, bytes: 0 }) {
  acc.nodes++;
  acc.depth = Math.max(acc.depth, depth);
  if (typeof v === "string") acc.bytes += v.length;
  else if (v instanceof Uint8Array) acc.bytes += v.length;
  else if (Array.isArray(v)) for (const x of v) measure(x, depth + 1, acc);
  else if (v && typeof v === "object" && !(v instanceof Date)) {
    check(Object.getPrototypeOf(v) === null, "decoded dict has a prototype");
    for (const k of Object.keys(v)) {
      acc.nodes++; // the key itself is a decoded string node in bplist
      acc.bytes += k.length;
      measure((v as Record<string, unknown>)[k], depth + 1, acc);
    }
  }
  return acc;
}

/** Comparable canonical form (see header for what XML can't keep). */
export function norm(v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : `big:${v}`;
  }
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : Object.is(v, -0) ? 0 : v;
  if (v instanceof Uint8Array) return `bytes:${Buffer.from(v).toString("hex")}`;
  if (v instanceof Date) return `date:${Math.floor(v.getTime() / 1000)}`;
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      Object.defineProperty(o, k, { value: norm((v as Record<string, unknown>)[k]), enumerable: true });
    }
    return o;
  }
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export function checkPlist(buf: Uint8Array, decoder: "binary" | "xml"): void {
  const dec: Decoder = decoder === "binary" ? decodeBinary : decodeXml;
  const t0 = performance.now();
  const full = attempt(() => dec(buf), decoder);
  const ms = performance.now() - t0;
  if (ms > SLOW_MS && buf.length < 1 << 16) {
    throw new InvariantError(`${decoder} decode of ${buf.length} bytes took ${ms.toFixed(0)} ms`);
  }
  const viaDecode = attempt(() => decode(buf), "decode");
  const isBin = buf.length >= 8 && Buffer.from(buf.subarray(0, 8)).toString("latin1") === "bplist00";
  if ((decoder === "binary") === isBin) {
    check((viaDecode instanceof PlistError) === (full instanceof PlistError), "decode() disagrees with its decoder");
  }

  const tight = attempt(() => dec(buf, TIGHT), `${decoder} (tight limits)`);
  if (!(tight instanceof PlistError)) {
    const m = measure(tight);
    check(m.depth <= TIGHT.maxDepth + 1, `depth ${m.depth} exceeds maxDepth`);
    check(m.bytes <= TIGHT.maxOutputBytes, `output ${m.bytes} exceeds maxOutputBytes`);
    check(!(full instanceof PlistError), "decodes under tight limits but not under the defaults");
    check(same(full, tight), "tight-limit decode differs from the default decode");
  }
  if (full instanceof PlistError) return;

  // Round trip through our own encoder.
  let xml: Uint8Array;
  try {
    xml = encodeXml(full);
  } catch (e) {
    throw new InvariantError(`encodeXml threw on a decoded value: ${(e as Error)?.stack ?? e}`);
  }
  const back = attempt(() => decodeXml(xml), "decodeXml(encodeXml(v))");
  if (back instanceof PlistError) {
    throw new InvariantError(`encodeXml output does not decode: ${back.message}`);
  }
  check(same(full, back), "encodeXml → decodeXml round trip changed the value");
}
