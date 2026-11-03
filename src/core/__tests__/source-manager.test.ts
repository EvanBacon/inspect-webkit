// SourceManager: one long-lived WebInspector connection per simulator /
// device, a per-source state machine (connecting → ready → closed →
// backoff → connecting), patient first connect (webinspectord_sim respawn
// throttle, R10), timeouts so a stuck device never blocks, and stable ids.

import { test, expect, afterEach } from "bun:test";
import {
  SourceManager,
  type SourceDescriptor,
  type SourceDiscovery,
  type SourceState,
} from "../source-manager";
import { makeFakeDaemon, waitUntil } from "../../__tests__/helpers/fake-wir";

const managers: SourceManager[] = [];
afterEach(() => {
  while (managers.length) managers.pop()!.stop();
});

/** A discovery whose descriptor set the test controls. */
class FakeDiscovery implements SourceDiscovery {
  private onChange: ((d: SourceDescriptor[]) => void) | null = null;
  refreshes = 0;
  stopped = false;
  private resolveReady!: () => void;
  ready = new Promise<void>((r) => (this.resolveReady = r));
  constructor(private descs: SourceDescriptor[] = [], private autoReady = true) {}
  start(onChange: (d: SourceDescriptor[]) => void) {
    this.onChange = onChange;
    onChange(this.descs);
    if (this.autoReady) this.resolveReady();
  }
  markReady() {
    this.resolveReady();
  }
  set(descs: SourceDescriptor[]) {
    this.descs = descs;
    this.onChange?.(descs);
  }
  refresh() {
    this.refreshes++;
  }
  stop() {
    this.stopped = true;
  }
}

type Daemon = ReturnType<typeof makeFakeDaemon>;

