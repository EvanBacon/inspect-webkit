// Smoke test: list devices, attempt to read a pair record for the first one.
import { listDevices, readPairRecord } from "./usbmux";

const devs = await listDevices();
console.log(`devices: ${devs.length}`);
for (const d of devs) {
  console.log(
    `  id=${d.DeviceID} udid=${d.Properties.SerialNumber} via=${d.Properties.ConnectionType}`,
  );
}
if (devs.length > 0) {
  const d = devs[0]!;
  try {
    const rec = await readPairRecord(d.Properties.SerialNumber);
    console.log(`pair record ok: HostID=${rec.HostID} SystemBUID=${rec.SystemBUID}`);
    console.log(`  HostCertificate: ${rec.HostCertificate.length} bytes`);
    console.log(`  HostPrivateKey: ${rec.HostPrivateKey.length} bytes`);
    console.log(`  RootCertificate: ${rec.RootCertificate.length} bytes`);
  } catch (e) {
    console.error("pair record err:", (e as Error).message);
  }
}
