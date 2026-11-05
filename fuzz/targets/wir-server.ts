// WIR target side, stateful: a real CdpServer (no sockets) fed hostile
// webinspectord RPC traffic — app lists, connect / update / disconnect,
// listings, forwarded page data with inner-target lifecycle — interleaved
// with HTTP requests, DevTools WebSocket sessions, hover highlights and
// source loss / reconnect. Every WIR frame goes through the real plist
// decoder and WebInspectorClient.
//
// Invariants:
//   - no escaped error, and no WIR subscriber throws (WebInspectorClient
//     swallows those, which would hide a broken server state);
//   - /json/list and / always answer 200; /json/list is a JSON array of
//     entries whose fields are strings and whose webSocketDebuggerUrl
//     matches the id;
//   - WebSocket replies: at most one per request id, none with foreign ids;
//   - losing the source closes its sessions (1011) and drops its targets;
//   - no prototype pollution.
//
// Input lines (see corpus-from-capture.ts for S lines); anything else
// drives the structured generator.

import { Bytes } from "../lib/bytes";
import { check, checkGlobal, harness, InvariantError, settle, setupHarness } from "../lib/invariants";
import { makeFakeSource, startServerRig, type FakeSource, type ServerRig, type WsClient } from "../lib/server-rig";
import { APP_IDS, PAGE_IDS, SELECTORS, appDict, fromTyped, maybe, pageDict, plistValue } from "../lib/wir-gen";
import { decodeWrites } from "../../src/__tests__/helpers/fake-wir";
import type { PlistValue } from "../../src/plist";

setupHarness();

const CAN_UPGRADE = !process.versions.bun; // Bun's `ws` shim needs a real socket
const METHODS = ["Runtime.evaluate", "Runtime.enable", "DOM.getDocument", "Page.enable", "Debugger.enable", "Page.setAdBlockingEnabled", "Target.setAutoAttach", "Network.enable", "CSS.enable", "Page.navigate"];

let rigP: Promise<ServerRig> | null = null;

type Client = { ws: WsClient; sent: Set<number>; source: FakeSource; closedByUs: boolean };

