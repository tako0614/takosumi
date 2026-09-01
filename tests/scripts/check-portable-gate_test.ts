import { expect, test } from "bun:test";

import {
  FAST_GATE_SKIPPED_PHASES,
  fastGatePhases,
  PORTABLE_GATE_PHASES,
  PortableGateFailure,
  runPortableGate,
  validatePortableGatePhases,
} from "../../scripts/check-portable-gate.ts";

test("preserves the complete check phase order and commands", () => {
  validatePortableGatePhases(PORTABLE_GATE_PHASES);

  expect(PORTABLE_GATE_PHASES.map((phase) => phase.name)).toEqual([
    "format",
    "package-script-boundaries",
    "production-migrations",
    "no-first-party-provider",
    "generated-assets",
    "service-form-runtime-artifacts",
    "authoritative-docs",
    "import-boundaries",
    "test-source-boundary",
    "unreferenced-exports",
    "generalization-boundaries",
    "tests",
    "typescript",
    "dashboard",
    "dashboard-browser",
    "docs-browser",
    "worker-types",
    "cloudflare-worker-build",
  ]);
  expect(PORTABLE_GATE_PHASES.map((phase) => phase.command.join(" "))).toEqual([
    "bun run fmt:check",
    "bun run check:package-script-boundaries",
    "bun run check:production-migrations",
    "bun run check:no-first-party-provider",
    "bun run generated-assets:check",
    "bun run service-form:runtime-artifacts:check",
    "bun run check:authoritative-docs",
    "bun run check:import-boundaries",
    "bun run check:test-source-boundary",
    "bun run check:unreferenced-exports",
    "bun run check:generalization-boundaries",
    "bun run test",
    "tsc --noEmit",
    "bun run check:dashboard",
    "bun run check:dashboard-browser",
    "bun run docs:test:browser",
    "bun run check:worker-types",
    "bun run check:cloudflare-worker-build",
  ]);
});

test("rejects duplicate phases and missing global sweeps", () => {
  expect(() =>
    validatePortableGatePhases([
      ...PORTABLE_GATE_PHASES,
      PORTABLE_GATE_PHASES[0]!,
    ]),
  ).toThrow("duplicate portable gate phase");

  expect(() =>
    validatePortableGatePhases(
      PORTABLE_GATE_PHASES.filter((phase) => phase.name !== "typescript"),
    ),
  ).toThrow("exactly one global TypeScript sweep");

  expect(() =>
    validatePortableGatePhases(
      PORTABLE_GATE_PHASES.filter((phase) => phase.name !== "tests"),
    ),
  ).toThrow("exactly one global test sweep");
});

test("prints per-phase timings and stops at the first failure", async () => {
  const events: string[] = [];
  const commands: string[] = [];
  let clock = 0;
  const phases = [
    { name: "first", command: ["first"] },
    { name: "second", command: ["second"] },
    { name: "never", command: ["never"] },
  ] as const;

  await expect(
    runPortableGate(
      {
        now: () => clock,
        write: (line) => events.push(line),
        run: async (command) => {
          commands.push(command.join(" "));
          clock += command[0] === "first" ? 1250 : 2750;
          return command[0] === "second" ? 7 : 0;
        },
      },
      [
        ...phases.map((phase) => ({
          name: phase.name,
          command: phase.command,
        })),
        { name: "typescript", command: ["tsc", "--noEmit"] },
        { name: "tests", command: ["bun", "run", "test"] },
      ],
    ),
  ).rejects.toBeInstanceOf(PortableGateFailure);

  expect(commands).toEqual(["first", "second"]);
  expect(events).toContain("[portable-check] ✓ first (1.25s)");
  expect(events).toContain("[portable-check] ✗ second (2.75s, exit 7)");
  expect(events.join("\n")).not.toContain("never");
  expect(events.join("\n")).not.toContain("complete (");
});

test("attributes a command-start failure to the phase", async () => {
  const events: string[] = [];
  const phases = [
    { name: "first", command: ["first"] },
    { name: "typescript", command: ["tsc", "--noEmit"] },
    { name: "tests", command: ["bun", "run", "test"] },
  ] as const;

  const failure = runPortableGate(
    {
      write: (line) => events.push(line),
      run: async () => {
        throw new Error("spawn unavailable");
      },
    },
    phases,
  );

  await expect(failure).rejects.toMatchObject({
    name: "PortableGateFailure",
    phase: phases[0],
    exitCode: null,
  });
  expect(events).toContain(
    "[portable-check] ✗ first (0.00s, could not start)",
  );
});

test("prints a total timing after every phase succeeds", async () => {
  const events: string[] = [];
  let clock = 0;
  await runPortableGate(
    {
      now: () => clock,
      write: (line) => events.push(line),
      run: async () => {
        clock += 500;
        return 0;
      },
    },
    [
      { name: "typescript", command: ["tsc", "--noEmit"] },
      { name: "tests", command: ["bun", "run", "test"] },
    ],
  );

  expect(events).toContain("[portable-check] ✓ typescript (0.50s)");
  expect(events).toContain("[portable-check] ✓ tests (0.50s)");
  expect(events).toContain("[portable-check] complete (1.00s)");
});

test("--fast keeps every non-browser phase and stays a valid gate", () => {
  const fast = fastGatePhases();

  // The inner loop must still be a real gate: same validation, both global
  // sweeps present, nothing reordered.
  validatePortableGatePhases(fast);
  expect(fast.map((phase) => phase.name)).toEqual([
    "format",
    "package-script-boundaries",
    "production-migrations",
    "no-first-party-provider",
    "generated-assets",
    "service-form-runtime-artifacts",
    "authoritative-docs",
    "import-boundaries",
    "test-source-boundary",
    "unreferenced-exports",
    "generalization-boundaries",
    "tests",
    "typescript",
    "worker-types",
    "cloudflare-worker-build",
  ]);
});

test("--fast never silently drops a phase the complete gate adds", () => {
  const skipped = PORTABLE_GATE_PHASES.filter(
    (phase) => !fastGatePhases().some((fast) => fast.name === phase.name),
  ).map((phase) => phase.name);

  expect(skipped).toEqual([...FAST_GATE_SKIPPED_PHASES]);
  for (const name of FAST_GATE_SKIPPED_PHASES) {
    expect(PORTABLE_GATE_PHASES.some((phase) => phase.name === name)).toBe(
      true,
    );
  }
});
