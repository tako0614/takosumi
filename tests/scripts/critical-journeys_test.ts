import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CRITICAL_JOURNEYS,
  buildTestCommand,
  validateCriticalJourneyInventory,
} from "../../scripts/run-critical-journeys.ts";
import { PORTABLE_GATE_PHASES } from "../../scripts/check-portable-gate.ts";
import { TEST_STAGES } from "../../scripts/run-test-suites.ts";

const root = resolve(import.meta.dir, "../..");

test("critical journey inventory is non-empty, grouped, and negative-controlled", () => {
  validateCriticalJourneyInventory(CRITICAL_JOURNEYS, root);
  expect(CRITICAL_JOURNEYS.length).toBeGreaterThanOrEqual(5);
  expect(CRITICAL_JOURNEYS.every((journey) => journey.tests.length > 0)).toBe(
    true,
  );
  expect(
    CRITICAL_JOURNEYS.every((journey) => journey.negativeControls.length > 0),
  ).toBe(true);
});

test("journey commands are local Bun test invocations only", () => {
  for (const journey of CRITICAL_JOURNEYS) {
    const command = buildTestCommand(journey);
    expect(command.slice(0, 4)).toEqual(["bun", "test", "--timeout", "30000"]);
    expect(command.slice(4)).toEqual(journey.tests);
    expect(command.some((part) => /(?:^|\/)live(?:$|\/)|production/i.test(part))).toBe(
      false,
    );
  }
});

test("inventory rejects an empty group or an execution path outside portable tests", () => {
  expect(() => validateCriticalJourneyInventory([], root)).toThrow(
    /inventory is empty/u,
  );

  const invalid = {
    id: "invalid",
    title: "invalid",
    tests: ["scripts/deploy.mjs"],
    negativeControls: [
      { path: "scripts/deploy.mjs", description: "not a test" },
    ],
  } as const;
  expect(() => validateCriticalJourneyInventory([invalid], root)).toThrow(
    /non-portable test path/u,
  );
});

test("package exposes the focused command without changing the complete gate", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  ) as {
    readonly scripts?: Record<string, string>;
  };
  expect(packageJson.scripts?.["test:critical-journeys"]).toBe(
    "bun scripts/run-critical-journeys.ts",
  );
  const workerd = packageJson.scripts?.["test:workerd"] ?? "";
  const portable = packageJson.scripts?.["test:portable"] ?? "";
  expect(workerd).toContain("bun test --isolate");
  // The isolated stage starts a real workerd / OpenTofu process; bun's 5s
  // default timeout is not a budget it can meet on a cold host.
  expect(workerd).toContain("--timeout=");
  // Both stages run: the isolated files are excluded from the portable sweep
  // and each is named exactly once in the isolated stage.
  for (const isolatedWorkerdTest of [
    "tests/runner/compatibility_check_test.ts",
    "tests/core/domains/interfaces/runtime_capability_reader_workerd_test.ts",
    "tests/core/domains/deploy-control/capsule_execution_authority_test.ts",
  ]) {
    expect(portable).toContain(
      `--path-ignore-patterns=${isolatedWorkerdTest}`,
    );
    expect(workerd).toContain(isolatedWorkerdTest);
  }
  // `bun run test` must not chain the stages, or one stage's failure hides
  // the other stage's result.
  expect(packageJson.scripts?.test).toBe("bun scripts/run-test-suites.ts");
  expect(TEST_STAGES.map((stage) => stage.script)).toEqual([
    "test:portable",
    "test:workerd",
  ]);
  expect(packageJson.scripts?.check).toBe("bun scripts/check-portable-gate.ts");
  expect(
    PORTABLE_GATE_PHASES.some(
      ({ command }) => command.join(" ") === "bun run test",
    ),
  ).toBe(true);
});
