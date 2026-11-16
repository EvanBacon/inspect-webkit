// Regression guard for issue #4: published .d.ts files must be consumable
// under `moduleResolution: node16/nodenext`. That requires every relative
// specifier in the declaration graph to carry an explicit `.js` extension
// (and directory imports to spell out `/index.js`). Otherwise consumers
// either get TS2834 (skipLibCheck: false) or silently see every re-exported
// symbol as `any` (skipLibCheck: true).
//
// The test:
//   1. statically scans src/** and bin/** for extensionless relative specifiers;
//   2. emits declarations with tsconfig.build.json (nodenext) into a temp dir;
//   3. scans the emitted .d.ts files for extensionless relative specifiers;
//   4. type-checks a tiny nodenext consumer against those declarations and
//      asserts that real type errors surface (i.e. the types aren't `any`).
// Hermetic: uses the repo's own typescript + @types, no network.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const TSC = join(ROOT, "node_modules/typescript/bin/tsc");

// Matches `from "x"`, `import "x"`, `import("x")`, `export * from "x"`,
// and `import x = require("x")`, capturing relative specifiers only.
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])(\.\.?\/[^"']*)\1/g;

function walk(dir: string, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") continue;
      out.push(...walk(p, filter));
    } else if (filter(p)) {
      out.push(p);
    }
  }
  return out;
}

function badSpecifiers(files: string[], base: string): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(SPECIFIER_RE)) {
      const spec = m[2]!;
      if (!/\.(?:js|mjs|cjs|json)$/.test(spec)) {
        bad.push(`${relative(base, f)}: "${spec}"`);
      }
    }
  }
  return bad;
}

function tsc(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [TSC, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

let work: string;
let dtsDir: string;
let emit: { code: number | null; out: string };

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "iw-dts-nodenext-"));
  dtsDir = join(work, "dist");
  emit = tsc(["-p", join(ROOT, "tsconfig.build.json"), "--outDir", dtsDir], ROOT);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test("source relative specifiers use explicit .js extensions", () => {
  const files = [
    ...walk(join(ROOT, "src"), (p) => /\.(?:ts|mts|cts)$/.test(p)),
    ...walk(join(ROOT, "bin"), (p) => /\.(?:ts|mts|cts)$/.test(p)),
  ];
  expect(files.length).toBeGreaterThan(0);
  expect(badSpecifiers(files, ROOT)).toEqual([]);
});

test("declarations build cleanly under nodenext (tsconfig.build.json)", () => {
  expect(emit.out).toBe("");
  expect(emit.code).toBe(0);
});

test("emitted .d.ts relative specifiers use explicit .js extensions", () => {
  const files = walk(dtsDir, (p) => p.endsWith(".d.ts"));
  expect(files.map((f) => relative(dtsDir, f))).toContain("index.d.ts");
  expect(badSpecifiers(files, dtsDir)).toEqual([]);
});

test("nodenext consumer sees real types (not any)", () => {
  const consumer = join(work, "consumer");
  const pkgDir = join(consumer, "node_modules", "inspect-webkit");
  mkdirSync(pkgDir, { recursive: true });

  // Mirror the published package's type-relevant manifest fields.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      type: pkg.type,
      types: pkg.types,
      exports: pkg.exports,
    }),
  );
  symlinkSync(dtsDir, join(pkgDir, "dist"), "dir");

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
        typeRoots: [join(ROOT, "node_modules/@types")],
      },
      files: ["repro.mts"],
    }),
  );
  writeFileSync(
    join(consumer, "repro.mts"),
    [
      `import { startCdpServer } from "inspect-webkit";`,
      `const s = await startCdpServer({ port: "9222" });`,
      `s.doesNotExist();`,
      ``,
    ].join("\n"),
  );

  const r = tsc(["-p", "."], consumer);
  const codes = [...r.out.matchAll(/error (TS\d+)/g)].map((m) => m[1]);
  // Exactly the two real errors in repro.mts; nothing from inside the package.
  expect(codes.sort()).toEqual(["TS2322", "TS2339"]);
  expect(r.out).not.toContain("node_modules/inspect-webkit");
  expect(r.code).not.toBe(0);
});
