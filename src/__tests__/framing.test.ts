// Length-prefix guards in the usbmux / lockdown frame readers.

import { test, expect } from "bun:test";
import * as usbmux from "../usbmux";
import * as lockdown from "../lockdown";
import { ByteStream } from "../stream";
import { FakeSocket } from "./helpers/fake-wir";

function u32(n: number, le: boolean): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, le);
  return b;
}

test("usbmux readFrame rejects len < 16 and destroys the socket", async () => {
  const stream = new ByteStream();
  const sock = new FakeSocket();
  stream.push(u32(8, true));
  stream.push(new Uint8Array(12));
  await expect(usbmux.readFrame(stream, sock as any)).rejects.toThrow(/usbmux frame length/);
  expect(sock.destroyed).toBe(true);
});

test("usbmux readFrame rejects oversized frames", async () => {
  const stream = new ByteStream();
  const sock = new FakeSocket();
  stream.push(u32(0xffffffff, true));
  await expect(usbmux.readFrame(stream, sock as any)).rejects.toThrow(/usbmux frame length/);
  expect(sock.destroyed).toBe(true);
});

test("lockdown readFrame rejects oversized frames", async () => {
  const stream = new ByteStream();
  const sock = new FakeSocket();
  stream.push(u32(0xffffffff, false));
  await expect(lockdown.readFrame(stream, sock as any)).rejects.toThrow(/lockdown frame length/);
  expect(sock.destroyed).toBe(true);
});
