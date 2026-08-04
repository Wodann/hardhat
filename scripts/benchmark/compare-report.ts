import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_CLONE_DIR } from "../end-to-end/helpers/args.ts";
import { log, logError, logStep, logWarning } from "./helpers/log.ts";

const USAGE = `
scripts/benchmark/compare-report.ts — Pair two scenarios' regression results

DESCRIPTION
  Formats the output of one or more bench:regression runs into a side-by-side
  comparison of a baseline scenario against a candidate scenario. Intended for
  A/B studies where the same benchmark command names are declared by two
  scenarios, e.g. OpenZeppelin on Hardhat 2 vs Hardhat 3.

  Each --input file is treated as one pass. Passes are reported individually as
  well as combined (combining pools the per-run samples, so the combined mean is
  not an average of the passes' means). Reporting passes separately is the point:
  if two passes of the same side disagree by more than their spread, the machine
  drifted between them and the comparison is not trustworthy.

  Every wall-clock entry emitted by bench:regression has "(cpu)" and
  "(peak RSS)" siblings; those are folded into the row for their base name
  rather than listed as rows of their own.

  Provenance is read straight from the scenario clones: the resolved hardhat and
  EDR versions, and the set of Solidity sources each side actually compiled
  (from artifacts/build-info). The compiled-source symmetric difference is the
  ground truth for whether the compile rows compare like with like.

  Mocha pass/pending/fail counts are picked up from <output dir>/mocha-<id>.log
  if those files exist (bench:regression discards command output, so capture
  them with a separate "pnpm e2e exec" run).

OPTIONS
  --input <paths>       Required. Comma-separated regression report JSON files
  --output <path>       Required. Markdown destination
  --baseline <id>       Baseline scenario id (default: openzeppelin-contracts-hh2)
  --candidate <id>      Candidate scenario id (default: openzeppelin-contracts)
  --e2e-clone-dir <p>   Override clone directory (default: same as pnpm e2e)

EXAMPLES
  node ./scripts/benchmark/compare-report.ts \\
    --input ./hh2-vs-hh3/pass1-hh2.json,./hh2-vs-hh3/pass1-hh3.json \\
    --output ./hh2-vs-hh3/comparison.md
`;

const CPU_SUFFIX = " (cpu)";
const RSS_SUFFIX = " (peak RSS)";

interface ReportEntry {
  name: string;
  unit: string;
  value: number;
  range: string;
  extra: string;
}

interface Measurement {
  times: number[];
  cpuUser: number | undefined;
  cpuSystem: number | undefined;
  peakRssMb: number | undefined;
}

// A run whose wall clock exceeds this multiple of its phase's median did not
// measure the phase — it measured a stall. Hardhat 3's `test mocha` can finish
// the suite and then never exit (the event loop stays parked in epoll_wait), and
// such a run's time is bounded only by the `timeout` wrapper in the scenario, so
// including it would swamp the mean. Discarded samples are always reported.
const STALL_MEDIAN_MULTIPLE = 3;

interface Stats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

interface CompareArgs {
  inputs: string[];
  output: string;
  baseline: string;
  candidate: string;
  e2eCloneDirectory: string;
}

// scenario id -> phase name -> pass label -> measurement
type Collected = Map<string, Map<string, Map<string, Measurement>>>;

function main(): void {
  const args = resolveArgs(process.argv.slice(2));

  if (args === undefined) {
    console.log(USAGE);
    return;
  }

  const passLabels: string[] = [];
  const collected: Collected = new Map();

  for (const input of args.inputs) {
    const label = path.basename(input, ".json");
    passLabels.push(label);
    collectPass(collected, label, readReport(input));
  }

  const phases = orderedPhases(collected, args.baseline, args.candidate);

  if (phases.length === 0) {
    logError(
      `No phase names are shared by "${args.baseline}" and "${args.candidate}"`,
    );
    process.exit(1);
  }

  const markdown = render(args, passLabels, collected, phases);

  mkdirSync(path.dirname(args.output), { recursive: true });
  writeFileSync(args.output, markdown);

  log(`Wrote ${args.output}`);
}

function readReport(input: string): ReportEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(input, "utf-8"));

  if (!Array.isArray(parsed)) {
    throw new Error(`${input} is not a benchmark report array`);
  }

  return parsed as ReportEntry[];
}

/**
 * Fold a pass's flat entry list into the collection, attaching each "(cpu)" and
 * "(peak RSS)" entry to the measurement of its base name.
 */
