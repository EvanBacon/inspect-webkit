// Plist encode/decode. Pure TS, no deps.
//
// We need three things end-to-end:
//   1. XML plist encode  — for outgoing usbmux/lockdown/webinspector messages
//   2. XML plist decode  — for incoming usbmux/lockdown messages (and embedded
//                          pair records, which are themselves XML plists)
//   3. Binary plist (bplist00) decode — for Web Inspector replies
//
// We do NOT need binary plist encode: Safari's webinspector accepts XML plist
// just fine on the input side, so we always send XML.
//
// Both decoders treat their input as hostile (it comes from a device, a
// daemon or anything that can reach those sockets): every offset and length
// is bounds-checked, depth / node count / output size are capped, dicts are
// prototype-less, and every failure is a PlistError.

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | Date
  | PlistValue[]
  | { [key: string]: PlistValue };

/** The only error type the decoders throw. */
export class PlistError extends Error {
  override name = "PlistError";
}

export type PlistLimits = {
  /** Reject inputs larger than this many bytes. */
  maxInputBytes?: number;
  /** Maximum container nesting. */
  maxDepth?: number;
  /** Maximum decoded values, counting each reference to a shared object. */
  maxNodes?: number;
  /** Maximum total bytes of decoded strings / data (shared ones count per use). */
  maxOutputBytes?: number;
};

const DEFAULT_LIMITS: Required<PlistLimits> = {
  maxInputBytes: 256 * 1024 * 1024,
  maxDepth: 256,
  maxNodes: 1_000_000,
  maxOutputBytes: 256 * 1024 * 1024,
};

function limitsOf(l?: PlistLimits): Required<PlistLimits> {
  return l ? { ...DEFAULT_LIMITS, ...l } : DEFAULT_LIMITS;
}

function fail(msg: string): never {
  throw new PlistError(msg);
}

/** Run a decoder, converting anything unexpected into a PlistError. */
function guarded<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PlistError) throw e;
    throw new PlistError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Counts nodes / output bytes against the limits. */
class Budget {
  nodes = 0;
  bytes = 0;
  constructor(private l: Required<PlistLimits>) {}
  node(depth: number) {
    if (++this.nodes > this.l.maxNodes) fail(`too many objects (> ${this.l.maxNodes})`);
    if (depth > this.l.maxDepth) fail(`nesting depth exceeds ${this.l.maxDepth}`);
  }
  out(n: number) {
    this.bytes += n;
    if (this.bytes > this.l.maxOutputBytes) fail(`decoded output exceeds ${this.l.maxOutputBytes} bytes`);
  }
}

const INT64_MIN = -(2n ** 63n);
const UINT64_MAX = 2n ** 64n - 1n;
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Number when exactly representable, else bigint. */
function intValue(v: bigint): number | bigint {
  return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v;
}

// ---------- XML plist encode ----------

const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';
const XML_FOOTER = "\n</plist>\n";

