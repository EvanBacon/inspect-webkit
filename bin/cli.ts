#!/usr/bin/env node
// inspect-webkit CLI — bridge iOS Safari / WKWebView debug targets to the
// Chrome DevTools Protocol.

import { execSync } from "node:child_process";
import { Command, InvalidArgumentError, Option } from "commander";
import { startCdpServer, startBunCdpServer } from "../src/index";

// Last-resort backstop: one bad frame or request must never take down
// every attached debugging session. Library code handles its own errors;
// this only catches what slips through, and logs it.
process.on("unhandledRejection", (reason) => {
  console.error(
    `# internal error (unhandled rejection): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});
process.on("uncaughtException", (err) => {
  console.error(`# internal error (uncaught exception): ${err?.stack ?? err}`);
});

function parsePort(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new InvalidArgumentError(`invalid port: ${v}`);
  }
  return n;
}

/** --allow-origin is repeatable and accepts comma-separated lists. */
function collectOrigins(v: string, prev: string[] | undefined): string[] {
  return [...(prev ?? []), ...v.split(",").map((s) => s.trim()).filter(Boolean)];
}

const HOST_HELP =
  "listen host; localhost binds 127.0.0.1 + ::1 only. Anything else (e.g. 0.0.0.0) exposes the unauthenticated bridge to the network";
const ORIGIN_HELP =
  "extra WebSocket Origin to accept besides devtools://devtools and none; repeatable or comma-separated (\"*\" = any)";

const program = new Command();

program
  .name("inspect-webkit")
  .description(
    "stand up a Chrome DevTools Protocol bridge backed by Safari's Web Inspector",
  )
  .addOption(new Option("-p, --port <port>", "listen port").default(9222).argParser(parsePort))
  .addOption(new Option("-H, --host <host>", HOST_HELP).default("localhost"))
  .addOption(new Option("--allow-origin <origin>", ORIGIN_HELP).argParser(collectOrigins))
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
  .showHelpAfterError()
  .action(async (opts: { port: number; host: string; allowOrigin?: string[] }) => {
    const server = await startCdpServer({
      port: opts.port,
      host: opts.host,
      allowOrigins: opts.allowOrigin,
    });
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
  .addOption(new Option("-p, --port <port>", "listen port").default(9223).argParser(parsePort))
  .addOption(new Option("-H, --host <host>", HOST_HELP).default("localhost"))
  .addOption(new Option("--allow-origin <origin>", ORIGIN_HELP).argParser(collectOrigins))
  .action(async (urls: string[], opts: { port: number; host: string; allowOrigin?: string[] }) => {
    const upstreams = urls.map((url) => ({ url }));
    const server = await startBunCdpServer({
      upstreams,
      port: opts.port,
      host: opts.host,
      allowOrigins: opts.allowOrigin,
    });
    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
    await new Promise(() => {});
  });

program.parseAsync().catch((e) => {
  if (e && (e as NodeJS.ErrnoException).code === "EADDRINUSE") {
    const port = (e as { port?: number }).port;
    let hint = "";
    if (typeof port === "number") {
      try {
        const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
        const pids = out ? Array.from(new Set(out.split(/\s+/))) : [];
        if (pids.length > 0) {
          hint = `\n  PID ${pids.join(", ")} is listening — run \`kill ${pids.join(" ")}\` to free it, or pass --port <other>.`;
        }
      } catch {}
    }
    console.error(
      `Error: port ${port ?? "?"} is already in use.${hint || "\n  Pass --port <other> to use a different port."}`,
    );
    process.exit(1);
  }
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
