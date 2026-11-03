// iOS Simulator transport: a straight Unix socket to webinspectord_sim.
//
// Each booted simulator's launchd_sim owns
// /private/var/tmp/com.apple.launchd.*/com.apple.webinspectord_sim.socket
// (discovery lives in core/sim-discovery.ts). Same wire protocol as the
// device path (length-prefixed plist + _rpc_*), but with no
// usbmux/lockdown/TLS layers.

import * as net from "node:net";
import { ByteStream } from "./stream";
import { attachStream } from "./socket";

export async function connectSimulator(
  socketPath: string,
  signal?: AbortSignal,
): Promise<{ socket: net.Socket; stream: ByteStream }> {
  const stream = new ByteStream();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const socket = net.createConnection({ path: socketPath });
    const onAbort = () => onError(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    const onError = (err: Error) => {
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      stream.close(err);
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.once("connect", () => {
      signal?.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      attachStream(socket, stream);
      resolve({ socket, stream });
    });
  });
}
