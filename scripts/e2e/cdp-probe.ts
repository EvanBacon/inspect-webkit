#!/usr/bin/env bun
// One-shot CDP probe. Connects to a running bridge, sends a sequence of
// CDP commands against a single target, prints results.
//
// Usage:
//   bun scripts/e2e/cdp-probe.ts <wsUrl>
//   bun scripts/e2e/cdp-probe.ts ws://localhost:9222/devtools/page/<targetId>
//
// To pick a target programmatically:
//   curl -s http://localhost:9222/json/list | jq -r '.[0].webSocketDebuggerUrl'

const wsUrl = process.argv[2];
if (!wsUrl) {
  console.error("usage: bun scripts/e2e/cdp-probe.ts <wsUrl>");
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map<number, (v: any) => void>();
const events: any[] = [];

function send(method: string, params: any = {}, timeoutMs = 5000): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, timeoutMs);
  });
}

ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
  } else {
    events.push(m);
  }
};
ws.onerror = (e) => console.error("ws error", e);

ws.onopen = async () => {
  const evalExpr = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r.error) throw new Error(`${expr}: ${r.error.message}`);
    if (r.result?.wasThrown) throw new Error(`${expr} threw: ${JSON.stringify(r.result.result)}`);
    return r.result.result.value;
  };

  await send("Runtime.enable");
  await send("Page.enable");

  console.log("1+41 =", await evalExpr("1+41"));
  console.log("location.href =", await evalExpr("location.href"));
  console.log("document.title =", await evalExpr("document.title"));

  const dom = await send("DOM.getDocument");
  console.log("DOM.getDocument root nodeId =", dom.result?.root?.nodeId);

  const tree = await send("Page.getResourceTree");
  console.log("frame url =", tree.result?.frameTree?.frame?.url);

  process.exit(0);
};
