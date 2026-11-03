// XML plist decoder: only PlistError, limits respected, encode round trip.
import { checkGlobal, harness, setupHarness } from "../lib/invariants";
import { checkPlist } from "../lib/plist-check";

setupHarness();

function run(data: Uint8Array): void {
  checkPlist(data, "xml");
  checkGlobal();
}

export const fuzz = harness(run);
