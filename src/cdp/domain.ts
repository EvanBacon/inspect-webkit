// Shared helpers and per-session context object passed to each domain's
// installXxxFilters(t, ctx) function. Kept tiny on purpose — only patterns
// used by 3+ filters live here.

import type { Target, CdpMessage } from "./target";

/** Per-session state shared across multiple domains. Each field is a
 *  mutable holder so domains can read/write the same value through the
 *  closure-captured object. State used by exactly one domain stays inside
 *  that domain's installer instead of going here. */
export type DomainCtx = {
  // Last seen Debugger.scriptParsed scriptId. Written by the Debugger
  // domain, read by Runtime (evaluate exception synthesis) and Console
  // (uncaught-exception synthesis).
  lastScriptEval: { value: string };
  // Tracked Runtime executionContextId for synthesized
  // Runtime.consoleAPICalled events. Written by Runtime, read by Console.
  pageExecCtx: { id: number; isPage: boolean };
  // The last Runtime.consoleAPICalled payload we emitted. Re-fired on
  // WIR Console.messageRepeatCountUpdated so DevTools shows a new entry
  // for each repeat (closest CDP equivalent — CDP has no count field).
  lastConsoleApiCalled: { value: any | null };
};

export function makeDomainCtx(): DomainCtx {
  return {
    lastScriptEval: { value: "" },
    pageExecCtx: { id: 0, isPage: false },
    lastConsoleApiCalled: { value: null },
  };
}

/** Reply to a tools-side request with `result` and swallow the message so
 *  it's never forwarded to Safari. Used by ack-and-stub filters. */
export function swallowWith(
  t: Target,
  msg: CdpMessage,
  result: any,
): Promise<CdpMessage | null> {
  t.fireResultToTools(msg.id!, result);
  return Promise.resolve(null);
}
