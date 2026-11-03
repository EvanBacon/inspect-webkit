// SourceManager: owns one long-lived WebInspector connection per simulator /
// device for as long as anyone needs it.
//
// Why long-lived: webinspectord_sim exits when its last client disconnects
// and launchd throttles its respawn (~10 s). A client that connects, lists
// and disconnects makes the *next* connection wait 6-10 s for its first
// reply (R10). Holding a connection keeps the daemon up.
//
// Discoveries (sim-discovery.ts, device-discovery.ts) report the set of
// sources that should exist; the manager runs a small state machine per
// source:
//
//   connecting ──first WIR reply──▶ ready ──socket closed──▶ closed
//       ▲  │                                                    │
//       │  └──open() failed / timed out / no reply────┐         │
//       │                                             ▼         ▼
//       └──────────────timer (capped exp. backoff + jitter)── backoff
//
// "connecting" covers both opening the transport (bounded by
// connectTimeoutMs, so a device stuck on "Trust This Computer" can't wedge
// anything) and waiting for the daemon's first reply (bounded by the much
// longer firstReplyTimeoutMs, so a daemon in its respawn throttle is waited
// out instead of being reported as "no sources").
//
// Source ids are stable across reconnects: "sim:<UDID>" / "device:<UDID>".

import type { LockdownClient } from "../lockdown";
import type { WebInspectorClient } from "../webinspector";
import { SimulatorDiscovery } from "./sim-discovery";
import { DeviceDiscovery } from "./device-discovery";

export type SourceKind = "device" | "simulator";
export type SourceState = "connecting" | "ready" | "closed" | "backoff";

/** A live, ready inspector connection. A reconnect yields a new Source
 *  object with the same `id`. */
export type Source = {
  kind: SourceKind;
  /** Stable id: "sim:<UDID>" / "device:<UDID>". */
  id: string;
  label: string;
  udid?: string;
  /** usbmux DeviceID (devices only). */
  deviceID?: number;
  wi: WebInspectorClient;
  lockdown?: LockdownClient;
};

/** What a discovery reports: a source that should be connected. */
export type SourceDescriptor = {
  id: string;
  kind: SourceKind;
  label: string;
  udid: string;
  deviceID?: number;
  /** Transport identity (socket path, "USB:<DeviceID>"). A change means the
   *  existing connection is stale: reconnect right away. */
  endpoint: string;
  /** Open the transport. Must not send anything; must honour `signal`. */
  open(signal: AbortSignal): Promise<{ wi: WebInspectorClient; lockdown?: LockdownClient }>;
};

export interface SourceDiscovery {
  /** Begin watching; `onChange` receives the full current set every time. */
  start(onChange: (descs: SourceDescriptor[]) => void): void;
  /** Re-check now (e.g. a source's connection dropped). */
  refresh(): void;
  stop(): void;
  /** Resolves once the first scan has been reported. */
  readonly ready: Promise<void>;
}

export type SourceInfo = {
  id: string;
  kind: SourceKind;
  label: string;
  udid: string;
  state: SourceState;
  /** Consecutive failed attempts (0 once ready). */
  attempts: number;
  lastError?: string;
};

export type SourceManagerOptions = {
  discoveries: SourceDiscovery[];
  /** Deadline for opening the transport (usbmux/lockdown/TLS, Unix socket). */
  connectTimeoutMs?: number;
  /** Deadline for the daemon's first reply (covers the respawn throttle). */
  firstReplyTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** @internal jitter source, for tests */
  random?: () => number;
};

type Entry = {
  desc: SourceDescriptor;
  owner: SourceDiscovery;
  state: SourceState;
  attempts: number;
  lastError?: string;
  timer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
  conn: { wi: WebInspectorClient; lockdown?: LockdownClient } | null;
  source: Source | null;
  removed: boolean;
};

const debug = (...args: unknown[]) => {
  if (process.env.INSPECT_WEBKIT_DEBUG) console.error("[sources]", ...args);
};

function unrefTimer(t: ReturnType<typeof setTimeout>) {
  (t as { unref?: () => void }).unref?.();
  return t;
}

export class SourceManager {
  private entries = new Map<string, Entry>();
  private readyHandlers = new Set<(src: Source) => void>();
  private changeHandlers = new Set<() => void>();
  private started = false;
  private stopped = false;
  private readonly connectTimeoutMs: number;
  private readonly firstReplyTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly random: () => number;

