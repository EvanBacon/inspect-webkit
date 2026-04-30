import type { Target } from "../target";
import type { DomainCtx } from "../domain";
import { swallowWith } from "../domain";

export function installConsoleLogFilters(t: Target, ctx: DomainCtx) {
  // Log.startViolationsReport / stopViolationsReport: Chrome-only lint hook
  // (Reporting API). Safari has no equivalent. Ack-stub so DevTools doesn't
  // log a "domain not found" on attach.
  t.addMessageFilter("tools::Log.startViolationsReport", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Log.stopViolationsReport", (msg) =>
    swallowWith(t, msg, {}),
  );
  // ---- Console / Log ----------------------------------------------------
  // Chrome DevTools (newer) uses Log.entryAdded; Safari emits Console.messageAdded.
  t.addMessageFilter("tools::Log.clear", (msg) => {
    msg.method = "Console.clearMessages";
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Log.disable", (msg) => {
    msg.method = "Console.disable";
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Log.enable", (msg) => {
    msg.method = "Console.enable";
    return Promise.resolve(msg);
  });
  // Chrome's Runtime.enable implicitly turns on console output too. Safari
  // doesn't — Console.* events only flow once Console.enable is sent. Modern
  // js-debug attaches with just Runtime.enable, so without this side-effect
  // call Console.messageAdded never fires and the Debug Console stays empty.
  // Pass-through Runtime.enable unchanged; kick Console.enable in parallel.
  t.addMessageFilter("tools::Runtime.enable", (msg) => {
    t.callTarget("Console.enable", {}).catch(() => {});
    return Promise.resolve(msg);
  });
  // Safari emits everything through Console.messageAdded (a single event
  // for console.* calls, network errors, security violations, uncaught
  // exceptions, ...). Modern Chrome DevTools demultiplexes this:
  //   - console.log/info/warn/error/debug/etc → Runtime.consoleAPICalled
  //     (this is what the Console panel listens to)
  //   - uncaught JS exceptions               → Runtime.exceptionThrown
  //   - network / security / other           → Log.entryAdded
  // We split here so each panel sees the events it expects.
  t.addMessageFilter("target::Console.messageAdded", (msg) => {
    const m = msg.params?.message ?? {};
    // Safari sends stackTrace either as an array of frames OR an object
    // { callFrames: [...] } depending on version. Normalize.
    const rawFrames: any[] = Array.isArray(m.stackTrace)
      ? m.stackTrace
      : Array.isArray(m.stackTrace?.callFrames)
        ? m.stackTrace.callFrames
        : [];
    const callFrames = rawFrames.map((f: any) => ({
      functionName: f.functionName ?? "",
      scriptId: f.scriptId ?? "",
      url: f.url ?? "",
      lineNumber: Number(f.lineNumber ?? 0),
      columnNumber: Number(f.columnNumber ?? 0),
    }));
    const stackTrace = callFrames.length ? { callFrames } : undefined;
    const tsMs = Date.now();

    if (m.source === "console-api") {
      // Map Safari console levels → CDP types. CDP uses "warning" (not "warn").
      const t0 = m.type === "log" ? m.level ?? "log" : m.type ?? "log";
      const apiType = mapConsoleType(t0);
      // Safari already sends RemoteObject-shaped entries in `parameters`.
      const args =
        Array.isArray(m.parameters) && m.parameters.length > 0
          ? m.parameters
          : [{ type: "string", value: String(m.text ?? "") }];
      const payload = {
        type: apiType,
        args,
        // If we haven't seen a Runtime.executionContextCreated yet, fall
        // back to 1 — DevTools' default. Most pages produce a context
        // event before any console output, so this rarely fires.
        executionContextId: ctx.pageExecCtx.id || 1,
        timestamp: tsMs,
        stackTrace,
      };
      ctx.lastConsoleApiCalled.value = payload;
      t.fireEventToTools("Runtime.consoleAPICalled", payload);
      return Promise.resolve(null);
    }

    if (m.source === "javascript" && m.level === "error") {
      // Uncaught exception — Console panel still wants this, but as
      // exceptionThrown so it can render the error stack/red banner.
      t.fireEventToTools("Runtime.exceptionThrown", {
        timestamp: tsMs,
        exceptionDetails: {
          exceptionId: 0,
          text: String(m.text ?? "Uncaught"),
          lineNumber: Number(m.line ?? 0),
          columnNumber: Number(m.column ?? 0),
          scriptId: ctx.lastScriptEval.value,
          url: m.url,
          stackTrace,
          exception: { type: "string", value: String(m.text ?? "") },
        },
      });
      return Promise.resolve(null);
    }

    // Everything else: Log.entryAdded (network errors, deprecations, etc).
    t.fireEventToTools("Log.entryAdded", {
      entry: {
        source: m.source ?? "other",
        level: mapLogLevel(m.level ?? m.type ?? "log"),
        text: String(m.text ?? ""),
        timestamp: tsMs,
        url: m.url,
        lineNumber: m.line,
        stackTrace,
        networkRequestId: m.networkRequestId,
      },
    });
    return Promise.resolve(null);
  });

  // Console.messagesCleared from Safari → Runtime.consoleAPIClear /
  // Log.entryCleared so DevTools clears its console panel state.
  t.addMessageFilter("target::Console.messagesCleared", () => {
    t.fireEventToTools("Log.entriesCleared", {});
    t.fireEventToTools("Runtime.consoleAPICalled", {
      type: "clear",
      args: [],
      executionContextId: ctx.pageExecCtx.id || 1,
      timestamp: Date.now(),
    });
    ctx.lastConsoleApiCalled.value = null;
    return Promise.resolve(null);
  });

  // WIR emits messageRepeatCountUpdated (with the new count) instead of
  // re-emitting the message body when the same line repeats. CDP has no
  // equivalent — DevTools dedupes by content client-side. Closest fix:
  // re-fire the last consoleAPICalled payload so the entry visibly
  // increments. Safari hands us the count, but CDP has no place for it.
  t.addMessageFilter("target::Console.messageRepeatCountUpdated", () => {
    const last = ctx.lastConsoleApiCalled.value;
    if (last) {
      // Bump the timestamp so DevTools doesn't collapse this back into
      // the previous entry by identity.
      t.fireEventToTools("Runtime.consoleAPICalled", { ...last, timestamp: Date.now() });
    }
    return Promise.resolve(null);
  });

  // WIR Console.heapSnapshot is a snapshot delivery channel for the
  // Memory panel. CDP's equivalent is HeapProfiler.addHeapSnapshotChunk
  // (chunked) plus reportHeapSnapshotProgress, and DevTools won't accept
  // a single-shot WIR-shaped payload. Until a proper translation exists,
  // swallow so DevTools doesn't see an unknown method (which would log a
  // visible protocol error in the Console panel).
  t.addMessageFilter("target::Console.heapSnapshot", () => Promise.resolve(null));
}

// CDP Runtime.consoleAPICalled types: log, debug, info, error, warning,
// dir, dirxml, table, trace, clear, startGroup, startGroupCollapsed,
// endGroup, assert, profile, profileEnd, count, timeEnd
export function mapConsoleType(t: string): string {
  switch (t) {
    // Safari emits `"warning"` (its native level), CDP DevTools clients
    // accept `"warning"` too; "warn" only appears in some WIR builds.
    case "warn":
    case "warning":
      return "warning";
    case "log":
    case "info":
    case "error":
    case "debug":
    case "dir":
    case "dirxml":
    case "table":
    case "trace":
    case "clear":
    case "assert":
    case "profile":
    case "profileEnd":
    case "count":
    case "timeEnd":
    case "startGroup":
    case "startGroupCollapsed":
    case "endGroup":
      return t;
    default:
      return "log";
  }
}

// CDP Log.LogEntry levels: verbose, info, warning, error
function mapLogLevel(level: string): string {
  switch (level) {
    case "log":
    case "debug":
      return "verbose";
    case "info":
      return "info";
    case "warn":
    case "warning":
      return "warning";
    case "error":
      return "error";
    default:
      return "info";
  }
}
