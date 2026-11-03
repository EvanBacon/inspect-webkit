// usbmuxd client — talks to /var/run/usbmuxd over a Unix socket.
//
// Frame format (little-endian):
//   uint32 length (incl. header)
//   uint32 version (1)
//   uint32 message (8 = plist)
//   uint32 tag
//   <XML plist body>
//
// After a successful Connect, the underlying byte stream is no longer a
// usbmux session — it's a raw tunnel to the device port. We hand off the
// (socket, stream) pair to whoever called us.

import * as net from "node:net";
import { encodeXml, decodeXml, type PlistValue } from "./plist";
import { ByteStream } from "./stream";
import { attachStream } from "./socket";

export type DeviceProperties = {
  ConnectionType: string;
  DeviceID: number;
  ProductID?: number;
  SerialNumber: string; // UDID
  LocationID?: number;
  USBSerialNumber?: string;
};

export type Device = { DeviceID: number; Properties: DeviceProperties };

export type PairRecord = {
  HostID: string;
  HostCertificate: Uint8Array;
  HostPrivateKey: Uint8Array;
  RootCertificate: Uint8Array;
  DeviceCertificate?: Uint8Array;
  SystemBUID: string;
  WiFiMACAddress?: string;
  EscrowBag?: Uint8Array;
};

const VERSION = 1;
const MESSAGE_PLIST = 8;
const SOCKET_PATH = "/var/run/usbmuxd";

export type RawSocket = net.Socket;

/** Where usbmuxd listens. Honours libimobiledevice's USBMUXD_SOCKET_ADDRESS
 *  ("UNIX:/path" or a bare path). */
export function defaultSocketPath(): string {
  const env = process.env.USBMUXD_SOCKET_ADDRESS;
  if (env && env.startsWith("UNIX:")) return env.slice(5);
  if (env && env.startsWith("/")) return env;
  return SOCKET_PATH;
}

/** Default deadline for a usbmuxd request/response. */
export const USBMUX_TIMEOUT_MS = 5_000;

export type UsbmuxOptions = {
  socketPath?: string;
  /** Per-request deadline (default USBMUX_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Aborting destroys the connection (handshakes in progress fail). */
  signal?: AbortSignal;
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

async function openRaw(opts: UsbmuxOptions = {}): Promise<{
  socket: net.Socket;
  stream: ByteStream;
  detach: () => void;
}> {
  const stream = new ByteStream();
  const { signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const socket = net.createConnection({ path: opts.socketPath ?? defaultSocketPath() });
    // Abort tears the connection down whenever it happens: during connect
    // or during whatever handshake the caller runs on top.
    const onAbort = () => {
      const err = abortError(signal!);
      socket.destroy();
      stream.close(err);
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("close", () => signal?.removeEventListener("abort", onAbort));
    const onError = (err: Error) => {
      stream.close(err);
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      const detach = attachStream(socket, stream);
      resolve({ socket, stream, detach });
    });
  });
}

/** usbmuxd control replies are small plists; anything bigger is bogus. */
export const MAX_USBMUX_FRAME = 16 * 1024 * 1024;
const USBMUX_HEADER = 16;

/** @internal exported for tests. Destroys `socket` on a malformed length. */
export async function readFrame(
  stream: ByteStream,
  socket?: { destroy(): void },
): Promise<Uint8Array> {
  const lenBuf = await stream.read(4);
  const len = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0, true);
  if (len < USBMUX_HEADER || len > MAX_USBMUX_FRAME) {
    try {
      socket?.destroy();
    } catch {}
    stream.close(new Error(`bad usbmux frame length ${len}`));
    throw new Error(`bad usbmux frame length ${len}`);
  }
  // length includes the 16-byte header but only the first 4 bytes have been read
  const rest = await stream.read(len - 4);
  // we want just the plist payload — strip the remaining 12 bytes of header
  return rest.slice(12);
}

function writeFrame(socket: net.Socket, tag: number, body: Uint8Array) {
  const total = 16 + body.length;
  const header = new Uint8Array(16);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, total, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, MESSAGE_PLIST, true);
  dv.setUint32(12, tag, true);
  const out = Buffer.allocUnsafe(total);
  out.set(header, 0);
  out.set(body, 16);
  socket.write(out);
}

