// In-process memory sampler, injected into every node process of a
// benchmarked command via NODE_OPTIONS="--require .../memory-internals.cjs"
// (see helpers/mem-internals.ts). Plain CJS with no dependencies so it loads
// under whatever Node version and module system the scenario uses.
//
// While the host process runs, it appends one JSON line per sample to
// <HARDHAT_BENCH_INTERNALS_DIR>/<pid>-<epoch>.ndjson: process.memoryUsage()
// broken down (V8 heap, external, array buffers) plus — once the host has
// loaded the EDR N-API addon — EDR's mimalloc-internal committed memory from
// its `memoryStats()` binding (only present in addons built with the
// `memory-stats` cargo feature). Writes are synchronous appends, so an
// OOM-killed process loses at most the line being written.
//
// The sampler must never affect the measured workload: everything is wrapped
// in try/catch, the interval is unref'd, and the EDR binding is never loaded
// eagerly — it is picked up from require.cache only after the host itself
// loaded it.

"use strict";

try {
  main();
} catch {
  // Never break the host process.
}

function main() {
  const dir = process.env.HARDHAT_BENCH_INTERNALS_DIR;

  if (dir === undefined || dir === "") {
    return;
  }

  if (!require("node:worker_threads").isMainThread) {
    // Worker threads share the process; sampling them would double-count.
    return;
  }

  const fs = require("node:fs");

  let fd;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(
      require("node:path").join(dir, `${process.pid}-${Date.now()}.ndjson`),
      "a",
    );
  } catch {
    return;
  }

  const writeLine = (record) => {
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    } catch {
      // Out of disk or fd closed at exit — drop the sample.
    }
  };

  writeLine({
    meta: {
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv,
      startEpochMs: Date.now(),
      node: process.version,
    },
  });

  // The EDR N-API addon, once the host loaded it. `edrBinding === null` means
  // "keep looking"; `undefined` means "found one without memoryStats (not a
  // memory-stats build), stop looking".
  let edrBinding = null;
  const EDR_NODE_RE = /[\\/]@nomicfoundation[\\/]edr[^\\/]*[\\/][^\\/]*\.node$/;

  const findEdrBinding = () => {
    const injected = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;

    if (injected !== undefined && require.cache[injected] !== undefined) {
      return require(injected);
    }

    for (const key of Object.keys(require.cache)) {
      if (EDR_NODE_RE.test(key)) {
        return require(key);
      }
    }

    return null;
  };

  let tick = 0;

  const sample = () => {
    try {
      if (edrBinding === null && tick % 10 === 0) {
        // Scanning require.cache is O(#modules); throttle until found.
        const binding = findEdrBinding();

        if (binding !== null) {
          edrBinding =
            typeof binding.memoryStats === "function" ? binding : undefined;
        }
      }

      tick += 1;

      const usage = process.memoryUsage();
      const record = {
        t: Date.now(),
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
      };

      if (edrBinding !== null && edrBinding !== undefined) {
        const stats = edrBinding.memoryStats();
        // BigInt values well below 2^53; JSON.stringify rejects BigInt.
        record.edrCommit = Number(stats.currentCommit);
        record.edrPeakCommit = Number(stats.peakCommit);
      }

      writeLine(record);
    } catch {
      // A failed sample must not take the interval down with it.
    }
  };

  sample();

  const intervalMs = Number(
    process.env.HARDHAT_BENCH_INTERNALS_INTERVAL_MS ?? 100,
  );

  // unref'd: fast-exiting processes (npx shims, compiler runners) are never
  // held open; they still leave the load-time sample above and the exit
  // sample below.
  setInterval(sample, intervalMs).unref();

  const reportIntervalMs = Number(
    process.env.HARDHAT_BENCH_MEM_REPORT_INTERVAL_MS ?? 0,
  );

  if (reportIntervalMs > 0) {
    setInterval(() => {
      try {
        if (edrBinding !== null && edrBinding !== undefined) {
          writeLine({ t: Date.now(), report: edrBinding.memoryReport() });
        }
      } catch {
        // Keep the interval alive.
      }
    }, reportIntervalMs).unref();
  }

  process.on("exit", () => {
    sample();

    try {
      if (
        edrBinding !== null &&
        edrBinding !== undefined &&
        typeof edrBinding.memoryReport === "function"
      ) {
        writeLine({ t: Date.now(), report: edrBinding.memoryReport() });
      }
    } catch {
      // Exit must stay clean.
    }
  });
}
