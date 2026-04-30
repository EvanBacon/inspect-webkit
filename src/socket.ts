// Shared helpers for wiring Node net/tls sockets to a ByteStream.

import type * as net from "node:net";
import type * as tls from "node:tls";
import { ByteStream } from "./stream";

export type AnySocket = net.Socket | tls.TLSSocket;

/**
 * Attach data/close/error listeners on `socket` that feed `stream`.
 * Returns a detacher that removes those listeners (use before swapping
 * to a TLS-wrapped socket so encrypted bytes don't leak into the stream).
 */
export function attachStream(socket: AnySocket, stream: ByteStream): () => void {
  const onData = (chunk: Buffer) => {
    stream.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  };
  const onClose = () => stream.close();
  const onError = (err: Error) => stream.close(err);
  socket.on("data", onData);
  socket.on("close", onClose);
  socket.on("error", onError);
  return () => {
    socket.off("data", onData);
    socket.off("close", onClose);
    socket.off("error", onError);
  };
}