function collectPass(
  collected: Collected,
  label: string,
  entries: ReportEntry[],
): void {
  for (const entry of entries) {
    const slash = entry.name.indexOf(" / ");

    if (slash === -1) {
      logWarning(`Ignoring unrecognized entry name: ${entry.name}`);
      continue;
    }

    const scenarioId = entry.name.slice(0, slash);
    const label2 = entry.name.slice(slash + 3);

    const isCpu = label2.endsWith(CPU_SUFFIX);
    const isRss = label2.endsWith(RSS_SUFFIX);

    const phase = isCpu
      ? label2.slice(0, -CPU_SUFFIX.length)
      : isRss
        ? label2.slice(0, -RSS_SUFFIX.length)
        : label2;

    const measurement = getMeasurement(collected, scenarioId, phase, label);
    const extra = parseExtra(entry.extra);

    if (isCpu) {
      measurement.cpuUser = numberOrUndefined(extra.user);
      measurement.cpuSystem = numberOrUndefined(extra.system);
    } else if (isRss) {
      measurement.peakRssMb = entry.value;
    } else {
      const times = Array.isArray(extra.times)
        ? extra.times.filter((t): t is number => typeof t === "number")
        : [entry.value];

      measurement.times.push(...times);

      // Wall-clock entries also embed the highest peak RSS, which is the only
      // source when a report predates the separate "(peak RSS)" entries.
      measurement.peakRssMb ??= numberOrUndefined(extra.peakRssMb);
    }
  }
}

function getMeasurement(
  collected: Collected,
  scenarioId: string,
  phase: string,
  passLabel: string,
): Measurement {
  let phases = collected.get(scenarioId);

  if (phases === undefined) {
    phases = new Map();
    collected.set(scenarioId, phases);
  }

  let passes = phases.get(phase);

  if (passes === undefined) {
    passes = new Map();
    phases.set(phase, passes);
  }

  let measurement = passes.get(passLabel);

  if (measurement === undefined) {
    measurement = {
      times: [],
      cpuUser: undefined,
      cpuSystem: undefined,
      peakRssMb: undefined,
    };
    passes.set(passLabel, measurement);
  }

  return measurement;
}

