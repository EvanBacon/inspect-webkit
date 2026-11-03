#!/usr/bin/env bun
// Run one jazzer.js target for a wall-clock budget, restarting after each
// crash with that crash's signature added to FUZZ_IGNORE, and write a
// summary (execs, coverage, CPU time, crashes) as JSON.
//
//   bun fuzz/scripts/run.ts <target> [--minutes 60] [--round r1]
//        [--corpus DIR] [--logs DIR] [--artifacts DIR]
//
// Defaults keep everything large outside the repo: the working corpus in
// ../p2/corpus/work/<target>, logs in ../p2/fuzz-logs, crash/timeout
// artifacts in ../p2/fuzz-artifacts/<target>. The committed seeds
// (fuzz/seeds/<target>) are read-only inputs.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const target = args[0];
if (!target) {
  console.error("usage: run.ts <target> [--minutes N] [--round NAME]");
  process.exit(2);
}
const opt = (n: string, d: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1]! : d;
};
const fuzzDir = new URL("..", import.meta.url).pathname;
const audit = resolve(fuzzDir, "../..");
const minutes = Number(opt("--minutes", "60"));
const round = opt("--round", "r1");
const corpus = resolve(opt("--corpus", join(audit, "p2/corpus/work", target)));
const logs = resolve(opt("--logs", join(audit, "p2/fuzz-logs")));
const artifacts = resolve(opt("--artifacts", join(audit, "p2/fuzz-artifacts", target)));
for (const d of [corpus, logs, artifacts]) mkdirSync(d, { recursive: true });

const SETTINGS: Record<string, { sync?: boolean; maxLen: number; dict?: string }> = {
  "plist-bplist": { sync: true, maxLen: 65536 },
  "plist-xml": { sync: true, maxLen: 65536, dict: "plist-xml.dict" },
  framing: { maxLen: 65536 },
  "cdp-tools": { maxLen: 32768, dict: "cdp.dict" },
  "wir-server": { maxLen: 32768, dict: "wir.dict" },
  "front-door": { maxLen: 4096, dict: "http.dict" },
  "page-channel": { maxLen: 16384, dict: "cdp.dict" },
};
const s = SETTINGS[target];
if (!s) throw new Error(`no settings for ${target}`);
const bundle = join(fuzzDir, "dist", `${target}.mjs`);
if (!existsSync(bundle)) throw new Error(`${bundle} missing: run bun fuzz/scripts/build.ts first`);
const seeds = join(fuzzDir, "seeds", target);
// The full captured corpus (corpus-from-capture.ts output), when present.
const captured = join(audit, "p2/corpus", target);
const log = join(logs, `${target}-${round}.log`);
const jazzer = join(fuzzDir, "node_modules/.bin/jazzer");

const ignore: string[] = (process.env.FUZZ_IGNORE ?? "").split("\n").filter(Boolean);
const crashes: Array<{ kind: string; signature: string; artifact: string; at: string }> = [];
let execs = 0;
let cpuMs = 0;
let cov = 0;
let ft = 0;
const t0 = Date.now();
const deadline = t0 + minutes * 60_000;

while (Date.now() < deadline - 20_000) {
  const remaining = Math.floor((deadline - Date.now()) / 1000);
  const cmd = [
    jazzer,
    bundle,
    corpus,
    ...[seeds, captured].filter((d) => existsSync(d)),
    ...(s.sync ? ["--sync"] : []),
    "--timeout=10000",
    "--disableBugDetectors=command-injection",
    "--disableBugDetectors=path-traversal",
    "--",
    `-max_total_time=${remaining}`,
    `-max_len=${s.maxLen}`,
    "-rss_limit_mb=3072",
    "-timeout=15",
    "-print_final_stats=1",
    "-reload=60",
    `-artifact_prefix=${artifacts}/`,
    ...(s.dict ? [`-dict=${join(fuzzDir, "dict", s.dict)}`] : []),
  ];
  appendFileSync(log, `\n=== ${new Date().toISOString()} ${cmd.join(" ")}\n`);
  const proc = Bun.spawn(cmd, {
    cwd: fuzzDir,
    env: { ...process.env, FUZZ_IGNORE: ignore.join("\n"), FUZZ_SOFT_LOG: join(logs, `${target}-${round}.soft.txt`) },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Stateful targets keep timers alive (the server's refresh interval):
  // jazzer stops fuzzing at max_total_time but Node may not exit by itself.
  const killer = setTimeout(() => proc.kill(), (remaining + 90) * 1000);
  let tail = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const c of stream) {
      const text = dec.decode(c);
      appendFileSync(log, text);
      tail = (tail + text).slice(-20_000);
      for (const m of text.matchAll(/cov: (\d+) ft: (\d+)/g)) {
        cov = Math.max(cov, Number(m[1]));
        ft = Math.max(ft, Number(m[2]));
      }
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
  clearTimeout(killer);
  const finished = /Done \d+ runs in/.test(tail);
  const ru = proc.resourceUsage();
  if (ru) cpuMs += Number(ru.cpuTime.user + ru.cpuTime.system) / 1000;
  const runs = /stat::number_of_executed_units: (\d+)/.exec(tail) ?? /Done (\d+) runs/.exec(tail);
  execs += runs ? Number(runs[1]) : 0;
  const artifact = /Test unit written to (\S+)/.exec(tail)?.[1];
  if (!artifact) {
    if (proc.exitCode !== 0) appendFileSync(log, `\n=== jazzer exited ${proc.exitCode} without an artifact\n`);
    if (proc.exitCode !== 0 && Date.now() < deadline - 20_000) await Bun.sleep(2000);
    if (proc.exitCode === 0 || finished) break;
    continue;
  }
  const kind = /\/(crash|timeout|oom|slow-unit|leak)-/.exec(artifact)?.[1] ?? "crash";
  // The first error line jazzer prints for the failing input.
  const errLine =
    /==\d+== Uncaught Exception: ([^\n]+)/.exec(tail)?.[1] ??
    /(InvariantError: [^\n]+)/.exec(tail)?.[1] ??
    /==\d+== ERROR: ([^\n]+)/.exec(tail)?.[1] ??
    kind;
  const sigLine = /FUZZ-SIGNATURE: ([^\n]+)/.exec(tail)?.[1] ?? errLine.slice(0, 160);
  crashes.push({ kind, signature: sigLine, artifact, at: new Date().toISOString() });
  appendFileSync(log, `\n=== recorded ${kind}: ${sigLine}\n`);
  if (kind === "timeout" || kind === "oom") {
    // Not attributable to a signature; keep going (libFuzzer won't re-add the same unit).
    continue;
  }
  ignore.push(sigLine.replace(/^Error: /, ""));
}

const summary = {
  target,
  round,
  wallMinutes: +((Date.now() - t0) / 60_000).toFixed(1),
  cpuMinutes: +(cpuMs / 60_000).toFixed(1),
  execs,
  cov,
  ft,
  crashes,
};
writeFileSync(join(logs, `${target}-${round}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
