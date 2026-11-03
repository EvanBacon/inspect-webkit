// Public API for inspect-webkit.
//
// Programmatic entry points for listing iOS Safari / WKWebView debug targets
// and bridging them to the Chrome DevTools Protocol.

import * as usbmux from "./usbmux";
import type { WebInspectorClient } from "./webinspector";
import { acquireSharedSourceManager } from "./core/source-manager";

export {
  startCdpServer,
  type CdpServerOptions,
  type CdpServer,
} from "./cdp/server";
export {
  startBunCdpServer,
  type BunCdpServerOptions,
  type BunCdpServer,
  type BunUpstream,
} from "./cdp/bun-server";
export type { Device, DeviceProperties } from "./usbmux";
export type { SourceInfo, SourceState } from "./core/source-manager";

export type Target = {
  source: "device" | "simulator";
  udid: string;
  deviceID?: number;
  appId: string;
  appName: string;
  bundleId?: string;
  pageId: number;
  title: string;
  url: string;
  type: string;
};

type TargetSource = Pick<Target, "source" | "udid" | "deviceID">;

export async function listDevices(): Promise<usbmux.Device[]> {
  return usbmux.listDevices();
}

/** How long listTargets() waits for sources that are still connecting (e.g.
 *  webinspectord_sim inside launchd's ~10 s respawn throttle). */
const LIST_TARGETS_SETTLE_MS = 15_000;
/** Keep the shared connections warm this long after listTargets() returns,
 *  so a follow-up call is instant and webinspectord doesn't idle-exit. The
 *  connections never keep the process alive on their own. */
const LIST_TARGETS_LINGER_MS = 30_000;

/**
 * Snapshot of every debuggable target on attached devices and booted
 * simulators. Shares one long-lived inspector connection per source with
 * any CDP server in the same process.
 */
export async function listTargets(): Promise<Target[]> {
  const lease = acquireSharedSourceManager();
  try {
    await lease.manager.settled(LIST_TARGETS_SETTLE_MS);
    const perSource = await Promise.all(
      lease.manager.readySources().map((src) =>
        targetsFromClient(src.wi, {
          source: src.kind,
          udid: src.udid ?? src.id,
          ...(src.deviceID !== undefined ? { deviceID: src.deviceID } : {}),
        }).catch((e) => {
          console.error(`warn: ${src.label}: ${(e as Error).message}`);
          return [] as Target[];
        }),
      ),
    );
    return perSource.flat();
  } finally {
    lease.release(LIST_TARGETS_LINGER_MS);
  }
}

async function targetsFromClient(
  client: WebInspectorClient,
  base: TargetSource,
): Promise<Target[]> {
  const apps = (await client.listApplications()).filter((a) => !a.isProxy);
  const listings = await Promise.all(apps.map((a) => client.getListing(a.appId)));
  const out: Target[] = [];
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i]!;
    for (const p of listings[i]!) {
      out.push({
        ...base,
        appId: app.appId,
        appName: app.name ?? app.bundleId ?? app.appId,
        bundleId: app.bundleId,
        pageId: p.pageId,
        title: p.title,
        url: p.url,
        type: p.type,
      });
    }
  }
  return out;
}
