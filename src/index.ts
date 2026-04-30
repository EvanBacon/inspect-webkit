// Public API for inspect-webkit.
//
// Programmatic entry points for listing iOS Safari / WKWebView debug targets
// and bridging them to the Chrome DevTools Protocol.

import * as usbmux from "./usbmux";
import * as sim from "./sim";
import { LockdownClient } from "./lockdown";
import { WebInspectorClient } from "./webinspector";

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

export async function listTargets(): Promise<Target[]> {
  const [deviceTargets, simulatorTargets] = await Promise.all([
    listDeviceTargets(),
    listSimulatorTargets(),
  ]);
  return [...deviceTargets.flat(), ...simulatorTargets.flat()];
}

async function listDeviceTargets(): Promise<Target[][]> {
  const devices = await listDevices();
  return Promise.all(devices.map(targetsForDevice));
}

async function listSimulatorTargets(): Promise<Target[][]> {
  const runtimes = await sim.findSimulatorSockets();
  return Promise.all(runtimes.map(targetsForSimulator));
}

async function targetsForDevice(d: usbmux.Device): Promise<Target[]> {
  let session: { client: WebInspectorClient; lockdown: LockdownClient } | null = null;
  try {
    session = await openDeviceWebInspector(d);
    return await targetsFromClient(session.client, {
      source: "device",
      udid: d.Properties.SerialNumber,
      deviceID: d.DeviceID,
    });
  } catch (e) {
    console.error(`warn: ${d.Properties.SerialNumber}: ${(e as Error).message}`);
    return [];
  } finally {
    session?.client.close();
    session?.lockdown.close();
  }
}

async function targetsForSimulator(r: sim.SimRuntime): Promise<Target[]> {
  let client: WebInspectorClient | null = null;
  try {
    const { socket, stream } = await sim.connectSimulator(r.socketPath);
    client = new WebInspectorClient(socket, stream);
    await client.reportIdentifier();
    return await targetsFromClient(client, {
      source: "simulator",
      udid: `sim:${r.pid}`,
    });
  } catch (e) {
    console.error(`warn: simulator (${r.socketPath}): ${(e as Error).message}`);
    return [];
  } finally {
    client?.close();
  }
}

async function openDeviceWebInspector(
  device: usbmux.Device,
): Promise<{ client: WebInspectorClient; lockdown: LockdownClient }> {
  const pair = await usbmux.readPairRecord(device.Properties.SerialNumber);
  const lockdown = await LockdownClient.open(device, pair);
  await lockdown.startSession();
  const svc = await lockdown.startService("com.apple.webinspector");
  const { socket, stream } = await lockdown.connectService(svc);
  const client = new WebInspectorClient(socket, stream);
  await client.reportIdentifier();
  return { client, lockdown };
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
