import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findMissingCommands } from "./regression.ts";
import type { ScenarioDefinition } from "../end-to-end/types.ts";

function definition(
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  return {
    description: "test",
    repo: "org/repo",
    commit: "abc123",
    packageManager: "npm",
    defaultCommand: "npx hardhat compile",
    tags: ["test"],
    ...overrides,
  };
}

describe("findMissingCommands", () => {
  it("returns empty when every scenario has at least one command", () => {
    const result = findMissingCommands([
      {
        id: "ok",
        definition: definition({
          benchmark: {
            commands: { build: { runs: 1, command: "npx hardhat compile" } },
          },
        }),
      },
    ]);

    assert.deepEqual(result, []);
  });

  it("flags scenarios with no benchmark field", () => {
    const result = findMissingCommands([
      { id: "no-bench", definition: definition() },
    ]);

    assert.deepEqual(result, [{ id: "no-bench", reason: "missing" }]);
  });

  it("flags scenarios with benchmark but no commands", () => {
    const result = findMissingCommands([
      { id: "no-cmds", definition: definition({ benchmark: {} }) },
    ]);

    assert.deepEqual(result, [{ id: "no-cmds", reason: "missing" }]);
  });

  it("flags scenarios with empty commands map", () => {
    const result = findMissingCommands([
      {
        id: "empty",
        definition: definition({ benchmark: { commands: {} } }),
      },
    ]);

    assert.deepEqual(result, [{ id: "empty", reason: "empty" }]);
  });

  it("returns one entry per offending scenario in input order", () => {
    const result = findMissingCommands([
      {
        id: "ok",
        definition: definition({
          benchmark: { commands: { x: { runs: 1, command: "x" } } },
        }),
      },
      { id: "no-bench", definition: definition() },
      {
        id: "empty",
        definition: definition({ benchmark: { commands: {} } }),
      },
    ]);

    assert.deepEqual(result, [
      { id: "no-bench", reason: "missing" },
      { id: "empty", reason: "empty" },
    ]);
  });
});
