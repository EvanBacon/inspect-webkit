// Simulator discovery.
//
// Each booted simulator runs a launchd_sim that owns a Unix socket
// /private/var/tmp/com.apple.launchd.<token>/com.apple.webinspectord_sim.socket
// and spawns webinspectord_sim on demand. Socket files of shut-down
// simulators are left behind, so the directory alone can't say which are
// live or which UDID they belong to.
//
// Strategy:
//   - Poll (default 1 s) with a readdir of /private/var/tmp — about 1-2 ms,
//     no process spawn. It's only the change trigger.
//   - When the socket set changes (a boot creates a new launchd dir), when
//     a source drops (refresh()), and as a slow safety net, map sockets to
//     UDIDs: booted simulators come from CoreSimulator's device.plist files
//     (a few ms; `xcrun simctl list devices booted -j` if that finds none,
//     and always for the safety rescan), and each one's socket from
//     `xcrun simctl getenv <udid> RWI_LISTEN_SOCKET` (the env var launchd_sim
//     sets for webinspectord_sim). Ids are then "sim:<UDID>", stable across
//     webinspectord restarts and reboots.
//   - A socket that appears before simctl reports its device as booted is
//     retried each poll for up to newSocketRetryMs.
//   - If simctl is unavailable, fall back to `lsof -U` (live sockets are held
//     open by launchd_sim); ids are then "sim:<launchd token>".

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { decode } from "../plist";
import { connectSimulator } from "../sim";
import { WebInspectorClient } from "../webinspector";
import type { SourceDescriptor, SourceDiscovery } from "./source-manager";

const LAUNCHD_TMP = "/private/var/tmp";
const SOCKET_NAME = "com.apple.webinspectord_sim.socket";

export type BootedSimulator = { udid: string; name: string };

export type SimDiscoveryDeps = {
  /** Candidate socket paths (live and stale). Must be cheap. */
  scanSockets(): string[];
  /** Booted simulators. `authoritative` asks simctl rather than a cheaper
   *  source that might be stale. */
  listBooted(authoritative?: boolean): Promise<BootedSimulator[]>;
  /** webinspectord_sim socket path of a booted simulator, or null. */
  socketFor(udid: string): Promise<string | null>;
  /** Fallback: live sockets according to lsof. */
  lsof(): Promise<Array<{ socketPath: string; pid: number }>>;
  connect(socketPath: string, signal: AbortSignal): Promise<WebInspectorClient>;
};

export type SimDiscoveryOptions = {
  deps?: Partial<SimDiscoveryDeps>;
  pollMs?: number;
  fullRescanMs?: number;
  newSocketRetryMs?: number;
};

const debug = (...args: unknown[]) => {
  if (process.env.INSPECT_WEBKIT_DEBUG) console.error("[sim-discovery]", ...args);
};

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** Parse `simctl list devices booted -j`; never throws. */
export function parseBootedDevices(json: string): BootedSimulator[] {
  let v: any;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  const out: BootedSimulator[] = [];
  const runtimes = v && typeof v === "object" ? v.devices : null;
  if (!runtimes || typeof runtimes !== "object") return out;
  for (const list of Object.values(runtimes)) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      if (!d || typeof d !== "object") continue;
      if (typeof d.udid !== "string" || d.state !== "Booted") continue;
      out.push({ udid: d.udid, name: typeof d.name === "string" ? d.name : d.udid });
    }
  }
  return out;
}

/** Parse `lsof -U` output for webinspectord_sim sockets; never throws. */
export function parseLsofSockets(out: string): Array<{ socketPath: string; pid: number }> {
  const sockets = new Map<string, number>();
  for (const line of out.split("\n")) {
    if (!line.includes(SOCKET_NAME)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[1]);
    const path = cols[cols.length - 1] ?? "";
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!path.startsWith("/") || !path.endsWith(`/${SOCKET_NAME}`)) continue;
    sockets.set(path, pid);
  }
  return Array.from(sockets, ([socketPath, pid]) => ({ socketPath, pid }));
}

/** Default CoreSimulator device set. */
const DEVICE_SET = `${homedir()}/Library/Developer/CoreSimulator/Devices`;
/** CoreSimulator's SimDeviceState.booted */
const STATE_BOOTED = 3;

/** Booted simulators according to the device set's device.plist files.
 *  Never throws; unreadable entries are skipped. */
