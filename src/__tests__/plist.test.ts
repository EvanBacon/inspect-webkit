import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { encodeXml, decodeXml, decodeBinary, decode } from "../plist";

test("xml roundtrip — primitives", () => {
  const v = {
    s: "hello & <world>",
    n: 42,
    b: true,
    f: false,
    arr: ["a", 1, true],
    nested: { k: "v" },
  };
  const buf = encodeXml(v);
  expect(decodeXml(buf)).toEqual(v);
});

test("xml roundtrip — data", () => {
  const v = { d: new Uint8Array([1, 2, 3, 250]) };
  const round = decodeXml(encodeXml(v)) as { d: Uint8Array };
  expect(Array.from(round.d)).toEqual([1, 2, 3, 250]);
});

test("xml — self-closing array/dict/string", () => {
  const src = `<?xml version="1.0"?><plist version="1.0"><dict><key>a</key><array/><key>b</key><string/></dict></plist>`;
  expect(decodeXml(src)).toEqual({ a: [], b: "" });
});

test("xml — usbmuxd ListDevices reply shape", () => {
  const src = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>DeviceList</key>
  <array>
    <dict>
      <key>DeviceID</key><integer>5</integer>
      <key>MessageType</key><string>Attached</string>
      <key>Properties</key>
      <dict>
        <key>ConnectionType</key><string>USB</string>
        <key>SerialNumber</key><string>00008101-001A2B3C0123456E</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;
  const v = decodeXml(src) as any;
  expect(v.DeviceList[0].Properties.SerialNumber).toBe("00008101-001A2B3C0123456E");
  expect(v.DeviceList[0].DeviceID).toBe(5);
});

test.skipIf(!existsSync("/tmp/test.bplist"))("bplist00 — decode real plutil-generated file", async () => {
  const buf = new Uint8Array(await readFile("/tmp/test.bplist"));
  const v = decodeBinary(buf) as any;
  expect(v.name).toBe("WIRTitleKey");
  expect(v.n).toBe(42);
  expect(v.big).toBe(4294967296);
  expect(v.list).toEqual(["a", "b", "café"]);
  expect(v.active).toBe(true);
  expect(Array.from(v.data as Uint8Array)).toEqual([1, 2, 254]);
  expect(v.nested).toEqual({ k: "v" });
  expect(v.real).toBeCloseTo(3.14);
  // dispatcher
  expect(decode(buf)).toEqual(decodeBinary(buf));
});

test("data round-trips through XML base64 (all byte values, large)", () => {
  const bytes = new Uint8Array(300_001);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
  const xml = encodeXml({ d: bytes });
  const back = decodeXml(xml) as { d: Uint8Array };
  expect(back.d instanceof Uint8Array).toBe(true);
  expect(back.d.length).toBe(bytes.length);
  expect(Buffer.from(back.d).equals(Buffer.from(bytes))).toBe(true);
  // A subarray view must encode only its own bytes.
  const view = bytes.subarray(10, 20);
  const v = decodeXml(encodeXml({ d: view })) as { d: Uint8Array };
  expect(Array.from(v.d)).toEqual(Array.from(view));
});
