// USB / Wi-Fi device discovery through usbmuxd.
//
// ListDevices for the initial set, then a long-lived Listen connection for
// hot-plug Attached / Detached notifications (re-established with backoff
// if usbmuxd restarts). usbmuxd reports one entry per connection type, so a
// device on USB and Wi-Fi at once shows up twice: entries are grouped by
// UDID and USB is preferred (review #13).

import * as usbmux from "../usbmux";
import { LockdownClient } from "../lockdown";
import { WebInspectorClient } from "../webinspector";
import type { SourceDescriptor, SourceDiscovery } from "./source-manager";

export type DeviceDiscoveryOptions = {
  socketPath?: string;
  /** Deadline per usbmuxd request. */
  requestTimeoutMs?: number;
  /** Delay before re-trying a failed / dropped usbmuxd connection. */
  retryMs?: number;
  /** Cap for the retry delay (doubles per consecutive failure). */
  retryMaxMs?: number;
};

const debug = (...args: unknown[]) => {
  if (process.env.INSPECT_WEBKIT_DEBUG) console.error("[device-discovery]", ...args);
};

/** Group key: some tools report UDIDs with/without the dash. */
const udidKey = (udid: string) => udid.replace(/-/g, "").toUpperCase();

/**
 * Open the WebInspector service on a device: pair record → lockdown
 * (QueryType, StartSession + TLS) → StartService com.apple.webinspector →
 * service tunnel (+TLS). Every socket opened along the way is destroyed if
 * a later step fails or `signal` aborts (timeouts, shutdown).
 */
export async function openDeviceWebInspector(
  device: usbmux.Device,
  signal?: AbortSignal,
): Promise<{ wi: WebInspectorClient; lockdown: LockdownClient }> {
  let lockdown: LockdownClient | null = null;
  try {
    const pair = await usbmux.readPairRecord(device.Properties.SerialNumber, { signal });
    lockdown = await LockdownClient.open(device, pair, signal);
    await lockdown.startSession();
    const svc = await lockdown.startService("com.apple.webinspector");
    const { socket, stream } = await lockdown.connectService(svc);
    if (signal?.aborted) {
      socket.destroy();
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    }
    return { wi: new WebInspectorClient(socket, stream), lockdown };
  } catch (e) {
    lockdown?.close();
    throw e;
  }
}

export class DeviceDiscovery implements SourceDiscovery {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private onChange: ((d: SourceDescriptor[]) => void) | null = null;
  /** usbmux DeviceID → device entry. */
  private devices = new Map<number, usbmux.Device>();
  private listener: { close(): void } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = false;
  private lastSignature: string | null = null;
  private readonly requestTimeoutMs: number;
  private readonly retryMs: number;
  private readonly retryMaxMs: number;

  constructor(private opts: DeviceDiscoveryOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? usbmux.USBMUX_TIMEOUT_MS;
    this.retryMs = opts.retryMs ?? 2_000;
    this.retryMaxMs = opts.retryMaxMs ?? 30_000;
    this.ready = new Promise((r) => (this.resolveReady = r));
  }

  start(onChange: (d: SourceDescriptor[]) => void): void {
    this.onChange = onChange;
    void this.connect();
  }

  refresh(): void {
    // Listen pushes changes; nothing to poll. A dropped device source
    // reconnects through the manager's backoff until Detached arrives.
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.listener?.close();
    this.listener = null;
    this.onChange = null;
    this.resolveReady();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const usbOpts = { socketPath: this.opts.socketPath, timeoutMs: this.requestTimeoutMs };
    try {
      // Snapshot first, so `ready` means "initial devices known".
      const list = await usbmux.listDevices(usbOpts);
      if (this.stopped) return;
      this.devices.clear();
      for (const d of list) if (isDevice(d)) this.devices.set(d.DeviceID, d);
      this.publish();
      this.resolveReady();
      const l = await usbmux.listen((e) => this.onEvent(e), usbOpts);
      if (this.stopped) return l.close();
      this.listener = l;
      this.failures = 0;
      l.unref();
      await l.done;
      this.listener = null;
      debug("usbmuxd Listen connection ended; re-syncing");
    } catch (e) {
      // No usbmuxd (Linux CI, sandbox) or it's wedged: no devices, retry later.
      debug(`usbmuxd unavailable: ${(e as Error)?.message ?? e}`);
      this.resolveReady();
    }
    if (this.stopped) return;
    const delay = Math.min(this.retryMaxMs, this.retryMs * 2 ** Math.min(this.failures++, 10));
    this.retryTimer = setTimeout(() => void this.connect(), delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private onEvent(e: usbmux.UsbmuxEvent): void {
    if (e.MessageType === "Attached" && typeof e.DeviceID === "number" && e.Properties) {
      const d = { DeviceID: e.DeviceID, Properties: { ...e.Properties, DeviceID: e.DeviceID } };
      if (!isDevice(d)) return;
      this.devices.set(d.DeviceID, d);
      this.publish();
    } else if (e.MessageType === "Detached" && typeof e.DeviceID === "number") {
      if (this.devices.delete(e.DeviceID)) this.publish();
    }
  }

  private publish(): void {
    // One source per UDID; prefer USB over Network.
    const byUdid = new Map<string, usbmux.Device>();
    for (const d of this.devices.values()) {
      const k = udidKey(d.Properties.SerialNumber);
      const cur = byUdid.get(k);
      if (!cur || (cur.Properties.ConnectionType !== "USB" && d.Properties.ConnectionType === "USB")) {
        byUdid.set(k, d);
      }
    }
    const descs = [...byUdid.values()].map((d) => this.descriptor(d));
    const sig = descs.map((d) => `${d.id}@${d.endpoint}`).sort().join(",");
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    debug(`devices: ${sig || "none"}`);
    this.onChange?.(descs);
  }

  private descriptor(d: usbmux.Device): SourceDescriptor {
    const udid = d.Properties.SerialNumber;
    return {
      id: `device:${udid}`,
      kind: "device",
      udid,
      deviceID: d.DeviceID,
      label: `device:${udid.slice(0, 8)}`,
      endpoint: `${d.Properties.ConnectionType}:${d.DeviceID}`,
      open: (signal) => openDeviceWebInspector(d, signal),
    };
  }
}

function isDevice(d: unknown): d is usbmux.Device {
  const x = d as usbmux.Device;
  return (
    !!x &&
    typeof x.DeviceID === "number" &&
    !!x.Properties &&
    typeof x.Properties.SerialNumber === "string" &&
    x.Properties.SerialNumber.length > 0
  );
}
