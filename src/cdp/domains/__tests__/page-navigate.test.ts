// Page.navigate (R11): iOS 27 WebKit dropped it (-32601). The bridge keeps
// the native method when present and otherwise navigates via
// Runtime.evaluate, always answering with a CDP-shaped {frameId, loaderId}.

import { test, expect } from "bun:test";
import { Target } from "../../target";
import { installPageFilters } from "../page";
import { makeDomainCtx } from "../../domain";

function rig() {
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
  installPageFilters(t, makeDomainCtx());
  return { t, toTools, toTarget };
}
type Rig = ReturnType<typeof rig>;

async function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const t0 = Date.now();
  while (true) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await Bun.sleep(2);
  }
}

const reply = (r: Rig, id: number) => until(() => r.toTools.find((m) => m.id === id));
const sentTo = (r: Rig, method: string, n = 0) =>
  until(() => r.toTarget.filter((m) => m.method === method)[n]);

async function mainFrame(r: Rig, url = "https://example.com/", loaderId = "0.7") {
  await r.t.onMessageFromTarget(
    JSON.stringify({ method: "Page.frameNavigated", params: { frame: { id: "0.1", loaderId, url, securityOrigin: new URL(url).origin, mimeType: "text/html" } } }),
  );
}

const nav = (r: Rig, id: number, params: any) =>
  void r.t.onMessageFromTools(JSON.stringify({ id, method: "Page.navigate", params }));

const NOT_FOUND = { code: -32601, message: "'Page.navigate' was not found" };

/** Run the shim's expression against a fake `location`; returns the assigned href. */
function runExpression(expr: string): string | undefined {
  const loc: { href?: string } = {};
  const timers: Array<() => void> = [];
  new Function("location", "setTimeout", `return ${expr}`)(loc, (f: () => void) => timers.push(f));
  timers.forEach((f) => f());
  return loc.href;
}

test("native Page.navigate is used when WebKit has it; reply is CDP-shaped", async () => {
  const r = rig();
  await mainFrame(r);
  nav(r, 1, { url: "https://www.iana.org/help/example-domains", transitionType: "typed" });
  const q = await sentTo(r, "Page.navigate");
  expect(q.params).toEqual({ url: "https://www.iana.org/help/example-domains" });
  await r.t.onMessageFromTarget(JSON.stringify({ id: q.id, result: {} }));
  const m = await reply(r, 1);
  expect(m.result.frameId).toBe("0.1");
  expect(typeof m.result.loaderId).toBe("string");
  expect(m.result.loaderId.length).toBeGreaterThan(0);
  expect(r.toTarget.some((x) => x.method === "Runtime.evaluate")).toBe(false);
});

test("-32601 from WebKit: falls back to location.href via Runtime.evaluate, and remembers", async () => {
  const r = rig();
  await mainFrame(r);
  nav(r, 1, { url: "https://www.iana.org/help/example-domains" });
  const q = await sentTo(r, "Page.navigate");
  await r.t.onMessageFromTarget(JSON.stringify({ id: q.id, error: NOT_FOUND }));
  const ev = await sentTo(r, "Runtime.evaluate");
  expect(runExpression(ev.params.expression)).toBe("https://www.iana.org/help/example-domains");
  await r.t.onMessageFromTarget(JSON.stringify({ id: ev.id, result: { result: { type: "boolean", value: true } } }));
  const m = await reply(r, 1);
  expect(m.error).toBeUndefined();
  expect(m.result.frameId).toBe("0.1");
  expect(typeof m.result.loaderId).toBe("string");

  // Second navigate: straight to the shim, no native probe.
  nav(r, 2, { url: "https://example.com/" });
  const ev2 = await sentTo(r, "Runtime.evaluate", 1);
  expect(r.toTarget.filter((x) => x.method === "Page.navigate")).toHaveLength(1);
  await r.t.onMessageFromTarget(JSON.stringify({ id: ev2.id, result: { result: { type: "boolean", value: true } } }));
  const m2 = await reply(r, 2);
  expect(m2.result.frameId).toBe("0.1");
  expect(m2.result.loaderId).not.toBe(m.result.loaderId);
});

