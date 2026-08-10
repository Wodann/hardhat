import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CommandFailedError,
  formatOutput,
  parseCpuTiming,
  runMeasured,
  shellQuote,
  wrapWithCpuTiming,
} from "./runner.ts";

describe("wrapWithCpuTiming", () => {
  it("wraps the command in bash's time builtin, reporting to the file", () => {
    assert.equal(
      wrapWithCpuTiming("npx hardhat compile", "/tmp/cpu.txt"),
      "{ LC_NUMERIC=C; TIMEFORMAT='%U %S'; time { npx hardhat compile\n} 2>&3 ; } 3>&2 2>/tmp/cpu.txt",
    );
  });

  it("quotes a timing path with spaces", () => {
    assert.match(
      wrapWithCpuTiming("true", "/tmp/dir with spaces/cpu.txt"),
      /2>'\/tmp\/dir with spaces\/cpu\.txt'$/,
    );
  });

  it("keeps shell operators inside the timed block", () => {
    const wrapped = wrapWithCpuTiming("a && b >> log", "/tmp/cpu.txt");
    assert.match(wrapped, /time \{ a && b >> log\n\}/);
  });
});

describe("parseCpuTiming", () => {
  it("parses user and system seconds", () => {
    assert.deepEqual(parseCpuTiming("1.25 0.75\n", "x"), {
      user: 1.25,
      system: 0.75,
    });
  });

  it("throws on unparseable content", () => {
    assert.throws(() => parseCpuTiming("", "/tmp/cpu.txt"), /\/tmp\/cpu\.txt/);
    assert.throws(() => parseCpuTiming("no numbers here", "x"));
  });

  it("throws when the system time is missing", () => {
    assert.throws(() => parseCpuTiming("1.25\n", "x"));
  });
});

describe("shellQuote", () => {
  it("leaves plain words unquoted", () => {
    assert.equal(shellQuote("/tmp/file-1.txt"), "/tmp/file-1.txt");
  });

  it("quotes values with spaces and shell operators", () => {
    assert.equal(shellQuote("a b && c"), "'a b && c'");
  });

  it("escapes embedded single quotes", () => {
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });
});

describe("runMeasured on failing commands", () => {
  function tempDirs(): { dir: string; timingPath: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "runner-test-"));

    return { dir, timingPath: path.join(dir, "cpu.txt") };
  }

  it("records the exit code and keeps the series with ignoreFailure", async () => {
    const { dir, timingPath } = tempDirs();

    try {
      const run = await runMeasured("sleep 0.15; exit 3", timingPath, {
        cwd: dir,
        ignoreFailure: true,
      });

      assert.deepEqual(run.failure, { exitCode: 3, signal: null });
      assert.ok(run.memory !== undefined && run.memory.samples.length > 0);
      assert.ok(run.memory.startEpochMs > 0);
      assert.ok(run.memory.monoStartNs > 0n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws after the fact without ignoreFailure", async () => {
    const { dir, timingPath } = tempDirs();

    try {
      await assert.rejects(
        runMeasured("echo oops >&2; exit 7", timingPath, { cwd: dir }),
        (error) =>
          error instanceof CommandFailedError &&
          /exited with code 7/.test(error.message) &&
          /oops/.test(error.stderr),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the killing signal and zero CPU when the tree dies", async () => {
    const { dir, timingPath } = tempDirs();

    try {
      // SIGKILLing the spawned bash itself takes the time report down with
      // the workload, like the OOM killer picking the process does.
      const run = await runMeasured("kill -9 $$", timingPath, {
        cwd: dir,
        ignoreFailure: true,
      });

      assert.equal(run.failure?.signal, "SIGKILL");
      assert.deepEqual(
        { user: run.user, system: run.system },
        {
          user: 0,
          system: 0,
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes run.json and streams proc.ndjson for a failed instrumented run", async () => {
    const { dir, timingPath } = tempDirs();
    const runDir = path.join(dir, "run-000");

    try {
      const run = await runMeasured("sleep 0.15; exit 5", timingPath, {
        cwd: dir,
        ignoreFailure: true,
        instrumentation: { outDir: dir, memInternals: false, runDir },
      });

      assert.equal(run.runDir, runDir);

      const runJson = JSON.parse(
        readFileSync(path.join(runDir, "run.json"), "utf-8"),
      );
      assert.deepEqual(runJson.failure, { exitCode: 5, signal: null });
      assert.ok(runJson.memory.peakRssMb >= 0);
      assert.equal(typeof runJson.monoStartNs, "string");

      const procLines = readFileSync(path.join(runDir, "proc.ndjson"), "utf-8")
        .split("\n")
        .filter((line) => line !== "");
      assert.ok(procLines.length >= 2);
      assert.ok("meta" in JSON.parse(procLines[0]));
      assert.ok("byLabel" in JSON.parse(procLines[1]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reports a failed run with the previous run's CPU times", async () => {
    const { dir, timingPath } = tempDirs();

    try {
      await runMeasured("true", timingPath, { cwd: dir });
      assert.ok(existsSync(timingPath));

      const failed = await runMeasured("kill -9 $$", timingPath, {
        cwd: dir,
        ignoreFailure: true,
      });

      assert.deepEqual(
        { user: failed.user, system: failed.system },
        {
          user: 0,
          system: 0,
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatOutput", () => {
  it("renders only non-empty streams", () => {
    assert.equal(
      formatOutput({ stdout: "hello\n", stderr: "" }),
      "  --- stdout ---\nhello",
    );
  });

  it("renders both streams in order", () => {
    assert.equal(
      formatOutput({ stdout: "out", stderr: "err" }),
      "  --- stdout ---\nout\n  --- stderr ---\nerr",
    );
  });

  it("renders nothing when both streams are empty", () => {
    assert.equal(formatOutput({ stdout: undefined, stderr: "" }), "");
  });
});
