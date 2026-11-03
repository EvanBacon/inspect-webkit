// Device discovery via usbmuxd: initial ListDevices, then Listen for
// hot-plug attach/detach; USB + Wi-Fi entries of one UDID become one source
// (USB preferred); a wedged or missing usbmuxd never blocks.

import { test, expect, afterEach } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeviceDiscovery } from "../device-discovery";
import type { SourceDescriptor } from "../source-manager";
import * as usbmux from "../../usbmux";
import { encodeXml, decodeXml, type PlistValue } from "../../plist";
import { waitUntil } from "../../__tests__/helpers/fake-wir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

type Dev = { DeviceID: number; SerialNumber: string; ConnectionType: "USB" | "Network" };

function usbmuxFrame(tag: number, body: Record<string, PlistValue>): Buffer {
  const xml = encodeXml(body);
  const out = Buffer.alloc(16 + xml.length);
  out.writeUInt32LE(16 + xml.length, 0);
  out.writeUInt32LE(1, 4);
  out.writeUInt32LE(8, 8);
  out.writeUInt32LE(tag, 12);
  out.set(xml, 16);
  return out;
}

const props = (d: Dev) => ({ DeviceID: d.DeviceID, SerialNumber: d.SerialNumber, ConnectionType: d.ConnectionType });

/** In-process fake usbmuxd on a temp Unix socket. */
async function fakeUsbmuxd(opts: { devices?: Dev[]; hang?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usbmuxd-"));
  const socketPath = path.join(dir, "usbmuxd");
  const devices = [...(opts.devices ?? [])];
  const listeners = new Set<net.Socket>();
  const conns = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on("close", () => {
      conns.delete(sock);
      listeners.delete(sock);
    });
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 16) {
        const len = buf.readUInt32LE(0);
        if (buf.length < len) break;
        const tag = buf.readUInt32LE(12);
        const msg = decodeXml(new Uint8Array(buf.subarray(16, len))) as Record<string, PlistValue>;
        buf = buf.subarray(len);
        if (opts.hang) continue;
        if (msg.MessageType === "ListDevices") {
          sock.write(usbmuxFrame(tag, { DeviceList: devices.map((d) => ({ DeviceID: d.DeviceID, MessageType: "Attached", Properties: props(d) })) }));
        } else if (msg.MessageType === "Listen") {
          sock.write(usbmuxFrame(tag, { MessageType: "Result", Number: 0 }));
          listeners.add(sock);
          for (const d of devices) {
            sock.write(usbmuxFrame(0, { MessageType: "Attached", DeviceID: d.DeviceID, Properties: props(d) }));
          }
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, () => r()));
  const ctl = {
    socketPath,
    attach(d: Dev) {
      devices.push(d);
      for (const l of listeners) l.write(usbmuxFrame(0, { MessageType: "Attached", DeviceID: d.DeviceID, Properties: props(d) }));
    },
    detach(id: number) {
      const i = devices.findIndex((d) => d.DeviceID === id);
      if (i >= 0) devices.splice(i, 1);
      for (const l of listeners) l.write(usbmuxFrame(0, { MessageType: "Detached", DeviceID: id }));
    },
    dropListeners() {
      for (const l of listeners) l.destroy();
    },
    get listenerCount() {
      return listeners.size;
    },
    close() {
      for (const c of conns) c.destroy();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  cleanups.push(() => ctl.close());
  return ctl;
}

function discover(socketPath: string, extra: Partial<ConstructorParameters<typeof DeviceDiscovery>[0]> = {}) {
  const d = new DeviceDiscovery({ socketPath, requestTimeoutMs: 300, retryMs: 50, ...extra });
  let last: SourceDescriptor[] = [];
  d.start((descs) => (last = descs));
  cleanups.push(() => d.stop());
  return {
    d,
    get descs() {
      return last;
    },
    summary: () => last.map((x) => `${x.id}@${x.endpoint}`).sort(),
  };
}

test("USB and Wi-Fi entries of one UDID become one source, USB preferred (#13)", async () => {
  const mux = await fakeUsbmuxd({
    devices: [
      { DeviceID: 2, SerialNumber: "00008110-AAA", ConnectionType: "Network" },
      { DeviceID: 1, SerialNumber: "00008110-AAA", ConnectionType: "USB" },
      { DeviceID: 3, SerialNumber: "00008120-BBB", ConnectionType: "Network" },
    ],
  });
  const r = discover(mux.socketPath);
  await r.d.ready;
  expect(r.summary()).toEqual(["device:00008110-AAA@USB:1", "device:00008120-BBB@Network:3"]);
  expect(r.descs.find((x) => x.udid === "00008110-AAA")!.kind).toBe("device");
});

test("hot-plug: attach and detach events add and remove sources (Listen)", async () => {
  const mux = await fakeUsbmuxd();
  const r = discover(mux.socketPath);
  await r.d.ready;
  expect(r.descs).toEqual([]);
  await waitUntil(() => mux.listenerCount === 1);
  mux.attach({ DeviceID: 7, SerialNumber: "UDID-7", ConnectionType: "USB" });
  expect(await waitUntil(() => r.descs.length === 1)).toBe(true);
  expect(r.summary()).toEqual(["device:UDID-7@USB:7"]);
  mux.detach(7);
  expect(await waitUntil(() => r.descs.length === 0)).toBe(true);
});

test("unplugging USB while Wi-Fi remains switches the endpoint, same id", async () => {
  const mux = await fakeUsbmuxd({
    devices: [
      { DeviceID: 1, SerialNumber: "UDID-1", ConnectionType: "USB" },
      { DeviceID: 2, SerialNumber: "UDID-1", ConnectionType: "Network" },
    ],
  });
  const r = discover(mux.socketPath);
  await r.d.ready;
  await waitUntil(() => mux.listenerCount === 1);
  mux.detach(1);
  expect(await waitUntil(() => r.summary()[0] === "device:UDID-1@Network:2")).toBe(true);
  expect(r.descs.length).toBe(1);
});

test("a dropped Listen connection is re-established and re-synced", async () => {
  const mux = await fakeUsbmuxd({ devices: [{ DeviceID: 1, SerialNumber: "UDID-1", ConnectionType: "USB" }] });
  const r = discover(mux.socketPath);
  await r.d.ready;
  await waitUntil(() => mux.listenerCount === 1);
  mux.dropListeners();
  mux.detach(1); // happened while we weren't listening
  mux.attach({ DeviceID: 9, SerialNumber: "UDID-9", ConnectionType: "USB" });
  expect(await waitUntil(() => r.summary().join() === "device:UDID-9@USB:9", 2000)).toBe(true);
});

test("a wedged usbmuxd never blocks discovery: requests time out", async () => {
  const mux = await fakeUsbmuxd({ hang: true });
  const t0 = Date.now();
  await expect(usbmux.listDevices({ socketPath: mux.socketPath, timeoutMs: 100 })).rejects.toThrow(/timed out/);
  expect(Date.now() - t0).toBeLessThan(1000);
  const r = discover(mux.socketPath, { requestTimeoutMs: 100 });
  await r.d.ready;
  expect(r.descs).toEqual([]);
});

test("a missing usbmuxd (no socket) resolves ready with no devices", async () => {
  const r = discover("/nonexistent/usbmuxd-socket");
  const t0 = Date.now();
  await r.d.ready;
  expect(Date.now() - t0).toBeLessThan(500);
  expect(r.descs).toEqual([]);
});
