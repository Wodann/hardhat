import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INTERNALS_DIR_ENV,
  SAMPLER_PATH,
  internalsEnv,
  mergeInternals,
  parseInternalsFile,
  type InternalsProcess,
  type InternalsSample,
} from "./mem-internals.ts";

const MB = 1024 * 1024;

function sample(
  t: number,
  bytes: Partial<InternalsSample> = {},
): InternalsSample {
  return {
    t,
    rss: 100 * MB,
    heapUsed: 10 * MB,
    heapTotal: 20 * MB,
    external: 5 * MB,
    arrayBuffers: 1 * MB,
    ...bytes,
  };
}

function ndjson(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

const HARDHAT_META = {
  meta: {
    pid: 42,
    ppid: 1,
    argv: ["/usr/bin/node", "/repo/node_modules/hardhat/dist/src/cli.js"],
    startEpochMs: 1000,
    node: "v22.0.0",
  },
};

describe("internalsEnv", () => {
  it("sets the dir and requires the sampler through NODE_OPTIONS", () => {
    const env = internalsEnv("/tmp/run/internals", undefined);

    assert.equal(env[INTERNALS_DIR_ENV], "/tmp/run/internals");
    assert.equal(env.NODE_OPTIONS, `--require "${SAMPLER_PATH}"`);
  });

  it("appends to existing NODE_OPTIONS", () => {
    const env = internalsEnv("/tmp/i", "--max-old-space-size=4096");

    assert.equal(
      env.NODE_OPTIONS,
      `--max-old-space-size=4096 --require "${SAMPLER_PATH}"`,
    );
  });
});

describe("parseInternalsFile", () => {
  it("parses meta, samples and reports, labeling by argv", () => {
    const parsed = parseInternalsFile(
      ndjson([
        HARDHAT_META,
        sample(1000),
        sample(1100, { edrCommit: 50 * MB, edrPeakCommit: 60 * MB }),
        { t: 1200, report: "heap stats: ..." },
      ]),
    );

    assert.ok(parsed !== undefined);
    assert.equal(parsed.pid, 42);
    assert.equal(parsed.label, "hardhat");
    assert.equal(parsed.samples.length, 2);
    assert.equal(parsed.samples[1].edrCommit, 50 * MB);
    assert.deepEqual(parsed.reports, [{ t: 1200, text: "heap stats: ..." }]);
  });

  it("drops a truncated final line", () => {
    const parsed = parseInternalsFile(
      `${ndjson([HARDHAT_META, sample(1000)])}{"t":1100,"rss":123`,
    );

    assert.ok(parsed !== undefined);
    assert.equal(parsed.samples.length, 1);
  });

  it("returns undefined without a meta line", () => {
    assert.equal(parseInternalsFile(ndjson([sample(1000)])), undefined);
    assert.equal(parseInternalsFile(""), undefined);
  });
});

describe("mergeInternals", () => {
  const table = {
    tMs: [0, 100, 200],
    byProcess: { hardhat: [100, 200, 300] },
  };

  function processOf(
    label: string,
    samples: InternalsSample[],
  ): InternalsProcess {
    return { pid: 1, label, samples, reports: [] };
  }

  it("aligns samples onto the axis and rounds to MB", () => {
    const merged = mergeInternals(table, 1000, [
      processOf("hardhat", [
        sample(1000, { heapUsed: 10 * MB }),
        sample(1150, { heapUsed: 30 * MB }),
      ]),
    ]);

    assert.deepEqual(merged.byProcess["hardhat:v8-heap"], [10, 10, 30]);
    assert.deepEqual(merged.byProcess["hardhat:external"], [5, 5, 5]);
    assert.deepEqual(merged.byProcess.hardhat, [100, 200, 300]);
  });

  it("sums same-label processes", () => {
    const merged = mergeInternals(table, 1000, [
      processOf("hardhat", [sample(1000, { heapUsed: 10 * MB })]),
      processOf("hardhat", [sample(1000, { heapUsed: 15 * MB })]),
    ]);

    assert.deepEqual(merged.byProcess["hardhat:v8-heap"], [25, 25, 25]);
  });

  it("zeroes a process beyond the staleness window", () => {
    const merged = mergeInternals({ tMs: [0, 2000], byProcess: {} }, 1000, [
      processOf("hardhat", [sample(1000, { heapUsed: 10 * MB })]),
    ]);

    assert.deepEqual(merged.byProcess["hardhat:v8-heap"], [10, 0]);
  });

  it("only adds edr-commit when some sample carried it", () => {
    const withoutEdr = mergeInternals(table, 1000, [
      processOf("hardhat", [sample(1000)]),
    ]);
    const withEdr = mergeInternals(table, 1000, [
      processOf("hardhat", [sample(1000, { edrCommit: 512 * MB })]),
    ]);

    assert.equal(withoutEdr.byProcess["hardhat:edr-commit"], undefined);
    assert.deepEqual(withEdr.byProcess["hardhat:edr-commit"], [512, 512, 512]);
  });

  it("ignores samples from the future", () => {
    const merged = mergeInternals(table, 1000, [
      processOf("hardhat", [sample(1150, { heapUsed: 10 * MB })]),
    ]);

    assert.deepEqual(merged.byProcess["hardhat:v8-heap"], [0, 0, 10]);
  });
});
