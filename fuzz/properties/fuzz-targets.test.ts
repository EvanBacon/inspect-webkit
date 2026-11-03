// The fuzz targets as fast-check properties, so `bun test` exercises every
// harness and its invariants without jazzer:
//   - each committed seed (fuzz/seeds/<target>) and regression input
//     (fuzz/regressions/<target>) must pass;
//   - random inputs: raw bytes, and mutations of the seeds.
//
// Bounded for CI. For long runs: FUZZ_RUNS=100000 bun test fuzz/properties
// (see fuzz/README.md). Under Bun the WebSocket-accept paths of the server
// harnesses are skipped (Bun's `ws` shim needs a real socket); jazzer runs
// them under Node.

import { test, expect, afterAll } from "bun:test";
import fc from "fast-check";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.FUZZ_IN_TEST = "1";
const { restoreConsole } = await import("../lib/invariants");

const ROOT = join(import.meta.dir, "..");
const RUNS = Number(process.env.FUZZ_RUNS) || 0;
const TIMEOUT = RUNS ? 0 : 60_000;

// Per-target CI budget: cheap codec targets get more cases.
const TARGETS: Array<[string, number]> = [
  ["plist-bplist", 3000],
  ["plist-xml", 3000],
  ["framing", 1000],
  ["cdp-tools", 150],
  ["page-channel", 100],
  ["wir-server", 100],
  ["front-door", 150],
  ["browser-endpoint", 300],
];

afterAll(() => restoreConsole());

function files(dir: string): Uint8Array[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .map((f) => new Uint8Array(readFileSync(join(dir, f))));
}

/** Byte-level mutations of a seed: flips, splices, truncation, insertion. */
function mutated(seeds: Uint8Array[]): fc.Arbitrary<Uint8Array> {
  return fc
    .tuple(fc.constantFrom(...seeds), fc.array(fc.tuple(fc.nat(), fc.nat(255), fc.nat(3)), { maxLength: 8 }), fc.uint8Array({ maxLength: 16 }))
    .map(([seed, edits, insert]) => {
      let b = Buffer.from(seed);
      for (const [pos, val, kind] of edits) {
        const at = b.length ? pos % b.length : 0;
        if (kind === 0 && b.length) b[at] = val;
        else if (kind === 1) b = Buffer.concat([b.subarray(0, at), insert, b.subarray(at)]);
        else if (kind === 2) b = b.subarray(0, at);
        else b = Buffer.concat([b.subarray(0, at), b.subarray(at + (val % 16))]);
      }
      return new Uint8Array(b);
    });
}

for (const [target, ciRuns] of TARGETS) {
  const seeds = files(join(ROOT, "seeds", target));
  const regressions = files(join(ROOT, "regressions", target));
  const load = async () => ((await import(`../targets/${target}.ts`)) as { fuzz: (d: Uint8Array) => unknown }).fuzz;

  test(`${target}: committed seeds and regressions pass`, async () => {
    const fuzz = await load();
    expect(seeds.length).toBeGreaterThan(0);
    for (const s of [...seeds, ...regressions]) await fuzz(s);
  }, TIMEOUT);

  test(`${target}: random and mutated inputs keep the invariants`, async () => {
    const fuzz = await load();
    const arb = seeds.length ? fc.oneof(fc.uint8Array({ maxLength: 2048 }), mutated(seeds), mutated(seeds)) : fc.uint8Array({ maxLength: 2048 });
    await fc.assert(
      fc.asyncProperty(arb, async (d) => {
        await fuzz(d);
      }),
      { numRuns: RUNS || ciRuns, endOnFailure: true },
    );
  }, TIMEOUT);
}
