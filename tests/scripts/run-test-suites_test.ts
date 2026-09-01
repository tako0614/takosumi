import { expect, test } from "bun:test";
import {
  summarizeStages,
  TEST_STAGES,
} from "../../scripts/run-test-suites.ts";

test("every stage runs; a failing stage does not hide the others", () => {
  const summary = summarizeStages([
    { name: "portable", exitCode: 0, durationMilliseconds: 142_520 },
    { name: "workerd", exitCode: 1, durationMilliseconds: 9_360 },
  ]);

  expect(summary.failed).toEqual(["workerd"]);
  expect(summary.lines).toEqual([
    "[test] ✓ portable (142.52s)",
    "[test] ✗ workerd (9.36s, exit 1)",
  ]);
});

test("a clean run reports no failures", () => {
  const summary = summarizeStages([
    { name: "portable", exitCode: 0, durationMilliseconds: 1_000 },
    { name: "workerd", exitCode: 0, durationMilliseconds: 2_000 },
  ]);

  expect(summary.failed).toEqual([]);
});

test("the portable sweep is the first stage and both stages are declared", () => {
  expect(TEST_STAGES.map((stage) => stage.name)).toEqual([
    "portable",
    "workerd",
  ]);
  expect(TEST_STAGES.map((stage) => stage.script)).toEqual([
    "test:portable",
    "test:workerd",
  ]);
});
