// Lockdown client.
//
// Wire format on top of a usbmux tunnel (port 62078):
//   uint32 BE length, then XML plist body (length bytes).
//
// Bring-up sequence to start a service:
//   QueryType                    -> validates we're talking lockdown
//   StartSession{HostID,SysBUID} -> returns SessionID, EnableSessionSSL: true
//   <upgrade socket to TLS using HostCertificate + HostPrivateKey>
//   StartService{Service: ...}   -> returns Port and optionally EnableServiceSSL
//
// Each service runs on its own usbmux tunnel — we don't multiplex.

import * as tls from "node:tls";
import { encodeXml, decodeXml, type PlistValue } from "./plist";
import * as usbmux from "./usbmux";
import { ByteStream } from "./stream";
import { attachStream, type AnySocket } from "./socket";

const LOCKDOWN_PORT = 62078;
const debug = (...args: unknown[]) => {
  if (process.env.INSPECT_WEBKIT_DEBUG) console.error("[lockdown]", ...args);
};

export type ServiceDescriptor = {
  port: number;
  enableServiceSSL: boolean;
  service: string;
};

async function readFrame(stream: ByteStream): Promise<Record<string, PlistValue>> {
  const lenBuf = await stream.read(4);
  const len = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0, false);
  const body = await stream.read(len);
  return decodeXml(body) as Record<string, PlistValue>;
}

function writeFrame(socket: AnySocket, payload: Record<string, PlistValue>) {
  const body = encodeXml({ Label: "inspect-webkit", ...payload });
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, body.length, false);
  socket.write(header);
  socket.write(body);
}

function expect(reply: Record<string, PlistValue>, request: string) {
  if (reply.Error) throw new Error(`lockdown ${request} error: ${String(reply.Error)}`);
  if (reply.Request !== request) {
    throw new Error(`lockdown expected Request=${request}, got ${String(reply.Request)}`);
  }
}

/** Wrap an existing connected socket in TLS, returning a fresh (socket, stream) pair. */
function upgradeSocketTLS(
  rawSocket: AnySocket,
  detach: () => void,
  pair: usbmux.PairRecord,
  label: string,
): Promise<{ socket: tls.TLSSocket; stream: ByteStream; detach: () => void }> {
  return new Promise((resolve, reject) => {
    detach();
    const newStream = new ByteStream();
    const tlsSocket = tls.connect({
      socket: rawSocket,
      cert: Buffer.from(pair.HostCertificate),
      key: Buffer.from(pair.HostPrivateKey),
      ca: Buffer.from(pair.RootCertificate),
      rejectUnauthorized: false,
    });
    const onError = (err: Error) => {
      debug(`${label} tls error:`, err);
      newStream.close(err);
      reject(err);
    };
    tlsSocket.once("error", onError);
    tlsSocket.once("secureConnect", () => {
      debug(`${label} tls handshake complete`);
      tlsSocket.off("error", onError);
      const newDetach = attachStream(tlsSocket, newStream);
      resolve({ socket: tlsSocket, stream: newStream, detach: newDetach });
    });
  });
}

export class LockdownClient {
  private detach: () => void;

  private constructor(
    private socket: AnySocket,
    private stream: ByteStream,
    private pair: usbmux.PairRecord,
    private udid: string,
    private deviceID: number,
    detach: () => void,
  ) {
    this.detach = detach;
  }

  static async open(device: usbmux.Device, pair: usbmux.PairRecord): Promise<LockdownClient> {
    debug("connecting usbmux tunnel to lockdown port", LOCKDOWN_PORT);
    const { socket, stream, detach } = await usbmux.connect(device.DeviceID, LOCKDOWN_PORT);

    const c = new LockdownClient(
      socket,
      stream,
      pair,
      device.Properties.SerialNumber,
      device.DeviceID,
      detach,
    );
    debug("sending QueryType");
    writeFrame(socket, { Request: "QueryType" });
    const r = await readFrame(stream);
    debug("QueryType reply:", r);
    expect(r, "QueryType");
    if (r.Type !== "com.apple.mobile.lockdown") {
      throw new Error(`unexpected lockdown Type: ${String(r.Type)}`);
    }
    return c;
  }

  async startSession(): Promise<void> {
    debug("StartSession with HostID", this.pair.HostID);
    writeFrame(this.socket, {
      Request: "StartSession",
      HostID: this.pair.HostID,
      SystemBUID: this.pair.SystemBUID,
    });
    const r = await readFrame(this.stream);
    debug("StartSession reply:", r);
    expect(r, "StartSession");
    if (r.EnableSessionSSL) {
      debug("upgrading to TLS");
      const upgraded = await upgradeSocketTLS(this.socket, this.detach, this.pair, "lockdown");
      this.socket = upgraded.socket;
      this.stream = upgraded.stream;
      this.detach = upgraded.detach;
      debug("TLS upgrade complete");
    }
  }

  async startService(name: string): Promise<ServiceDescriptor> {
    debug("StartService", name);
    writeFrame(this.socket, { Request: "StartService", Service: name });
    const r = await readFrame(this.stream);
    debug("StartService reply:", r);
    expect(r, "StartService");
    return {
      port: r.Port as number,
      enableServiceSSL: Boolean(r.EnableServiceSSL),
      service: name,
    };
  }

  /** Connect a fresh usbmux tunnel to the service port and (optionally) wrap in TLS. */
  async connectService(svc: ServiceDescriptor): Promise<{
    socket: AnySocket;
    stream: ByteStream;
  }> {
    debug("connecting service tunnel to port", svc.port, "ssl=", svc.enableServiceSSL);
    const { socket, stream, detach } = await usbmux.connect(this.deviceID, svc.port);
    if (!svc.enableServiceSSL) return { socket, stream };

    const upgraded = await upgradeSocketTLS(socket, detach, this.pair, "service");
    return { socket: upgraded.socket, stream: upgraded.stream };
  }

  close() {
    this.socket.end();
  }
}
