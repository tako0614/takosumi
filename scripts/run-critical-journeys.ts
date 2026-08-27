import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The portable, read-only scenarios that make up Takosumi's local critical
 * journey loop.
 *
 * Keep this list pointed at existing tests. The command is deliberately a
 * runner and inventory, not a second implementation of the product flow.
 */
export type CriticalJourney = {
  readonly id: string;
  readonly title: string;
  readonly tests: readonly string[];
  readonly negativeControls: readonly {
    readonly path: string;
    readonly description: string;
  }[];
};

export const CRITICAL_JOURNEYS: readonly CriticalJourney[] = [
  {
    id: "source-install",
    title: "Git repository source install preparation",
    tests: [
      "tests/lib/opentofu-configuration/src/mod_test.ts",
      "tests/worker/src/runner_source_sync_test.ts",
      "tests/core/domains/capsules/repository_install_ux_compiler_test.ts",
      "tests/core/api/deploy_control_source_routes_test.ts",
    ],
    negativeControls: [
      {
        path: "tests/lib/opentofu-configuration/src/mod_test.ts",
        description:
          "fails closed for ambiguous local topology, scan limits, and remote modules",
      },
      {
        path: "tests/core/api/deploy_control_source_routes_test.ts",
        description: "rejects missing auth, out-of-scope workspaces, and URLs",
      },
    ],
  },
  {
    id: "plan-apply-approval",
    title: "plan/apply and unchanged approval boundary",
    tests: [
      "tests/core/domains/deploy-control/approve_run_test.ts",
      "tests/core/domains/deploy-control/apply_create_once_test.ts",
      "tests/core/domains/deploy-control/stale_propagation_test.ts",
    ],
    negativeControls: [
      {
        path: "tests/core/domains/deploy-control/approve_run_test.ts",
        description: "refuses unapproved destructive plans and bad approvals",
      },
      {
        path: "tests/core/domains/deploy-control/apply_create_once_test.ts",
        description: "rejects a stale recovery checkpoint instead of substituting it",
      },
    ],
  },
  {
    id: "output-interface-readback",
    title: "Output/Interface readback without secrets",
    tests: [
      "tests/core/api/capsule_output_routes_test.ts",
      "tests/core/api/interface_routes_test.ts",
      "tests/core/domains/interfaces/run_lifecycle_test.ts",
      "tests/core/domains/observability/redaction_test.ts",
    ],
    negativeControls: [
      {
        path: "tests/core/api/capsule_output_routes_test.ts",
        description: "fails closed for dangling cursors, mismatches, and missing bearer",
      },
      {
        path: "tests/core/api/interface_routes_test.ts",
        description: "blocks cross-Workspace and unauthenticated Interface access",
      },
      {
        path: "tests/core/domains/observability/redaction_test.ts",
        description: "masks bearer, token, private-key, and credential URL values",
      },
    ],
  },
  {
    id: "destroy-recreate-idempotency",
    title: "destroy/recreate/idempotency conflict handling",
    tests: [
      "tests/core/domains/interfaces/service_test.ts",
    ],
    negativeControls: [
      {
        path: "tests/core/domains/interfaces/service_test.ts",
        description: "keeps Interface and Binding lifecycle authority scoped",
      },
    ],
  },
  {
    id: "dashboard-install",
    title: "dashboard install route and browser harness",
    tests: [
      "tests/dashboard/src/views/new/install-view_test.ts",
      "tests/dashboard/src/views/new/install-execution_test.ts",
      "tests/dashboard/e2e/harness_test.ts",
    ],
    negativeControls: [
      {
        path: "tests/dashboard/src/views/new/install-view_test.ts",
        description: "keeps non-ready compatibility out of Capsule creation",
      },
      {
        path: "tests/dashboard/e2e/harness_test.ts",
        description: "rejects unsafe browser state and unexpected required-route failures",
      },
    ],
  },
] as const;

const TEST_TIMEOUT_MS = 30_000;
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEST_ROOT_PREFIXES = [
  "tests/contract/",
  "tests/core/",
  "tests/dashboard/",
  "tests/lib/",
  "tests/worker/",
];

/**
 * Build the only command this entrypoint is allowed to execute for a journey.
 * Keeping this exact shape prevents a future edit from turning the local lane
 * into a deploy, live smoke, or production operation.
 */
