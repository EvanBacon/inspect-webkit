#!/usr/bin/env bun
// inspect-webkit CLI — bridge iOS Safari / WKWebView debug targets to the
// Chrome DevTools Protocol.

import { Command, Option } from "commander";
import { startCdpServer, startBunCdpServer } from "../src/index";

const program = new Command();

program
  .name("inspect-webkit")
  .description("bridge iOS Safari / WKWebView debug targets to CDP")
  .addHelpText(
    "after",
    `
sources:
  - iOS device      via /var/run/usbmuxd → lockdown TLS → com.apple.webinspector
  - iOS simulator   via /private/var/tmp/com.apple.launchd.*/com.apple.webinspectord_sim.socket

requirements:
  - macOS host
  - device paired & "Trust This Computer" accepted
  - Settings → Safari → Advanced → Web Inspector ON
  - WKWebView on iOS 16.4+: app must set isInspectable = true
`,
  )
  .showHelpAfterError();

program
  .command("cdp", { isDefault: true })
  .description(
    "stand up a Chrome DevTools Protocol bridge backed by Safari's Web Inspector",
  )
  .addOption(new Option("-p, --port <port>", "listen port").default(9222).argParser(Number))
  .addOption(new Option("-H, --host <host>", "listen host").default("localhost"))
  .action(async (opts: { port: number; host: string }) => {
    const server = await startCdpServer({ port: opts.port, host: opts.host });
    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
    await new Promise(() => {});
  });

// Undocumented: bridge one or more Bun `--inspect` WebSocket URLs to CDP.
// Start Bun with e.g. `bun --inspect=ws://127.0.0.1:6499/foo script.ts`,
// then `inspect-webkit bun ws://127.0.0.1:6499/foo` and attach via
// chrome://inspect at localhost:9223.
program
  .command("bun", { hidden: true })
  .description("bridge one or more Bun --inspect WebSocket URLs to CDP")
  .argument("<urls...>", "ws:// URLs from `bun --inspect=…`")
  .addOption(new Option("-p, --port <port>", "listen port").default(9223).argParser(Number))
  .addOption(new Option("-H, --host <host>", "listen host").default("localhost"))
  .action(async (urls: string[], opts: { port: number; host: string }) => {
    const upstreams = urls.map((url) => ({ url }));
    const server = await startBunCdpServer({
      upstreams,
      port: opts.port,
      host: opts.host,
    });
    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
    await new Promise(() => {});
  });

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
