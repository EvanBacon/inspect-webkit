// Public listTargets(): reuses one shared, long-lived SourceManager so
// repeated calls don't reconnect (which made webinspectord_sim idle-exit and
// the next call hit the ~10 s launchd respawn throttle, R10), and waits for a
// throttled daemon instead of silently returning [].

import { test, expect, afterEach } from "bun:test";
import { listTargets } from "../index";
import { SourceManager, setSharedSourceManagerFactory, type SourceDescriptor } from "../core/source-manager";
import { makeFakeDaemon } from "./helpers/fake-wir";

afterEach(() => setSharedSourceManagerFactory(null));

function install(replyDelayMs: number) {
  const daemons: ReturnType<typeof makeFakeDaemon>[] = [];
  const desc: SourceDescriptor = {
    id: "sim:UDID-1",
    kind: "simulator",
    udid: "UDID-1",
    label: "iPhone",
    endpoint: "/tmp/x",
    async open() {
      const d = makeFakeDaemon({ replyDelayMs, pages: [{ id: 3, url: "https://example.com/", title: "Ex" }] });
      daemons.push(d);
      return { wi: d.wi };
    },
  };
  setSharedSourceManagerFactory(
    () =>
      new SourceManager({
        discoveries: [{ ready: Promise.resolve(), start: (cb) => cb([desc]), refresh() {}, stop() {} }],
      }),
  );
  return daemons;
}

test("listTargets() waits out a respawn-throttled daemon instead of returning [] (R10)", async () => {
  install(500);
  const t0 = Date.now();
  const targets = await listTargets();
  expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({
    source: "simulator",
    udid: "UDID-1",
    appId: "PID:1",
    pageId: 3,
    url: "https://example.com/",
    title: "Ex",
  });
});

test("repeated listTargets() calls reuse one long-lived connection (R10)", async () => {
  const daemons = install(0);
  await listTargets();
  await listTargets();
  await listTargets();
  expect(daemons.length).toBe(1);
  expect(daemons[0]!.sock.destroyed).toBe(false);
});
