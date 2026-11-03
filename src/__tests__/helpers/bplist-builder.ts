// Hand-assemble bplist00 buffers from raw object bytes, so tests can craft
// exactly the malformed / hostile structures a decoder must survive.

export type BuildOpts = {
  /** Bytes per offset-table entry (trailer[6]). */
  offsetIntSize?: number;
  /** Bytes per object reference (trailer[7]). */
  refSize?: number;
  /** Override trailer fields (after the real values are computed). */
  numObjects?: bigint;
  topObject?: bigint;
  offsetTableOffset?: bigint;
  /** Override individual offset-table entries. */
  offsets?: Record<number, number>;
};

/** `objects[i]` is the encoded bytes of object i (marker + payload + refs). */
export function buildBplist(objects: Uint8Array[], top = 0, o: BuildOpts = {}): Uint8Array {
  const offSize = o.offsetIntSize ?? 4;
  const parts: number[] = [..."bplist00"].map((c) => c.charCodeAt(0));
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(parts.length);
    parts.push(...obj);
  }
  const tableOff = parts.length;
  offsets.forEach((off, i) => {
    const v = o.offsets?.[i] ?? off;
    parts.push(...uintBE(BigInt(v), offSize));
  });
  const trailer = new Uint8Array(32);
  trailer[6] = offSize;
  trailer[7] = o.refSize ?? 1;
  const dv = new DataView(trailer.buffer);
  dv.setBigUint64(8, o.numObjects ?? BigInt(objects.length));
  dv.setBigUint64(16, o.topObject ?? BigInt(top));
  dv.setBigUint64(24, o.offsetTableOffset ?? BigInt(tableOff));
  return new Uint8Array([...parts, ...trailer]);
}

export function uintBE(v: bigint, size: number): number[] {
  const out: number[] = [];
  for (let i = size - 1; i >= 0; i--) out.push(Number((v >> BigInt(i * 8)) & 0xffn));
  return out;
}

const bytes = (...xs: number[]) => new Uint8Array(xs);

/** Marker + optional extended length for container/string types. */
function withLen(type: number, len: number): number[] {
  if (len < 15) return [(type << 4) | len];
  return [(type << 4) | 0xf, 0x13, ...uintBE(BigInt(len), 8)];
}

export const obj = {
  ascii: (s: string) => bytes(...withLen(0x5, s.length), ...[...s].map((c) => c.charCodeAt(0))),
  int8: (v: bigint) => bytes(0x13, ...uintBE(BigInt.asUintN(64, v), 8)),
  int16: (v: bigint) => bytes(0x14, ...uintBE(BigInt.asUintN(128, v), 16)),
  int1: (v: number) => bytes(0x10, v),
  array: (refs: number[], refSize = 1) =>
    bytes(...withLen(0xa, refs.length), ...refs.flatMap((r) => uintBE(BigInt(r), refSize))),
  dict: (keys: number[], vals: number[], refSize = 1) =>
    bytes(
      ...withLen(0xd, keys.length),
      ...keys.flatMap((r) => uintBE(BigInt(r), refSize)),
      ...vals.flatMap((r) => uintBE(BigInt(r), refSize)),
    ),
  data: (d: number[]) => bytes(...withLen(0x4, d.length), ...d),
  raw: (...xs: number[]) => bytes(...xs),
};