function escapeXml(s: string): string {
  return s.replace(/[&<>'"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "'" ? "&apos;" : "&quot;",
  );
}

function b64encode(bytes: Uint8Array): string {
  // Native base64 (Buffer is a global in Bun and Node). The old per-byte
  // String.fromCharCode + btoa loop dominated large tools->page uploads.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function b64decode(s: string): Uint8Array {
  // Buffer's base64 decoder skips whitespace (plist <data> is line-wrapped).
  const buf = Buffer.from(s, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** CF's spellings for non-finite reals; anything else is shortest round-trip. */
function encodeReal(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "+infinity";
  if (v === -Infinity) return "-infinity";
  return String(v);
}

function encodeValue(v: PlistValue, indent: string): string {
  if (v === null || v === undefined) return `${indent}<string></string>`;
  if (typeof v === "boolean") return `${indent}<${v ? "true" : "false"}/>`;
  if (typeof v === "string") return `${indent}<string>${escapeXml(v)}</string>`;
  if (typeof v === "number") {
    // Only exact integers go in <integer>: String(1e300) is not an integer literal.
    if (Number.isSafeInteger(v)) return `${indent}<integer>${v}</integer>`;
    return `${indent}<real>${encodeReal(v)}</real>`;
  }
  if (typeof v === "bigint") return `${indent}<integer>${v.toString()}</integer>`;
  if (v instanceof Uint8Array) return `${indent}<data>${b64encode(v)}</data>`;
  if (v instanceof Date) return `${indent}<date>${v.toISOString().replace(/\.\d+Z$/, "Z")}</date>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `${indent}<array/>`;
    const inner = v.map((x) => encodeValue(x, indent + "\t")).join("\n");
    return `${indent}<array>\n${inner}\n${indent}</array>`;
  }
  // dict
  const keys = Object.keys(v);
  if (keys.length === 0) return `${indent}<dict/>`;
  const inner = keys
    .map(
      (k) =>
        `${indent}\t<key>${escapeXml(k)}</key>\n` +
        encodeValue((v as Record<string, PlistValue>)[k]!, indent + "\t"),
    )
    .join("\n");
  return `${indent}<dict>\n${inner}\n${indent}</dict>`;
}

export function encodeXml(v: PlistValue): Uint8Array {
  const body = encodeValue(v, "");
  return new TextEncoder().encode(XML_HEADER + body + XML_FOOTER);
}

// ---------- XML plist decode ----------
//
// Hand-rolled and deliberately small: skips the prolog, DOCTYPE (including
// any internal subset, whose entity declarations are never expanded),
// comments and processing instructions. Text supports the five predefined
// entities plus numeric character references; anything else is an error.

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&<]{0,10});|&/g, (m, body: string | undefined) => {
    if (body === undefined) fail("bare '&' in text (expected an entity reference)");
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    const num = /^#x([0-9a-fA-F]{1,6})$/.exec(body) ?? /^#([0-9]{1,7})$/.exec(body);
    if (num) {
      const cp = parseInt(num[1]!, body[1] === "x" ? 16 : 10);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0) {
        fail(`invalid character reference ${m}`);
      }
      return String.fromCodePoint(cp);
    }
    return fail(`unsupported entity reference ${m}`);
  });
}

type Tag = { name: string; selfClose: boolean; isClose: boolean };

class XmlReader {
  pos = 0;
  constructor(public src: string) {}
  // Advance past whitespace, comments, PIs and DOCTYPE.
  skip() {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else if (s.startsWith("<!--", this.pos)) {
        const end = s.indexOf("-->", this.pos + 4);
        if (end < 0) fail("unterminated comment");
        this.pos = end + 3;
      } else if (s.startsWith("<?", this.pos)) {
        const end = s.indexOf("?>", this.pos + 2);
        if (end < 0) fail("unterminated processing instruction");
        this.pos = end + 2;
      } else if (s.startsWith("<!DOCTYPE", this.pos)) {
        let depth = 0;
        let closed = false;
        while (this.pos < s.length) {
          const ch = s[this.pos++]!;
          if (ch === "[") depth++;
          else if (ch === "]") depth--;
          else if (ch === ">" && depth <= 0) {
            closed = true;
            break;
          }
        }
        if (!closed) fail("unterminated DOCTYPE");
      } else break;
    }
  }
  nextTag(): Tag | null {
    this.skip();
    if (this.pos >= this.src.length) return null;
    if (this.src[this.pos] !== "<") fail(`unexpected text at offset ${this.pos}`);
    const end = this.src.indexOf(">", this.pos);
    if (end < 0) fail("unterminated tag");
    const raw = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    const isClose = raw.startsWith("/");
    const selfClose = !isClose && raw.endsWith("/");
    const inner = raw.slice(isClose ? 1 : 0, selfClose ? -1 : undefined).trim();
    const sp = inner.search(/\s/);
    return { name: sp < 0 ? inner : inner.slice(0, sp), selfClose, isClose };
  }
  /** Text up to the next '<', entity-decoded. */
  readText(): string {
    const end = this.src.indexOf("<", this.pos);
    if (end < 0) fail("unterminated element");
    const raw = this.src.slice(this.pos, end);
    this.pos = end;
    return decodeEntities(raw);
  }
}

class XmlDecoder {
  private budget: Budget;
  constructor(
    private r: XmlReader,
    limits: Required<PlistLimits>,
  ) {
    this.budget = new Budget(limits);
  }

  /** Parse a value whose opening tag was just consumed (and its close tag). */
  value(t: Tag, depth: number): PlistValue {
    if (t.isClose) fail(`unexpected </${t.name}>`);
    this.budget.node(depth);
    if (t.selfClose) return this.empty(t.name);
    const r = this.r;
    switch (t.name) {
      case "string": {
        const v = this.text("string");
        this.budget.out(v.length);
        return v;
      }
      case "integer":
        return parseXmlInteger(this.text("integer").trim());
      case "real":
        return parseXmlReal(this.text("real").trim());
      case "data": {
        const v = b64decode(this.text("data"));
        this.budget.out(v.length);
        return v;
      }
      case "date": {
        const s = this.text("date").trim();
        const d = new Date(s);
        if (!/^\d{4}-\d\d-\d\dT/.test(s) || Number.isNaN(d.getTime())) fail(`invalid <date> ${JSON.stringify(s.slice(0, 40))}`);
        return d;
      }
      case "array": {
        const arr: PlistValue[] = [];
        while (true) {
          const c = r.nextTag() ?? fail("unterminated <array>");
          if (c.isClose && c.name === "array") return arr;
          arr.push(this.value(c, depth + 1));
        }
      }
      case "dict": {
        const obj: Record<string, PlistValue> = Object.create(null);
        while (true) {
          const k = r.nextTag() ?? fail("unterminated <dict>");
          if (k.isClose && k.name === "dict") return obj;
          if (k.name !== "key" || k.isClose) fail(`expected <key> in <dict>, got <${k.isClose ? "/" : ""}${k.name}>`);
          const key = k.selfClose ? "" : this.text("key");
          const v = r.nextTag() ?? fail("unterminated <dict>");
          if (v.isClose) fail(`<key>${key.slice(0, 40)}</key> has no value`);
          obj[key] = this.value(v, depth + 1);
        }
      }
      case "true":
      case "false":
        return fail(`<${t.name}> must be self-closing`);
      default:
        return fail(`unknown plist tag <${t.name.slice(0, 40)}>`);
    }
  }

  private text(name: string): string {
    const v = this.r.readText();
    const c = this.r.nextTag();
    if (!c || !c.isClose || c.name !== name) fail(`expected </${name}>`);
    return v;
  }

  private empty(name: string): PlistValue {
    switch (name) {
      case "true":
        return true;
      case "false":
        return false;
      case "string":
        return "";
      case "data":
        return new Uint8Array(0);
      case "array":
        return [];
      case "dict":
        return Object.create(null);
      default:
        return fail(`self-closing <${name.slice(0, 40)}/> not supported`);
    }
  }
}

function parseXmlInteger(t: string): number | bigint {
  let v: bigint;
  if (/^[+-]?\d{1,20}$/.test(t)) v = BigInt(t.replace(/^\+/, ""));
  else if (/^[+-]?0x[0-9a-fA-F]{1,16}$/.test(t)) {
    const neg = t.startsWith("-");
    v = BigInt(t.replace(/^[+-]/, ""));
    if (neg) v = -v;
  } else return fail(`invalid <integer> ${JSON.stringify(t.slice(0, 40))}`);
  if (v < INT64_MIN || v > UINT64_MAX) fail(`<integer> out of 64-bit range: ${t}`);
  return intValue(v);
}

function parseXmlReal(t: string): number {
  const lower = t.toLowerCase();
  if (lower === "nan" || lower === "+nan" || lower === "-nan") return NaN;
  if (/^\+?inf(inity)?$/.test(lower)) return Infinity;
  if (/^-inf(inity)?$/.test(lower)) return -Infinity;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(lower)) fail(`invalid <real> ${JSON.stringify(t.slice(0, 40))}`);
  return Number(t);
}

export function decodeXml(buf: Uint8Array | string, limits?: PlistLimits): PlistValue {
  const l = limitsOf(limits);
  return guarded("xml plist", () => {
    if (buf.length > l.maxInputBytes) fail(`plist too large (${buf.length} > ${l.maxInputBytes} bytes)`);
    const src = typeof buf === "string" ? buf : new TextDecoder().decode(buf);
    const r = new XmlReader(src);
    while (true) {
      const t = r.nextTag() ?? fail("no <plist> root");
      if (t.name === "plist" && !t.isClose && !t.selfClose) break;
    }
    const t = r.nextTag() ?? fail("empty plist");
    const v = new XmlDecoder(r, l).value(t, 0);
    const end = r.nextTag();
    if (!end || !end.isClose || end.name !== "plist") fail("expected </plist> after the root value");
    return v;
  });
}

// ---------- Binary plist (bplist00) decode ----------
//
// Format reference:
//   8-byte magic "bplist00"
//   ... objects ...
//   offset table (numObjects entries, each `offsetIntSize` bytes)
//   32-byte trailer:
//     [0..5]   unused
//     [6]      offsetIntSize
//     [7]      objectRefSize
//     [8..15]  numObjects (uint64 BE)
//     [16..23] topObject index (uint64 BE)
//     [24..31] offsetTableOffset (uint64 BE)
//
// Objects live in [8, offsetTableOffset); every read is checked against that.
// Values are not memoized: a shared object is decoded once per reference,
// which the node / output budgets keep bounded, and an on-stack bitmap
// turns reference cycles into an error.

const MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]; // "bplist00"
const TRAILER = 32;

function isBplist(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) if (buf[i] !== MAGIC[i]) return false;
  return true;
}

/** Unsigned big-endian int of 1..8 bytes. May lose precision above 2^53,
 *  which only matters for values that then fail a range check anyway. */
function readUInt(buf: Uint8Array, off: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[off + i]!;
  return v;
}

const utf16le = new TextDecoder("utf-16le" as never);

export function decodeBinary(buf: Uint8Array, limits?: PlistLimits): PlistValue {
  const l = limitsOf(limits);
  return guarded("bplist", () => {
    if (buf.length > l.maxInputBytes) fail(`plist too large (${buf.length} > ${l.maxInputBytes} bytes)`);
    if (buf.length < 8 + 1 + TRAILER) fail("bplist too short");
    if (!isBplist(buf)) fail("bad bplist magic");
    return new BinaryDecoder(buf, l).decode();
  });
}

class BinaryDecoder {
  private view: DataView;
  private offSize: number;
  private refSize: number;
  private numObjects: number;
  private top: number;
  private tableOff: number;
  private onStack: Uint8Array;
  private budget: Budget;

  constructor(
    private buf: Uint8Array,
    limits: Required<PlistLimits>,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.budget = new Budget(limits);
    const t = buf.length - TRAILER;
    this.offSize = buf[t + 6]!;
    this.refSize = buf[t + 7]!;
    if (this.offSize < 1 || this.offSize > 8) fail(`bad offsetIntSize ${this.offSize}`);
    if (this.refSize < 1 || this.refSize > 8) fail(`bad objectRefSize ${this.refSize}`);
    this.numObjects = readUInt(buf, t + 8, 8);
    this.top = readUInt(buf, t + 16, 8);
    this.tableOff = readUInt(buf, t + 24, 8);
    // Each object takes at least one byte, so numObjects ≤ objects region.
    if (this.numObjects < 1 || this.numObjects > t - 8) fail(`bad numObjects ${this.numObjects}`);
    if (this.tableOff < 9 || this.tableOff > t) fail(`bad offsetTableOffset ${this.tableOff}`);
    if (this.numObjects * this.offSize > t - this.tableOff) fail("offset table overruns the trailer");
    if (this.top >= this.numObjects) fail(`topObject ${this.top} out of range`);
    this.onStack = new Uint8Array(this.numObjects);
  }

  decode(): PlistValue {
    return this.object(this.top, 0);
  }

  /** Require [off, off+len) inside the objects region. */
  private need(off: number, len: number) {
    if (!(len >= 0) || off + len > this.tableOff) fail(`object at ${off} overruns the objects region`);
  }

  private offsetOf(idx: number): number {
    const off = readUInt(this.buf, this.tableOff + idx * this.offSize, this.offSize);
    if (off < 8 || off >= this.tableOff) fail(`object ${idx} offset ${off} out of range`);
    return off;
  }

  private ref(at: number): number {
    const r = readUInt(this.buf, at, this.refSize);
    if (r >= this.numObjects) fail(`object reference ${r} out of range`);
    return r;
  }

  /** Length for variable-size objects: the low nibble, or a following int. */
  private len(low: number, start: number): [len: number, next: number] {
    if (low !== 0xf) return [low, start];
    this.need(start, 1);
    const m = this.buf[start]!;
    if ((m & 0xf0) !== 0x10 || (m & 0x0f) > 3) fail(`bad length marker 0x${m.toString(16)}`);
    const size = 1 << (m & 0x0f);
    this.need(start + 1, size);
    return [readUInt(this.buf, start + 1, size), start + 1 + size];
  }

  private object(idx: number, depth: number): PlistValue {
    this.budget.node(depth);
    const buf = this.buf;
    const off = this.offsetOf(idx);
    const marker = buf[off]!;
    const low = marker & 0x0f;
    switch (marker >> 4) {
      case 0x0:
        if (low === 0) return null as unknown as PlistValue; // null (never written by CF)
        if (low === 8) return false;
        if (low === 9) return true;
        return fail(`unsupported singleton 0x${marker.toString(16)}`);
      case 0x1: {
        // int: 1, 2, 4 bytes unsigned; 8 bytes signed; 16 bytes (CF's
        // encoding for unsigned values above INT64_MAX) signed 128-bit.
        if (low > 4) fail(`bad int size nibble ${low}`);
        const size = 1 << low;
        this.need(off + 1, size);
        if (size <= 4) return readUInt(buf, off + 1, size);
        if (size === 8) return intValue(this.view.getBigInt64(off + 1));
        const v = (this.view.getBigInt64(off + 1) << 64n) | this.view.getBigUint64(off + 9);
        if (v < INT64_MIN || v > UINT64_MAX) fail("128-bit int out of 64-bit range");
        return intValue(v);
      }
      case 0x2: {
        if (low !== 2 && low !== 3) fail(`bad real size nibble ${low}`);
        this.need(off + 1, 1 << low);
        return low === 2 ? this.view.getFloat32(off + 1) : this.view.getFloat64(off + 1);
      }
      case 0x3: {
        // date — 8-byte BE float, seconds since 2001-01-01 UTC
        if (low !== 3) fail(`bad date marker 0x${marker.toString(16)}`);
        this.need(off + 1, 8);
        return new Date(Date.UTC(2001, 0, 1) + this.view.getFloat64(off + 1) * 1000);
      }
      case 0x4: {
        const [len, next] = this.len(low, off + 1);
        this.need(next, len);
        this.budget.out(len);
        return buf.slice(next, next + len);
      }
      case 0x5: {
        // ASCII string
        const [len, next] = this.len(low, off + 1);
        this.need(next, len);
        this.budget.out(len);
        return Buffer.from(buf.buffer, buf.byteOffset + next, len).toString("latin1");
      }
      case 0x6: {
        // UTF-16BE string; len counts 16-bit code units
        const [len, next] = this.len(low, off + 1);
        this.need(next, len * 2);
        this.budget.out(len * 2);
        const swapped = new Uint8Array(len * 2);
        for (let i = 0; i < swapped.length; i += 2) {
          swapped[i] = buf[next + i + 1]!;
          swapped[i + 1] = buf[next + i]!;
        }
        return utf16le.decode(swapped);
      }
      case 0x8: {
        // UID (NSKeyedArchiver). Same shape plutil prints for it in XML.
        this.need(off + 1, low + 1);
        const uid: Record<string, PlistValue> = Object.create(null);
        uid["CF$UID"] = readUInt(buf, off + 1, low + 1);
        return uid;
      }
      case 0xa: {
        const [len, next] = this.len(low, off + 1);
        this.need(next, len * this.refSize);
        return this.container(idx, () => {
          const out: PlistValue[] = new Array(len);
          for (let i = 0; i < len; i++) out[i] = this.object(this.ref(next + i * this.refSize), depth + 1);
          return out;
        });
      }
      case 0xb:
      case 0xc:
        return fail("bplist sets are not supported");
      case 0xd: {
        const [len, next] = this.len(low, off + 1);
        this.need(next, 2 * len * this.refSize);
        return this.container(idx, () => {
          const obj: Record<string, PlistValue> = Object.create(null);
          for (let i = 0; i < len; i++) {
            const k = this.object(this.ref(next + i * this.refSize), depth + 1);
            if (typeof k !== "string") fail(`non-string dict key (${typeof k})`);
            obj[k] = this.object(this.ref(next + (len + i) * this.refSize), depth + 1);
          }
          return obj;
        });
      }
      default:
        return fail(`unknown bplist marker 0x${marker.toString(16)} at ${off}`);
    }
  }

  private container<T>(idx: number, fn: () => T): T {
    if (this.onStack[idx]) fail(`reference cycle through object ${idx}`);
    this.onStack[idx] = 1;
    const v = fn();
    this.onStack[idx] = 0;
    return v;
  }
}

export function decode(buf: Uint8Array, limits?: PlistLimits): PlistValue {
  return isBplist(buf) ? decodeBinary(buf, limits) : decodeXml(buf, limits);
}
