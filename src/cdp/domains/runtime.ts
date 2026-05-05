import type { Target } from "../target";
import { type DomainCtx, swallowWith } from "../domain";

// Runtime domain translation. Most CDP Runtime methods map 1:1 onto WIR's
// Runtime, so the bulk of work here is reshaping responses (evaluate-with-
// throw, getProperties shape) and silencing methods Safari doesn't have.
export function installRuntimeFilters(t: Target, ctx: DomainCtx) {
  t.addMessageFilter("target::Runtime.executionContextCreated", (msg) => {
    const c = msg.params?.context;
    if (c) {
      if (!c.origin) c.origin = c.name ?? "";
      // The executionContextId on synthesized Runtime.consoleAPICalled
      // events MUST be one DevTools knows about (it dropped events
      // otherwise). Track whatever Safari announces:
      //   - first announced wins (so a Console.messageAdded that arrives
      //     before any page context still has a real id)
      //   - upgrade to a page context if/when one is announced
      const id = Number(c.id);
      const isPage = !!(c.isPageContext || c.type === "normal");
      if (Number.isFinite(id) && id > 0) {
        if (!ctx.pageExecCtx.id || (isPage && !ctx.pageExecCtx.isPage)) {
          ctx.pageExecCtx.id = id;
          ctx.pageExecCtx.isPage = isPage;
        }
      }
      if (c.frameId) {
        c.auxData = { frameId: c.frameId, isDefault: true };
        delete c.frameId;
      }
    }
    return Promise.resolve(msg);
  });
  // CDP-only Runtime.evaluate fields that need WIR equivalents. Without
  // these renames `silent` and `userGesture` are silently ignored —
  // observable as the page pausing on exceptions while DevTools evaluates,
  // or gesture-gated APIs (clipboard, fullscreen) failing in the REPL.
  t.addMessageFilter("tools::Runtime.evaluate", (msg) => {
    const p = msg.params;
    if (!p) return Promise.resolve(msg);
    // Eager-eval: DevTools sends Runtime.evaluate with throwOnSideEffect
    // every keystroke to render the inline preview. V8 honors the flag and
    // refuses anything mutating; Safari's WIR has no equivalent and would
    // run the half-typed expression for real. Short-circuit with the same
    // synthetic "side-effect" exception V8 returns, so DevTools just
    // suppresses the preview.
    if (p.throwOnSideEffect) {
      return swallowWith(t, msg, {
        result: {
          type: "object",
          subtype: "error",
          className: "EvalError",
          description: "EvalError: Possible side-effect in debug-evaluate",
        },
        exceptionDetails: {
          exceptionId: 0,
          text: "EvalError: Possible side-effect in debug-evaluate",
          lineNumber: 0,
          columnNumber: 0,
          url: "",
          exception: {
            type: "object",
            subtype: "error",
            className: "EvalError",
            description: "EvalError: Possible side-effect in debug-evaluate",
          },
        },
      });
    }
    if ("silent" in p) {
      p.doNotPauseOnExceptionsAndMuteConsole = !!p.silent;
      delete p.silent;
    }
    if ("userGesture" in p) {
      p.emulateUserGesture = !!p.userGesture;
      delete p.userGesture;
    }
    return Promise.resolve(msg);
  });

  // Safari signals exceptions with a top-level `wasThrown:true`; CDP wants
  // `exceptionDetails: {...}` and a `subtype:"error"` on the value. Apply
  // ONLY to Runtime.evaluate. callFunctionOn and evaluateOnCallFrame have
  // overlapping shapes but DevTools uses callFunctionOn for many internal
  // probes (previews, descriptions) where mutating the response confuses it
  // — leave those passthrough.
  t.addMessageFilter("target::Runtime.evaluate", (msg) => {
    const r = msg.result;
    if (r?.wasThrown) {
      if (r.result) r.result.subtype = "error";
      r.exceptionDetails = {
        exceptionId: 0,
        text: r.result?.description ?? "Uncaught",
        url: "",
        scriptId: ctx.lastScriptEval.value,
        lineNumber: 0,
        columnNumber: 0,
        stackTrace: {
          callFrames: [
            {
              functionName: "",
              scriptId: ctx.lastScriptEval.value,
              url: "",
              lineNumber: 0,
              columnNumber: 0,
            },
          ],
        },
        exception: r.result,
      };
    }
    return Promise.resolve(msg);
  });
  t.addMessageFilter("target::Runtime.getProperties", (msg) => {
    // CDP and WIR mostly agree on the property descriptor shape, but Safari
    // sometimes delivers inherited props mixed in even when ownProperties
    // was requested, and uses a top-level `properties` field instead of
    // `result` on some iOS builds. Normalize to CDP's shape:
    //   { result: PropertyDescriptor[], internalProperties?: ... }
    const r = msg.result;
    if (!r) return Promise.resolve(msg);
    // Some iOS builds use `properties` rather than `result` on the wire.
    const arr = Array.isArray(r.result) ? r.result
      : Array.isArray(r.properties) ? r.properties
      : null;
    if (arr) {
      r.result = arr
        .filter((p: any) => p.isOwn || p.nativeGetter)
        .map((p: any) => ({ ...p, isOwn: true }));
      delete r.properties;
    }
    // Internal properties: pass through unchanged (CDP shape is a subset).
    if (Array.isArray(r.internalProperties)) {
      r.internalProperties = r.internalProperties.map((p: any) => ({
        name: p.name,
        value: p.value,
      }));
    }
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Runtime.compileScript", (msg) =>
    // Safari doesn't have compileScript — fake success so DevTools can call evaluate.
    swallowWith(t, msg, { scriptId: null, exceptionDetails: null }),
  );

  // ---- Runtime: methods DevTools' Console REPL exercises ----------------
  // Auto-complete uses globalLexicalScopeNames; Safari has nothing
  // equivalent — return empty so DevTools falls back to enumerating
  // window properties via getProperties.
  t.addMessageFilter("tools::Runtime.globalLexicalScopeNames", (msg) =>
    swallowWith(t, msg, { names: [] }),
  );
  // Console panel uses these; Safari's Inspector returns "method not
  // found" which DevTools surfaces as a console error. Stub to keep the
  // panel quiet.
  t.addMessageFilter("tools::Runtime.terminateExecution", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Runtime.getIsolateId", (msg) =>
    swallowWith(t, msg, { id: "inspect-webkit" }),
  );
  t.addMessageFilter("tools::Runtime.getHeapUsage", (msg) =>
    swallowWith(t, msg, { usedSize: 0, totalSize: 0 }),
  );

  // ---- Runtime small additions -----------------------------------------
  // DevTools uses these on console.clear() / context teardown. Safari has
  // analogous but differently-named methods.
  t.addMessageFilter("tools::Runtime.discardConsoleEntries", (msg) => {
    msg.method = "Console.clearMessages";
    return Promise.resolve(msg);
  });
  // Runtime.runIfWaitingForDebugger — no-op in Safari, ack so DevTools moves on.
  t.addMessageFilter("tools::Runtime.runIfWaitingForDebugger", (msg) =>
    swallowWith(t, msg, {}),
  );
  // setAsyncCallStackDepth: WIR has the equivalent under the Debugger
  // domain (`Debugger.setAsyncStackTraceDepth`). DevTools is happy with a
  // clean ack — forwarding the renamed call has no observable effect on
  // the panel and risks "method not found" on older iOS builds where the
  // WIR equivalent is gated. Swallow with `{}`.
  t.addMessageFilter("tools::Runtime.setAsyncCallStackDepth", (msg) =>
    swallowWith(t, msg, {}),
  );
  // Object lifetime methods: WIR exposes both with the same name and the
  // same params shape ({ objectId } / { objectGroup }). Pure passthrough
  // — registering the filter explicitly so the survey is honest about
  // what we forward.
  t.addMessageFilter("tools::Runtime.releaseObject", (msg) =>
    Promise.resolve(msg),
  );
  t.addMessageFilter("tools::Runtime.releaseObjectGroup", (msg) =>
    Promise.resolve(msg),
  );
  // callFunctionOn: CDP and WIR agree on the param shape
  // ({ objectId, functionDeclaration, arguments?, returnByValue?,
  // generatePreview?, awaitPromise?, executionContextId?, objectGroup? }).
  // The response mirrors Runtime.evaluate ({ result, wasThrown? }). We
  // deliberately do NOT synthesize exceptionDetails on the way back — see
  // the comment on target::Runtime.evaluate above; DevTools uses
  // callFunctionOn for object previews and a fake error confuses it.
  t.addMessageFilter("tools::Runtime.callFunctionOn", (msg) =>
    Promise.resolve(msg),
  );
  // queryObjects: Safari supports this with the same params
  // ({ prototypeObjectId, objectGroup? }) and same response
  // ({ objects: RemoteObject }). Passthrough.
  t.addMessageFilter("tools::Runtime.queryObjects", (msg) =>
    Promise.resolve(msg),
  );
  // executionContextsCleared synthesis: Safari emits
  // Debugger.globalObjectCleared on navigation; CDP equivalent is
  // Runtime.executionContextsCleared. Translate and swallow the WIR event
  // so DevTools doesn't see an unknown method.
  t.addMessageFilter("target::Debugger.globalObjectCleared", (_msg) => {
    t.fireEventToTools("Runtime.executionContextsCleared", {});
    return Promise.resolve(null);
  });
}