export async function readBootedFromDeviceSet(dir = DEVICE_SET): Promise<BootedSimulator[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rows = await Promise.all(
    names.map(async (n) => {
      try {
        const v = decode(new Uint8Array(await readFile(`${dir}/${n}/device.plist`))) as any;
        if (!v || typeof v !== "object" || typeof v.UDID !== "string") return null;
        if (Number(v.state) !== STATE_BOOTED || v.isDeleted === true) return null;
        return { udid: v.UDID as string, name: typeof v.name === "string" ? v.name : v.UDID };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((r): r is BootedSimulator => r !== null);
}

async function simctlBooted(): Promise<BootedSimulator[]> {
  return parseBootedDevices(await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]));
}

export const defaultSimDeps: SimDiscoveryDeps = {
  scanSockets() {
    let names: string[];
    try {
      names = readdirSync(LAUNCHD_TMP);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names) {
      if (!n.startsWith("com.apple.launchd.")) continue;
      const p = `${LAUNCHD_TMP}/${n}/${SOCKET_NAME}`;
      if (existsSync(p)) out.push(p);
    }
    return out;
  },
  async listBooted(authoritative) {
    if (!authoritative) {
      const fast = await readBootedFromDeviceSet();
      if (fast.length > 0) return fast;
    }
    return simctlBooted();
  },
  async socketFor(udid) {
    const p = (await run("xcrun", ["simctl", "getenv", udid, "RWI_LISTEN_SOCKET"])).trim();
    return p.startsWith("/") ? p : null;
  },
  async lsof() {
    return parseLsofSockets(await run("lsof", ["-U"]));
  },
  async connect(socketPath, signal) {
    const { socket, stream } = await connectSimulator(socketPath, signal);
    return new WebInspectorClient(socket, stream);
  },
};

type Found = { id: string; udid: string; name?: string; socketPath: string };

export class SimulatorDiscovery implements SourceDiscovery {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private deps: SimDiscoveryDeps;
  private pollMs: number;
  private fullRescanMs: number;
  private newSocketRetryMs: number;
  private onChange: ((d: SourceDescriptor[]) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScan = new Set<string>();
  /** Sockets that appeared after start and aren't mapped yet → first seen. */
  private unmapped = new Map<string, number>();
  private mapped = new Set<string>();
  private resolving = false;
  private again: "no" | "yes" | "authoritative" = "no";
  private lastAuthoritativeAt = 0;
  private lastSignature: string | null = null;
  private stopped = false;

  constructor(opts: SimDiscoveryOptions = {}) {
    this.deps = { ...defaultSimDeps, ...opts.deps };
    this.pollMs = opts.pollMs ?? 1000;
    this.fullRescanMs = opts.fullRescanMs ?? 30_000;
    this.newSocketRetryMs = opts.newSocketRetryMs ?? 60_000;
    this.ready = new Promise((r) => (this.resolveReady = r));
  }

  start(onChange: (d: SourceDescriptor[]) => void): void {
    this.onChange = onChange;
    this.lastScan = new Set(this.safeScan());
    void this.resolve();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** A source dropped: was its simulator shut down? Ask simctl (device.plist
   *  may lag behind). */
  refresh(): void {
    void this.resolve(true);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onChange = null;
    this.resolveReady();
  }

  private safeScan(): string[] {
    try {
      return this.deps.scanSockets();
    } catch {
      return [];
    }
  }

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    const scan = new Set(this.safeScan());
    let changed = false;
    for (const p of scan) {
      if (this.lastScan.has(p)) continue;
      changed = true;
      if (!this.mapped.has(p)) this.unmapped.set(p, now);
    }
    for (const p of this.lastScan) if (!scan.has(p)) changed = true;
    this.lastScan = scan;
    for (const [p, since] of this.unmapped) {
      if (!scan.has(p) || now - since > this.newSocketRetryMs) this.unmapped.delete(p);
    }
    if (now - this.lastAuthoritativeAt >= this.fullRescanMs) void this.resolve(true);
    else if (changed || this.unmapped.size > 0) void this.resolve();
  }

  private async resolve(authoritative = false): Promise<void> {
    if (this.stopped) return;
    if (this.resolving) {
      if (authoritative) this.again = "authoritative";
      else if (this.again === "no") this.again = "yes";
      return;
    }
    this.resolving = true;
    // Start the safety-rescan clock now: it covers the very first resolve too.
    if (authoritative || this.lastAuthoritativeAt === 0) this.lastAuthoritativeAt = Date.now();
    try {
      const found = await this.find(authoritative);
      if (this.stopped) return;
      this.mapped = new Set(found.map((f) => f.socketPath));
      for (const f of found) this.unmapped.delete(f.socketPath);
      const descs = found.map((f) => this.descriptor(f));
      const sig = descs.map((d) => `${d.id}|${d.endpoint}|${d.label}`).sort().join("\n");
      if (sig !== this.lastSignature) {
        this.lastSignature = sig;
        debug(`simulators: ${sig.replace(/\n/g, ", ") || "none"}`);
        this.onChange?.(descs);
      }
    } catch (e) {
      debug(`resolve failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.resolving = false;
      this.resolveReady();
      if (this.again !== "no" && !this.stopped) {
        const authoritativeAgain = this.again === "authoritative";
        this.again = "no";
        void this.resolve(authoritativeAgain);
      }
    }
  }

  private async find(authoritative: boolean): Promise<Found[]> {
    let booted: BootedSimulator[];
    try {
      booted = await this.deps.listBooted(authoritative);
    } catch (e) {
      debug(`simctl unavailable (${(e as Error)?.message ?? e}); falling back to lsof`);
      const rows = await this.deps.lsof().catch(() => []);
      return rows.map((r) => {
        const token = /com\.apple\.launchd\.([^/]+)\//.exec(r.socketPath)?.[1] ?? String(r.pid);
        return { id: `sim:${token}`, udid: token, socketPath: r.socketPath };
      });
    }
    const rows = await Promise.all(
      booted.map(async (b) => ({ ...b, socketPath: await this.deps.socketFor(b.udid).catch(() => null) })),
    );
    const out: Found[] = [];
    for (const r of rows) {
      if (r.socketPath) out.push({ id: `sim:${r.udid}`, udid: r.udid, name: r.name, socketPath: r.socketPath });
    }
    return out;
  }

  private descriptor(f: Found): SourceDescriptor {
    const connect = this.deps.connect;
    return {
      id: f.id,
      kind: "simulator",
      udid: f.udid,
      label: f.name ?? `sim:${f.udid.slice(0, 8)}`,
      endpoint: f.socketPath,
      async open(signal) {
        return { wi: await connect(f.socketPath, signal) };
      },
    };
  }
}
