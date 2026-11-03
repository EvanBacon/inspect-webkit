#!/usr/bin/env bun
// Bundle each fuzz target (harness + the library code it exercises + ws) into
// one ES module under fuzz/dist/ for jazzer.js, which runs on Node and
// instruments the bundle at load time.
//
//   bun fuzz/scripts/build.ts [target...]

import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const all = readdirSync(join(root, "targets"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.slice(0, -3));
const wanted = process.argv.slice(2);
const targets = wanted.length ? all.filter((t) => wanted.includes(t)) : all;
if (wanted.length && targets.length !== wanted.length) {
  console.error(`unknown target(s); have: ${all.join(", ")}`);
  process.exit(2);
}
for (const t of targets) {
  const r = await Bun.build({
    entrypoints: [join(root, "targets", `${t}.ts`)],
    target: "node",
    format: "esm",
    outdir: join(root, "dist"),
    naming: `${t}.mjs`,
    sourcemap: "inline",
    // Optional native addons of `ws`; the JS fallbacks are what we want.
    external: ["bufferutil", "utf-8-validate"],
  });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
  console.log(`built dist/${t}.mjs`);
}
