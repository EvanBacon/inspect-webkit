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

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | Date
  | PlistValue[]
  | { [key: string]: PlistValue };

// ---------- XML plist ----------

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
  // Bun supports Buffer; this avoids a node import
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeValue(v: PlistValue, indent: string): string {
  if (v === null || v === undefined) return `${indent}<string></string>`;
  if (typeof v === "boolean") return `${indent}<${v ? "true" : "false"}/>`;
  if (typeof v === "string") return `${indent}<string>${escapeXml(v)}</string>`;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return `${indent}<integer>${v}</integer>`;
    return `${indent}<real>${v}</real>`;
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

// XML plist parser. Hand-rolled, tolerant: ignores DOCTYPE/comments/whitespace.
class XmlReader {
  pos = 0;
  constructor(public src: string) {}
  // Advance past whitespace and comments.
  skip() {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else if (this.src.startsWith("<!--", this.pos)) {
        const end = this.src.indexOf("-->", this.pos + 4);
        if (end < 0) throw new Error("unterminated comment");
        this.pos = end + 3;
      } else if (this.src.startsWith("<?", this.pos)) {
        const end = this.src.indexOf("?>", this.pos + 2);
        if (end < 0) throw new Error("unterminated processing instruction");
        this.pos = end + 2;
      } else if (this.src.startsWith("<!DOCTYPE", this.pos)) {
        // skip until matching '>'
        let depth = 0;
        while (this.pos < this.src.length) {
          const ch = this.src[this.pos++]!;
          if (ch === "[") depth++;
          else if (ch === "]") depth--;
          else if (ch === ">" && depth === 0) break;
        }
      } else break;
    }
  }
  // Read the next tag (open, close, or self-closing). Returns { name, selfClose, isClose }.
  nextTag(): { name: string; selfClose: boolean; isClose: boolean } | null {
    this.skip();
    if (this.pos >= this.src.length) return null;
    if (this.src[this.pos] !== "<") throw new Error(`expected '<' at ${this.pos}`);
    const end = this.src.indexOf(">", this.pos);
    if (end < 0) throw new Error("unterminated tag");
    const raw = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    const isClose = raw.startsWith("/");
    const selfClose = raw.endsWith("/");
    const inner = raw.replace(/^\/?/, "").replace(/\/$/, "").trim();
    const name = inner.split(/\s+/)[0]!;
    return { name, selfClose, isClose };
  }
  // Read text up to the next '<' and unescape.
  readText(): string {
    const end = this.src.indexOf("<", this.pos);
    const raw = end < 0 ? this.src.slice(this.pos) : this.src.slice(this.pos, end);
    this.pos = end < 0 ? this.src.length : end;
    return raw
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }
}

// Parses the value whose opening tag has just been consumed, AND consumes its
// matching close tag. Always consume-close keeps the recursion symmetric.
function parseValue(r: XmlReader, openTag: string): PlistValue {
  const consumeClose = (name: string) => {
    const c = r.nextTag();
    if (!c || !c.isClose || c.name !== name) throw new Error(`expected </${name}>`);
  };
  switch (openTag) {
    case "true":
    case "false":
      throw new Error(`<${openTag}> must be self-closing`);
    case "string":
    case "key": {
      const v = r.readText();
      consumeClose(openTag);
      return v;
    }
    case "integer": {
      const t = r.readText().trim();
      consumeClose("integer");
      if (/^-?\d+$/.test(t) && Math.abs(Number(t)) <= Number.MAX_SAFE_INTEGER) return Number(t);
      return BigInt(t);
    }
    case "real": {
      const v = Number(r.readText().trim());
      consumeClose("real");
      return v;
    }
    case "data": {
      const v = b64decode(r.readText());
      consumeClose("data");
      return v;
    }
    case "date": {
      const v = new Date(r.readText().trim());
      consumeClose("date");
      return v;
    }
    case "array": {
      const arr: PlistValue[] = [];
      while (true) {
        const t = r.nextTag();
        if (!t) throw new Error("unterminated <array>");
        if (t.isClose && t.name === "array") return arr;
        arr.push(t.selfClose ? parseSelfClose(t.name) : parseValue(r, t.name));
      }
    }
    case "dict": {
      const obj: Record<string, PlistValue> = {};
      while (true) {
        const t = r.nextTag();
        if (!t) throw new Error("unterminated <dict>");
        if (t.isClose && t.name === "dict") return obj;
        if (t.name !== "key") throw new Error(`expected <key>, got <${t.name}>`);
        const k = r.readText();
        consumeClose("key");
        const vt = r.nextTag();
        if (!vt) throw new Error("unterminated <dict>");
        obj[k] = vt.selfClose ? parseSelfClose(vt.name) : parseValue(r, vt.name);
      }
    }
    default:
      throw new Error(`unknown plist tag <${openTag}>`);
  }
}

function parseSelfClose(name: string): PlistValue {
  if (name === "true") return true;
  if (name === "false") return false;
  if (name === "string") return "";
  if (name === "data") return new Uint8Array(0);
  if (name === "array") return [];
  if (name === "dict") return {};
  throw new Error(`self-closing <${name}/> not supported`);
}

export function decodeXml(buf: Uint8Array | string): PlistValue {
  const src = typeof buf === "string" ? buf : new TextDecoder().decode(buf);
  const r = new XmlReader(src);
  // find <plist ...>
  while (true) {
    const t = r.nextTag();
    if (!t) throw new Error("no <plist> root");
    if (t.name === "plist" && !t.isClose) break;
  }
  // root value
  const t = r.nextTag();
  if (!t) throw new Error("empty plist");
  return t.selfClose ? parseSelfClose(t.name) : parseValue(r, t.name);
}

