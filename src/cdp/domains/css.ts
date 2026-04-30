// CSS domain: WIR <-> CDP for the Styles panel and live edit.
// Coverage:  tools::  CSS.{enable,getMatchedStylesForNode,getInlineStylesForNode,
//                         setRuleSelector,setStyleTexts,addRule}
//            target:: CSS.{styleSheetAdded,getInlineStylesForNode,setRuleSelector}
// Notable shape gaps:
//  - WIR identifies a style by {styleSheetId, ordinal}; CDP by {styleSheetId, range}.
//    resolveStyleId() fetches the sheet via CSS.getStyleSheet and matches on range.
//  - WIR's CSSStyleSheetHeader lacks isMutable/isConstructed/length/end{Line,Column};
//    backfill conservatively in transformHeader.

import type { Target } from "../target";

type Range = { startLine: number; startColumn: number; endLine: number; endColumn: number };
type WirStyleId = { styleSheetId: string; ordinal: number };

const sameRange = (a: Range | undefined, b: Range | undefined) =>
  !!a && !!b && a.startLine === b.startLine && a.endLine === b.endLine &&
  a.startColumn === b.startColumn && a.endColumn === b.endColumn;

function transformHeader(h: any): any {
  if (!h) return h;
  const inspector = h.origin === "inspector";
  return {
    styleSheetId: h.styleSheetId,
    frameId: h.frameId,
    sourceURL: h.sourceURL ?? "",
    origin: h.origin === "author" ? "regular" : h.origin,
    title: h.title ?? "",
    disabled: !!h.disabled,
    isInline: !!h.isInline,
    startLine: h.startLine ?? 0,
    startColumn: h.startColumn ?? 0,
    isMutable: inspector,
    isConstructed: inspector,
    length: h.length ?? 0,
    endLine: h.endLine ?? 0,
    endColumn: h.endColumn ?? 0,
    hasSourceURL: !!h.sourceURL,
  };
}

const transformProperty = (p: any) => p && ({
  name: p.name, value: p.value, text: p.text, implicit: p.implicit,
  parsedOk: p.parsedOk !== false, important: !!p.priority,
  disabled: p.status === "disabled", range: p.range,
});

const transformStyle = (s: any) => s && ({
  styleSheetId: s.styleId?.styleSheetId,
  cssText: s.cssText,
  range: s.range,
  shorthandEntries: s.shorthandEntries ?? [],
  cssProperties: Array.isArray(s.cssProperties) ? s.cssProperties.map(transformProperty) : [],
});

const mediaSourceMap: Record<string, string> = {
  "media-rule": "mediaRule",
  "media-import-rule": "importRule",
  "media-style-node": "inlineSheet",
  "media-link-node": "linkedSheet",
};

const transformSelectorList = (sl: any) => sl && ({
  text: sl.text,
  selectors: Array.isArray(sl.selectors)
    ? sl.selectors.map((sel: any) => ({ text: sel.text, range: sel.range ?? sl.range }))
    : [],
});

function transformRule(r: any): any {
  if (!r) return r;
  const out: any = {
    origin: r.origin === "author" ? "regular" : r.origin,
    style: transformStyle(r.style),
    selectorList: transformSelectorList(r.selectorList),
  };
  if (r.ruleId?.styleSheetId) out.styleSheetId = r.ruleId.styleSheetId;
  if (Array.isArray(r.groupings)) {
    out.media = r.groupings.map((g: any) => ({
      text: g.text, sourceURL: g.sourceURL, source: mediaSourceMap[g.type],
    }));
  }
  return out;
}

const transformMatchList = (xs: any): any[] =>
  Array.isArray(xs)
    ? xs.map((m: any) => ({ matchingSelectors: m.matchingSelectors, rule: transformRule(m.rule) }))
    : [];

const transformPseudoMatches = (xs: any): any[] =>
  Array.isArray(xs)
    ? xs.map((m: any) => ({ pseudoType: m.pseudoId, matches: transformMatchList(m.matches) }))
    : [];

const transformInherited = (xs: any): any[] =>
  Array.isArray(xs)
    ? xs.map((e: any) => ({
        inlineStyle: transformStyle(e.inlineStyle),
        matchedCSSRules: transformMatchList(e.matchedCSSRules),
      }))
    : [];

