#!/usr/bin/env bun
// Regression test for the cross-origin navigation fix
// (src/cdp/target.ts, Target.didCommitProvisionalTarget handler).
//
// Before the fix: after a cross-origin navigation, the bridge kept wrapping
// outgoing messages for the old (dead) inner targetId, so all subsequent
// requests hung. This test confirms a Runtime.evaluate after a cross-origin
// nav reaches the new target.
//
// Usage: bun scripts/e2e/cdp-cross-origin-nav.ts <wsUrl>
// Precondition: target page is loaded at https://example.com/.

const wsUrl = process.argv[2];
if (!wsUrl) {
  console.error("usage: bun scripts/e2e/cdp-cross-origin-nav.ts <wsUrl>");
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map<number, (m: any) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
};
function send(method: string, params: any = {}, timeoutMs = 5000): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
    }, timeoutMs);
  });
}

await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
await send("Runtime.enable");

const before = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
const startUrl = before.result?.result?.value;
console.log(`before: ${startUrl}`);
if (!startUrl?.startsWith("https://example.com/")) {
  console.error("precondition failed: page must start at https://example.com/");
  process.exit(2);
}

// Trigger a cross-origin navigation. Page.navigate isn't supported on iOS
// 26.5, so use Runtime.evaluate to set location.href instead.
await send("Runtime.evaluate", { expression: "location.href = 'https://example.org/'" });

// Pre-fix: this Runtime.evaluate would hang forever (wrapped to dead target).
// Post-fix: it reaches the new provisional target.
const after = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, 8000);
const endUrl = after.result?.result?.value;
console.log(`after:  ${endUrl}`);

if (endUrl === "https://example.org/") {
  console.log("PASS — bridge followed provisional target swap");
  process.exit(0);
} else {
  console.log("FAIL");
  process.exit(1);
}
