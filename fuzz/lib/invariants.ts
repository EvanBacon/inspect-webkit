// Invariants shared by every harness: no prototype pollution, no unhandled
// rejection / uncaught exception escaping the code under test, and quiet
// logging (the bridge logs handled errors to stderr; at 10k execs/s that
// would drown the fuzzer, so they are counted instead — see softFindings).

import { writeFileSync } from "node:fs";

export class InvariantError extends Error {
  override name = "InvariantError";
}

export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new InvariantError(msg);
}

const PROTOS: Array<[string, object]> = [
  ["Object.prototype", Object.prototype],
  ["Array.prototype", Array.prototype],
  ["Function.prototype", Function.prototype],
  ["String.prototype", String.prototype],
];
const baseline = new Map(PROTOS.map(([n, p]) => [n, new Set(Reflect.ownKeys(p))]));

/** Throws if any well-known prototype gained a property. */
export function checkNoPollution(): void {
  for (const [name, proto] of PROTOS) {
    const known = baseline.get(name)!;
    for (const k of Reflect.ownKeys(proto)) {
      if (!known.has(k)) {
        const key = String(k);
        delete (proto as any)[k];
        throw new InvariantError(`prototype pollution: ${name}.${key}`);
      }
    }
  }
}

// --- escaped async errors -------------------------------------------------

const escaped: unknown[] = [];
let installed = false;

/** Record unhandled rejections / uncaught exceptions instead of crashing,
 *  so the harness can attribute them to the current input. */
export function trackEscapes(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (e) => escaped.push(e));
  process.on("uncaughtException", (e) => escaped.push(e));
}

export function checkNoEscapes(): void {
  if (escaped.length === 0) return;
  const e = escaped.splice(0)[0];
  const err = new InvariantError(`escaped error: ${(e as Error)?.stack ?? String(e)}`);
  throw err;
}

// --- logging ----------------------------------------------------------------

/** Handled-error log lines, normalised (numbers/ids stripped) → count. */
export const softFindings = new Map<string, number>();
let quieted = false;

/** Swallow console output from the code under test, counting the lines that
 *  report a handled error ("threw", "failed", "error"). Returns a restore
 *  function (bun test shares one console between test files). */
export function quietConsole(): () => void {
  if (quieted || process.env.FUZZ_VERBOSE) return () => {};
  quieted = true;
  const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug };
  const note = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : (a as Error)?.message ?? String(a))).join(" ");
    if (!/threw|failed|error/i.test(line)) return;
    const key = line
      .replace(/\d+/g, "N")
      .replace(/"[^"]*"/g, '"…"')
      .slice(0, 160);
    softFindings.set(key, (softFindings.get(key) ?? 0) + 1);
  };
  console.error = note;
  console.warn = note;
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  const out = process.env.FUZZ_SOFT_LOG;
  if (out) {
    const dump = () => {
      try {
        const rows = [...softFindings].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}\t${k}`);
        writeFileSync(out, rows.join("\n") + "\n");
      } catch {}
    };
    setInterval(dump, 30_000).unref();
    process.on("exit", dump);
  }
  return () => {
    Object.assign(console, saved);
    quieted = false;
  };
}

/** Let queued microtasks and `rounds` macrotask turns run. */
export async function settle(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** Common preamble for each harness. Under `bun test` (FUZZ_IN_TEST=1)
 *  escaped errors are left to the test runner, which fails on them anyway. */
export function setupHarness(): void {
  if (!process.env.FUZZ_IN_TEST) trackEscapes();
  restoreConsole = quietConsole();
}

/** Undo quietConsole() (bun test shares one console between files). */
export let restoreConsole = (): void => {};

/** Common postamble: pollution + escaped errors. */
export function checkGlobal(): void {
  checkNoPollution();
  checkNoEscapes();
}

// --- known-crash filter ------------------------------------------------------

/** A stable signature for a failure: error name + message shape + first
 *  frame inside src/ (or the harness). */
export function signature(e: unknown): string {
  const err = e as Error;
  const msg = String(err?.message ?? e)
    .split("\n")[0]!
    .replace(/\d+/g, "N")
    .replace(/"[^"]*"/g, '"…"')
    .slice(0, 120);
  const frame =
    String(err?.stack ?? "")
      .split("\n")
      .slice(1)
      .find((l) => /src\/|fuzz\/lib\/|fuzz\/targets\//.test(l)) ?? "";
  const where = /([\w-]+\.ts):(\d+)/.exec(frame);
  return `${err?.name ?? "Error"}: ${msg}${where ? ` @ ${where[1]}:${where[2]}` : ""}`;
}

const ignored = (process.env.FUZZ_IGNORE ?? "")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

/** Wrap a target so failures whose signature is listed in FUZZ_IGNORE
 *  (one per line, substring match) are swallowed: a known, recorded bug
 *  shouldn't stop the campaign from finding the next one. */
export function harness<T extends (data: Uint8Array) => unknown>(fn: T): (data: Uint8Array) => unknown {
  const onError = (e: unknown) => {
    const sig = signature(e);
    if (ignored.some((i) => sig.includes(i))) return;
    // run.ts keys crash dedup on this line.
    process.stderr.write(`\nFUZZ-SIGNATURE: ${sig}\n${(e as Error)?.stack ?? String(e)}\n`);
    throw e;
  };
  return (data) => {
    try {
      const r = fn(data);
      return r instanceof Promise ? r.catch(onError) : r;
    } catch (e) {
      onError(e);
    }
  };
}
