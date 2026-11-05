// fast-check case counts: small by default (CI), FUZZ_RUNS=<n> for long runs.
export function fcRuns(ciDefault: number): number {
  return Number(process.env.FUZZ_RUNS) || ciDefault;
}

/** bun test per-test timeout: unlimited for long runs. */
export const fcTimeout = (ciMs: number): number => (process.env.FUZZ_RUNS ? 0 : ciMs);
