import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { init as e2eInit } from "../end-to-end/subcommands/init.ts";
import { exec as e2eExec } from "../end-to-end/subcommands/exec.ts";
import { loadScenario } from "../end-to-end/helpers/directory.ts";
import { resolveAndValidateArgs, type BenchArgs } from "./helpers/args.ts";
import { fmt, log, logStep, logError, logWarning } from "./helpers/log.ts";
import { computeStats, mean } from "./helpers/stats.ts";
import {
  measuredRunTable,
  runSeries,
  type Instrumentation,
  type MeasuredRun,
} from "./helpers/runner.ts";
import { procSamplingAvailable } from "./helpers/mem-series.ts";
import { DEFAULT_FAULT_PERIOD } from "./helpers/perf-faults.ts";

const USAGE = `
scripts/benchmark/main.ts — Benchmark Hardhat scenarios

DESCRIPTION
  Initializes an e2e scenario and benchmarks a command: wall-clock time
  (with the shell-spawn overhead measured up-front and subtracted, like
  hyperfine's calibration), CPU time via bash's time builtin, and — on
  Linux — a memory-over-time series sampled from /proc every 100 ms with
  the exact peak RSS (VmHWM).
  Use --use-local to detect changed packages, publish them to Verdaccio,
  and pin the scenario to those versions before benchmarking.

OPTIONS
  --scenario <path>     Scenario folder or scenario.json (required)
  --command <cmd>       Command to benchmark (default: scenario's defaultCommand)
  --init                Force (re-)initialization of the scenario even if it is
                        already set up. Without this flag, an existing scenario
                        setup is reused and only (re-)initialized on demand
  --use-local           Detect packages changed since their release tag, bump
                        versions, publish to Verdaccio, and pin scenario deps to
                        the published versions. If Verdaccio is already running,
                        publish is skipped (the existing registry contents are
                        reused) unless --force-publish is also passed.
                        Only applies when init runs
  --force-checkout      Force git checkouts even if there are uncommitted changes in the scenario working directory
  --force-publish       Force publishing to an already-running Verdaccio instance,
                        potentially overwriting its current contents.
                        Only applies when init runs
  --precompile          Run "npx hardhat compile" in the scenario before
                        benchmarking (useful for warming up compilation caches)
  --prepare <cmd>       Execute CMD unmeasured before each timing run (warmup
                        runs included). Useful for clearing disk caches or
                        resetting state between runs
  --warmup <n>          Unmeasured warmup runs before benchmarking (default: 0).
                        Useful for filling disk caches for I/O-heavy programs
  --runs <n>            Number of benchmark runs (default: 10)
  --ignore-failure      Keep going when the benchmarked command fails; the
                        failed run keeps its (partial) measurements and is
                        flagged in the report and the JSON export
  --show-output         Print stdout and stderr of the benchmarked command
  --export-json <path>  Write a hyperfine-compatible JSON report to PATH,
                        extended with each run's memory series
  --e2e-clone-dir <p>   Override clone directory (default: same as pnpm e2e)
  --env KEY=VALUE       Extra environment for the benchmarked command, on top
                        of the scenario's env map (repeatable)

MEMORY ATTRIBUTION
  These options collect per-run artifacts in <out-dir>/run-NNN/, written
  continuously while the run executes — an OOM-killed run (or driver) keeps
  everything but the sample in flight. Note that instrumentation overhead is
  included in the reported wall/CPU times: treat instrumented runs as memory
  diagnostics, not timing benchmarks.

  --out-dir <dir>       Per-run artifact directory. Alone, it streams the
                        /proc series (proc.ndjson) and writes a run.json
                        summary per run. Defaults to a temp dir when other
                        instrumentation flags are given without it
  --mem-internals       Inject an in-process sampler (NODE_OPTIONS --require)
                        into every node process of the run: V8 heap/external
                        breakdown plus EDR's mimalloc-committed memory when a
                        memory-stats EDR build is loaded (see
                        NAPI_RS_NATIVE_LIBRARY_PATH). Sample interval:
                        HARDHAT_BENCH_INTERNALS_INTERVAL_MS (default 100);
                        periodic mimalloc reports:
                        HARDHAT_BENCH_MEM_REPORT_INTERVAL_MS (default: exit
                        only). Merged into the series as <label>:<metric>
  --perf-faults         Record a page-fault profile (perf record
                        -e page-faults -g) of the whole run — RSS growth
                        attributed to native call stacks. Render with
                        pnpm bench:flamegraph <run-dir>
  --perf-faults-period <n>
                        Faults per call-graph sample (default: ${DEFAULT_FAULT_PERIOD},
                        i.e. one stack per ~4 MiB of first-touched pages)

EXAMPLES
  pnpm bench --scenario ./end-to-end/uniswap-v4-core --runs 1
  pnpm bench --scenario ./end-to-end/uniswap-v4-core --use-local --precompile
  pnpm bench --scenario ./end-to-end/openzeppelin-contracts --command "npx hardhat compile"

  # Memory attribution of a run that is expected to OOM: EDR memory-stats
  # build injected, in-process sampling, page-fault profile, artifacts kept.
  pnpm bench --scenario ./end-to-end/lidofinance-core --runs 1 \\
    --command "npx hardhat test solidity -vvvv" --ignore-failure \\
    --mem-internals --perf-faults --out-dir /tmp/lido-mem/vvvv \\
    --env NAPI_RS_NATIVE_LIBRARY_PATH=/path/to/edr.linux-x64-gnu.node \\
    --export-json /tmp/lido-mem/vvvv.json
`;

