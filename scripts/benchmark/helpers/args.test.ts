import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEnvPairs } from "./args.ts";

describe("parseEnvPairs", () => {
  it("parses repeated KEY=VALUE pairs", () => {
    assert.deepEqual(
      parseEnvPairs(["A=1", "NAPI_RS_NATIVE_LIBRARY_PATH=/x/edr.node"]),
      { A: "1", NAPI_RS_NATIVE_LIBRARY_PATH: "/x/edr.node" },
    );
  });

  it("keeps '=' inside the value", () => {
    assert.deepEqual(parseEnvPairs(["NODE_OPTIONS=--require=x"]), {
      NODE_OPTIONS: "--require=x",
    });
  });

  it("returns an empty map for no values", () => {
    assert.deepEqual(parseEnvPairs([]), {});
  });

  it("rejects values without a key", () => {
    assert.throws(() => parseEnvPairs(["=nope"]), /KEY=VALUE/);
    assert.throws(() => parseEnvPairs(["nope"]), /KEY=VALUE/);
  });
});
