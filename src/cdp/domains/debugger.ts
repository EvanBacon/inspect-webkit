import type { Target, CdpMessage } from "../target";
import { type DomainCtx, swallowWith } from "../domain";

// CDP↔WIR debugger differences: setBreakpoint/ByUrl param wrapping
// (CDP uses top-level `condition`, WIR nests under `options`); call-frame
// field names on Debugger.paused; and a few CDP methods absent on Safari
// that we silently ack instead of forwarding.
export function installDebuggerFilters(t: Target, ctx: DomainCtx) {
  t.addMessageFilter("tools::Debugger.canSetScriptSource", (msg) =>
    swallowWith(t, msg, { result: false }),
  );
  t.addMessageFilter("tools::Debugger.setBlackboxPatterns", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Debugger.setAsyncCallStackDepth", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("target::Debugger.enable", (msg) => {
    // Both kicks must run AFTER Debugger.enable is acked; Safari no-ops
    // them silently if the domain isn't enabled, and CDP assumes
    // pause-on-debugger is on by default — so we opt in for the page.
    t.callTarget("Debugger.setBreakpointsActive", { active: true }).catch(() => {});
    t.callTarget("Debugger.setPauseOnDebuggerStatements", { enabled: true }).catch(() => {});
    return Promise.resolve(msg);
  });
  t.addMessageFilter("target::Debugger.scriptParsed", (msg) => {
    if (msg.params?.scriptId) ctx.lastScriptEval.value = String(msg.params.scriptId);
    return Promise.resolve(msg);
  });

  // ---- Breakpoint setup -----------------------------------------------
  // CDP setBreakpoint: { location: {scriptId, lineNumber, columnNumber?},
  //                     condition? }
  // WIR setBreakpoint:  { location: {scriptId, lineNumber, columnNumber?},
  //                     options?: { condition?, ignoreCount?, autoContinue? } }
  // Reshape on the way down.
  t.addMessageFilter("tools::Debugger.setBreakpoint", (msg) => {
    const p = msg.params ?? {};
    msg.params = {
      location: p.location,
      options: p.condition ? { condition: p.condition } : {},
    };
    return Promise.resolve(msg);
  });
  // CDP setBreakpointByUrl: { lineNumber, url?, urlRegex?, scriptHash?,
  //                          columnNumber?, condition? }
  // WIR setBreakpointByUrl: { lineNumber, url?, urlRegex?, columnNumber?,
  //                          options?: { condition? } }
  // Strip the unsupported scriptHash field; nest condition.
  t.addMessageFilter("tools::Debugger.setBreakpointByUrl", (msg) => {
    const p = msg.params ?? {};
    msg.params = {
      lineNumber: p.lineNumber,
      url: p.url,
      urlRegex: p.urlRegex,
      columnNumber: p.columnNumber,
      options: p.condition ? { condition: p.condition } : {},
    };
    return Promise.resolve(msg);
  });

  // ---- Step / pause / resume — pure passthrough -----------------------
  // WIR matches CDP exactly for these; declare filters so the survey
  // shows we own them.
  for (const m of [
    "removeBreakpoint",
    "continueToLocation",
    "stepInto",
    "stepOver",
    "stepOut",
    "resume",
    "pause",
    "getScriptSource",
    "evaluateOnCallFrame",
  ] as const) {
    t.addMessageFilter(`tools::Debugger.${m}`, (msg) => Promise.resolve(msg));
  }

  // ---- Debugger.paused event ------------------------------------------
  // CDP shape per call frame:
  //   { callFrameId, functionName, location:{scriptId,lineNumber,columnNumber},
  //     scopeChain:[{type, object, name?, startLocation?, endLocation?}],
  //     this, returnValue?, url? }
  // WIR shape can deliver `functionName` as `name`, `location` as
  // `sourceCodeLocation`, and scope `type` values match. Normalize.
  t.addMessageFilter("target::Debugger.paused", (msg: CdpMessage) => {
    const frames = msg.params?.callFrames;
    if (Array.isArray(frames)) {
      for (const f of frames) {
        if (f.functionName == null && typeof f.name === "string") {
          f.functionName = f.name;
        }
        if (!f.location && f.sourceCodeLocation) {
          f.location = {
            scriptId: String(f.sourceCodeLocation.scriptId ?? ""),
            lineNumber: f.sourceCodeLocation.lineNumber ?? 0,
            columnNumber: f.sourceCodeLocation.columnNumber ?? 0,
          };
        }
        if (Array.isArray(f.scopeChain)) {
          for (const s of f.scopeChain) {
            // WIR uses the same `type` strings, but CDP requires `object`
            // — older Safari sometimes ships it as `value`.
            if (!s.object && s.value) s.object = s.value;
          }
        }
      }
    }
    return Promise.resolve(msg);
  });

  // ---- Methods CDP defines that Safari doesn't -----------------------
  t.addMessageFilter("tools::Debugger.setBlackboxedRanges", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Debugger.setSkipAllPauses", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Debugger.setPauseOnExceptions", (msg) => {
    // Safari understands this method but accepts {state:"none"|"uncaught"|"all"}
    // exactly like CDP — passthrough is fine.
    return Promise.resolve(msg);
  });
}
