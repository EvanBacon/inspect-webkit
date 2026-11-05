// Hostile-but-plausible WIR (webinspectord RPC) messages as plist values.

import type { PlistValue } from "../../src/plist";
import { Bytes } from "./bytes";

export const APP_IDS = ["PID:1", "PID:2", "PID:3", "PID:1", "__proto__", "", "PID:1:2"];
export const PAGE_IDS: PlistValue[] = [1, 2, 3, 1, 0, -1, 2 ** 53, 1.5];

/** Any plist value, biased to awkward ones (prototype-less dicts are what
 *  the decoder produces, so `a.b` on them works but `${a}` throws). */
export function plistValue(b: Bytes, depth = 2): PlistValue {
  switch (b.u8() % (depth > 0 ? 10 : 8)) {
    case 0:
      return b.str();
    case 1:
      return b.pick([0, 1, -1, 2 ** 31, 2 ** 53 + 2, 1.5, NaN, Infinity]);
    case 2:
      return b.pick([2n ** 63n, -(2n ** 63n), 2n ** 64n - 1n]);
    case 3:
      return b.bool();
    case 4:
      return new Uint8Array(b.bytes(16));
    case 5:
      return new Date(b.pick([0, 978307200000, -1e12, 253402300799000]));
    case 6:
    case 7:
      return b.str();
    case 8: {
      const o: Record<string, PlistValue> = {};
      for (let i = b.int(0, 3); i > 0; i--) {
        Object.defineProperty(o, b.str(WIR_KEYS), { value: plistValue(b, depth - 1), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    default: {
      const a: PlistValue[] = [];
      for (let i = b.int(0, 3); i > 0; i--) a.push(plistValue(b, depth - 1));
      return a;
    }
  }
}

/** Usually `good`, sometimes something else entirely. */
export function maybe(b: Bytes, good: PlistValue): PlistValue {
  return b.u8() % 5 === 0 ? plistValue(b) : good;
}

export const WIR_KEYS = [
  "WIRApplicationIdentifierKey", "WIRApplicationBundleIdentifierKey", "WIRApplicationNameKey", "WIRIsApplicationProxyKey",
  "WIRIsApplicationActiveKey", "WIRHostApplicationIdentifierKey", "WIRApplicationDictionaryKey", "WIRListingKey",
  "WIRPageIdentifierKey", "WIRTitleKey", "WIRURLKey", "WIRTypeKey", "WIRConnectionIdentifierKey", "WIRDestinationKey",
  "WIRMessageDataKey", "WIRSocketDataKey", "WIRSenderKey", "__proto__", "constructor", "toString",
];

export const SELECTORS = [
  "_rpc_reportConnectedApplicationList:", "_rpc_applicationConnected:", "_rpc_applicationUpdated:",
  "_rpc_applicationDisconnected:", "_rpc_applicationSentListing:", "_rpc_applicationSentData:",
  "_rpc_reportCurrentState:", "_rpc_reportConnectedDriverList:", "_rpc_reportSetup:", "_rpc_bogus:",
];

export function appDict(b: Bytes, appId: string): Record<string, PlistValue> {
  return {
    WIRApplicationIdentifierKey: maybe(b, appId),
    WIRApplicationBundleIdentifierKey: maybe(b, b.pick(["com.apple.mobilesafari", "com.example.app", "com.apple.WebKit.WebContent"])),
    WIRApplicationNameKey: maybe(b, b.pick(["Safari", "Example", ""])),
    WIRIsApplicationProxyKey: maybe(b, b.u8() % 4 === 0),
    WIRIsApplicationActiveKey: maybe(b, 1),
    ...(b.u8() % 4 === 0 ? { WIRHostApplicationIdentifierKey: maybe(b, b.pick(APP_IDS)) } : {}),
  };
}

export function pageDict(b: Bytes, pageId: PlistValue): Record<string, PlistValue> {
  return {
    WIRPageIdentifierKey: maybe(b, pageId),
    WIRTitleKey: maybe(b, b.str()),
    WIRURLKey: maybe(b, b.pick(["https://example.com/", "file:///App.app/", "about:blank", "http://x/<script>", ""])),
    WIRTypeKey: maybe(b, b.pick(["WIRTypeWebPage", "WIRTypeWeb", "WIRTypeJavaScript", "WIRTypeServiceWorker", "WIRTypeAutomation"])),
    ...(b.u8() % 3 === 0 ? { WIRConnectionIdentifierKey: maybe(b, b.pick(["", "other-conn"])) } : {}),
  };
}

/** Rebuild plist values from the typed JSON used in seed files. */
export function fromTyped(v: unknown): PlistValue {
  if (Array.isArray(v)) return v.map(fromTyped);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$data === "string") return new Uint8Array(Buffer.from(o.$data));
    if (typeof o.$date === "number") return new Date(o.$date);
    if (typeof o.$big === "string") {
      try {
        return BigInt(o.$big);
      } catch {
        return o.$big;
      }
    }
    const out: Record<string, PlistValue> = {};
    for (const k of Object.keys(o)) {
      Object.defineProperty(out, k, { value: fromTyped(o[k]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (v === null) return "";
  return v as PlistValue;
}
