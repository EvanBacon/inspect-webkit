// Simulator discovery without per-poll lsof: a cheap readdir of the launchd
// socket dirs as the change trigger, `simctl` to map socket → UDID (stable
// ids), lsof only as a fallback.

import { test, expect, afterEach } from "bun:test";
import {
  SimulatorDiscovery,
  parseBootedDevices,
  parseLsofSockets,
  type SimDiscoveryDeps,
} from "../sim-discovery";
import type { SourceDescriptor } from "../source-manager";
import { waitUntil } from "../../__tests__/helpers/fake-wir";

const SOCK = (t: string) => `/private/var/tmp/com.apple.launchd.${t}/com.apple.webinspectord_sim.socket`;

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
});

function rig(init: {
  sockets: string[];
  booted: Array<{ udid: string; name: string }>;
  env: Record<string, string>;
  simctlFails?: boolean;
  lsof?: Array<{ socketPath: string; pid: number }>;
}) {
  const state = { ...init, calls: { listBooted: 0, socketFor: 0, lsof: 0, scan: 0 } };
  const deps: SimDiscoveryDeps = {
    scanSockets: () => {
      state.calls.scan++;
      return [...state.sockets];
    },
    listBooted: async () => {
      state.calls.listBooted++;
      if (state.simctlFails) throw new Error("xcrun: error: unable to find utility simctl");
      return [...state.booted];
    },
    socketFor: async (udid) => {
      state.calls.socketFor++;
      return state.env[udid] ?? null;
    },
    lsof: async () => {
      state.calls.lsof++;
      return state.lsof ?? [];
    },
    connect: async () => {
      throw new Error("not used");
    },
  };
  const d = new SimulatorDiscovery({ deps, pollMs: 20, fullRescanMs: 60_000, newSocketRetryMs: 2_000 });
  let last: SourceDescriptor[] = [];
  let changes = 0;
  d.start((descs) => {
    last = descs;
    changes++;
  });
  stops.push(() => d.stop());
  return {
    d,
    state,
    get descs() {
      return last;
    },
    get changes() {
      return changes;
    },
  };
}

test("maps booted simulators to their sockets by UDID; stale sockets are ignored", async () => {
  const r = rig({
    sockets: [SOCK("live"), SOCK("stale1"), SOCK("stale2")],
    booted: [{ udid: "U-1", name: "iPhone 18 Pro" }],
    env: { "U-1": SOCK("live") },
  });
  await r.d.ready;
  expect(r.descs.map((d) => [d.id, d.kind, d.udid, d.endpoint])).toEqual([
    ["sim:U-1", "simulator", "U-1", SOCK("live")],
  ]);
  expect(r.descs[0]!.label).toContain("iPhone 18 Pro");
});

test("idle polls are a readdir only — no simctl/lsof spawns while nothing changes", async () => {
  const r = rig({ sockets: [SOCK("live")], booted: [{ udid: "U-1", name: "A" }], env: { "U-1": SOCK("live") } });
  await r.d.ready;
  const before = { ...r.state.calls };
  await new Promise((res) => setTimeout(res, 150));
  expect(r.state.calls.scan).toBeGreaterThan(before.scan + 3);
  expect(r.state.calls.listBooted).toBe(before.listBooted);
  expect(r.state.calls.socketFor).toBe(before.socketFor);
  expect(r.state.calls.lsof).toBe(0);
});

test("a simulator booted later is discovered (R8), retrying until simctl reports it", async () => {
  const r = rig({ sockets: [SOCK("a")], booted: [{ udid: "U-1", name: "A" }], env: { "U-1": SOCK("a") } });
  await r.d.ready;
  // Boot starts: the socket appears before simctl lists the device as booted.
  r.state.sockets.push(SOCK("b"));
  await new Promise((res) => setTimeout(res, 100));
  expect(r.descs.map((d) => d.id)).toEqual(["sim:U-1"]);
  r.state.booted.push({ udid: "U-2", name: "B" });
  r.state.env["U-2"] = SOCK("b");
  expect(await waitUntil(() => r.descs.length === 2, 2000)).toBe(true);
  expect(r.descs.map((d) => d.id).sort()).toEqual(["sim:U-1", "sim:U-2"]);
});

test("refresh() after a source drops removes a simulator that was shut down", async () => {
  const r = rig({ sockets: [SOCK("a")], booted: [{ udid: "U-1", name: "A" }], env: { "U-1": SOCK("a") } });
  await r.d.ready;
  r.state.booted = [];
  r.d.refresh();
  expect(await waitUntil(() => r.descs.length === 0, 1000)).toBe(true);
});

