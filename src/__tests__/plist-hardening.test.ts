// Hostile-input behaviour of the plist decoders (review #11). Every failure
// must be a PlistError, fast — never a hang, an OOM, a stack overflow, a
// silently truncated value or a prototype-polluted object.

import { test, expect, describe } from "bun:test";
import { decodeBinary, decodeXml, decode, encodeXml, PlistError } from "../plist";
import { buildBplist, obj, uintBE } from "./helpers/bplist-builder";

function expectPlistError(fn: () => unknown, re?: RegExp) {
  const t0 = performance.now();
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  const ms = performance.now() - t0;
  expect(err).toBeInstanceOf(PlistError);
  if (re) expect(String((err as Error).message)).toMatch(re);
  expect(ms).toBeLessThan(1000);
}

describe("bplist trailer / offset table", () => {
  const good = buildBplist([obj.ascii("hi")]);

  test("sanity: the builder's output decodes", () => {
    expect(decodeBinary(good)).toBe("hi");
  });

  test("too short / bad magic", () => {
    expectPlistError(() => decodeBinary(good.subarray(0, 20)));
    const bad = good.slice();
    bad[0] = 0x41;
    expectPlistError(() => decodeBinary(bad));
  });

  test("offsetIntSize / objectRefSize of 0 or > 8", () => {
    for (const offsetIntSize of [0, 9, 255]) {
      const b = good.slice();
      b[b.length - 32 + 6] = offsetIntSize;
      expectPlistError(() => decodeBinary(b));
    }
    for (const refSize of [0, 9]) {
      const b = good.slice();
      b[b.length - 32 + 7] = refSize;
      expectPlistError(() => decodeBinary(b));
    }
  });

  test("huge numObjects is rejected, not allocated", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { numObjects: 1n << 40n })));
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { numObjects: 0xffffffffffffffffn })));
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { numObjects: 0n })));
  });

  test("topObject out of range", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { topObject: 1n })));
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { topObject: 1n << 62n })));
  });

  test("offset table outside the buffer / overlapping the trailer", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { offsetTableOffset: 1n << 50n })));
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { offsetTableOffset: 2n })));
    // Table claims 2 entries but only room for 1 before the trailer.
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { numObjects: 2n })));
  });

  test("an object offset pointing past the objects region or into the header", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { offsets: { 0: 5000 } })));
    expectPlistError(() => decodeBinary(buildBplist([obj.ascii("hi")], 0, { offsets: { 0: 2 } })));
  });
});

describe("bplist object bounds", () => {
  test("string / data / utf16 lengths past the end are errors, not truncation", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x5f, 0x10, 200, 0x41)])));
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x45, 1, 2)])));
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x63, 0, 0x41)])));
  });

  test("an array with an 8-byte length fails fast instead of looping / OOM", () => {
    const huge = obj.raw(0xaf, 0x13, ...uintBE(1n << 62n, 8), 0);
    expectPlistError(() => decodeBinary(buildBplist([huge, obj.int1(1)])));
    const dictHuge = obj.raw(0xdf, 0x13, ...uintBE(1n << 40n, 8), 0, 0);
    expectPlistError(() => decodeBinary(buildBplist([dictHuge, obj.int1(1)])));
  });

  test("length marker that is not an int / 16-byte length", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x5f, 0x50, 0x41)])));
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x5f, 0x14, ...uintBE(1n, 16), 0x41)])));
  });

  test("object references out of range", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.array([7])])));
    expectPlistError(() => decodeBinary(buildBplist([obj.dict([1], [9]), obj.ascii("k")])));
  });

  test("int / real / date with an invalid size nibble", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x15, ...new Array(32).fill(0))])));
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x21, 0, 0)])));
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x32, 0, 0, 0, 0)])));
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x23, 0, 0)]))); // truncated real
  });

  test("fill byte and unknown markers", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x0f)])));
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0x70)])));
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0xe0)])));
  });

  test("non-string dict keys", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.dict([1], [1]), obj.int1(3)])));
  });
});