function simDesc(
  udid: string,
  make: () => Daemon | Promise<Daemon> | "hang" | Error,
  endpoint = `/tmp/${udid}.socket`,
) {
  const daemons: Daemon[] = [];
  const signals: AbortSignal[] = [];
  const desc: SourceDescriptor = {
    id: `sim:${udid}`,
    kind: "simulator",
    udid,
    label: `sim ${udid}`,
    endpoint,
    async open(signal) {
      signals.push(signal);
      const d = make();
      if (d === "hang") {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (d instanceof Error) throw d;
      const daemon = await d;
      daemons.push(daemon);
      return { wi: daemon.wi };
    },
  };
  return { desc, daemons, signals };
}

function manager(discoveries: SourceDiscovery[], opts: Partial<ConstructorParameters<typeof SourceManager>[0]> = {}) {
  const m = new SourceManager({
    discoveries,
    backoffBaseMs: 20,
    backoffMaxMs: 80,
    connectTimeoutMs: 200,
    firstReplyTimeoutMs: 2000,
    ...opts,
  });
  managers.push(m);
  return m;
}

const stateOf = (m: SourceManager, id: string): SourceState | undefined =>
  m.list().find((s) => s.id === id)?.state;

test("holds ONE long-lived connection per source across repeated listings (R10)", async () => {
  const s = simDesc("AAAA", () => makeFakeDaemon());
  const m = manager([new FakeDiscovery([s.desc])]);
  m.start();
  for (let i = 0; i < 3; i++) {
    await m.settled(1000);
    const [src] = m.readySources();
    expect(src).toBeDefined();
    expect(await src!.wi.listApplications()).toHaveLength(1);
  }
  expect(s.daemons.length).toBe(1);
  expect(s.daemons[0]!.sock.destroyed).toBe(false);
});

test("first connect is patient with a respawn-throttled daemon: no silent empty result (R10)", async () => {
  const s = simDesc("AAAA", () => makeFakeDaemon({ replyDelayMs: 400 }));
  const m = manager([new FakeDiscovery([s.desc])]);
  m.start();
  await waitUntil(() => stateOf(m, "sim:AAAA") === "connecting");
  expect(m.readySources()).toEqual([]);
  const t0 = Date.now();
  await m.settled(5000);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  expect(stateOf(m, "sim:AAAA")).toBe("ready");
  expect(m.readySources().map((x) => x.id)).toEqual(["sim:AAAA"]);
});

test("start() never blocks, and a hung open() times out into backoff", async () => {
  const s = simDesc("BBBB", () => "hang");
  const m = manager([new FakeDiscovery([s.desc])]);
  const t0 = Date.now();
  m.start();
  expect(Date.now() - t0).toBeLessThan(50);
  expect(await waitUntil(() => s.signals.length >= 1 && s.signals[0]!.aborted, 1000)).toBe(true);
  expect(await waitUntil(() => stateOf(m, "sim:BBBB") === "backoff", 1000)).toBe(true);
  // ...and retries.
  expect(await waitUntil(() => s.signals.length >= 2, 1000)).toBe(true);
});

test("a daemon that never answers is closed and retried after firstReplyTimeoutMs", async () => {
  let n = 0;
  const s = simDesc("CCCC", () => makeFakeDaemon({ silent: n++ === 0 }));
  const m = manager([new FakeDiscovery([s.desc])], { firstReplyTimeoutMs: 100 });
  m.start();
  expect(await waitUntil(() => stateOf(m, "sim:CCCC") === "ready", 2000)).toBe(true);
  expect(s.daemons.length).toBe(2);
  expect(s.daemons[0]!.sock.destroyed).toBe(true);
});

test("a dropped connection reconnects with backoff under the same stable id", async () => {
  const s = simDesc("DDDD", () => makeFakeDaemon());
  const disc = new FakeDiscovery([s.desc]);
  const m = manager([disc]);
  const seen: string[] = [];
  m.onChange(() => {
    const st = stateOf(m, "sim:DDDD");
    if (st && seen.at(-1) !== st) seen.push(st);
  });
  const ready: string[] = [];
  m.onSourceReady((src) => ready.push(src.id));
  m.start();
  await m.settled(1000);
  const first = m.readySources()[0]!;
  s.daemons[0]!.sock.emit("close"); // webinspectord died
  expect(await waitUntil(() => s.daemons.length === 2 && stateOf(m, "sim:DDDD") === "ready", 2000)).toBe(true);
  const second = m.readySources()[0]!;
  expect(second.id).toBe(first.id);
  expect(second.wi).not.toBe(first.wi);
  expect(ready).toEqual(["sim:DDDD", "sim:DDDD"]);
  expect(seen).toEqual(["connecting", "ready", "closed", "backoff", "connecting", "ready"]);
  // A closed source makes discovery re-check (e.g. the sim was shut down).
  expect(disc.refreshes).toBeGreaterThanOrEqual(1);
});

test("backoff grows exponentially, is capped, and is jittered", () => {
  const m = manager([], { backoffBaseMs: 100, backoffMaxMs: 1000, random: () => 0 });
  expect([0, 1, 2, 3, 4, 10].map((a) => m.backoffDelay(a))).toEqual([50, 100, 200, 400, 500, 500]);
  const m2 = manager([], { backoffBaseMs: 100, backoffMaxMs: 1000, random: () => 0.999999 });
  expect(m2.backoffDelay(10)).toBeLessThanOrEqual(1000);
  expect(m2.backoffDelay(10)).toBeGreaterThan(990);
});

test("a source removed by discovery is closed and not reconnected", async () => {
  const s = simDesc("EEEE", () => makeFakeDaemon());
  const disc = new FakeDiscovery([s.desc]);
  const m = manager([disc]);
  m.start();
  await m.settled(1000);
  disc.set([]);
  expect(await waitUntil(() => s.daemons[0]!.sock.destroyed, 500)).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(s.daemons.length).toBe(1);
  expect(m.list()).toEqual([]);
});

test("an endpoint change (USB↔Wi-Fi, new socket) reconnects immediately", async () => {
  const a = simDesc("FFFF", () => makeFakeDaemon(), "/tmp/a.socket");
  const disc = new FakeDiscovery([a.desc]);
  const m = manager([disc], { backoffBaseMs: 5000, backoffMaxMs: 5000 });
  m.start();
  await m.settled(1000);
  const b = simDesc("FFFF", () => makeFakeDaemon(), "/tmp/b.socket");
  disc.set([b.desc]);
  expect(await waitUntil(() => b.daemons.length === 1 && stateOf(m, "sim:FFFF") === "ready", 1000)).toBe(true);
  expect(a.daemons[0]!.sock.destroyed).toBe(true);
});

test("settled() waits for discovery's first scan, then for connecting sources", async () => {
  const s = simDesc("GGGG", () => makeFakeDaemon({ replyDelayMs: 100 }));
  const disc = new FakeDiscovery([], false);
  const m = manager([disc]);
  m.start();
  let done = false;
  const p = m.settled(3000).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 50));
  expect(done).toBe(false);
  disc.set([s.desc]);
  disc.markReady();
  await p;
  expect(m.readySources().map((x) => x.id)).toEqual(["sim:GGGG"]);
});

test("settled() gives up at its deadline", async () => {
  const s = simDesc("HHHH", () => makeFakeDaemon({ silent: true }));
  const m = manager([new FakeDiscovery([s.desc])], { firstReplyTimeoutMs: 10_000 });
  m.start();
  const t0 = Date.now();
  await m.settled(150);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(m.readySources()).toEqual([]);
});

test("stop() closes connections, aborts pending opens and stops discovery", async () => {
  const ok = simDesc("IIII", () => makeFakeDaemon());
  const hang = simDesc("JJJJ", () => "hang");
  const disc = new FakeDiscovery([ok.desc, hang.desc]);
  const m = manager([disc], { connectTimeoutMs: 10_000 });
  m.start();
  await waitUntil(() => stateOf(m, "sim:IIII") === "ready");
  m.stop();
  expect(ok.daemons[0]!.sock.destroyed).toBe(true);
  expect(hang.signals[0]!.aborted).toBe(true);
  expect(disc.stopped).toBe(true);
  expect(m.readySources()).toEqual([]);
});
