#!/usr/bin/env bun
// Run a fuzz target on input files under Bun (no instrumentation), printing
// time and the failure, if any. Directories are expanded.
//
//   bun fuzz/scripts/repro.ts <target> <file|dir>...

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [target, ...paths] = process.argv.slice(2);
if (!target || paths.length === 0) {
  console.error("usage: repro.ts <target> <file|dir>...");
  process.exit(2);
}
const { fuzz } = (await import(`../targets/${target}.ts`)) as { fuzz: (d: Uint8Array) => unknown };
const files = paths.flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).map((f) => join(p, f)) : [p]));
let failed = 0;
for (const f of files) {
  const t0 = performance.now();
  try {
    await fuzz(readFileSync(f));
    const ms = performance.now() - t0;
    if (ms > 500 || files.length < 20) process.stderr.write(`ok   ${ms.toFixed(0).padStart(6)} ms  ${f}\n`);
  } catch (e) {
    failed++;
    process.stderr.write(`FAIL ${(performance.now() - t0).toFixed(0).padStart(6)} ms  ${f}\n${(e as Error)?.stack ?? e}\n`);
  }
}
process.stderr.write(`${files.length - failed}/${files.length} passed\n`);
process.exit(failed ? 1 : 0);
