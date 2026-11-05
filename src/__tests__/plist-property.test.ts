// Property tests for the plist codec:
//   - encodeXml → decodeXml round-trips arbitrary plist values
//   - differential against Apple's plutil: our XML → plutil → binary1/xml1
//     → our decoders must give back the same value
//   - mutated bplist/XML inputs only ever return a value or throw PlistError

import { test, expect } from "bun:test";
import fc from "fast-check";
import { fcRuns, fcTimeout } from "./helpers/fc-runs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeXml, decodeXml, decodeBinary, decode, PlistError, type PlistValue } from "../plist";

// Characters legal in XML 1.0 and preserved by CF (no CR: XML line-end
// normalisation is out of scope). Includes astral code points.
const xmlChar = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0x20, max: 0x7e }) },
  { weight: 1, arbitrary: fc.constantFrom(0x09, 0x0a) },
  { weight: 2, arbitrary: fc.integer({ min: 0xa0, max: 0xd7ff }) },
  { weight: 1, arbitrary: fc.integer({ min: 0xe000, max: 0xfffd }) },
  { weight: 1, arbitrary: fc.integer({ min: 0x10000, max: 0x10ffff }) },
).map((cp) => String.fromCodePoint(cp));
const xmlString = fc.array(xmlChar, { maxLength: 24 }).map((a) => a.join(""));
const key = fc.oneof(xmlString, fc.constantFrom("__proto__", "constructor", "toString", "WIRDestinationKey"));

const leaf: fc.Arbitrary<PlistValue> = fc.oneof(
  xmlString,
  fc.boolean(),
  fc.integer(),
  fc.maxSafeInteger(),
  fc.bigInt({ min: -(2n ** 63n), max: 2n ** 64n - 1n }),
  fc.double({ noNaN: true }).filter((d) => !Object.is(d, -0)),
  fc.uint8Array({ maxLength: 40 }),
  fc
    .integer({ min: -2_000_000_000, max: 4_000_000_000 })
    .map((s) => new Date(s * 1000)),
);

const value: fc.Arbitrary<PlistValue> = fc.letrec<{ v: PlistValue }>((tie) => ({
  v: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.array(tie("v"), { maxLength: 5 }),
    fc.dictionary(key, tie("v"), { maxKeys: 5 }).map((d) => {
      // fc.dictionary builds a normal object; re-home keys like __proto__ as own props.
      const o: Record<string, PlistValue> = Object.create(null);
      for (const k of Object.keys(d)) o[k] = d[k]!;
      return o;
    }),
  ),
})).v;

/** Canonical comparable form: safe bigints → numbers, bytes → hex, dates → ms. */
function norm(v: unknown): unknown {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : `big:${v}`;
  }
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : v;
  if (v instanceof Uint8Array) return `bytes:${Buffer.from(v).toString("hex")}`;
  if (v instanceof Date) return `date:${v.getTime()}`;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v).sort()) out[k] = norm((v as any)[k]);
    return JSON.stringify(Object.entries(out));
  }
  return v;
}

test("encodeXml → decodeXml round-trips arbitrary values", () => {
  fc.assert(
    fc.property(value, (v) => {
      expect(norm(decodeXml(encodeXml(v)))).toEqual(norm(v));
    }),
    { numRuns: fcRuns(400) },
  );
}, fcTimeout(5_000));

const hasPlutil = spawnSync("plutil", ["-help"]).error === undefined && process.platform === "darwin";

test.skipIf(!hasPlutil)("plutil differential: binary1 and xml1 conversions decode to the same value", () => {
  const dir = mkdtempSync(join(tmpdir(), "plist-diff-"));
  try {
    // One plutil call per batch keeps this fast: the batch is a top-level array.
    for (let batch = 0; batch < 4; batch++) {
      const values = fc.sample(value, { numRuns: 150, seed: 1000 + batch });
      const src = join(dir, `in${batch}.plist`);
      writeFileSync(src, encodeXml(values));
      for (const fmt of ["binary1", "xml1"] as const) {
        const out = join(dir, `out${batch}.${fmt}`);
        const r = spawnSync("plutil", ["-convert", fmt, "-o", out, src]);
        expect(r.status, String(r.stderr)).toBe(0);
        const bytes = new Uint8Array(readFileSync(out));
        const back = fmt === "binary1" ? decodeBinary(bytes) : decodeXml(bytes);
        expect(norm(back)).toEqual(norm(values));
        expect(norm(decode(bytes))).toEqual(norm(values));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Valid seeds for the mutation fuzz: produced by plutil when available. */
function seeds(): Uint8Array[] {
  const values = fc.sample(value, { numRuns: 20, seed: 42 });
  const xml = values.map((v) => encodeXml(v));
  if (!hasPlutil) return xml;
  const dir = mkdtempSync(join(tmpdir(), "plist-seed-"));
  try {
    return xml.flatMap((x, i) => {
      const src = join(dir, `s${i}.plist`);
      writeFileSync(src, x);
      spawnSync("plutil", ["-convert", "binary1", "-o", `${src}.bin`, src]);
      return [x, new Uint8Array(readFileSync(`${src}.bin`))];
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mutated inputs return a value or throw PlistError — never anything else, never slow", () => {
  const corpus = seeds();
  const mutation = fc.record({
    seed: fc.nat({ max: corpus.length - 1 }),
    edits: fc.array(
      fc.record({ pos: fc.nat(), byte: fc.nat({ max: 255 }), kind: fc.constantFrom("set", "insert", "delete", "truncate") }),
      { minLength: 1, maxLength: 6 },
    ),
  });
  fc.assert(
    fc.property(mutation, ({ seed, edits }) => {
      let b = Array.from(corpus[seed]!);
      for (const e of edits) {
        const p = b.length ? e.pos % b.length : 0;
        if (e.kind === "set") b[p] = e.byte;
        else if (e.kind === "insert") b.splice(p, 0, e.byte);
        else if (e.kind === "delete") b.splice(p, 1);
        else b = b.slice(0, p);
      }
      const input = new Uint8Array(b);
      const t0 = performance.now();
      try {
        decode(input);
      } catch (e) {
        if (!(e instanceof PlistError)) throw e;
      }
      expect(performance.now() - t0).toBeLessThan(250);
    }),
    { numRuns: fcRuns(3000) },
  );
}, fcTimeout(5_000));