  constructor(private opts: SourceManagerOptions) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.firstReplyTimeoutMs = opts.firstReplyTimeoutMs ?? 30_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 15_000;
    this.random = opts.random ?? Math.random;
  }

  /** Begin discovery. Never blocks; safe to call more than once. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const d of this.opts.discoveries) {
      try {
        d.start((descs) => this.reconcile(d, descs));
      } catch (e) {
        console.error(`warn: source discovery failed to start: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const d of this.opts.discoveries) {
      try {
        d.stop();
      } catch {}
    }
    for (const e of this.entries.values()) this.dispose(e);
    this.entries.clear();
    this.emitChange();
    this.readyHandlers.clear();
    this.changeHandlers.clear();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  list(): SourceInfo[] {
    return [...this.entries.values()].map((e) => ({
      id: e.desc.id,
      kind: e.desc.kind,
      label: e.desc.label,
      udid: e.desc.udid,
      state: e.state,
      attempts: e.attempts,
      ...(e.lastError ? { lastError: e.lastError } : {}),
    }));
  }

  readySources(): Source[] {
    const out: Source[] = [];
    for (const e of this.entries.values()) if (e.state === "ready" && e.source) out.push(e.source);
    return out;
  }

  /** Called with each Source as it becomes ready (again, after reconnects). */
  onSourceReady(cb: (src: Source) => void): () => void {
    this.readyHandlers.add(cb);
    return () => this.readyHandlers.delete(cb);
  }

  /** Called on any state / membership change. */
  onChange(cb: () => void): () => void {
    this.changeHandlers.add(cb);
    return () => this.changeHandlers.delete(cb);
  }

  /**
   * Resolve once every discovery has reported its first scan and no source
   * is still connecting (ready, or failed into backoff) — or at `timeoutMs`.
   */
  async settled(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => (timer = unrefTimer(setTimeout(r, left()))));
    try {
      await Promise.race([Promise.all(this.opts.discoveries.map((d) => d.ready)), timeout]);
      while (!this.stopped && left() > 0) {
        if (![...this.entries.values()].some((e) => e.state === "connecting")) return;
        let off = () => {};
        await Promise.race([new Promise<void>((r) => (off = this.onChange(() => r()))), timeout]);
        off();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Capped exponential backoff with jitter in [50%, 100%] of the step. */
  backoffDelay(attempt: number): number {
    const step = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(attempt, 30));
    return Math.round(step * (0.5 + 0.5 * this.random()));
  }

  // ---------------------------------------------------------------------

  private reconcile(owner: SourceDiscovery, descs: SourceDescriptor[]): void {
    if (this.stopped) return;
    const wanted = new Map<string, SourceDescriptor>();
    for (const d of descs) wanted.set(d.id, d);
    // Removed
    for (const [id, e] of [...this.entries]) {
      if (e.owner !== owner || wanted.has(id)) continue;
      debug(`${e.desc.label}: gone`);
      this.dispose(e);
      this.entries.delete(id);
      this.emitChange();
    }
    // Added / changed
    for (const desc of wanted.values()) {
      const e = this.entries.get(desc.id);
      if (!e) {
        const entry: Entry = {
          desc,
          owner,
          state: "connecting",
          attempts: 0,
          timer: null,
          abort: null,
          conn: null,
          source: null,
          removed: false,
        };
        this.entries.set(desc.id, entry);
        void this.connect(entry);
        continue;
      }
      if (e.desc.endpoint !== desc.endpoint) {
        debug(`${desc.label}: endpoint ${e.desc.endpoint} → ${desc.endpoint}; reconnecting`);
        this.dispose(e);
        const fresh: Entry = { ...e, desc, removed: false, attempts: 0, timer: null, abort: null, conn: null, source: null };
        this.entries.set(desc.id, fresh);
        void this.connect(fresh);
      } else {
        e.desc = desc; // label / name updates
      }
    }
  }

  private setState(e: Entry, state: SourceState): void {
    if (e.state === state) return;
    e.state = state;
    this.emitChange();
  }

  private async connect(e: Entry): Promise<void> {
    if (e.removed || this.stopped) return;
    e.timer = null;
    this.setState(e, "connecting");
    this.emitChange(); // a fresh entry starts in "connecting"
    const abort = new AbortController();
    e.abort = abort;
    const connectTimer = setTimeout(
      () => abort.abort(new Error(`connect timed out after ${this.connectTimeoutMs}ms`)),
      this.connectTimeoutMs,
    );
    let conn: Entry["conn"];
    try {
      conn = await e.desc.open(abort.signal);
    } catch (err) {
      clearTimeout(connectTimer);
      const reason = abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason : err;
      return this.fail(e, reason);
    }
    clearTimeout(connectTimer);
    if (e.removed || this.stopped || e.abort !== abort) {
      closeConn(conn);
      return;
    }
    e.conn = conn;
    // Our connection must never keep a host process alive on its own (the
    // HTTP server does that for the CLI; library callers may want to exit).
    conn.wi.unref();
    conn.lockdown?.unref();

    // Wait for the daemon's first reply. While webinspectord_sim sits in
    // launchd's respawn throttle this takes up to ~10 s; that is "still
    // connecting", not "no targets".
    const replied = await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        unsub();
        offClose();
        offAbort();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), this.firstReplyTimeoutMs);
      const unsub = conn.wi.subscribe(() => done(true));
      const offClose = conn.wi.onClose(() => done(false));
      const onAbort = () => done(false);
      abort.signal.addEventListener("abort", onAbort, { once: true });
      const offAbort = () => abort.signal.removeEventListener("abort", onAbort);
      conn.wi.send("_rpc_reportIdentifier:", {});
      conn.wi.send("_rpc_getConnectedApplications:", {});
    });
    if (e.removed || this.stopped || e.abort !== abort) return;
    if (!replied) {
      closeConn(conn);
      e.conn = null;
      return this.fail(e, new Error(`no reply from webinspector within ${this.firstReplyTimeoutMs}ms`));
    }

    const source: Source = {
      kind: e.desc.kind,
      id: e.desc.id,
      label: e.desc.label,
      udid: e.desc.udid,
      ...(e.desc.deviceID !== undefined ? { deviceID: e.desc.deviceID } : {}),
      wi: conn.wi,
      ...(conn.lockdown ? { lockdown: conn.lockdown } : {}),
    };
    conn.wi.onClose(() => {
      if (e.source !== source) return;
      e.source = null;
      e.conn = null;
      if (e.removed || this.stopped) return;
      console.error(`# source disconnected: ${e.desc.label}; reconnecting`);
      try {
        conn.lockdown?.close();
      } catch {}
      this.setState(e, "closed");
      // Was it shut down / unplugged? Let discovery re-check.
      try {
        e.owner.refresh();
      } catch {}
      this.scheduleReconnect(e);
    });
    if (e.attempts > 0 || e.lastError) debug(`${e.desc.label}: ready after ${e.attempts} retries`);
    e.attempts = 0;
    e.lastError = undefined;
    e.source = source;
    this.setState(e, "ready");
    console.error(`# source ready: ${e.desc.label} (${e.desc.id})`);
    for (const h of [...this.readyHandlers]) {
      try {
        h(source);
      } catch (err) {
        console.error(`warn: source-ready handler threw: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  private fail(e: Entry, err: unknown): void {
    if (e.removed || this.stopped) return;
    const msg = (err as Error)?.message ?? String(err);
    // Log the first failure and changes, not every retry.
    if (e.lastError !== msg) console.error(`warn: ${e.desc.label}: ${msg}; will retry`);
    e.lastError = msg;
    this.scheduleReconnect(e);
  }

  private scheduleReconnect(e: Entry): void {
    if (e.removed || this.stopped) return;
    const delay = this.backoffDelay(e.attempts++);
    this.setState(e, "backoff");
    e.timer = unrefTimer(setTimeout(() => void this.connect(e), delay));
  }

  private dispose(e: Entry): void {
    e.removed = true;
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.abort?.abort(new Error("source removed"));
    if (e.conn) closeConn(e.conn);
    e.conn = null;
    e.source = null;
    e.state = "closed";
  }

  private emitChange(): void {
    for (const h of [...this.changeHandlers]) {
      try {
        h();
      } catch {}
    }
  }
}

function closeConn(conn: { wi: WebInspectorClient; lockdown?: LockdownClient }) {
  try {
    conn.wi.close();
  } catch {}
  try {
    conn.lockdown?.close();
  } catch {}
}

// --- shared manager ------------------------------------------------------
//
// One manager per process, shared by startCdpServer() and listTargets(), so
// the process holds a single connection per simulator / device.

let factory: (() => SourceManager) | null = null;
let shared: { manager: SourceManager; refs: number; linger: ReturnType<typeof setTimeout> | null } | null =
  null;

/** @internal Test seam: build the shared manager from fakes (null = default). */
export function setSharedSourceManagerFactory(f: (() => SourceManager) | null): void {
  factory = f;
  if (shared) {
    if (shared.linger) clearTimeout(shared.linger);
    shared.manager.stop();
    shared = null;
  }
}

export type SourceManagerLease = {
  manager: SourceManager;
  /** Drop this reference. The last release stops the manager after
   *  `lingerMs` (keeping connections warm for a follow-up call). */
  release(lingerMs?: number): void;
};

export function acquireSharedSourceManager(): SourceManagerLease {
  if (!shared || shared.manager.isStopped) {
    shared = { manager: (factory ?? defaultSourceManager)(), refs: 0, linger: null };
  }
  const s = shared;
  s.refs++;
  if (s.linger) clearTimeout(s.linger);
  s.linger = null;
  s.manager.start();
  let released = false;
  return {
    manager: s.manager,
    release(lingerMs = 0) {
      if (released) return;
      released = true;
      if (--s.refs > 0) return;
      const stop = () => {
        if (s.refs > 0) return;
        s.manager.stop();
        if (shared === s) shared = null;
      };
      if (lingerMs <= 0) return stop();
      s.linger = unrefTimer(setTimeout(stop, lingerMs));
    },
  };
}

function defaultSourceManager(): SourceManager {
  return new SourceManager({ discoveries: [new SimulatorDiscovery(), new DeviceDiscovery()] });
}
