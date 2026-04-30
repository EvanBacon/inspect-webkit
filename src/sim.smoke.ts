// Probe what the simulator's webinspectord_sim speaks on its Unix socket.
// We expect length-prefixed plist (same as the iOS device path).
import * as net from "node:net";
import { ByteStream } from "./stream";
import { decode, encodeXml } from "./plist";
import { attachStream } from "./socket";

const SOCK = process.argv[2];
if (!SOCK) throw new Error("usage: bun src/sim.smoke.ts <socket-path>");

const stream = new ByteStream();
const sock = net.createConnection({ path: SOCK });
await new Promise<void>((resolve, reject) => {
  sock.once("error", reject);
  sock.once("connect", () => {
    console.log("# socket open");
    sock.off("error", reject);
    attachStream(sock, stream);
    resolve();
  });
});

// Try the iOS-style framing: 4-byte BE length, then plist body.
const body = encodeXml({
  __selector: "_rpc_reportIdentifier:",
  __argument: { WIRConnectionIdentifierKey: crypto.randomUUID() },
});
const header = new Uint8Array(4);
new DataView(header.buffer).setUint32(0, body.length, false);
sock.write(header);
sock.write(body);
console.log(`# sent ${body.length}-byte _rpc_reportIdentifier:`);

setTimeout(() => {
  console.log("# timeout, no reply");
  process.exit(0);
}, 2000);

// Try to read first reply
try {
  const len = new DataView((await stream.read(4)).buffer).getUint32(0, false);
  console.log(`# got reply, length=${len}`);
  const buf = await stream.read(len);
  const reply = decode(buf);
  console.log(JSON.stringify(reply, null, 2).slice(0, 2000));
  process.exit(0);
} catch (e) {
  console.log("# read err:", (e as Error).message);
}
