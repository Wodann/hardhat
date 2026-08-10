import { shellQuote } from "./runner.ts";

/**
 * Page-fault profiling of a measured run via `perf record -e page-faults -g`.
 *
 * Every first touch of a newly committed page raises a minor fault, so a
 * call-graph sample per N faults attributes RSS *growth* to the native call
 * stacks that caused it — including allocations made through EDR's mimalloc,
 * which are invisible to malloc-interposition profilers. perf streams
 * `perf.data` to disk while the workload runs, so the profile survives an
 * OOM-killed workload by construction.
 *
 * perf stamps samples with the clock passed to `-k`; CLOCK_MONOTONIC is the
 * clock behind `process.hrtime.bigint()`, so a series' `monoStartNs` anchor
 * maps chart time windows onto `perf script --time` windows exactly (see
 * {@link perfTimeWindow}).
 */

/** One call-graph sample per this many faults ≈ one per ~4 MiB touched. */
export const DEFAULT_FAULT_PERIOD = 1000;

/**
 * Wrap a shell command so its whole process tree runs under
 * `perf record -e page-faults`. The wrapped command's exit status is the
 * workload's (perf mirrors it), so failure detection is unaffected.
 */
export function wrapWithPerf(
  command: string,
  perfDataPath: string,
  periodFaults: number,
): string {
  return (
    `perf record -e page-faults -c ${periodFaults} -g -k CLOCK_MONOTONIC ` +
    `-o ${shellQuote(perfDataPath)} -- bash -c ${shellQuote(command)}`
  );
}

/**
 * The `perf script --time <from>,<to>` argument selecting the samples of a
 * memory-series window: `monoStartNs` is the series' monotonic anchor and
 * `fromMs`/`toMs` are series times as read off a rendered chart.
 */
export function perfTimeWindow(
  monoStartNs: bigint,
  fromMs: number,
  toMs: number,
): string {
  const at = (ms: number) =>
    (Number(monoStartNs / 1000n) / 1e6 + ms / 1000).toFixed(6);

  return `${at(fromMs)},${at(toMs)}`;
}
