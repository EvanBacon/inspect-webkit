// WebKit gives a page to one inspector connection at a time and keeps the
// first one. While Safari's Web Inspector (or another bridge) holds a page,
// a CDP client attached through this bridge gets no replies at all — no
// error, no close. The listing says who holds the page, so the bridge warns
// on attach instead of leaving the user staring at an empty DevTools.

import { test, expect, afterEach, spyOn } from "bun:test";
import { startCdpServer } from "../server";
import { freePort, makeFakeWir, seedApp, sendListing, waitUntil } from "../../__tests__/helpers/fake-wir";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

async function attachWith(connectionId: (ours: string) => string | undefined): Promise<string[]> {
  const port = await freePort();
  const wir = makeFakeWir();
  const server = await startCdpServer({
    port,
    openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: wir.wi }],
  });
  cleanups.push(() => server.stop());
  seedApp(wir, [{ id: 1 }]);
  await waitUntil(() => server.getTargets().length === 1);
  const id = connectionId(wir.wi.connection);
  if (id) sendListing(wir, "PID:1", [{ id: 1, connectionId: id }]);
  await waitUntil(() => server.getTargets()[0]?.inUseByOtherInspector === (id !== undefined && id !== wir.wi.connection));

  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => errors.mockRestore());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/sim:fake:PID:1:1`);
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  await waitUntil(() => errors.mock.calls.some((c) => String(c[0]).includes("devtools attached")));
  return errors.mock.calls.map((c) => String(c[0]));
}

test("attaching to a page another inspector holds logs a warning", async () => {
  const lines = await attachWith(() => "SAFARI-WEB-INSPECTOR-CONNECTION");
  expect(lines.some((l) => /another inspector/i.test(l) && /Safari/.test(l))).toBe(true);
});

test("no warning for a free page", async () => {
  const lines = await attachWith(() => undefined);
  expect(lines.some((l) => /another inspector/i.test(l))).toBe(false);
});

test("no warning when the holder is this bridge's own connection", async () => {
  const lines = await attachWith((ours) => ours);
  expect(lines.some((l) => /another inspector/i.test(l))).toBe(false);
});

test("a listing that shows a foreign holder after attach warns once", async () => {
  const port = await freePort();
  const wir = makeFakeWir();
  const server = await startCdpServer({
    port,
    openSources: async () => [{ kind: "simulator", id: "sim:fake", label: "sim:fake", wi: wir.wi }],
  });
  cleanups.push(() => server.stop());
  seedApp(wir, [{ id: 1 }]);
  await waitUntil(() => server.getTargets().length === 1);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => errors.mockRestore());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/sim:fake:PID:1:1`);
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
  const warnings = () => errors.mock.calls.filter((c) => /another inspector/i.test(String(c[0]))).length;

  sendListing(wir, "PID:1", [{ id: 1, connectionId: "OTHER" }]);
  await waitUntil(() => warnings() > 0);
  sendListing(wir, "PID:1", [{ id: 1, connectionId: "OTHER" }]);
  await Bun.sleep(50);
  expect(warnings()).toBe(1);
});
