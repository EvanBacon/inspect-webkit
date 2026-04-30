import type { Target } from "../target";

// CDP `IO` domain. WIR has no real stream-IO surface — handles are produced
// by other domains (e.g. HeapProfiler) and `IO.read` / `IO.close` consume
// them. We keep a per-session in-memory cache so other domains can stash a
// blob and the DevTools client can drain it. Today nothing populates the
// cache; the stubs exist so the heap-snapshot download path doesn't dead-end
// with "domain not found" once whichever producer lands.
//
// Closure-local: the cache is allocated inside installIoFilters per Target,
// so two concurrent DevTools sessions don't share handles.

const CHUNK = 64 * 1024;

export type IoCache = Map<string, string>;

export function installIoFilters(t: Target): IoCache {
  const cache: IoCache = new Map();

  t.addMessageFilter("tools::IO.read", (msg) => {
    const handle = String(msg.params?.handle ?? "");
    const size = Number(msg.params?.size) || CHUNK;
    const offset = Number(msg.params?.offset) || 0;
    const blob = cache.get(handle);
    if (blob === undefined) {
      t.fireResultToTools(msg.id!, { data: "", eof: true, base64Encoded: false });
      return Promise.resolve(null);
    }
    const slice = blob.slice(offset, offset + size);
    const eof = offset + size >= blob.length;
    t.fireResultToTools(msg.id!, { data: slice, eof, base64Encoded: false });
    return Promise.resolve(null);
  });

  t.addMessageFilter("tools::IO.close", (msg) => {
    cache.delete(String(msg.params?.handle ?? ""));
    t.fireResultToTools(msg.id!, {});
    return Promise.resolve(null);
  });

  // Not implemented: IO.resolveBlob (would need a BlobURL store).
  return cache;
}
