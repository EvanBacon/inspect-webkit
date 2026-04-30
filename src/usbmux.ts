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

async function openRaw(): Promise<{
  socket: net.Socket;
  stream: ByteStream;
  detach: () => void;
}> {
  const stream = new ByteStream();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: SOCKET_PATH });
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

async function readFrame(stream: ByteStream): Promise<Uint8Array> {
  const lenBuf = await stream.read(4);
  const len = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0, true);
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
  socket.write(header);
  socket.write(body);
}

async function sendRecv(
  socket: net.Socket,
  stream: ByteStream,
  tag: number,
  payload: Record<string, PlistValue>,
): Promise<Record<string, PlistValue>> {
  const body = encodeXml({
    ClientVersionString: "inspect-webkit-1.0",
    ProgName: "inspect-webkit",
    kLibUSBMuxVersion: 3,
    ...payload,
  });
  writeFrame(socket, tag, body);
  const reply = await readFrame(stream);
  return decodeXml(reply) as Record<string, PlistValue>;
}

export async function listDevices(): Promise<Device[]> {
  const { socket, stream } = await openRaw();
  try {
    const r = await sendRecv(socket, stream, 1, { MessageType: "ListDevices" });
    return ((r.DeviceList as unknown) as Device[]) ?? [];
  } finally {
    socket.end();
  }
}

export async function readPairRecord(udid: string): Promise<PairRecord> {
  const { socket, stream } = await openRaw();
  try {
    const r = await sendRecv(socket, stream, 1, {
      MessageType: "ReadPairRecord",
      PairRecordID: udid,
    });
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
): Promise<{ socket: net.Socket; stream: ByteStream; detach: () => void }> {
  const { socket, stream, detach } = await openRaw();
  // PortNumber is htons-style: low 16 bits hold the byte-swapped port.
  const portBE = ((port & 0xff) << 8) | ((port >> 8) & 0xff);
  const r = await sendRecv(socket, stream, 1, {
    MessageType: "Connect",
    DeviceID: deviceID,
    PortNumber: portBE,
  });
  if (r.MessageType !== "Result" || r.Number !== 0) {
    socket.end();
    const code = r.Number ?? "?";
    throw new Error(`Connect to device ${deviceID} port ${port} failed (code ${code})`);
  }
  return { socket, stream, detach };
}
