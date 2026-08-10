import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";

import { processLabel, type SeriesTable } from "./mem-series.ts";

/**
 * Driver side of the in-process memory sampler (inject/memory-internals.cjs).
 *
 * The runner injects the sampler into every node process of a measured
 * command through NODE_OPTIONS ({@link internalsEnv}); each process appends
 * NDJSON samples to its own file in the run's internals directory. After the
 * run — successful or not — the driver parses those files
 * ({@link readInternalsDir}) and layers them onto the /proc-sampled series
 * table as metric labels ({@link mergeInternals}), so charts show how much
 * of a process's RSS is V8 heap, JS-external allocations, and EDR's
 * mimalloc-committed native memory.
 */

export const INTERNALS_DIR_ENV = "HARDHAT_BENCH_INTERNALS_DIR";

export const SAMPLER_PATH: string = path.join(
  import.meta.dirname,
  "..",
  "inject",
  "memory-internals.cjs",
);

/**
 * The environment entries that switch the sampler on for one measured run.
 * The `--require` flag is appended to the caller's NODE_OPTIONS (double
 * quotes per NODE_OPTIONS quoting rules) so scenario-configured options are
 * preserved; the whole environment propagates to child node processes,
 * which is what samples mocha workers and subprocesses too.
 */
export function internalsEnv(
  internalsDir: string,
  baseNodeOptions: string | undefined,
): Record<string, string> {
  const requireFlag = `--require "${SAMPLER_PATH}"`;

  return {
    NODE_OPTIONS:
      baseNodeOptions === undefined || baseNodeOptions === ""
        ? requireFlag
        : `${baseNodeOptions} ${requireFlag}`,
    [INTERNALS_DIR_ENV]: internalsDir,
  };
}

/** One in-process sample; `t` is epoch ms, all values are bytes. */
export interface InternalsSample {
  t: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  edrCommit?: number;
  edrPeakCommit?: number;
}

/** The parsed NDJSON file of one sampled process. */
export interface InternalsProcess {
  pid: number;
  /** Chart label, derived from argv like the /proc sampler's labels. */
  label: string;
  samples: InternalsSample[];
  /** mimalloc `memoryReport()` snapshots (exit and optional periodic). */
  reports: Array<{ t: number; text: string }>;
}

interface MetaLine {
  meta: { pid: number; argv: string[] };
}

/**
 * Parse one process's NDJSON file. Returns undefined when the meta line is
 * missing or unparseable (nothing to label the data with). A truncated final
 * line — the process was OOM-killed mid-write — is dropped.
 */
export function parseInternalsFile(
  content: string,
): InternalsProcess | undefined {
  const lines = content.split("\n").filter((line) => line !== "");

  if (lines.length === 0) {
    return undefined;
  }

  let meta: MetaLine["meta"] | undefined;
  const samples: InternalsSample[] = [];
  const reports: Array<{ t: number; text: string }> = [];

  for (const line of lines) {
    let record: unknown;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof record !== "object" || record === null) {
      continue;
    }

    if ("meta" in record) {
      meta ??= (record as MetaLine).meta;
    } else if ("report" in record) {
      const { t, report } = record as { t: number; report: string };
      reports.push({ t, text: report });
    } else if ("rss" in record && "t" in record) {
      samples.push(record as InternalsSample);
    }
  }

  if (meta === undefined || !Array.isArray(meta.argv)) {
    return undefined;
  }

  const fallbackName =
    meta.argv.length > 0 ? path.basename(meta.argv[0]) : String(meta.pid);

  return {
    pid: meta.pid,
    label: processLabel(meta.argv, fallbackName),
    samples,
    reports,
  };
}

/** Parse every NDJSON file of a run's internals directory (missing dir: []). */
export function readInternalsDir(dir: string): InternalsProcess[] {
  let names: string[];

  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const processes: InternalsProcess[] = [];

  for (const name of names) {
    if (!name.endsWith(".ndjson")) {
      continue;
    }

    let content: string;

    try {
      content = readFileSync(path.join(dir, name), "utf-8");
    } catch {
      continue;
    }

    const parsed = parseInternalsFile(content);

    if (parsed !== undefined) {
      processes.push(parsed);
    }
  }

  return processes;
}

// A process's contribution to an axis point is its most recent sample at
// most this old; beyond it the process is treated as gone (matching the
// zero-fill convention of toSeriesTable).
const STALENESS_MS = 1000;

const METRICS: Array<{
  name: string;
  value: (sample: InternalsSample) => number | undefined;
}> = [
  { name: "v8-heap", value: (s) => s.heapUsed },
  { name: "external", value: (s) => s.external },
  { name: "edr-commit", value: (s) => s.edrCommit },
];

/**
 * Layer the in-process metrics onto a /proc series table as
 * `<label>:<metric>` lines (see the metric-label convention on
 * {@link SeriesTable}): same-label processes are summed, each internals
 * sample is aligned onto the table's time axis by
 * last-sample-at-or-before, and values are rounded to integer MB. A metric
 * line is only added when some process actually reported it (edr-commit
 * appears only for runs with a memory-stats EDR build).
 */
export function mergeInternals(
  table: SeriesTable,
  startEpochMs: number,
  processes: InternalsProcess[],
): SeriesTable {
  const byLabel = new Map<string, InternalsProcess[]>();

  for (const process of processes) {
    const group = byLabel.get(process.label) ?? [];
    group.push(process);
    byLabel.set(process.label, group);
  }

  const byProcess: Record<string, number[]> = { ...table.byProcess };

  for (const [label, group] of byLabel) {
    for (const metric of METRICS) {
      const reporting = group.filter((p) =>
        p.samples.some((s) => metric.value(s) !== undefined),
      );

      if (reporting.length === 0) {
        continue;
      }

      byProcess[`${label}:${metric.name}`] = table.tMs.map((tMs) => {
        const epoch = startEpochMs + tMs;
        let bytes = 0;

        for (const process of reporting) {
          const sample = lastSampleAtOrBefore(process.samples, epoch);

          if (sample !== undefined && epoch - sample.t <= STALENESS_MS) {
            bytes += metric.value(sample) ?? 0;
          }
        }

        return Math.round(bytes / 1048576);
      });
    }
  }

  return { tMs: table.tMs, byProcess };
}

function lastSampleAtOrBefore(
  samples: InternalsSample[],
  epoch: number,
): InternalsSample | undefined {
  let result: InternalsSample | undefined;

  for (const sample of samples) {
    if (sample.t > epoch) {
      break;
    }

    result = sample;
  }

  return result;
}
