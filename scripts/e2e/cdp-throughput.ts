#!/usr/bin/env bun
// Throughput characterization for Runtime.evaluate over the bridge.
// Surveys serial, throttled, and naïve-parallel modes; pinpoints the
// in-flight ceiling. Used to set sensible test budgets.
//
// Usage: bun scripts/e2e/cdp-throughput.ts <wsUrl>
//
// IMPORTANT: this script DELIBERATELY tries to overflow the inflight queue
// (n=70+). Doing so leaves Safari's webinspector session for that page in
// a wedged state. The script reconnects a fresh WS per trial to isolate
// trials, but the underlying page may still need a Safari restart afterward
// for normal use. Don't run this against a production debugging session.

const wsUrl = process.argv[2];
if (!wsUrl) {
  console.error("usage: bun scripts/e2e/cdp-throughput.ts <wsUrl>");
  process.exit(2);
}

async function trial(n: number) {
  let nextId = 0;
  const pending = new Map<number, (m: any) => void>();
  const ws = new WebSocket(wsUrl);
  // onmessage MUST be set before onopen — see docs/e2e-verification.md
  ws.onmessage = (e) => {
    const m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  };
  function send(method: string, params: any = {}, timeoutMs = 5000) {
    const id = ++nextId;
    return new Promise<{ ok: boolean; ms: number }>((resolve) => {
      const t0 = performance.now();
      pending.set(id, () => resolve({ ok: true, ms: performance.now() - t0 }));
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, ms: timeoutMs }); }
      }, timeoutMs);
    });
  }
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  await send("Runtime.enable");
  const start = performance.now();
  const ps: Promise<{ ok: boolean; ms: number }>[] = [];
  for (let i = 0; i < n; i++) {
    ps.push(send("Runtime.evaluate", { expression: `${i}+1`, returnByValue: true }));
  }
  const r = await Promise.all(ps);
  const wall = performance.now() - start;
  const ok = r.filter((x) => x.ok).length;
  const durs = r.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
  const p = (q: number) => durs[Math.min(durs.length - 1, Math.floor(durs.length * q))] ?? -1;
  ws.close();
  await new Promise((r) => setTimeout(r, 800));
  return {
    n, wall: +wall.toFixed(0), ok, drops: n - ok,
    p50: +p(0.5).toFixed(2), p95: +p(0.95).toFixed(2),
    reqPerSec: ok > 0 ? +((ok / wall) * 1000).toFixed(0) : 0,
  };
}

console.log("# Naïve parallel — find the in-flight ceiling");
console.log("# (each row uses a fresh WebSocket)");
for (const n of [10, 30, 50, 60, 70, 80, 100]) {
  console.log(JSON.stringify(await trial(n)));
}
process.exit(0);