test("a reboot (new launchd socket for the same UDID) updates the endpoint, same id", async () => {
  const r = rig({ sockets: [SOCK("a")], booted: [{ udid: "U-1", name: "A" }], env: { "U-1": SOCK("a") } });
  await r.d.ready;
  r.state.sockets.push(SOCK("a2"));
  r.state.env["U-1"] = SOCK("a2");
  expect(await waitUntil(() => r.descs[0]?.endpoint === SOCK("a2"), 1000)).toBe(true);
  expect(r.descs.map((d) => d.id)).toEqual(["sim:U-1"]);
});

test("falls back to lsof when simctl is unavailable", async () => {
  const r = rig({
    sockets: [SOCK("live"), SOCK("stale")],
    booted: [],
    env: {},
    simctlFails: true,
    lsof: [{ socketPath: SOCK("live"), pid: 4242 }],
  });
  await r.d.ready;
  expect(r.state.calls.lsof).toBe(1);
  expect(r.descs.map((d) => [d.id, d.endpoint])).toEqual([["sim:live", SOCK("live")]]);
});

test("parseBootedDevices tolerates junk and returns only booted devices", () => {
  expect(parseBootedDevices("not json")).toEqual([]);
  expect(parseBootedDevices("null")).toEqual([]);
  expect(parseBootedDevices(JSON.stringify({ devices: { r: "x" } }))).toEqual([]);
  expect(
    parseBootedDevices(
      JSON.stringify({
        devices: {
          "iOS-27-2": [
            { udid: "U-1", name: "A", state: "Booted" },
            { udid: "U-2", name: "B", state: "Shutdown" },
            { udid: 5, name: "C", state: "Booted" },
            null,
          ],
        },
      }),
    ),
  ).toEqual([{ udid: "U-1", name: "A" }]);
});

test("parseLsofSockets (F12): never throws, only webinspectord_sim sockets", () => {
  const out = [
    "COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    `launchd_s 72043 me   10u  unix 0xaa5e204c5ac53188      0t0      ${SOCK("x")}`,
    `launchd_s 72043 me   12u  unix 0xaa5e204c5ac53188      0t0      ${SOCK("x")}`,
    "garbage",
    "",
    `foo abc me 1u unix 0x1 0t0 /tmp/other.socket`,
  ].join("\n");
  expect(parseLsofSockets(out)).toEqual([{ socketPath: SOCK("x"), pid: 72043 }]);
  expect(parseLsofSockets("")).toEqual([]);
  for (const junk of ["\u0000\n\n", "a b c d e f g h i j k webinspectord_sim.socket", "x".repeat(1000)]) {
    expect(() => parseLsofSockets(junk)).not.toThrow();
    for (const r of parseLsofSockets(junk)) expect(r.socketPath.endsWith("webinspectord_sim.socket")).toBe(true);
  }
});

test("readBootedFromDeviceSet reads CoreSimulator device.plist files (no simctl spawn)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { encodeXml } = await import("../../plist");
  const { readBootedFromDeviceSet } = await import("../sim-discovery");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devset-"));
  try {
    const mk = (udid: string, state: number, extra: Record<string, any> = {}) => {
      fs.mkdirSync(path.join(dir, udid));
      fs.writeFileSync(path.join(dir, udid, "device.plist"), encodeXml({ UDID: udid, name: `Dev ${udid}`, state, ...extra }));
    };
    mk("U-BOOTED", 3);
    mk("U-SHUTDOWN", 1);
    mk("U-DELETED", 3, { isDeleted: true });
    fs.mkdirSync(path.join(dir, "junk"));
    fs.writeFileSync(path.join(dir, "junk", "device.plist"), "not a plist");
    fs.writeFileSync(path.join(dir, "device_set.plist"), "x");
    expect(await readBootedFromDeviceSet(dir)).toEqual([{ udid: "U-BOOTED", name: "Dev U-BOOTED" }]);
    expect(await readBootedFromDeviceSet(path.join(dir, "missing"))).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the periodic safety rescan asks simctl authoritatively", async () => {
  const seen: boolean[] = [];
  const d = new SimulatorDiscovery({
    deps: {
      scanSockets: () => [SOCK("a")],
      listBooted: async (authoritative?: boolean) => {
        seen.push(!!authoritative);
        return [{ udid: "U-1", name: "A" }];
      },
      socketFor: async () => SOCK("a"),
      lsof: async () => [],
      connect: async () => {
        throw new Error("unused");
      },
    },
    pollMs: 10,
    fullRescanMs: 50,
  });
  d.start(() => {});
  stops.push(() => d.stop());
  await d.ready;
  expect(seen[0]).toBe(false);
  expect(await waitUntil(() => seen.includes(true), 1000)).toBe(true);
});
