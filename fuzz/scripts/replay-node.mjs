#!/usr/bin/env node
// Replay inputs against a built bundle under Node (real `ws`, so the
// WebSocket paths run too), without jazzer, and exit.
//
//   node fuzz/scripts/replay-node.mjs <target> <file|dir>...
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [target, ...paths] = process.argv.slice(2);
const { fuzz } = await import(new URL(`../dist/${target}.mjs`, import.meta.url).href);
const files = paths.flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).map((f) => join(p, f)) : [p]));
let failed = 0;
for (const f of files) {
  const t0 = performance.now();
  try {
    await fuzz(readFileSync(f));
    if (files.length < 20) process.stderr.write(`ok   ${(performance.now() - t0).toFixed(0)} ms  ${f}\n`);
  } catch (e) {
    failed++;
    process.stderr.write(`FAIL ${f}\n${e?.stack ?? e}\n`);
  }
}
process.stderr.write(`${files.length - failed}/${files.length} passed\n`);
process.exit(failed ? 1 : 0);
