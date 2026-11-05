// bplist00 decoder: only PlistError, limits respected, XML round trip.
import { checkGlobal, harness, setupHarness } from "../lib/invariants";
import { checkPlist } from "../lib/plist-check";

setupHarness();
const MAGIC = Buffer.from("bplist00");

function run(data: Uint8Array): void {
  // Most mutations keep the magic; give the rest a chance to reach the trailer logic.
  const buf = Buffer.from(data.subarray(0, 8)).equals(MAGIC) ? data : Buffer.concat([MAGIC, data]);
  checkPlist(buf, "binary");
  checkGlobal();
}

export const fuzz = harness(run);
