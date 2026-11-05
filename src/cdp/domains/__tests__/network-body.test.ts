// Network.getResponseBody: WebKit's own method first; the host-side
// re-fetch is a policy-gated fallback (review #10).

import { test, expect } from "bun:test";
import { Target } from "../../target";
import { installNetworkFilters, type NetworkFilterOptions } from "../network";
import type { RefetchDeps } from "../../refetch";

function rig(opts: NetworkFilterOptions = {}) {
  const toTools: any[] = [];
  const toTarget: any[] = [];
  const ws = { readyState: 1, send: (s: string) => toTools.push(JSON.parse(s)) };
  const wi = {
    forwardSocketData(_a: string, _p: number, _s: string, bytes: Uint8Array) {
      toTarget.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
    forwardDidClose() {},
  };
  const t = new Target(ws as any, wi as any, "PID:1", 1, "s");
  installNetworkFilters(t, undefined, opts);
  const fetched: string[] = [];
  const deps: RefetchDeps = {
    async lookup(host) {
      return [{ address: host === "metadata.test" ? "169.254.169.254" : "93.184.216.34", family: 4 }];
    },
    async request({ url, headers }) {
      fetched.push(url.href);
      return { status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(`refetched ${headers.cookie ?? "-"}`) };
    },
    localAddresses: () => ["127.0.0.1"],
  };
  return { t, toTools, toTarget, fetched, deps };
}

/** Raw mode (no Target.targetCreated): replies are plain {id, result}. */
async function rwbs(r: ReturnType<typeof rig>, requestId: string, url: string, headers: Record<string, string> = {}) {
  await r.t.onMessageFromTarget(
    JSON.stringify({
      method: "Network.requestWillBeSent",
      params: { requestId, frameId: "f", documentURL: "https://app.test/", request: { url, method: "GET", headers } },
    }),
  );
  await r.t.onMessageFromTarget(JSON.stringify({ method: "Network.dataReceived", params: { requestId, dataLength: 10 } }));
}

async function until(fn: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

test("asks WebKit first and relays its body; no host-side fetch", async () => {
  const r = rig();
  r.t.callTimeoutMs = 500;
  await rwbs(r, "1.1", "https://cdn.test/a.png");
  void r.t.onMessageFromTools(JSON.stringify({ id: 7, method: "Network.getResponseBody", params: { requestId: "1.1" } }));
  await until(() => r.toTarget.some((m) => m.method === "Network.getResponseBody"));
  const q = r.toTarget.find((m) => m.method === "Network.getResponseBody");
  expect(q.params).toEqual({ requestId: "1.1" });
  await r.t.onMessageFromTarget(JSON.stringify({ id: q.id, result: { body: "iVBORw0K", base64Encoded: true } }));
  await until(() => r.toTools.some((m) => m.id === 7));
  expect(r.toTools.find((m) => m.id === 7)).toEqual({ id: 7, result: { body: "iVBORw0K", base64Encoded: true } });
  expect(r.fetched).toEqual([]);
});

async function nativeFails(r: ReturnType<typeof rig>, id: number, requestId: string) {
  void r.t.onMessageFromTools(JSON.stringify({ id, method: "Network.getResponseBody", params: { requestId } }));
  await until(() => r.toTarget.some((m) => m.method === "Network.getResponseBody" && m.params.requestId === requestId));
  const q = r.toTarget.filter((m) => m.method === "Network.getResponseBody" && m.params.requestId === requestId).at(-1);
  await r.t.onMessageFromTarget(JSON.stringify({ id: q.id, error: { code: -32000, message: "No resource with given identifier found" } }));
  await until(() => r.toTools.some((m) => m.id === id), 3000);
  return r.toTools.find((m) => m.id === id);
}

test("falls back to a safe re-fetch when WebKit has no body (default policy)", async () => {
  const base = rig();
  const r = rig({ refetchDeps: base.deps });
  await rwbs(r, "2.1", "https://cdn.test/lib.js", { Cookie: "sid=1" });
  const reply = await nativeFails(r, 8, "2.1");
  expect(reply.result).toEqual({ body: "refetched -", base64Encoded: false }); // cross-origin to the page: no cookie
  expect(base.fetched).toEqual(["https://cdn.test/lib.js"]);
});

test("the SSRF case: a page-chosen metadata URL is refused, never fetched", async () => {
  const base = rig();
  const r = rig({ refetchDeps: base.deps });
  await rwbs(r, "3.1", "http://metadata.test/latest/meta-data/iam", { Cookie: "sid=1" });
  const reply = await nativeFails(r, 9, "3.1");
  expect(reply.error.message).toMatch(/link-local/);
  expect(base.fetched).toEqual([]);
});

test('responseBodyRefetch "off": WebKit\'s error is returned, nothing fetched', async () => {
  const base = rig();
  const r = rig({ responseBodyRefetch: "off", refetchDeps: base.deps });
  await rwbs(r, "4.1", "https://cdn.test/a.js");
  const reply = await nativeFails(r, 10, "4.1");
  expect(reply.error.message).toMatch(/No resource/);
  expect(base.fetched).toEqual([]);
});

test("the bridge's own listening ports are passed to the re-fetch check", async () => {
  const base = rig();
  const r = rig({ responseBodyRefetch: "any", bridgePorts: () => [9351], refetchDeps: { ...base.deps, lookup: async () => [{ address: "127.0.0.1", family: 4 }] } });
  await rwbs(r, "5.1", "http://localhost:9351/json/list");
  const reply = await nativeFails(r, 11, "5.1");
  expect(reply.error.message).toMatch(/bridge/);
  expect(base.fetched).toEqual([]);
});
