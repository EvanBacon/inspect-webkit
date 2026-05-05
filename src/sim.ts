// iOS Simulator targets via /private/var/tmp/com.apple.launchd.*/com.apple.webinspectord_sim.socket.
//
// The simulator's webinspectord_sim listens on a Unix socket per booted runtime.
// Path is launchd-managed and rotates on boot, so we discover it via `lsof`
// (looking at the daemon process's open Unix sockets).
//
// Same wire protocol as the iOS device path (length-prefixed plist + _rpc_*),
// but with no usbmux/lockdown/TLS layers — straight Unix socket.

import * as net from "node:net";
import { spawnSync } from "node:child_process";
import { ByteStream } from "./stream";
import { attachStream } from "./socket";

export type SimRuntime = {
  socketPath: string;
  pid: number;
};

export async function findSimulatorSockets(): Promise<SimRuntime[]> {
  // Each booted simulator runtime has its own webinspectord_sim. The daemon
  // PID owns one Unix socket file; lsof -U lists them.
  const r = spawnSync("lsof", ["-U"], { stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0 || !r.stdout) return [];
  const out = r.stdout.toString("utf8");
  const sockets = new Map<string, number>(); // path -> pid
  for (const line of out.split("\n")) {
    if (!/com\.apple\.webinspectord_sim\.socket\b/.test(line)) continue;
    const cols = line.split(/\s+/);
    const pid = Number(cols[1]);
    const path = cols[cols.length - 1]!;
    if (path) sockets.set(path, pid);
  }
  return Array.from(sockets, ([socketPath, pid]) => ({ socketPath, pid }));
}

export async function connectSimulator(
  socketPath: string,
): Promise<{ socket: net.Socket; stream: ByteStream }> {
  const stream = new ByteStream();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const onError = (err: Error) => {
      stream.close(err);
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      attachStream(socket, stream);
      resolve({ socket, stream });
    });
  });
}