function parseExtra(extra: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(extra);

    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Phase names present on both sides, in the order the candidate declares them.
 */
function orderedPhases(
  collected: Collected,
  baseline: string,
  candidate: string,
): string[] {
  const baselinePhases = collected.get(baseline);
  const candidatePhases = collected.get(candidate);

  if (baselinePhases === undefined || candidatePhases === undefined) {
    return [];
  }

  return [...candidatePhases.keys()].filter((phase) =>
    baselinePhases.has(phase),
  );
}

function combine(passes: Map<string, Measurement> | undefined): Measurement {
  const combined: Measurement = {
    times: [],
    cpuUser: undefined,
    cpuSystem: undefined,
    peakRssMb: undefined,
  };

  if (passes === undefined) {
    return combined;
  }

  const users: number[] = [];
  const systems: number[] = [];

  for (const measurement of passes.values()) {
    combined.times.push(...measurement.times);

    if (measurement.cpuUser !== undefined) {
      users.push(measurement.cpuUser);
    }

    if (measurement.cpuSystem !== undefined) {
      systems.push(measurement.cpuSystem);
    }

    if (measurement.peakRssMb !== undefined) {
      combined.peakRssMb = Math.max(
        combined.peakRssMb ?? 0,
        measurement.peakRssMb,
      );
    }
  }

  combined.cpuUser = users.length > 0 ? mean(users) : undefined;
  combined.cpuSystem = systems.length > 0 ? mean(systems) : undefined;

  return combined;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Split samples into the ones that measured the phase and the ones that measured
 * a stall. Uses the median rather than the mean as the reference, so a single
 * enormous sample cannot drag the threshold up far enough to protect itself.
 */
function partitionStalls(times: number[]): {
  kept: number[];
  discarded: number[];
} {
  if (times.length < 3) {
    return { kept: times, discarded: [] };
  }

  const threshold = median(times) * STALL_MEDIAN_MULTIPLE;
  const kept: number[] = [];
  const discarded: number[] = [];

  for (const time of times) {
    (time > threshold ? discarded : kept).push(time);
  }

  return kept.length > 0 ? { kept, discarded } : { kept: times, discarded: [] };
}

function stats(times: number[]): Stats | undefined {
  if (times.length === 0) {
    return undefined;
  }

  const m = mean(times);
  const variance =
    times.length > 1
      ? times.reduce((sum, t) => sum + (t - m) ** 2, 0) / (times.length - 1)
      : 0;

  return {
    mean: m,
    stddev: Math.sqrt(variance),
    min: Math.min(...times),
    max: Math.max(...times),
  };
}

function render(
  args: CompareArgs,
  passLabels: string[],
  collected: Collected,
  phases: string[],
): string {
  const lines: string[] = [];

  lines.push("# OpenZeppelin end-to-end: Hardhat 2 vs Hardhat 3");
  lines.push("");
  lines.push(`Baseline: \`${args.baseline}\``);
  lines.push(`Candidate: \`${args.candidate}\``);
  lines.push("");

  lines.push(...renderProvenance(args));
  lines.push(...renderCombined(args, collected, phases));
  lines.push(...renderPerPass(args, passLabels, collected, phases));
  lines.push(...renderUnpaired(args, collected));
  lines.push(...renderCompiledSources(args));

  return `${lines.join("\n")}\n`;
}

function renderCombined(
  args: CompareArgs,
  collected: Collected,
  phases: string[],
): string[] {
  const lines: string[] = [];

  lines.push("## Combined");
  lines.push("");
  lines.push(
    "Wall clock is mean ± stddev over the pooled runs of every pass. CPU is" +
      " user+system; CPU% is CPU over wall clock, i.e. how much parallelism the" +
      " phase achieved. Ratio is candidate ÷ baseline, so below 1.00 means" +
      " Hardhat 3 is faster.",
  );
  lines.push("");
  lines.push(
    "| Phase | Runs | HH2 wall | HH3 wall | Δ wall | Ratio | HH2 CPU (u/s, %) | HH3 CPU (u/s, %) | HH2 peak RSS | HH3 peak RSS |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  const stalls: string[] = [];

  for (const phase of phases) {
    const base = combine(collected.get(args.baseline)?.get(phase));
    const cand = combine(collected.get(args.candidate)?.get(phase));

    const baseSamples = partitionStalls(base.times);
    const candSamples = partitionStalls(cand.times);

    const baseStats = stats(baseSamples.kept);
    const candStats = stats(candSamples.kept);

    for (const [scenarioId, samples] of [
      [args.baseline, baseSamples],
      [args.candidate, candSamples],
    ] as Array<[string, { kept: number[]; discarded: number[] }]>) {
      if (samples.discarded.length > 0) {
        stalls.push(
          `- \`${scenarioId}\` / ${phase}: discarded ${samples.discarded.length} of ` +
            `${samples.kept.length + samples.discarded.length} runs as stalls ` +
            `(${samples.discarded.map((t) => `${t.toFixed(1)} s`).join(", ")}; ` +
            `kept runs median ${median(samples.kept).toFixed(1)} s)`,
        );
      }
    }

    lines.push(
      `| ${phase} | ${baseSamples.kept.length} / ${candSamples.kept.length} | ${fmtStats(baseStats)} | ${fmtStats(candStats)} | ${fmtDelta(baseStats, candStats)} | ${fmtRatio(baseStats, candStats)} | ${fmtCpu(base, baseStats)} | ${fmtCpu(cand, candStats)} | ${fmtRss(base)} | ${fmtRss(cand)} |`,
    );
  }

  lines.push("");

  if (stalls.length > 0) {
    lines.push(
      `Runs discarded as stalls (wall clock over ${STALL_MEDIAN_MULTIPLE}× the` +
        " phase median). Hardhat 3's `test mocha` intermittently completes the" +
        " suite and then never exits, so such a run's duration reflects the" +
        " scenario's `timeout` wrapper rather than the work being measured:",
    );
    lines.push("");
    lines.push(...stalls);
    lines.push("");
  }

  return lines;
}

function renderPerPass(
  args: CompareArgs,
  passLabels: string[],
  collected: Collected,
  phases: string[],
): string[] {
  const lines: string[] = [];

  lines.push("## Per pass");
  lines.push("");
  lines.push(
    "Each column is one bench:regression invocation. Two passes of the same" +
      " side that disagree by more than their spread mean the machine drifted" +
      " between them; prefer reporting the disagreement over averaging it away.",
  );
  lines.push("");
  lines.push(`| Scenario | Phase | ${passLabels.join(" | ")} |`);
  lines.push(`| --- | --- | ${passLabels.map(() => "---").join(" | ")} |`);

  for (const scenarioId of [args.baseline, args.candidate]) {
    for (const phase of phases) {
      const passes = collected.get(scenarioId)?.get(phase);

      const cells = passLabels.map((label) => {
        const measurement = passes?.get(label);

        if (measurement === undefined || measurement.times.length === 0) {
          return "—";
        }

        const { kept, discarded } = partitionStalls(measurement.times);
        const suffix =
          discarded.length > 0 ? ` (−${discarded.length} stalled)` : "";

        return `${fmtStats(stats(kept))}${suffix}`;
      });

      lines.push(`| ${scenarioId} | ${phase} | ${cells.join(" | ")} |`);
    }
  }

  lines.push("");

  return lines;
}

function renderUnpaired(args: CompareArgs, collected: Collected): string[] {
  const lines: string[] = [];

  for (const [scenarioId, other] of [
    [args.baseline, args.candidate],
    [args.candidate, args.baseline],
  ]) {
    const own = collected.get(scenarioId);
    const otherPhases = collected.get(other);

    const unpaired = [...(own?.keys() ?? [])].filter(
      (phase) => otherPhases?.has(phase) !== true,
    );

    if (unpaired.length > 0) {
      lines.push(`### Phases only measured for \`${scenarioId}\``);
      lines.push("");

      for (const phase of unpaired) {
        lines.push(`- ${phase}`);
      }

      lines.push("");
    }
  }

  return lines;
}

function renderProvenance(args: CompareArgs): string[] {
  const lines: string[] = ["## Provenance", ""];

  lines.push(`Node: \`${process.version}\``);
  lines.push("");
  lines.push("| Scenario | hardhat | @nomicfoundation/edr | mocha results |");
  lines.push("| --- | --- | --- | --- |");

  for (const scenarioId of [args.baseline, args.candidate]) {
    const workingDir = path.join(args.e2eCloneDirectory, scenarioId);

    lines.push(
      `| ${scenarioId} | ${installedVersion(workingDir, "hardhat")} | ${installedVersion(workingDir, "@nomicfoundation/edr")} | ${mochaCounts(args.output, scenarioId)} |`,
    );
  }

  lines.push("");

  return lines;
}

function installedVersion(workingDir: string, packageName: string): string {
  const pkgJsonPath = path.join(
    workingDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );

  try {
    const pkgJson: unknown = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const version = (pkgJson as { version?: unknown }).version;

    return typeof version === "string" ? `\`${version}\`` : "unknown";
  } catch {
    return "not installed";
  }
}

/**
 * bench:regression discards command output, so counts come from a separate
 * "pnpm e2e exec" run captured to <output dir>/mocha-<scenarioId>.log.
 */
function mochaCounts(outputPath: string, scenarioId: string): string {
  const logPath = path.join(
    path.dirname(outputPath),
    `mocha-${scenarioId}.log`,
  );

  let contents: string;

  try {
    contents = readFileSync(logPath, "utf-8");
  } catch {
    return "no log captured";
  }

  const parts: string[] = [];

  for (const kind of ["passing", "pending", "failing"]) {
    const match = new RegExp(`(\\d+)\\s+${kind}`).exec(contents);

    if (match !== null) {
      parts.push(`${match[1]} ${kind}`);
    }
  }

  return parts.length > 0 ? parts.join(", ") : "not found in log";
}

function renderCompiledSources(args: CompareArgs): string[] {
  const lines: string[] = ["## Compiled sources", ""];

  const baseSources = compiledSources(
    path.join(args.e2eCloneDirectory, args.baseline),
  );
  const candSources = compiledSources(
    path.join(args.e2eCloneDirectory, args.candidate),
  );

  if (baseSources === undefined || candSources === undefined) {
    lines.push(
      "Could not read build-info from both clones, so the compile rows are" +
        " unverified. Re-run after a compile to populate artifacts/build-info.",
    );
    lines.push("");

    return lines;
  }

  const onlyBase = [...baseSources].filter((s) => !candSources.has(s)).sort();
  const onlyCand = [...candSources].filter((s) => !baseSources.has(s)).sort();

  lines.push(
    `\`${args.baseline}\` compiled ${baseSources.size} sources;` +
      ` \`${args.candidate}\` compiled ${candSources.size}.`,
  );
  lines.push("");

  if (onlyBase.length === 0 && onlyCand.length === 0) {
    lines.push(
      "The two source sets are identical, so the compile rows compare like" +
        " with like.",
    );
    lines.push("");

    return lines;
  }

  lines.push(
    "**The source sets differ, so the compile rows do not compare like with" +
      " like.** Symmetric difference:",
  );
  lines.push("");

  for (const [scenarioId, only] of [
    [args.baseline, onlyBase],
    [args.candidate, onlyCand],
  ] as Array<[string, string[]]>) {
    if (only.length > 0) {
      lines.push(`Only in \`${scenarioId}\` (${only.length}):`);
      lines.push("");

      for (const source of only.slice(0, 40)) {
        lines.push(`- \`${source}\``);
      }

      if (only.length > 40) {
        lines.push(`- …and ${only.length - 40} more`);
      }

      lines.push("");
    }
  }

  return lines;
}

/**
 * The Solidity sources a scenario's last build actually fed to solc, taken from
 * the compiler inputs recorded in artifacts/build-info.
 */
function compiledSources(workingDir: string): Set<string> | undefined {
  const buildInfoDir = path.join(workingDir, "artifacts", "build-info");

  let files: string[];

  try {
    files = readdirSync(buildInfoDir).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".output.json"),
    );
  } catch {
    return undefined;
  }

  const sources = new Set<string>();

  for (const file of files) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(readFileSync(path.join(buildInfoDir, file), "utf-8"));
    } catch {
      continue;
    }

    const input = (parsed as { input?: { sources?: unknown } }).input;

    if (typeof input?.sources === "object" && input.sources !== null) {
      for (const source of Object.keys(input.sources)) {
        sources.add(normalizeSourcePath(source));
      }
    }
  }

  return sources.size > 0 ? sources : undefined;
}