async function run(data: Uint8Array): Promise<void> {
  const rig = await (rigP ??= startServerRig());
  const subscriberErrors: unknown[] = [];
  let source = connect(rig, subscriberErrors);
  const clients: Client[] = [];
  let nextId = 1;

  /** The sender the server's channel registered for `pageId`, if any. */
  const senderFor = (src: FakeSource, pageId: PlistValue): string | undefined => {
    const setups = decodeWrites(src.sock).filter((m) => m.__selector === "_rpc_forwardSocketSetup:");
    const mine = setups.filter((m) => (m.__argument as any)?.WIRPageIdentifierKey === pageId);
    return (mine.at(-1)?.__argument as any)?.WIRSenderKey ?? (setups.at(-1)?.__argument as any)?.WIRSenderKey;
  };

  const checkHttp = () => {
    const list = rig.get("/json/list");
    check(list.status === 200, `/json/list answered ${list.status}`);
    const arr = JSON.parse(list.body);
    check(Array.isArray(arr), "/json/list is not an array");
    for (const e of arr) {
      for (const f of ["id", "title", "url", "type", "description", "webSocketDebuggerUrl", "devtoolsFrontendUrl"]) {
        check(typeof e[f] === "string", `/json/list entry field ${f} is ${typeof e[f]}`);
      }
      check(e.webSocketDebuggerUrl === `ws://127.0.0.1:9222/devtools/page/${e.id}`, "webSocketDebuggerUrl does not match id");
    }
    check(rig.get("/").status === 200, "/ did not answer 200");
    return arr as Array<{ id: string }>;
  };

  const lines = Buffer.from(data).toString("utf8").split("\n").slice(0, 200);
  for (const line of lines) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "S") {
      let m: any;
      try {
        m = fromTyped(JSON.parse(rest));
      } catch {
        continue;
      }
      if (!m || typeof m.__selector !== "string") continue;
      const arg = m.__argument;
      if (arg && typeof arg === "object" && typeof arg.WIRDestinationKey === "string") {
        arg.WIRDestinationKey = senderFor(source, arg.WIRPageIdentifierKey) ?? arg.WIRDestinationKey;
      }
      source.push(m.__selector, arg ?? {});
    } else if (tag === "G") {
      rig.get(rest || "/");
    } else {
      await generate(new Bytes(Buffer.from(line, "latin1")));
    }
    await settle(2);
  }

  async function generate(b: Bytes) {
    while (!b.done) {
      const op = b.u8() % 12;
      switch (op) {
        case 0: {
          const dict: Record<string, PlistValue> = {};
          for (let i = b.int(0, 3); i > 0; i--) {
            const id = b.pick(APP_IDS);
            own(dict, id, b.u8() % 6 === 0 ? plistValue(b) : appDict(b, id));
          }
          source.push("_rpc_reportConnectedApplicationList:", { WIRApplicationDictionaryKey: maybe(b, dict) });
          break;
        }
        case 1:
          source.push(b.bool() ? "_rpc_applicationConnected:" : "_rpc_applicationUpdated:", appDict(b, b.pick(APP_IDS)));
          break;
        case 2:
          source.push("_rpc_applicationDisconnected:", { WIRApplicationIdentifierKey: maybe(b, b.pick(APP_IDS)) });
          break;
        case 3: {
          const listing: Record<string, PlistValue> = {};
          for (let i = b.int(0, 3); i > 0; i--) {
            const pid = b.pick(PAGE_IDS);
            own(listing, String(b.u8() % 4 === 0 ? b.str() : pid), b.u8() % 6 === 0 ? plistValue(b) : pageDict(b, pid));
          }
          source.push("_rpc_applicationSentListing:", {
            WIRApplicationIdentifierKey: maybe(b, b.pick(APP_IDS)),
            WIRListingKey: maybe(b, listing),
          });
          break;
        }
        case 4: {
          const pageId = b.pick([1, 2, 3]);
          const frames = [
            { method: "Target.targetCreated", params: { targetInfo: { targetId: b.pick(["page-1", "page-2"]), type: b.pick(["page", "worker"]), isProvisional: b.bool() } } },
            { method: "Target.targetDestroyed", params: { targetId: b.pick(["page-1", "page-2"]) } },
            { method: "Target.didCommitProvisionalTarget", params: { oldTargetId: "page-1", newTargetId: "page-2" } },
            { method: "Target.dispatchMessageFromTarget", params: { targetId: "page-1", message: JSON.stringify({ result: b.json(1), id: b.int(1, nextId + 2) }) } },
            { method: "Target.dispatchMessageFromTarget", params: { targetId: "page-1", message: JSON.stringify({ method: "Runtime.consoleAPICalled", params: b.json(2) }) } },
            { result: {}, id: b.int(1, 40) },
            b.json(2),
          ];
          const f = b.pick(frames);
          const text = typeof f === "string" ? f : JSON.stringify(f);
          source.push("_rpc_applicationSentData:", {
            WIRApplicationIdentifierKey: maybe(b, "PID:1"),
            WIRPageIdentifierKey: maybe(b, pageId),
            WIRDestinationKey: maybe(b, senderFor(source, pageId) ?? "nobody"),
            WIRMessageDataKey: b.u8() % 8 === 0 ? (plistValue(b) as PlistValue) : new TextEncoder().encode(text),
          });
          break;
        }
        case 5:
          if (b.bool()) source.pushRaw(b.bytes(64));
          else source.push(b.pick(SELECTORS), { [b.str()]: plistValue(b) });
          break;
        case 6:
          rig.get(b.pick(["/json/list", "/json", "/", "/json/version", "/json/protocol", "/x", "//[", "/%"]));
          break;
        case 7: {
          if (!CAN_UPGRADE || clients.length >= 4) break;
          const targets = rig.server.getTargets();
          const id = targets.length && b.u8() % 6 !== 0 ? b.pick(targets).targetId : b.str();
          let path: string;
          try {
            path = `/devtools/page/${b.bool() ? encodeURIComponent(id) : id}`;
          } catch {
            path = `/devtools/page/${id}`; // lone surrogate
          }
          const ws = rig.upgrade(path);
          clients.push({ ws, sent: new Set(), source, closedByUs: false });
          break;
        }
        case 8: {
          const c = clients.length ? b.pick(clients) : null;
          if (!c) break;
          const id = nextId++;
          c.sent.add(id);
          c.ws.send(JSON.stringify({ id, method: b.pick(METHODS), params: b.u8() % 3 ? { expression: "1" } : b.json(1) }));
          break;
        }
        case 9: {
          const c = clients.length ? b.pick(clients) : null;
          if (c) {
            c.closedByUs = true;
            c.ws.close();
          }
          break;
        }
        case 10: {
          const targets = rig.server.getTargets();
          if (targets.length) void rig.server.highlightTarget(b.pick(targets).targetId, b.bool());
          break;
        }
        case 11: {
          await loseSource();
          source = connect(rig, subscriberErrors);
          break;
        }
      }
      await settle(2);
      checkHttp();
    }
  }

  async function loseSource() {
    const old = source;
    rig.server.releaseHighlight();
    old.close();
    await settle(3);
    for (const t of rig.server.getTargets()) {
      check(t.source !== old.src, `target ${t.targetId} survived its source`);
    }
    for (const c of clients) {
      if (c.source !== old || c.closedByUs || c.ws.status !== 101) continue;
      const code = c.ws.closeCode();
      check(code === 1011 || c.ws.sock.destroyed, `session on a lost source not closed (code ${code})`);
    }
  }

  checkHttp();
  await loseSource();
  check(rig.server.getTargets().length === 0, "targets left after the source closed");
  for (const c of clients) {
    const seen = new Set<number>();
    for (const text of c.ws.texts()) {
      let m: any;
      try {
        m = JSON.parse(text);
      } catch {
        throw new InvariantError(`server sent invalid JSON: ${text.slice(0, 80)}`);
      }
      if (typeof m?.id !== "number") continue;
      check(c.sent.has(m.id), `WS reply with an id the client never sent: ${m.id}`);
      check(!seen.has(m.id), `duplicate WS reply for id ${m.id}`);
      seen.add(m.id);
    }
    c.ws.close();
  }
  await settle(2);
  if (subscriberErrors.length) {
    const e = subscriberErrors[0] as Error;
    throw new InvariantError(`WIR subscriber threw: ${e?.stack ?? e}`);
  }
  checkGlobal();
}

/** A fresh source whose subscribers report what they throw. */
function connect(rig: ServerRig, errors: unknown[]): FakeSource {
  const s = makeFakeSource();
  const wi = s.src.wi;
  const subscribe = wi.subscribe.bind(wi);
  wi.subscribe = (fn) =>
    subscribe((m) => {
      try {
        fn(m);
      } catch (e) {
        errors.push(e);
        throw e;
      }
    });
  rig.addSource(s);
  return s;
}

/** Set an own data property (keys like __proto__ included). */
function own(o: Record<string, PlistValue>, k: string, v: PlistValue): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

export const fuzz = harness(run);