test("a hostile URL is escaped: it can only ever become location.href", async () => {
  const r = rig();
  await mainFrame(r);
  nav(r, 1, { url: "https://a.test/" });
  await r.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r, "Page.navigate")).id, error: NOT_FOUND }));
  await r.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r, "Runtime.evaluate")).id, result: { result: { value: true } } }));
  await reply(r, 1);
  const evil = `https://x.test/"';}+alert(1)//\\</script>  ?q=\`\${x}\``;
  nav(r, 2, { url: evil });
  const ev = await sentTo(r, "Runtime.evaluate", 1);
  expect(runExpression(ev.params.expression)).toBe(new URL(evil).href);
});

test("invalid URLs are rejected without touching the page", async () => {
  const r = rig();
  await mainFrame(r);
  for (const [i, url] of [[1, "not a url"], [2, ""], [3, 42], [4, undefined]] as const) {
    nav(r, i, url === undefined ? {} : { url });
    const m = await reply(r, i);
    expect(m.error.message).toMatch(/invalid URL/i);
  }
  expect(r.toTarget).toHaveLength(0);
});

test("shim refuses javascript: URLs and sub-frame navigation", async () => {
  const r = rig();
  await mainFrame(r);
  nav(r, 1, { url: "https://a.test/" });
  await r.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r, "Page.navigate")).id, error: NOT_FOUND }));
  await r.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r, "Runtime.evaluate")).id, result: { result: { value: true } } }));
  await reply(r, 1);
  nav(r, 2, { url: "javascript:alert(1)" });
  expect((await reply(r, 2)).error.message).toMatch(/javascript:/);
  nav(r, 3, { url: "https://b.test/", frameId: "0.9" });
  expect((await reply(r, 3)).error.message).toMatch(/frame/);
  expect(r.toTarget.filter((x) => x.method === "Runtime.evaluate")).toHaveLength(1);
});

test("same-document (fragment) navigation answers without a loaderId", async () => {
  const r = rig();
  await mainFrame(r, "https://a.test/page");
  nav(r, 1, { url: "https://a.test/page#section" });
  await r.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r, "Page.navigate")).id, error: NOT_FOUND }));
  await r.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r, "Runtime.evaluate")).id, result: { result: { value: true } } }));
  const m = await reply(r, 1);
  expect(m.result.frameId).toBe("0.1");
  expect(m.result.loaderId).toBeUndefined();
});

test("main frame unknown: asks Page.getResourceTree for it", async () => {
  const r = rig();
  nav(r, 1, { url: "https://a.test/" });
  const q = await sentTo(r, "Page.navigate");
  await r.t.onMessageFromTarget(JSON.stringify({ id: q.id, result: {} }));
  const tree = await sentTo(r, "Page.getResourceTree");
  await r.t.onMessageFromTarget(
    JSON.stringify({ id: tree.id, result: { frameTree: { frame: { id: "0.3", loaderId: "0.4", url: "https://z.test/" }, resources: [] } } }),
  );
  expect((await reply(r, 1)).result.frameId).toBe("0.3");
});

test("an exception from the shim evaluate, or another native error, is reported", async () => {
  const r = rig();
  await mainFrame(r);
  nav(r, 1, { url: "https://a.test/" });
  await r.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r, "Page.navigate")).id, error: NOT_FOUND }));
  const ev = await sentTo(r, "Runtime.evaluate");
  await r.t.onMessageFromTarget(JSON.stringify({ id: ev.id, result: { result: { type: "object" }, wasThrown: true, exceptionDetails: { text: "SecurityError" } } }));
  expect((await reply(r, 1)).error.message).toMatch(/SecurityError/);

  const r2 = rig();
  await mainFrame(r2);
  nav(r2, 1, { url: "https://a.test/" });
  await r2.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r2, "Page.navigate")).id, error: { code: -32000, message: "Cannot navigate" } }));
  expect((await reply(r2, 1)).error.message).toMatch(/Cannot navigate/);
  expect(r2.toTarget.some((x) => x.method === "Runtime.evaluate")).toBe(false);
});

test("an unrelated 'was not found' error does not switch the session to the shim (review)", async () => {
  const r = rig();
  await mainFrame(r);
  nav(r, 1, { url: "https://a.test/" });
  await r.t.onMessageFromTarget(JSON.stringify({ id: (await sentTo(r, "Page.navigate")).id, error: { code: -32000, message: "Frame was not found" } }));
  expect((await reply(r, 1)).error.message).toMatch(/Frame was not found/);
  nav(r, 2, { url: "https://a.test/" });
  await sentTo(r, "Page.navigate", 1);
  expect(r.toTarget.some((x) => x.method === "Runtime.evaluate")).toBe(false);
});