/**
 * Two naming differences are pure layout and would otherwise swamp the
 * comparison with false differences:
 *
 * - Hardhat 3 roots the project's own sources under "project/" in the solc
 *   input, where Hardhat 2 uses bare relative paths.
 * - OpenZeppelin's Hardhat 3 port of hardhat-exposed nests its generated files
 *   under an extra "contracts/" segment that the npm plugin does not.
 *
 * Other prefixes (e.g. Hardhat 3's "npm/") are left alone, since a source only
 * one side compiles is exactly what this comparison needs to surface.
 */
function normalizeSourcePath(source: string): string {
  const withoutProject = source.startsWith("project/")
    ? source.slice("project/".length)
    : source;

  return withoutProject.replace(
    /^contracts-exposed\/contracts\//,
    "contracts-exposed/",
  );
}

function fmtStats(s: Stats | undefined): string {
  return s === undefined
    ? "—"
    : `${s.mean.toFixed(2)} ± ${s.stddev.toFixed(2)} s`;
}

function fmtDelta(base: Stats | undefined, cand: Stats | undefined): string {
  if (base === undefined || cand === undefined) {
    return "—";
  }

  const delta = cand.mean - base.mean;

  return `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} s`;
}

function fmtRatio(base: Stats | undefined, cand: Stats | undefined): string {
  if (base === undefined || cand === undefined || base.mean === 0) {
    return "—";
  }

  return `${(cand.mean / base.mean).toFixed(2)}×`;
}