// ---------- Binary plist (bplist00) decode ----------
//
// Format reference:
//   8-byte magic "bplist00"
//   ... objects ...
//   offset table (numObjects entries, each `offsetIntSize` bytes)
//   32-byte trailer:
//     [0..5]   unused
//     [6]      sortVersion
//     [7]      offsetIntSize
//     [8]      objectRefSize
//     [9..16]  numObjects (uint64 BE)
//     [17..24] topObject index (uint64 BE)
//     [25..32] offsetTableOffset (uint64 BE)

function readBigUInt(buf: Uint8Array, off: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[off + i]!;
  return v;
}

export function decodeBinary(buf: Uint8Array): PlistValue {
  if (buf.length < 32 + 9) throw new Error("bplist too short");
  const magic = new TextDecoder().decode(buf.slice(0, 8));
  if (magic !== "bplist00") throw new Error(`bad magic: ${magic}`);
  const trailerOff = buf.length - 32;
  const offsetIntSize = buf[trailerOff + 6]!;
  const objectRefSize = buf[trailerOff + 7]!;
  const numObjects = readBigUInt(buf, trailerOff + 8, 8);
  const topObject = readBigUInt(buf, trailerOff + 16, 8);
  const offsetTableOff = readBigUInt(buf, trailerOff + 24, 8);

  const offsets: number[] = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) {
    offsets[i] = readBigUInt(buf, offsetTableOff + i * offsetIntSize, offsetIntSize);
  }

  function readRef(off: number): number {
    return readBigUInt(buf, off, objectRefSize);
  }

  function readObject(idx: number): PlistValue {
    const off = offsets[idx]!;
    const marker = buf[off]!;
    const high = marker >> 4;
    const low = marker & 0x0f;

    // length helper for variable-length objects
    function readLen(start: number): { len: number; next: number } {
      if (low !== 0xf) return { len: low, next: start };
      // next byte is an int marker
      const intMarker = buf[start]!;
      if ((intMarker & 0xf0) !== 0x10) throw new Error("expected int marker for length");
      const intSize = 1 << (intMarker & 0x0f);
      const len = readBigUInt(buf, start + 1, intSize);
      return { len, next: start + 1 + intSize };
    }

    switch (high) {
      case 0x0: // singletons
        if (low === 0) return null as unknown as PlistValue;
        if (low === 8) return false;
        if (low === 9) return true;
        if (low === 0xf) return null as unknown as PlistValue; // fill
        throw new Error(`unknown singleton ${low}`);
      case 0x1: {
        // int — 2^low bytes
        const size = 1 << low;
        const n = readBigUInt(buf, off + 1, size);
        // 8-byte ints in bplist are signed; rare in our use, return Number when safe
        if (size === 8 && n > Number.MAX_SAFE_INTEGER) return BigInt(n);
        return n;
      }
      case 0x2: {
        // real — 2^low bytes (4 or 8)
        const size = 1 << low;
        const view = new DataView(buf.buffer, buf.byteOffset + off + 1, size);
        return size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
      }
      case 0x3: {
        // date — 8-byte BE float, seconds since 2001-01-01 UTC
        const view = new DataView(buf.buffer, buf.byteOffset + off + 1, 8);
        const secs = view.getFloat64(0, false);
        return new Date(Date.UTC(2001, 0, 1) + secs * 1000);
      }
      case 0x4: {
        // data
        const { len, next } = readLen(off + 1);
        return buf.slice(next, next + len);
      }
      case 0x5: {
        // ASCII string
        const { len, next } = readLen(off + 1);
        return new TextDecoder("ascii" as never).decode(buf.slice(next, next + len));
      }
      case 0x6: {
        // UTF-16BE string
        const { len, next } = readLen(off + 1);
        // len is in characters (16-bit code units)
        // swap to LE for TextDecoder
        const bytes = buf.slice(next, next + len * 2);
        const swapped = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i += 2) {
          swapped[i] = bytes[i + 1]!;
          swapped[i + 1] = bytes[i]!;
        }
        return new TextDecoder("utf-16le" as never).decode(swapped);
      }
      case 0xa: {
        // array
        const { len, next } = readLen(off + 1);
        const out: PlistValue[] = [];
        for (let i = 0; i < len; i++) {
          out.push(readObject(readRef(next + i * objectRefSize)));
        }
        return out;
      }
      case 0xd: {
        // dict
        const { len, next } = readLen(off + 1);
        const obj: Record<string, PlistValue> = {};
        for (let i = 0; i < len; i++) {
          const k = readObject(readRef(next + i * objectRefSize));
          const v = readObject(readRef(next + (len + i) * objectRefSize));
          if (typeof k !== "string") throw new Error(`non-string dict key: ${typeof k}`);
          obj[k] = v;
        }
        return obj;
      }
      default:
        throw new Error(`unknown bplist marker 0x${marker.toString(16)} at ${off}`);
    }
  }

  return readObject(topObject);
}

export function decode(buf: Uint8Array): PlistValue {
  if (buf.length >= 8) {
    const magic = new TextDecoder().decode(buf.slice(0, 8));
    if (magic === "bplist00") return decodeBinary(buf);
  }
  return decodeXml(buf);
}
