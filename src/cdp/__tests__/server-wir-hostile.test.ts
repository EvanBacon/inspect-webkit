// Malformed webinspectord data (found by the wir-server fuzzer). Plist dicts
// decode prototype-less, so `Number(dict)` / `${dict}` / regex tests on one
// throw: a single odd listing entry used to make the server's WIR subscriber
// throw (listing silently dropped) and /json/list + / answer 500 (or 200
// with "internal error"), and non-string titles / urls leaked into
// /json/list.

import { test, expect, afterEach } from "bun:test";
import { startCdpServer, type CdpServer } from "../server";
import { createCdpHttpServer } from "../http";
import { freePort, httpGet, makeFakeWir, waitUntil } from "../../__tests__/helpers/fake-wir";
import type { PlistValue } from "../../plist";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function rig() {
  const port = await freePort();
  const wir = makeFakeWir();
  const server: CdpServer = await startCdpServer({
    port,
    openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: wir.wi }],
  });
  cleanups.push(() => server.stop());
  return { port, wir, server };
}

const dict = (o: Record<string, PlistValue> = { x: 1 }) => o;
async function jsonList(port: number): Promise<any[]> {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  expect(r.status).toBe(200);
  return (await r.json()) as any[];
}

function apps(wir: ReturnType<typeof makeFakeWir>, entries: Record<string, PlistValue>) {
  wir.push("_rpc_reportConnectedApplicationList:", { WIRApplicationDictionaryKey: entries });
}

const GOOD_APP = {
  WIRApplicationIdentifierKey: "PID:1",
  WIRApplicationBundleIdentifierKey: "com.apple.mobilesafari",
  WIRApplicationNameKey: "Safari",
  WIRIsApplicationProxyKey: false,
};

test("odd listing entries are skipped or sanitized; good pages still list", async () => {
  const { port, wir, server } = await rig();
  apps(wir, { "PID:1": GOOD_APP });
  wir.push("_rpc_applicationSentListing:", {
    WIRApplicationIdentifierKey: "PID:1",
    WIRListingKey: {
      a: { WIRPageIdentifierKey: dict(), WIRTitleKey: "bad id", WIRURLKey: "https://a/" },
      b: { WIRPageIdentifierKey: 2, WIRTitleKey: dict(), WIRURLKey: dict(), WIRTypeKey: 7 },
      c: { WIRPageIdentifierKey: 3, WIRTitleKey: 42, WIRURLKey: true },
      d: "not a page",
      e: [1, 2],
      f: { WIRPageIdentifierKey: "4", WIRTitleKey: "string id", WIRURLKey: "https://f/" },
      g: { WIRPageIdentifierKey: 5, WIRTitleKey: "good", WIRURLKey: "https://example.com/" },
    },
  });
  await waitUntil(() => server.getTargets().length > 0);
  expect(server.getTargets().map((t) => t.pageId).sort()).toEqual([2, 3, 5]);
  for (const t of server.getTargets()) {
    expect(typeof t.title).toBe("string");
    expect(typeof t.url).toBe("string");
    expect(typeof t.type).toBe("string");
  }
  const list = await jsonList(port);
  expect(list).toHaveLength(3);
  for (const e of list) for (const f of ["id", "title", "url", "type", "description"]) expect(typeof e[f]).toBe("string");
  expect((await httpGet(port, "/")).startsWith("HTTP/1.1 200")).toBe(true);
});

test("odd app entries don't break the app list or the listing", async () => {
  const { port, wir, server } = await rig();
  apps(wir, {
    "PID:1": GOOD_APP,
    "PID:2": "not an app",
    "PID:3": { WIRApplicationBundleIdentifierKey: dict(), WIRApplicationNameKey: 12, WIRIsApplicationProxyKey: dict() },
  });
  wir.push("_rpc_applicationConnected:", { WIRApplicationIdentifierKey: dict(), WIRApplicationNameKey: "x" });
  for (const appId of ["PID:1", "PID:3"]) {
    wir.push("_rpc_applicationSentListing:", {
      WIRApplicationIdentifierKey: appId,
      WIRListingKey: { "1": { WIRPageIdentifierKey: 1, WIRTitleKey: "", WIRURLKey: "https://example.com/" } },
    });
  }
  await waitUntil(() => server.getTargets().length >= 2);
  const targets = server.getTargets();
  expect(targets.map((t) => t.targetId).sort()).toEqual(["sim:fake:PID:1:1", "sim:fake:PID:3:1"]);
  for (const t of targets) {
    expect(typeof t.appName).toBe("string");
    expect(t.bundleId === undefined || typeof t.bundleId === "string").toBe(true);
  }
  for (const e of await jsonList(port)) expect(typeof e.title).toBe("string");
});

test("WebInspectorClient.getListing skips malformed pages (public listTargets path)", async () => {
  const wir = makeFakeWir();
  const p = wir.wi.getListing("PID:1");
  wir.push("_rpc_applicationSentListing:", {
    WIRApplicationIdentifierKey: "PID:1",
    WIRListingKey: {
      a: { WIRPageIdentifierKey: dict(), WIRTitleKey: "x" },
      b: "junk",
      c: { WIRPageIdentifierKey: 9, WIRTitleKey: dict(), WIRURLKey: 3, WIRTypeKey: "WIRTypeWebPage" },
    },
  });
  expect(await p).toEqual([{ pageId: 9, title: "", url: "", type: "WIRTypeWebPage" }]);
});

test("tracked apps keep string-or-undefined names (listApplications)", async () => {
  const wir = makeFakeWir();
  apps(wir, { "PID:1": { WIRApplicationBundleIdentifierKey: dict(), WIRApplicationNameKey: 5 } });
  await new Promise((r) => setTimeout(r, 10));
  const [a] = await wir.wi.listApplications();
  expect(a!.bundleId).toBeUndefined();
  expect(a!.name).toBeUndefined();
});

test("a JSON route that can't be serialized answers 500, not 200 + 'internal error'", async () => {
  const port = await freePort();
  const http = createCdpHttpServer({
    brand: "",
    version: { Browser: "x", "Protocol-Version": "1.3", "User-Agent": "x", "WebKit-Version": "x" },
    listTargets: () => [{ bad: 1n } as never],
  });
  await http.listen("127.0.0.1", port);
  cleanups.push(() => http.close());
  expect(await httpGet(port, "/json/list")).toStartWith("HTTP/1.1 500");
});