describe("bplist structure attacks", () => {
  test("a self-referencing array is a cycle error, not a stack overflow", () => {
    expectPlistError(() => decodeBinary(buildBplist([obj.array([0])])), /cycle/);
    // Indirect: 0 -> 1 -> 0
    expectPlistError(() => decodeBinary(buildBplist([obj.array([1]), obj.array([0])])), /cycle/);
  });

  test("a DAG that doubles at each of 64 levels fails fast (no 2^64 work)", () => {
    const objs: Uint8Array[] = [obj.ascii("leaf")];
    for (let i = 1; i <= 64; i++) objs.push(obj.array([i - 1, i - 1]));
    expectPlistError(() => decodeBinary(buildBplist(objs, 64)));
  });

  test("nesting deeper than the cap", () => {
    const objs: Uint8Array[] = [obj.array([])];
    for (let i = 1; i < 5000; i++) objs.push(obj.array([i - 1], 2));
    expectPlistError(() => decodeBinary(buildBplist(objs, 4999, { refSize: 2 })), /depth/);
  });

  test("a shared value referenced many times is fine (CF uniques strings)", () => {
    const objs = [obj.array([1, 1, 1, 1]), obj.ascii("same")];
    expect(decodeBinary(buildBplist(objs))).toEqual(["same", "same", "same", "same"]);
  });

  test("total output size cap", () => {
    const big = new Array(1000).fill(7);
    const refs = new Array(100).fill(1);
    const b = buildBplist([obj.array(refs), obj.data(big)]);
    expect((decodeBinary(b) as Uint8Array[]).length).toBe(100);
    expectPlistError(() => decodeBinary(b, { maxOutputBytes: 50_000 }), /output/);
  });

  test("node count cap", () => {
    const refs = new Array(100).fill(1);
    const b = buildBplist([obj.array(refs), obj.int1(1)]);
    expectPlistError(() => decodeBinary(b, { maxNodes: 50 }), /objects|nodes/);
  });

  test("input size cap", () => {
    const b = buildBplist([obj.ascii("hi")]);
    expectPlistError(() => decodeBinary(b, { maxInputBytes: 10 }), /large|size/);
  });
});

describe("bplist value semantics", () => {
  test("8-byte ints are signed; 16-byte ints carry the unsigned 64-bit range", () => {
    expect(decodeBinary(buildBplist([obj.int8(-1n)]))).toBe(-1);
    expect(decodeBinary(buildBplist([obj.int8(-(2n ** 63n))]))).toBe(-(2n ** 63n));
    expect(decodeBinary(buildBplist([obj.int8(2n ** 63n - 1n)]))).toBe(2n ** 63n - 1n);
    expect(decodeBinary(buildBplist([obj.int8(4294967296n)]))).toBe(4294967296);
    expect(decodeBinary(buildBplist([obj.int16(2n ** 64n - 1n)]))).toBe(2n ** 64n - 1n);
    expect(decodeBinary(buildBplist([obj.int16(5n)]))).toBe(5);
  });

  test("dicts have no prototype: __proto__ is an own key, nothing inherited", () => {
    // { "__proto__": { "WIRDestinationKey": "evil" } }
    const objs = [obj.dict([1], [2]), obj.ascii("__proto__"), obj.dict([3], [4]), obj.ascii("WIRDestinationKey"), obj.ascii("evil")];
    const v = decodeBinary(buildBplist(objs)) as any;
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect(v.WIRDestinationKey).toBeUndefined();
    expect(Object.keys(v)).toEqual(["__proto__"]);
    expect(v["__proto__"].WIRDestinationKey).toBe("evil");
    expect(({} as any).WIRDestinationKey).toBeUndefined();
  });

  test("UID decodes to plutil's {CF$UID: n}; sets are a PlistError", () => {
    const v = decodeBinary(buildBplist([obj.raw(0x81, 0x01, 0x02)])) as any;
    expect(v["CF$UID"]).toBe(0x102);
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0xc1, 1), obj.int1(1)])), /set/);
    expectPlistError(() => decodeBinary(buildBplist([obj.raw(0xb1, 1), obj.int1(1)])), /set/);
  });
});