export function installCssFilters(t: Target) {
  // closure-local state — last selected node for CSS.addRule (CDP omits
  // nodeId there; WIR needs contextNodeId), and a per-sheet cache so a
  // batched setStyleTexts doesn't re-fetch on every edit.
  const state = { lastNodeId: 0 };
  const sheetCache = new Map<string, any>();

  async function resolveStyleId(styleSheetId: string, range: Range): Promise<WirStyleId> {
    let sheet = sheetCache.get(styleSheetId);
    if (!sheet) {
      try {
        const r = await t.callTarget("CSS.getStyleSheet", { styleSheetId });
        sheet = r?.styleSheet;
        if (sheet) sheetCache.set(styleSheetId, sheet);
      } catch {}
    }
    const rules: any[] = sheet?.rules ?? [];
    for (let ordinal = 0; ordinal < rules.length; ordinal++) {
      if (sameRange(rules[ordinal]?.style?.range, range)) return { styleSheetId, ordinal };
    }
    return { styleSheetId, ordinal: 0 };
  }

  // CSS.enable — Safari accepts the wrapped Target.sendMessageToTarget
  // for this command but reliably *fails to send back the inner
  // dispatchMessageFromTarget reply* on iOS 26 (verified live: only the
  // outer ack arrives, the bridge waits forever for the unwrap, DevTools
  // hangs waiting for CSS.enable). Instead, swallow at the bridge with a
  // synthetic ack and immediately kick CSS.getAllStyleSheets to replay
  // styleSheetAdded events. Safari's CSS domain methods (getMatchedStyles,
  // getAllStyleSheets, etc.) work without a successful CSS.enable round
  // trip, so DevTools' Styles panel is unaffected.
  t.addMessageFilter("tools::CSS.enable", (msg) => {
    // Pure bridge-side ack. iOS 26 wedges the inner page target if any
    // CSS.* command is forwarded at attach time (verified live: both
    // CSS.enable AND CSS.getAllStyleSheets, even with a 100ms delay,
    // cause subsequent DOM.getDocument / Runtime.evaluate to hang
    // forever for that target). The CSS domain still works on demand —
    // CSS.getMatchedStylesForNode against a node id is satisfied via
    // its own filter below, and the Sources panel resolves stylesheet
    // sources on click via CSS.getStyleSheetText. The trade-off: the
    // Sources tree won't auto-populate on CSS.enable; sheets become
    // visible only after the user selects an element whose rule
    // references one. Acceptable given the alternative is a wedged
    // inspector.
    t.fireResultToTools(msg.id!, {});
    return Promise.resolve(null);
  });

  t.addMessageFilter("target::CSS.styleSheetAdded", (msg) => {
    if (msg.params?.header) msg.params.header = transformHeader(msg.params.header);
    return Promise.resolve(msg);
  });

  t.addMessageFilter("target::CSS.getInlineStylesForNode", (msg) => {
    const r = msg.result;
    if (r) {
      msg.result = {
        inlineStyle: transformStyle(r.inlineStyle),
        attributesStyle: transformStyle(r.attributesStyle),
      };
    }
    return Promise.resolve(msg);
  });

  // CSS.getMatchedStylesForNode — Safari's matched-styles call doesn't
  // return inlineStyle, so fan out to two WIR calls and assemble CDP shape.
  t.addMessageFilter("tools::CSS.getMatchedStylesForNode", async (msg) => {
    if (typeof msg.params?.nodeId === "number") state.lastNodeId = msg.params.nodeId;
    try {
      const [inline, matched] = await Promise.all([
        t.callTarget("CSS.getInlineStylesForNode", { nodeId: msg.params.nodeId }),
        t.callTarget("CSS.getMatchedStylesForNode", {
          nodeId: msg.params.nodeId, includePseudo: true, includeInherited: true,
        }),
      ]);
      t.fireResultToTools(msg.id!, {
        inlineStyle: transformStyle(inline?.inlineStyle),
        attributesStyle: transformStyle(inline?.attributesStyle),
        matchedCSSRules: transformMatchList(matched?.matchedCSSRules),
        pseudoElements: transformPseudoMatches(matched?.pseudoElements),
        inherited: transformInherited(matched?.inherited),
        cssKeyframesRules: [],
      });
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  });

  // CSS.setStyleTexts — split CDP batch into per-edit CSS.setStyleText.
  t.addMessageFilter("tools::CSS.setStyleTexts", async (msg) => {
    const edits: Array<{ styleSheetId: string; range: Range; text: string }> =
      msg.params?.edits ?? [];
    const styles: any[] = [];
    for (const edit of edits) {
      try {
        const styleId = await resolveStyleId(edit.styleSheetId, edit.range);
        const r = await t.callTarget("CSS.setStyleText", { styleId, text: edit.text });
        styles.push(transformStyle(r?.style));
        // ranges shift after a successful edit; drop the cache.
        sheetCache.delete(edit.styleSheetId);
        t.fireEventToTools("CSS.styleSheetChanged", { styleSheetId: edit.styleSheetId });
      } catch {
        styles.push(null);
      }
    }
    t.fireResultToTools(msg.id!, { styles });
    return null;
  });

  // CSS.setRuleSelector — CDP {styleSheetId,range,selector} -> WIR {ruleId,selector}.
  t.addMessageFilter("tools::CSS.setRuleSelector", async (msg) => {
    const { styleSheetId, range, selector } = msg.params ?? {};
    try {
      const ruleId = await resolveStyleId(styleSheetId, range);
      msg.params = { ruleId, selector };
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
      return null;
    }
    return msg;
  });

  t.addMessageFilter("target::CSS.setRuleSelector", (msg) => {
    if (msg.result?.rule) msg.result = { rule: transformRule(msg.result.rule) };
    return Promise.resolve(msg);
  });

  // CSS.addRule — CDP "h1 {}" -> WIR selector + contextNodeId.
  t.addMessageFilter("tools::CSS.addRule", async (msg) => {
    const params = msg.params ?? {};
    const selector = String(params.ruleText ?? "").trim().replace(/\{\s*\}\s*$/, "").trim();
    try {
      const r = await t.callTarget("CSS.addRule", {
        contextNodeId: state.lastNodeId,
        styleSheetId: params.styleSheetId,
        selector,
      });
      t.fireResultToTools(msg.id!, { rule: transformRule(r?.rule) });
    } catch (e: any) {
      t.fireErrorToTools(msg.id!, { message: e?.message ?? String(e) });
    }
    return null;
  });
}
