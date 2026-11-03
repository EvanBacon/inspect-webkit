// Page.navigate (R11). WebKit on iOS 27 no longer has Page.navigate
// (-32601 "'Page.navigate' was not found"). The bridge tries the native
// method first and, once WebKit reports it missing, navigates by assigning
// location.href through Runtime.evaluate for the rest of the session.
// Either way the client gets the CDP reply shape {frameId, loaderId}
// (WebKit's native reply is {}), which Puppeteer's page.goto relies on.

import type { Target } from "../target";
import { isPlainObject } from "../domain";

/** Fallback when the main frame id can't be learned (no frameNavigated, no tree). */
const UNKNOWN_FRAME_ID = "main";

function isMethodNotFound(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  return err?.code === -32601 || /was not found/.test(err?.message ?? "");
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Script for the shim. The URL is a JSON string literal (quotes, backslashes
 *  and control characters escaped), so it can only ever be the value
 *  assigned. The assignment runs after the evaluate returns, so the reply
 *  isn't lost to the navigation tearing down the context. */
export function navigateExpression(href: string): string {
  return `(function(){var u=${JSON.stringify(href)};setTimeout(function(){location.href=u},0);return true})()`;
}

export function installPageNavigateFilters(t: Target) {
  /** undefined until probed; false once WebKit said -32601. */
  let native: boolean | undefined;
  let main: { id: string; url?: string } | null = null;
  let loaderSeq = 0;

  const noteMainFrame = (f: unknown) => {
    if (!isPlainObject(f) || f.parentId || typeof f.id !== "string") return;
    main = { id: f.id, url: typeof f.url === "string" ? f.url : undefined };
  };
  t.addMessageFilter("target::Page.frameNavigated", (msg) => {
    noteMainFrame(msg.params?.frame);
    return Promise.resolve(msg);
  });

  async function mainFrameId(): Promise<string> {
    if (!main) {
      try {
        const r = await t.callTarget("Page.getResourceTree", {});
        noteMainFrame(r?.frameTree?.frame);
      } catch {}
    }
    return main?.id ?? UNKNOWN_FRAME_ID;
  }

  /** Same document: only the fragment changes (CDP then omits loaderId). */
  function isSameDocument(url: URL): boolean {
    if (!url.hash || !main?.url) return false;
    try {
      const cur = new URL(main.url);
      cur.hash = url.hash;
      return cur.href === url.href;
    } catch {
      return false;
    }
  }

  async function viaScript(url: URL, frameId: unknown): Promise<void> {
    if (url.protocol === "javascript:") throw new Error("javascript: URLs are not supported");
    if (typeof frameId === "string" && frameId !== (await mainFrameId())) {
      throw new Error(`navigating a sub-frame (${frameId}) is not supported on this iOS version`);
    }
    const r = await t.callTarget("Runtime.evaluate", { expression: navigateExpression(url.href), returnByValue: true });
    if (r?.wasThrown || r?.exceptionDetails) {
      const why = r?.exceptionDetails?.text ?? r?.result?.description ?? "exception";
      throw new Error(`navigation script threw: ${why}`);
    }
  }

  t.addMessageFilter("tools::Page.navigate", async (msg) => {
    if (typeof msg.id !== "number") return null;
    const id = msg.id;
    const p = isPlainObject(msg.params) ? msg.params : {};
    let url: URL;
    try {
      url = new URL(typeof p.url === "string" ? p.url : "");
    } catch {
      t.fireErrorToTools(id, { message: "Cannot navigate to invalid URL" });
      return null;
    }
    try {
      let done = false;
      if (native !== false) {
        try {
          await t.callTarget("Page.navigate", { url: p.url });
          native = true;
          done = true;
        } catch (e) {
          if (!isMethodNotFound(e)) throw e;
          native = false;
        }
      }
      if (!done) await viaScript(url, p.frameId);
      const frameId = await mainFrameId();
      t.fireResultToTools(id, isSameDocument(url) ? { frameId } : { frameId, loaderId: `bridge-loader-${++loaderSeq}` });
    } catch (e) {
      t.fireErrorToTools(id, { message: `Page.navigate: ${errText(e)}` });
    }
    return null;
  });
}
