import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { perfTimeWindow, wrapWithPerf } from "./perf-faults.ts";
import { wrapWithCpuTiming } from "./runner.ts";

describe("wrapWithPerf", () => {
  it("records page faults with a call graph on the monotonic clock", () => {
    assert.equal(
      wrapWithPerf("npx hardhat test", "/tmp/run/perf.data", 1000),
      "perf record -e page-faults -c 1000 -g -k CLOCK_MONOTONIC " +
        "-o /tmp/run/perf.data -- bash -c 'npx hardhat test'",
    );
  });

  it("escapes single quotes in the wrapped command", () => {
    assert.match(
      wrapWithPerf("echo 'hi'", "/tmp/perf.data", 10),
      /-- bash -c 'echo '\\''hi'\\'''$/,
    );
  });

  it("quotes an output path with spaces", () => {
    assert.match(
      wrapWithPerf("true", "/tmp/dir with spaces/perf.data", 10),
      /-o '\/tmp\/dir with spaces\/perf\.data'/,
    );
  });

  it("composes inside the bash time wrapper", () => {
    const wrapped = wrapWithCpuTiming(
      wrapWithPerf("true", "/tmp/perf.data", 1000),
      "/tmp/cpu.txt",
    );

    assert.match(
      wrapped,
      /^\{ LC_NUMERIC=C; TIMEFORMAT='%U %S'; time \{ perf record/,
    );
    assert.match(wrapped, /2>\/tmp\/cpu\.txt$/);
  });
});

describe("perfTimeWindow", () => {
  it("maps series ms onto monotonic seconds", () => {
    assert.equal(
      perfTimeWindow(2_000_000_000n, 1500, 2500),
      "3.500000,4.500000",
    );
  });

  it("keeps microsecond precision for large anchors", () => {
    // ~11.6 days of uptime in ns; naive Number(ns)/1e9 would lose precision.
    assert.equal(
      perfTimeWindow(1_000_000_000_123_456n, 0, 1),
      "1000000.000123,1000000.001123",
    );
  });
});
