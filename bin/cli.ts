#!/usr/bin/env bun
// inspect-webkit CLI — list iOS Safari / WKWebView debug targets and bridge
// them to the Chrome DevTools Protocol.

import {
  listDevices,
  listTargets,
  startCdpServer,
  startBunCdpServer,
  type Target,
} from "../src/index";

const usage = `inspect-webkit — list & bridge iOS Safari / WKWebView debug targets

usage:
  inspect-webkit devices [--json]
  inspect-webkit list    [--json] [--watch]
  inspect-webkit cdp     [--port 9222] [--host localhost]
  inspect-webkit bun     <ws://...> [<ws://...> ...] [--port 9223] [--host localhost]

bun:
  Bridges one or more Bun \`--inspect\` WebSocket URLs to Chrome DevTools.
  Start Bun with e.g. \`bun --inspect=ws://127.0.0.1:6499/foo script.ts\`,
  then \`inspect-webkit bun ws://127.0.0.1:6499/foo\` and attach via
  chrome://inspect at localhost:9223.

cdp:
  Stands up a Chrome DevTools Protocol bridge backed by Safari's Web
  Inspector. Open chrome://inspect → "Configure" → add localhost:9222,
  or attach VS Code with { "type": "chrome", "request": "attach",
  "port": 9222 }.

sources:
  - iOS device      via /var/run/usbmuxd → lockdown TLS → com.apple.webinspector
  - iOS simulator   via /private/var/tmp/com.apple.launchd.*/com.apple.webinspectord_sim.socket

requirements:
  - macOS host
  - device paired & "Trust This Computer" accepted
  - Settings → Safari → Advanced → Web Inspector ON
  - WKWebView on iOS 16.4+: app must set isInspectable = true
`;

type Flags = { json?: boolean; watch?: boolean; port?: number; host?: string };

function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") flags.json = true;
    else if (a === "--watch") flags.watch = true;
    else if (a === "--port") flags.port = Number(argv[++i]);
    else if (a === "--host") flags.host = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  return { positional, flags };
}

async function cmdDevices(json: boolean) {
  const devs = await listDevices();
  if (json) {
    console.log(JSON.stringify(devs, null, 2));
    return;
  }
  if (devs.length === 0) {
    console.log("no devices — plug a paired iOS device in over USB");
    return;
  }
  for (const d of devs) {
    console.log(
      `${d.Properties.SerialNumber}  id=${d.DeviceID}  via=${d.Properties.ConnectionType}`,
    );
  }
}

function formatTargets(targets: Target[]) {
  if (targets.length === 0) {
    console.log("(no debuggable targets — Safari Web Inspector enabled?");
    console.log(" For WKWebView on iOS 16.4+, app must set isInspectable=true.)");
    return;
  }
  let lastHost = "";
  for (const t of targets) {
    const host =
      t.source === "device" ? `device:${t.udid.slice(0, 8)}` : `sim:${t.udid.slice(4)}`;
    if (host !== lastHost) {
      console.log(`\n# ${host}`);
      lastHost = host;
    }
    const tag = `${host.split(":")[0]![0]}/${t.appId}/${t.pageId}`;
    console.log(`  [${t.appName}${t.bundleId ? ` ${t.bundleId}` : ""}]`);
    console.log(`  ${tag.padEnd(30)} ${t.title || "(untitled)"}`);
    console.log(`  ${" ".repeat(30)} ${t.url}`);
  }
}

async function cmdList(opts: { json?: boolean; watch?: boolean }) {
  const print = async () => {
    const targets = await listTargets();
    if (opts.json) {
      console.log(JSON.stringify(targets, null, 2));
    } else {
      formatTargets(targets);
    }
  };

  if (!opts.watch) return print();

  let prev = "";
  while (true) {
    const targets = await listTargets();
    const sig = JSON.stringify(targets);
    if (sig !== prev) {
      console.clear();
      console.log(`# ${new Date().toISOString()} — ${targets.length} target(s)`);
      if (opts.json) console.log(JSON.stringify(targets, null, 2));
      else formatTargets(targets);
      prev = sig;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function cmdCdp(port: number, host: string) {
  const server = await startCdpServer({ port, host });
  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  await new Promise(() => {});
}

async function cmdBun(urls: string[], port: number, host: string) {
  const upstreams = urls.map((url) => ({ url }));
  const server = await startBunCdpServer({ upstreams, port, host });
  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  await new Promise(() => {});
}

async function main() {
  const [cmd = "list", ...rest] = process.argv.slice(2);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage);
    return;
  }

  const { positional, flags } = parse(rest);

  if (cmd === "devices") return cmdDevices(Boolean(flags.json));
  if (cmd === "list") return cmdList({ json: flags.json, watch: flags.watch });
  if (cmd === "cdp") return cmdCdp(flags.port ?? 9222, flags.host ?? "localhost");
  if (cmd === "bun") {
    if (positional.length === 0) {
      console.error("bun: need at least one ws:// URL\n\n" + usage);
      process.exit(2);
    }
    return cmdBun(positional, flags.port ?? 9223, flags.host ?? "localhost");
  }

  console.error(`unknown command: ${cmd}\n\n${usage}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