export async function runBenchmark(benchArgs: BenchArgs): Promise<void> {
  const {
    scenarioPath,
    command,
    init,
    useLocal,
    forceCheckout,
    forcePublish,
    precompile,
    prepare,
    ignoreFailure,
    showOutput,
    warmup,
    exportJson,
    e2eCloneDirectory,
    memInternals,
    perfFaults,
    perfFaultsPeriod,
    env,
  } = benchArgs;

  const scenario = loadScenario(e2eCloneDirectory, scenarioPath);

  if (scenario.definition.disabled === true) {
    logWarning(`Scenario "${scenario.id}" is disabled`);
    return;
  }

  const benchCommand = command ?? scenario.definition.defaultCommand;
  const runs = benchArgs.runs ?? 10;

  if (init || !existsSync(scenario.workingDir)) {
    logStep("Initializing scenario");
    await e2eInit(
      e2eCloneDirectory,
      scenarioPath,
      useLocal,
      forceCheckout,
      forcePublish,
    );
  }

  if (precompile) {
    logStep("Precompiling (npx hardhat compile)");
    await e2eExec(
      e2eCloneDirectory,
      scenarioPath,
      "npx hardhat compile",
      useLocal,
      forceCheckout,
      forcePublish,
    );
  }

  if (!procSamplingAvailable()) {
    logWarning(
      "/proc is not available — peak RSS and memory-over-time will not be " +
        "measured. Memory measurements require Linux.",
    );
  }

  logStep("Running benchmark");
  log(`Benchmarking: ${fmt.pkg(benchCommand)}`);
  log(`Warmup: ${warmup}, Runs: ${runs}`);

  const timingPath = path.join(
    mkdtempSync(path.join(tmpdir(), "hardhat-bench-")),
    "cpu.txt",
  );

  let outDir = benchArgs.outDir;

  if (outDir === undefined && (memInternals || perfFaults)) {
    outDir = mkdtempSync(path.join(tmpdir(), "hardhat-bench-artifacts-"));
    log(`Writing per-run artifacts to ${outDir}`);
  }

  const instrumentation: Instrumentation | undefined =
    outDir !== undefined
      ? {
          outDir,
          memInternals,
          perfFaults: perfFaults
            ? { periodFaults: perfFaultsPeriod ?? DEFAULT_FAULT_PERIOD }
            : undefined,
        }
      : undefined;

  const measured = await runSeries(benchCommand, timingPath, {
    cwd: scenario.workingDir,
    env: { ...scenario.definition.env, ...env },
    runs,
    warmup,
    prepare,
    ignoreFailure,
    showOutput,
    instrumentation,
  });

  report(measured);

  if (exportJson !== undefined) {
    writeFileSync(exportJson, buildExport(benchCommand, measured));
    log(`Report written to ${exportJson}`);
  }

  log(fmt.success("Benchmark complete"));
}

