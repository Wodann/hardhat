import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { perfTimeWindow } from "./helpers/perf-faults.ts";
import { shellQuote } from "./helpers/runner.ts";

const USAGE = `
scripts/benchmark/flamegraph.ts — Flamegraph a run's page-fault profile

DESCRIPTION
  Renders the perf.data of a benchmark run recorded with \`pnpm bench
  --perf-faults\` into a flamegraph SVG (or folded stacks). Each sample is a
  call stack that first-touched a batch of newly committed pages, so wide
  frames are the code paths responsible for RSS growth.

  With --from-ms/--to-ms, only samples inside that window of the run's
  memory series are included: read a growth phase's interval off a chart
  rendered by \`pnpm bench:render:mem-series\`, then flamegraph exactly the
  allocations of that phase. The window is translated to perf's clock
  through the \`monoStartNs\` anchor in the run's run.json.

  Requires \`perf\` and inferno (\`cargo install inferno\`) on the PATH; when
  they are missing, the equivalent pipeline is printed instead.

USAGE
  pnpm bench:flamegraph <run-dir> [options]

OPTIONS
  <run-dir>          A run-NNN directory containing perf.data and run.json
  --from-ms <n>      Window start, in series ms (requires --to-ms)
  --to-ms <n>        Window end, in series ms
  --output <path>    SVG output path (default: <run-dir>/flamegraph.svg)
  --folded <path>    Write collapsed stacks instead of rendering an SVG

EXAMPLES
  pnpm bench:flamegraph /tmp/bench-artifacts/run-000
  pnpm bench:flamegraph /tmp/bench-artifacts/run-000 --from-ms 120000 --to-ms 180000
`;

interface FlamegraphArgs {
  runDir: string;
  fromMs: number | undefined;
  toMs: number | undefined;
  output: string | undefined;
  folded: string | undefined;
}

export function resolveArgs(args: string[]): FlamegraphArgs | undefined {
  const positional = args.filter(
    (arg, i) => !arg.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"),
  );

  if (positional.length !== 1) {
    return undefined;
  }

  const numberArg = (flag: string): number | undefined => {
    const idx = args.indexOf(flag);

    if (idx === -1) {
      return undefined;
    }

    const value = Number(args[idx + 1]);

    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${flag} must be a non-negative number`);
    }

    return value;
  };

  const stringArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);

    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const fromMs = numberArg("--from-ms");
  const toMs = numberArg("--to-ms");

  if ((fromMs === undefined) !== (toMs === undefined)) {
    throw new Error("--from-ms and --to-ms must be passed together");
  }

  if (fromMs !== undefined && toMs !== undefined && toMs <= fromMs) {
    throw new Error("--to-ms must be greater than --from-ms");
  }

  return {
    runDir: positional[0],
    fromMs,
    toMs,
    output: stringArg("--output"),
    folded: stringArg("--folded"),
  };
}

/** The shell pipeline rendering a run's perf.data, for running or printing. */
export function buildPipeline(args: FlamegraphArgs): string {
  const perfData = path.join(args.runDir, "perf.data");

  let script = `perf script -i ${shellQuote(perfData)}`;

  if (args.fromMs !== undefined && args.toMs !== undefined) {
    const monoStartNs = readMonoStartNs(args.runDir);
    script += ` --time ${perfTimeWindow(monoStartNs, args.fromMs, args.toMs)}`;
  }

  const collapsed = `${script} | inferno-collapse-perf`;

  if (args.folded !== undefined) {
    return `${collapsed} > ${shellQuote(args.folded)}`;
  }

  const output =
    args.output ?? path.join(args.runDir, windowedName(args, "flamegraph"));

  return `${collapsed} | inferno-flamegraph --title ${shellQuote(flamegraphTitle(args))} > ${shellQuote(output)}`;
}

function windowedName(args: FlamegraphArgs, base: string): string {
  return args.fromMs !== undefined && args.toMs !== undefined
    ? `${base}-${args.fromMs}ms-${args.toMs}ms.svg`
    : `${base}.svg`;
}

function flamegraphTitle(args: FlamegraphArgs): string {
  const window =
    args.fromMs !== undefined && args.toMs !== undefined
      ? ` [${args.fromMs}–${args.toMs} ms]`
      : "";

  return `page faults — ${path.basename(path.resolve(args.runDir))}${window}`;
}

function readMonoStartNs(runDir: string): bigint {
  const runJsonPath = path.join(runDir, "run.json");
  const runJson = JSON.parse(readFileSync(runJsonPath, "utf-8")) as {
    monoStartNs?: string | null;
  };

  if (runJson.monoStartNs === undefined || runJson.monoStartNs === null) {
    throw new Error(
      `${runJsonPath} has no monoStartNs anchor — the run was recorded ` +
        "without memory sampling, so series windows cannot be mapped onto " +
        "perf time",
    );
  }

  return BigInt(runJson.monoStartNs);
}

function toolAvailable(tool: string): boolean {
  return spawnSync("which", [tool], { stdio: "ignore" }).status === 0;
}

async function cliMain(): Promise<void> {
  let args: FlamegraphArgs | undefined;

  try {
    args = resolveArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (args === undefined) {
    console.log(USAGE);
    return;
  }

  if (!existsSync(path.join(args.runDir, "perf.data"))) {
    console.error(
      `No perf.data in ${args.runDir} — was the run recorded with --perf-faults?`,
    );
    process.exit(1);
  }

  const pipeline = buildPipeline(args);

  const requiredTools = ["perf", "inferno-collapse-perf"];

  if (args.folded === undefined) {
    requiredTools.push("inferno-flamegraph");
  }

  const missing = requiredTools.filter((tool) => !toolAvailable(tool));

  if (missing.length > 0) {
    console.error(
      `Missing tools on PATH: ${missing.join(", ")}. Run the pipeline yourself:`,
    );
    console.error(`  ${pipeline}`);
    process.exit(1);
  }

  const result = spawnSync("bash", ["-c", pipeline], { stdio: "inherit" });

  if (result.status !== 0) {
    console.error(`Pipeline failed (exit ${String(result.status)}):`);
    console.error(`  ${pipeline}`);
    process.exit(1);
  }

  console.log(pipeline.split(" > ").pop() ?? "done");
}

if (import.meta.main) {
  await cliMain();
}
