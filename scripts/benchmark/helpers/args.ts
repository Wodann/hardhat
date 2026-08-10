import { log } from "node:console";
import { normalizeScenarioPath } from "../../end-to-end/helpers/directory.ts";
import { DEFAULT_CLONE_DIR } from "../../end-to-end/helpers/args.ts";
import {
  ForceCheckout,
  ForcePublish,
  UseLocal,
} from "../../end-to-end/subcommands/init.ts";

export interface BenchArgs {
  scenarioPath: string;
  command: string | undefined;
  init: boolean;
  useLocal: UseLocal;
  forceCheckout: ForceCheckout;
  forcePublish: ForcePublish;
  precompile: boolean;
  prepare: string | undefined;
  ignoreFailure: boolean;
  showOutput: boolean;
  warmup: number;
  runs: number | undefined;
  exportJson: string | undefined;
  e2eCloneDirectory: string;
  outDir: string | undefined;
  memInternals: boolean;
  perfFaults: boolean;
  perfFaultsPeriod: number | undefined;
  env: Record<string, string>;
}

export function resolveAndValidateArgs(args: string[]): BenchArgs | undefined {
  const scenarioPathRaw =
    getArgValue(args, "--scenario") ?? process.env.E2E_SCENARIO;

  if (scenarioPathRaw === undefined) {
    return undefined;
  }

  const scenarioPath = normalizeScenarioPath(scenarioPathRaw);
  const command = getArgValue(args, "--command");
  const init = args.includes("--init");
  const useLocal = args.includes("--use-local") ? UseLocal.Yes : UseLocal.No;

  const forceCheckout = args.includes("--force-checkout")
    ? ForceCheckout.Yes
    : ForceCheckout.No;

  const forcePublish = args.includes("--force-publish")
    ? ForcePublish.Yes
    : ForcePublish.No;

  const precompile = args.includes("--precompile");
  const prepare = getArgValue(args, "--prepare");
  const ignoreFailure = args.includes("--ignore-failure");
  const showOutput = args.includes("--show-output");

  const warmupRaw = getArgValue(args, "--warmup");
  const warmup = warmupRaw !== undefined ? parseInt(warmupRaw, 10) : 0;

  if (warmupRaw !== undefined && (isNaN(warmup) || warmup < 0)) {
    throw new Error("--warmup must be a non-negative integer");
  }

  const runsRaw = getArgValue(args, "--runs");
  const runs = runsRaw !== undefined ? parseInt(runsRaw, 10) : undefined;

  if (
    runsRaw !== undefined &&
    (runs === undefined || isNaN(runs) || runs < 1)
  ) {
    throw new Error("--runs must be a positive integer");
  }

  const exportJson = getArgValue(args, "--export-json");

  const outDir = getArgValue(args, "--out-dir");
  const memInternals = args.includes("--mem-internals");
  const perfFaults = args.includes("--perf-faults");

  const perfFaultsPeriodRaw = getArgValue(args, "--perf-faults-period");
  const perfFaultsPeriod =
    perfFaultsPeriodRaw !== undefined
      ? parseInt(perfFaultsPeriodRaw, 10)
      : undefined;

  if (
    perfFaultsPeriodRaw !== undefined &&
    (perfFaultsPeriod === undefined ||
      isNaN(perfFaultsPeriod) ||
      perfFaultsPeriod < 1)
  ) {
    throw new Error("--perf-faults-period must be a positive integer");
  }

  const env = parseEnvPairs(getArgValues(args, "--env"));

  let e2eCloneDirectory =
    getArgValue(args, "--e2e-clone-dir") ?? process.env.E2E_CLONE_DIR;

  if (e2eCloneDirectory === undefined) {
    e2eCloneDirectory = DEFAULT_CLONE_DIR;

    log(
      `No --e2e-clone-dir argument or E2E_CLONE_DIR environment variable provided, defaulting to:`,
    );
    log(`  ${DEFAULT_CLONE_DIR}`);
  }

  return {
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
    runs,
    exportJson,
    e2eCloneDirectory,
    outDir,
    memInternals,
    perfFaults,
    perfFaultsPeriod,
    env,
  };
}

/** Parse repeatable `--env KEY=VALUE` values (VALUE may contain `=`). */
export function parseEnvPairs(values: string[]): Record<string, string> {
  const env: Record<string, string> = {};

  for (const value of values) {
    const separator = value.indexOf("=");

    if (separator < 1) {
      throw new Error(`--env expects KEY=VALUE, got ${JSON.stringify(value)}`);
    }

    env[value.slice(0, separator)] = value.slice(separator + 1);
  }

  return env;
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);

  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function getArgValues(args: string[], flag: string): string[] {
  const values: string[] = [];

  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) {
      values.push(args[i + 1]);
    }
  }

  return values;
}