function report(measured: MeasuredRun[]): void {
  const seconds = (s: number) => `${s.toFixed(3)} s`;
  const succeeded = measured.filter((r) => r.failure === undefined);

  // Timing statistics describe successful runs only — a killed run's wall
  // time measures the kill, not the command. Peaks and series are still
  // reported for every run.
  if (succeeded.length > 0) {
    const stats = computeStats(succeeded.map((r) => r.wallSeconds));

    log(
      `  Time (mean ± σ):   ${seconds(stats.mean)} ± ${seconds(stats.stddev)}`,
    );
    log(
      `  Range (min … max): ${seconds(stats.min)} … ${seconds(stats.max)}  (${succeeded.length} runs)`,
    );
    log(
      `  CPU (user, system): ${seconds(mean(succeeded.map((r) => r.user)))}, ${seconds(mean(succeeded.map((r) => r.system)))}`,
    );
  }

  const peaks = measured
    .map((r) => r.memory?.peakRssMb)
    .filter((peak) => peak !== undefined);

  if (peaks.length === measured.length) {
    log(`  Peak RSS:          ${Math.max(...peaks)} MB`);
  }

  for (const [i, run] of measured.entries()) {
    if (run.failure === undefined) {
      continue;
    }

    const reason =
      run.failure.signal !== null
        ? `killed by ${run.failure.signal}`
        : `exited with code ${String(run.failure.exitCode)}`;
    const series =
      run.memory !== undefined
        ? ` — series kept (${run.memory.peakRssMb} MB peak)`
        : "";

    logWarning(
      `run ${i}: ${reason} after ${seconds(run.wallSeconds)}${series}`,
    );
  }
}

/**
 * Render the report in hyperfine's --export-json shape ({ times, mean,
 * stddev, min, max, median, user, system }) so downstream consumers keep
 * working, extended with each run's memory series (`memory[i]` holds the
 * i-th run's exact peak and its per-process series over a shared time axis,
 * including the in-process metric labels when --mem-internals sampled them).
 * A failed run's entry additionally carries `failed: { exitCode, signal }`;
 * its timing is excluded from the hyperfine statistics.
 */
function buildExport(command: string, measured: MeasuredRun[]): string {
  const succeeded = measured.filter((r) => r.failure === undefined);
  const timed = succeeded.length > 0 ? succeeded : measured;
  const stats = computeStats(timed.map((r) => r.wallSeconds));

  return JSON.stringify(
    {
      results: [
        {
          command,
          mean: stats.mean,
          stddev: stats.stddev,
          median: stats.median,
          user: mean(timed.map((r) => r.user)),
          system: mean(timed.map((r) => r.system)),
          min: stats.min,
          max: stats.max,
          times: stats.times,
          memory: measured.map((r) =>
            r.memory !== undefined
              ? {
                  peakRssMb: r.memory.peakRssMb,
                  ...measuredRunTable(r),
                  ...(r.failure !== undefined ? { failed: r.failure } : {}),
                }
              : null,
          ),
        },
      ],
    },
    null,
    2,
  );
}

async function cliMain(): Promise<void> {
  const benchArgs = resolveAndValidateArgs(process.argv.slice(2));

  if (benchArgs === undefined) {
    console.log(USAGE);
    return;
  }

  try {
    await runBenchmark(benchArgs);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    logError(error.message);
    process.exit(1);
  }
}

if (import.meta.main) {
  await cliMain();
}
