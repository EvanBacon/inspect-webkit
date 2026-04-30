#!/usr/bin/env bun
// Scenario probe: Debugger.paused must fire on a `debugger;` statement,
// callFrames must be well-formed, and Debugger.resume must let the eval
// complete. Regression guard for the setPauseOnDebuggerStatements kick
// in src/cdp/domains/debugger.ts (target::Debugger.enable filter).
//
// Usage: bun scripts/e2e/cdp-debugger-paused.ts <wsUrl>
// Exit:  0 if all assertions pass, 1 otherwise.

const wsUrl = process.argv[2];
if (!wsUrl) {
  console.error("usage: bun scripts/e2e/cdp-debugger-paused.ts <wsUrl>");
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map<number, (m: any) => void>();
const events: any[] = [];
let pausedEvent: any = null;

// Attach onmessage BEFORE awaiting onopen — otherwise Bun drops the first
// frame, which presents as Runtime.enable hanging. See
// docs/e2e-verification.md L166-170.
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === "Debugger.paused" && !pausedEvent) pausedEvent = m;
  events.push(m);
};

function send(method: string, params: any = {}, timeoutMs = 3000): Promise<any> {
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

const failures: string[] = [];
function assert(cond: any, msg: string) {
  if (!cond) failures.push(msg);
}

ws.onopen = async () => {
  await send("Runtime.enable");
  await send("Debugger.enable");
  // Safari retains setPauseOnDebuggerStatements as persistent JSC state
  // across CDP sessions, so a prior run with the bridge's kick in place
  // would leave the page already paused-on-debugger and mask a missing
  // kick. Force pause-on-debugger OFF, then disable/re-enable Debugger
  // so the bridge's target::Debugger.enable filter has to put it back
  // on. If the kick is missing, the next eval will skip the `debugger;`
  // statement and Debugger.paused won't fire.
  await send("Debugger.setPauseOnDebuggerStatements", { enabled: false }).catch(() => {});
  await send("Debugger.disable");
  await send("Debugger.enable");
  await new Promise((r) => setTimeout(r, 200));

  const evalP = send(
    "Runtime.evaluate",
    { expression: "(function(){ debugger; return 42; })()", returnByValue: true },
    5000,
  );

  // Wait up to 1s for Debugger.paused.
  const deadline = Date.now() + 1000;
  while (!pausedEvent && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  assert(pausedEvent, "Debugger.paused did not fire within 1s");
  if (pausedEvent) {
    const frames = pausedEvent.params?.callFrames;
    assert(Array.isArray(frames) && frames.length > 0, "callFrames missing or empty");
    if (Array.isArray(frames) && frames.length > 0) {
      const f = frames[0];
      assert(typeof f.functionName === "string", "callFrames[0].functionName missing/wrong type");
      assert(f.location && typeof f.location.scriptId === "string", "callFrames[0].location.scriptId missing");
      assert(typeof f.location?.lineNumber === "number", "callFrames[0].location.lineNumber missing");
    }
  }

  await send("Debugger.resume").catch(() => {});

  let evalResult: any;
  try {
    evalResult = await evalP;
  } catch (e) {
    failures.push(`Runtime.evaluate did not complete after resume: ${(e as Error).message}`);
  }
  if (evalResult) {
    const v = evalResult.result?.result?.value;
    assert(v === 42, `eval returned ${JSON.stringify(v)}, expected 42`);
  }

  if (failures.length === 0) {
    console.log("OK  Debugger.paused regression probe — all assertions passed");
    process.exit(0);
  }
  console.error("FAIL Debugger.paused regression probe");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
};