describe("XML decoder", () => {
  const wrap = (body: string) => `<?xml version="1.0"?><plist version="1.0">${body}</plist>`;

  test("nesting deeper than the cap is a PlistError (no stack overflow)", () => {
    const n = 100_000;
    expectPlistError(() => decodeXml(wrap("<array>".repeat(n) + "</array>".repeat(n))), /depth/);
  });

  test("standard + numeric character references decode; nothing else expands", () => {
    expect(decodeXml(wrap("<string>&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#x1F600;</string>"))).toBe(`<>&"'AB😀`);
    expectPlistError(() => decodeXml(wrap("<string>&foo;</string>")), /entity|reference/);
    expectPlistError(() => decodeXml(wrap("<string>a & b</string>")));
    expectPlistError(() => decodeXml(wrap("<string>&#xD800;</string>")));
    expectPlistError(() => decodeXml(wrap("<string>&#x110000;</string>")));
  });

  test("billion laughs: internal-subset entities are never expanded", () => {
    let dtd = '<!DOCTYPE plist [<!ENTITY lol "lol">';
    for (let i = 1; i < 10; i++) dtd += `<!ENTITY lol${i} "${`&lol${i - 1};`.repeat(10)}">`;
    dtd += "]>";
    const src = `<?xml version="1.0"?>${dtd}<plist version="1.0"><string>&lol9;</string></plist>`;
    expectPlistError(() => decodeXml(src));
  });

  test("garbage and out-of-range integers, bad reals and dates", () => {
    expectPlistError(() => decodeXml(wrap("<integer>12abc</integer>")));
    expectPlistError(() => decodeXml(wrap("<integer></integer>")));
    expectPlistError(() => decodeXml(wrap("<integer>18446744073709551616</integer>")));
    expectPlistError(() => decodeXml(wrap("<integer>-9223372036854775809</integer>")));
    expect(decodeXml(wrap("<integer>18446744073709551615</integer>"))).toBe(2n ** 64n - 1n);
    expect(decodeXml(wrap("<integer>-9223372036854775808</integer>"))).toBe(-(2n ** 63n));
    expect(decodeXml(wrap("<integer>0x10</integer>"))).toBe(16);
    expectPlistError(() => decodeXml(wrap("<real>pi</real>")));
    expect(Number.isNaN(decodeXml(wrap("<real>nan</real>")))).toBe(true);
    expect(decodeXml(wrap("<real>-infinity</real>"))).toBe(-Infinity);
    expectPlistError(() => decodeXml(wrap("<date>yesterday</date>")));
  });

  test("dicts have no prototype", () => {
    const v = decodeXml(
      wrap("<dict><key>__proto__</key><dict><key>polluted</key><true/></dict></dict>"),
    ) as any;
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect(v.polluted).toBeUndefined();
    expect(v["__proto__"].polluted).toBe(true);
  });

  test("input size and node caps", () => {
    expectPlistError(() => decodeXml(wrap("<string>x</string>"), { maxInputBytes: 10 }));
    expectPlistError(() => decodeXml(wrap("<array>" + "<true/>".repeat(100) + "</array>"), { maxNodes: 50 }));
  });

  test("structural errors are PlistErrors", () => {
    for (const bad of [
      "",
      "<plist>",
      wrap("<dict><string>x</string></dict>"),
      wrap("<array><string>x</array>"),
      wrap("<bogus/>"),
      wrap("<true>"),
      wrap("<dict><key>k</key></dict>"),
      wrap("text<string/>"),
      "<!-- unterminated",
    ]) {
      expectPlistError(() => decodeXml(bad));
    }
  });

  test("decode() dispatcher surfaces PlistError for both formats", () => {
    expectPlistError(() => decode(new TextEncoder().encode("bplist00garbage-garbage-garbage-garbage-garbage")));
    expectPlistError(() => decode(new TextEncoder().encode("<plist><integer>x</integer></plist>")));
  });
});

describe("XML encoder", () => {
  test("non-finite and non-safe-integer numbers encode as reals CF accepts", () => {
    const xml = new TextDecoder().decode(encodeXml([NaN, Infinity, -Infinity, 1e300, 2 ** 60]));
    expect(xml).toContain("<real>nan</real>");
    expect(xml).toContain("<real>+infinity</real>");
    expect(xml).toContain("<real>-infinity</real>");
    expect(xml).not.toContain("<integer>1e+300</integer>");
    const back = decodeXml(xml) as number[];
    expect(Number.isNaN(back[0])).toBe(true);
    expect(back.slice(1)).toEqual([Infinity, -Infinity, 1e300, 2 ** 60]);
  });
});

describe("review follow-ups", () => {
  test("<real> parsing is linear: a long non-matching digit run fails fast", () => {
    const src = `<plist><real>${"1".repeat(200_000)}x</real></plist>`;
    expectPlistError(() => decodeXml(src));
    for (const ok of ["1", ".5", "1.", "1.5e3", "-2E-3", "+7"]) {
      expect(decodeXml(`<plist><real>${ok}</real></plist>`)).toBe(Number(ok));
    }
  });

  test("<date> must be UTC (trailing Z), like CF", () => {
    expectPlistError(() => decodeXml("<plist><date>2020-01-01T00:00:00</date></plist>"));
    expect((decodeXml("<plist><date>2020-01-01T00:00:00Z</date></plist>") as Date).getTime()).toBe(Date.UTC(2020, 0, 1));
  });
});