function fmtCpu(m: Measurement, wall: Stats | undefined): string {
  if (m.cpuUser === undefined || m.cpuSystem === undefined) {
    return "—";
  }

  const cpu = m.cpuUser + m.cpuSystem;
  const percent =
    wall !== undefined && wall.mean > 0
      ? ` ${Math.round((cpu / wall.mean) * 100)}%`
      : "";

  return `${cpu.toFixed(2)} s (${m.cpuUser.toFixed(2)}/${m.cpuSystem.toFixed(2)})${percent}`;
}

function fmtRss(m: Measurement): string {
  return m.peakRssMb === undefined ? "—" : `${Math.round(m.peakRssMb)} MB`;
}

function resolveArgs(argv: string[]): CompareArgs | undefined {
  const inputRaw = getArgValue(argv, "--input");
  const output = getArgValue(argv, "--output");

  if (inputRaw === undefined || output === undefined) {
    return undefined;
  }

  const inputs = inputRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => path.resolve(s));

  if (inputs.length === 0) {
    return undefined;
  }

  return {
    inputs,
    output: path.resolve(output),
    baseline: getArgValue(argv, "--baseline") ?? "openzeppelin-contracts-hh2",
    candidate: getArgValue(argv, "--candidate") ?? "openzeppelin-contracts",
    e2eCloneDirectory:
      getArgValue(argv, "--e2e-clone-dir") ??
      process.env.E2E_CLONE_DIR ??
      DEFAULT_CLONE_DIR,
  };
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);

  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

try {
  main();
} catch (error) {
  logStep("Comparison failed");
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
