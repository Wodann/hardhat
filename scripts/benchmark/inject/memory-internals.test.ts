import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INTERNALS_DIR_ENV,
  SAMPLER_PATH,
  parseInternalsFile,
} from "../helpers/mem-internals.ts";

function runNode(
  code: string,
  env: Record<string, string | undefined>,
): { status: number | null; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "internals-test-"));

  const result = spawnSync(
    process.execPath,
    ["--require", SAMPLER_PATH, "-e", code],
    { env: { ...process.env, [INTERNALS_DIR_ENV]: dir, ...env } },
  );

  return { status: result.status, dir };
}

function ndjsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".ndjson"));
}

describe("memory-internals.cjs", () => {
  it("samples the process into a pid-keyed NDJSON file", () => {
    const { status, dir } = runNode(
      `Buffer.alloc(50 << 20).fill(1); setTimeout(() => {}, 250);`,
      { HARDHAT_BENCH_INTERNALS_INTERVAL_MS: "50" },
    );

    try {
      assert.equal(status, 0);

      const files = ndjsonFiles(dir);
      assert.equal(files.length, 1);

      const parsed = parseInternalsFile(
        readFileSync(path.join(dir, files[0]), "utf-8"),
      );

      assert.ok(parsed !== undefined);
      // Load-time sample, several interval ticks, and the exit sample.
      assert.ok(parsed.samples.length >= 3);
      assert.ok(parsed.samples.every((s) => s.rss > 0 && s.heapUsed > 0));
      assert.ok(parsed.samples.at(-1)!.rss > 50 << 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing without the dir env var", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "internals-test-"));

    try {
      const result = spawnSync(
        process.execPath,
        ["--require", SAMPLER_PATH, "-e", "0"],
        { env: { ...process.env, [INTERNALS_DIR_ENV]: undefined } },
      );

      assert.equal(result.status, 0);
      assert.equal(ndjsonFiles(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not hold a fast-exiting process open", () => {
    const start = Date.now();
    const { status, dir } = runNode("0", {});

    try {
      assert.equal(status, 0);
      assert.ok(Date.now() - start < 5_000);

      // Even an immediate exit leaves the load-time and exit samples.
      const files = ndjsonFiles(dir);
      assert.equal(files.length, 1);

      const parsed = parseInternalsFile(
        readFileSync(path.join(dir, files[0]), "utf-8"),
      );
      assert.ok(parsed !== undefined && parsed.samples.length >= 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never breaks the host when the dir cannot be created", () => {
    // A path under a regular file: mkdirSync fails with ENOTDIR.
    const parent = mkdtempSync(path.join(tmpdir(), "internals-test-"));
    const filePath = path.join(parent, "a-file");
    writeFileSync(filePath, "");

    try {
      const result = spawnSync(
        process.execPath,
        ["--require", SAMPLER_PATH, "-e", "console.log('ok')"],
        {
          env: {
            ...process.env,
            [INTERNALS_DIR_ENV]: path.join(filePath, "not-creatable"),
          },
        },
      );

      assert.equal(result.status, 0);
      assert.equal(result.stdout.toString().trim(), "ok");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