export function buildTestCommand(
  journey: CriticalJourney,
): readonly string[] {
  return ["bun", "test", "--timeout", String(TEST_TIMEOUT_MS), ...journey.tests];
}

function assertRelativeTestPath(path: string, repoRoot: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("..") ||
    !TEST_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    !path.endsWith("_test.ts")
  ) {
    throw new Error(`critical journey contains a non-portable test path: ${path}`);
  }

  const absolute = resolve(repoRoot, path);
  if (!existsSync(absolute)) {
    throw new Error(`critical journey test does not exist: ${path}`);
  }

  const resolvedRelative = relative(realpathSync(repoRoot), realpathSync(absolute));
  if (resolvedRelative !== path) {
    throw new Error(`critical journey test escapes the repository or uses a symlink: ${path}`);
  }
}

/**
 * Validate the inventory before spawning Bun. Tests use this same validator so
 * the command cannot silently become empty or gain an unsafe execution mode.
 */
export function validateCriticalJourneyInventory(
  journeys: readonly CriticalJourney[] = CRITICAL_JOURNEYS,
  repoRoot = REPO_ROOT,
): void {
  if (journeys.length === 0) {
    throw new Error("critical journey inventory is empty");
  }

  const ids = new Set<string>();
  for (const journey of journeys) {
    if (!journey.id || ids.has(journey.id)) {
      throw new Error(`critical journey id is empty or duplicated: ${journey.id}`);
    }
    ids.add(journey.id);

    if (journey.tests.length === 0) {
      throw new Error(`critical journey has no tests: ${journey.id}`);
    }
    if (journey.negativeControls.length === 0) {
      throw new Error(`critical journey has no negative control: ${journey.id}`);
    }

    const command = buildTestCommand(journey);
    if (
      command[0] !== "bun" ||
      command[1] !== "test" ||
      command[2] !== "--timeout" ||
      command.length < 5
    ) {
      throw new Error(`critical journey command is not a local Bun test: ${journey.id}`);
    }
    for (const path of journey.tests) {
      assertRelativeTestPath(path, repoRoot);
    }
    for (const negativeControl of journey.negativeControls) {
      assertRelativeTestPath(negativeControl.path, repoRoot);
      if (!negativeControl.description.trim()) {
        throw new Error(
          `critical journey negative control has no description: ${journey.id}`,
        );
      }
      if (!journey.tests.includes(negativeControl.path)) {
        throw new Error(
          `negative control is outside its journey command: ${journey.id} ${negativeControl.path}`,
        );
      }
    }
  }
}

async function runJourney(
  journey: CriticalJourney,
  repoRoot: string,
): Promise<number> {
  const command = buildTestCommand(journey);
  console.log(`\n== ${journey.title} (${journey.id}) ==`);
  console.log(
    `negative controls: ${journey.negativeControls
      .map((control) => control.description)
      .join("; ")}`,
  );
  console.log(`$ ${command.join(" ")}`);

  const started = performance.now();
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  const elapsed = ((performance.now() - started) / 1000).toFixed(2);
  if (exitCode !== 0) {
    console.error(`x ${journey.id} failed in ${elapsed}s (exit ${exitCode})`);
  } else {
    console.log(`ok ${journey.id} in ${elapsed}s`);
  }
  return exitCode;
}

export async function main(
  journeys: readonly CriticalJourney[] = CRITICAL_JOURNEYS,
  repoRoot = REPO_ROOT,
): Promise<number> {
  if (process.argv.slice(2).length > 0) {
    console.error("usage: bun scripts/run-critical-journeys.ts");
    return 2;
  }

  try {
    validateCriticalJourneyInventory(journeys, repoRoot);
  } catch (error) {
    console.error(`x critical journey inventory rejected: ${String(error)}`);
    return 2;
  }

  const started = performance.now();
  console.log(
    `Takosumi critical journeys: ${journeys.length} groups, ${journeys.reduce(
      (count, journey) => count + journey.tests.length,
      0,
    )} test files (portable/read-only)`,
  );

  for (const journey of journeys) {
    const exitCode = await runJourney(journey, repoRoot);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  console.log(
    `\nok critical journeys passed in ${(
      (performance.now() - started) /
      1000
    ).toFixed(2)}s; run "bun run check" for the complete owner gate`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
