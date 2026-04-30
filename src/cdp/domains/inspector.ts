import type { Target } from "../target";

export function installInspectorFilters(t: Target) {
  t.addMessageFilter("target::Inspector.inspect", (msg) => {
    msg.method = "DOM.inspectNodeRequested";
    if (msg.params) {
      msg.params.backendNodeId = msg.params.object?.objectId;
      delete msg.params.object;
      delete msg.params.hints;
    }
    return Promise.resolve(msg);
  });
}