async function sendRecv(
  socket: net.Socket,
  stream: ByteStream,
  tag: number,
  payload: Record<string, PlistValue>,
  timeoutMs = USBMUX_TIMEOUT_MS,
): Promise<Record<string, PlistValue>> {
  const body = encodeXml({
    ClientVersionString: "inspect-webkit-1.0",
    ProgName: "inspect-webkit",
    kLibUSBMuxVersion: 3,
    ...payload,
  });
  // A wedged usbmuxd must not hang us: tear the connection down at the deadline.
  const timer = setTimeout(() => {
    const err = new Error(`usbmux ${String(payload.MessageType)} timed out after ${timeoutMs}ms`);
    socket.destroy();
    stream.close(err);
  }, timeoutMs);
  try {
    writeFrame(socket, tag, body);
    const reply = await readFrame(stream, socket);
    return decodeXml(reply) as Record<string, PlistValue>;
  } finally {
    clearTimeout(timer);
  }
}

export async function listDevices(opts: UsbmuxOptions = {}): Promise<Device[]> {
  const { socket, stream } = await openRaw(opts);
  try {
    const r = await sendRecv(socket, stream, 1, { MessageType: "ListDevices" }, opts.timeoutMs);
    return ((r.DeviceList as unknown) as Device[]) ?? [];
  } finally {
    socket.end();
  }
}

export async function readPairRecord(udid: string, opts: UsbmuxOptions = {}): Promise<PairRecord> {
  const { socket, stream } = await openRaw(opts);
  try {
    const r = await sendRecv(
      socket,
      stream,
      1,
      { MessageType: "ReadPairRecord", PairRecordID: udid },
      opts.timeoutMs,
    );
    const data = r.PairRecordData as Uint8Array | undefined;
    if (!data) {
      throw new Error(
        `no pair record for ${udid} — pair the device first (open Finder/iTunes, tap "Trust")`,
      );
    }
    return decodeXml(data) as unknown as PairRecord;
  } finally {
    socket.end();
  }
}

/**
 * Open a tunnel to a TCP port on the device. The returned socket+stream is a
 * raw byte channel — the next layer owns framing.
 */
export async function connect(
  deviceID: number,
  port: number,
  opts: UsbmuxOptions = {},
): Promise<{ socket: net.Socket; stream: ByteStream; detach: () => void }> {
  const { socket, stream, detach } = await openRaw(opts);
  try {
    // PortNumber is htons-style: low 16 bits hold the byte-swapped port.
    const portBE = ((port & 0xff) << 8) | ((port >> 8) & 0xff);
    const r = await sendRecv(
      socket,
      stream,
      1,
      { MessageType: "Connect", DeviceID: deviceID, PortNumber: portBE },
      opts.timeoutMs,
    );
    if (r.MessageType !== "Result" || r.Number !== 0) {
      const code = r.Number ?? "?";
      throw new Error(`Connect to device ${deviceID} port ${port} failed (code ${code})`);
    }
  } catch (e) {
    socket.destroy();
    throw e;
  }
  return { socket, stream, detach };
}

export type UsbmuxEvent = {
  MessageType: string;
  DeviceID?: number;
  Properties?: DeviceProperties;
};

/**
 * Subscribe to device attach/detach notifications ("Attached" with
 * Properties, "Detached"). Resolves once usbmuxd accepted the Listen;
 * `done` resolves when the connection ends (usbmuxd restarted, close()).
 */
export async function listen(
  onEvent: (e: UsbmuxEvent) => void,
  opts: UsbmuxOptions = {},
): Promise<{ close(): void; unref(): void; done: Promise<void> }> {
  const { socket, stream } = await openRaw(opts);
  try {
    const r = await sendRecv(socket, stream, 1, { MessageType: "Listen" }, opts.timeoutMs);
    if (r.MessageType !== "Result" || r.Number !== 0) {
      throw new Error(`usbmux Listen failed (code ${String(r.Number ?? "?")})`);
    }
  } catch (e) {
    socket.destroy();
    throw e;
  }
  const done = (async () => {
    try {
      for (;;) {
        const body = await readFrame(stream, socket);
        let msg: unknown;
        try {
          msg = decodeXml(body);
        } catch {
          continue; // undecodable notification; the frame boundary is intact
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
        try {
          onEvent(msg as UsbmuxEvent);
        } catch {}
      }
    } catch {
      // stream ended
    } finally {
      socket.destroy();
    }
  })();
  return { close: () => socket.destroy(), unref: () => socket.unref(), done };
}
