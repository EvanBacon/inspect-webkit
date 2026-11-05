// Built with `bun build --target=node` and run under Node by
// ws-frame-limits.test.ts, so the frame limits are exercised against the real
// `ws` package — the code path the published (node-targeted) CLI ships. Under
// the Bun runtime, `import "ws"` resolves to Bun's built-in shim instead.
//
// Starts one Safari CDP server (fake WIR, one page) and one Bun CDP server
// (silent local upstream), prints their ports + page paths as one JSON line,
// then runs until killed.

import { WebSocketServer } from "ws";
import { startCdpServer } from "../../server";
import { startBunCdpServer } from "../../bun-server";
import { freePort, makeFakeWir, seedApp, waitUntil } from "../../../__tests__/helpers/fake-wir";

const rig = makeFakeWir();
const safariPort = await freePort();
const safari = await startCdpServer({
  port: safariPort,
  openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: rig.wi }],
});
seedApp(rig, [{ id: 1 }]);
await waitUntil(() => safari.getTargets().length === 1);

const upPort = await freePort();
const upstreamWss = new WebSocketServer({ host: "127.0.0.1", port: upPort });
await new Promise<void>((r) => upstreamWss.once("listening", () => r()));
const upstream = `ws://127.0.0.1:${upPort}/inspector`;
const bunPort = await freePort();
await startBunCdpServer({ port: bunPort, upstreams: [{ url: upstream }] });

process.stdout.write(
  JSON.stringify({
    pid: process.pid,
    servers: {
      server: { port: safariPort, pagePath: "/devtools/page/sim:fake:PID:1:1" },
      "bun-server": { port: bunPort, pagePath: `/devtools/page/${encodeURIComponent(upstream)}` },
    },
  }) + "\n",
);
