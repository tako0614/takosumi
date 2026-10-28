import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { expect, test } from "bun:test";
import {
  PORTABLE_GATE_PHASES,
  selectPortableGatePhases,
} from "../../scripts/check-portable-gate.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const EXPECTED_JOB_IDS = [
  "static",
  "tests",
  "dashboard-browser",
  "docs-browser",
  "check",
];
const EXTERNAL_ACTION = /^([^@]+)@([0-9a-f]{40})$/u;

type Workflow = {
  jobs?: Record<string, Record<string, unknown>>;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function commandFor(job: Record<string, unknown>, stepName: string): string {
  const steps = job.steps;
  requireCondition(Array.isArray(steps), "job steps must be an array");
  const step = steps.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>).name === stepName,
  ) as Record<string, unknown> | undefined;
  requireCondition(step, `missing step ${stepName}`);
  requireCondition(typeof step.run === "string", `${stepName} must run a command`);
  return step.run;
}

function selectedPhases(command: string) {
  const tokens = command.trim().split(/\s+/u);
  expect(tokens.slice(0, 3)).toEqual(["bun", "run", "check"]);
  return selectPortableGatePhases(tokens.slice(3));
}

function assertWorkflow(workflow: Workflow): void {
  const jobs = workflow.jobs;
  requireCondition(jobs && typeof jobs === "object", "workflow jobs are required");
  expect(Object.keys(jobs)).toEqual(EXPECTED_JOB_IDS);

  const known = new Set(PORTABLE_GATE_PHASES.map((phase) => phase.name));
  const staticJob = jobs.static!;
  const staticCommand = commandFor(staticJob, "Run static and build phases");
  const staticPhases = selectedPhases(staticCommand);

  const testsJob = jobs.tests!;
  requireCondition(
    (testsJob.steps as Record<string, unknown>[]).some(
      (step) => step.name === "Setup OpenTofu",
    ),
    "test shards must install OpenTofu for tests that use the live local proof",
  );
  const matrix = testsJob.strategy as Record<string, unknown> | undefined;
  requireCondition(matrix?.["fail-fast"] === false, "test shards must not cancel siblings");
  const matrixDefinition = matrix?.matrix as Record<string, unknown> | undefined;
  const shards = matrixDefinition?.shard;
  requireCondition(
    Array.isArray(shards) && shards.length > 0,
    "test shard indexes must be a non-empty array",
  );
  requireCondition(
    shards.every((value, index) => value === index + 1),
    "test shard indexes must be complete from 1 through N",
  );
  const shardCount = shards.length;
  expect(testsJob.name).toBe("tests (${{ matrix.shard }}/" + shardCount + ")");
  const testsCommand = commandFor(testsJob, "Run test phase shard");
  const testPhases = selectedPhases(testsCommand);
  expect(testPhases.map(({ name }) => name)).toEqual(["tests"]);
  const testsStep = (testsJob.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Run test phase shard",
  )!;
  const shardEnv = (testsStep.env as Record<string, unknown> | undefined)
    ?.TAKOSUMI_TEST_SHARD;
  expect(shardEnv).toBe("${{ matrix.shard }}/" + shardCount);

  const dashboardJob = jobs["dashboard-browser"]!;
  expect(dashboardJob.needs).toEqual(["static"]);
  const dashboardPhases = selectedPhases(
    commandFor(dashboardJob, "Run dashboard browser phase"),
  );
  expect(dashboardPhases.map(({ name }) => name)).toEqual([
    "dashboard-browser",
  ]);
  const upload = (staticJob.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Upload dashboard build for browser checks",
  );
  const download = (dashboardJob.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Download dashboard build",
  );
  requireCondition(upload && download, "dashboard build artifact handoff is required");
  const uploadWith = upload.with as Record<string, unknown>;
  const downloadWith = download.with as Record<string, unknown>;
  expect(uploadWith.path).toBe("dashboard/dist/");
  expect(uploadWith.name).toBe(downloadWith.name);

  const docsJob = jobs["docs-browser"]!;
  const docsPhases = selectedPhases(
    commandFor(docsJob, "Run docs browser phase"),
  );
  expect(docsPhases.map(({ name }) => name)).toEqual(["docs-browser"]);

  const assigned = new Map<string, number>();
  for (const phase of [
    ...staticPhases,
    ...testPhases,
    ...dashboardPhases,
    ...docsPhases,
  ]) {
    assigned.set(phase.name, (assigned.get(phase.name) ?? 0) + 1);
  }
  for (const phase of PORTABLE_GATE_PHASES) {
    requireCondition(
      assigned.get(phase.name) === 1,
      `phase ${phase.name} must be assigned exactly once`,
    );
  }
  expect([...assigned.keys()].sort()).toEqual([...known].sort());

  const aggregator = jobs.check!;
  expect(aggregator.name).toBe("check and test");
  expect(aggregator.if).toBe("always()");
  expect(aggregator.needs).toEqual([
    "static",
    "tests",
    "dashboard-browser",
    "docs-browser",
  ]);
  const aggregateCommand = commandFor(
    aggregator,
    "Require all quality jobs to succeed",
  );
  expect(aggregateCommand).toContain('[[ "$result" != success ]]');
  expect(aggregateCommand).toContain("exit 1");
  const aggregateStep = (aggregator.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Require all quality jobs to succeed",
  )!;
  const aggregateEnv = aggregateStep.env as Record<string, unknown>;
  const resultVariables = {
    STATIC_RESULT: "static",
    TESTS_RESULT: "tests",
    DASHBOARD_BROWSER_RESULT: "dashboard-browser",
    DOCS_BROWSER_RESULT: "docs-browser",
  } as const;
  for (const [variable, jobId] of Object.entries(resultVariables)) {
    expect(aggregateEnv[variable]).toBe(`\${{ needs.${jobId}.result }}`);
  }
  const resultLoop = aggregateCommand.match(/for result in ([^\n]+); do/u);
  expect(resultLoop?.[1]).toBe(
    Object.keys(resultVariables)
      .map((variable) => `"$${variable}"`)
      .join(" "),
  );

  for (const [jobId, job] of Object.entries(jobs)) {
    requireCondition(
      typeof job.permissions === "object" || typeof workflowPermissions(workflow) === "object",
      `${jobId} must declare permissions or inherit read-only workflow permissions`,
    );
    const steps = (job.steps as Record<string, unknown>[] | undefined) ?? [];
    for (const step of steps) {
      if (typeof step.uses !== "string") continue;
      const match = step.uses.match(EXTERNAL_ACTION);
      requireCondition(match, `${jobId} action must be pinned by full SHA: ${step.uses}`);
      if (match[1] === "actions/checkout") {
        expect((step.with as Record<string, unknown> | undefined)?.["persist-credentials"]).toBe(false);
      }
    }
  }
}

function workflowPermissions(workflow: Workflow): unknown {
  return (workflow as Workflow & { permissions?: unknown }).permissions;
}

test("quality workflow runs every portable gate phase exactly once", async () => {
  const source = await readFile(
    resolve(REPOSITORY_ROOT, ".github/workflows/quality.yml"),
    "utf8",
  );
  const workflow = parse(source) as Workflow;
  assertWorkflow(workflow);
});

test("workflow regression checks reject omitted, unknown, and restricted phases", async () => {
  const source = await readFile(
    resolve(REPOSITORY_ROOT, ".github/workflows/quality.yml"),
    "utf8",
  );
  const workflow = parse(source) as Workflow;

  const omitted = structuredClone(workflow);
  const staticJob = omitted.jobs!.static!;
  const staticStep = (staticJob.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Run static and build phases",
  )!;
  staticStep.run = "bun run check --except tests,dashboard,dashboard-browser,docs-browser";
  expect(() => assertWorkflow(omitted)).toThrow();

  const unknown = structuredClone(workflow);
  const unknownStep = (unknown.jobs!.static!.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Run static and build phases",
  )!;
  unknownStep.run = "bun run check --except tests,dashboard-browser,docs-browser,not-a-phase";
  expect(() => assertWorkflow(unknown)).toThrow("unknown portable gate phase: not-a-phase");

  const restricted = structuredClone(workflow);
  const restrictedStep = (restricted.jobs!.static!.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Run static and build phases",
  )!;
  restrictedStep.run =
    "bun run check --except tests,dashboard-browser,docs-browser --only tools";
  expect(() => assertWorkflow(restricted)).toThrow();
});

test("workflow regression checks reject incomplete shards and aggregator wiring", async () => {
  const source = await readFile(
    resolve(REPOSITORY_ROOT, ".github/workflows/quality.yml"),
    "utf8",
  );
  const workflow = parse(source) as Workflow;

  const missingShard = structuredClone(workflow);
  const matrix = (missingShard.jobs!.tests!.strategy as Record<string, unknown>)
    .matrix as Record<string, unknown>;
  matrix.shard = (matrix.shard as number[]).slice(0, -1);
  expect(() => assertWorkflow(missingShard)).toThrow();

  const mismatchedShard = structuredClone(workflow);
  const mismatchedMatrix = (mismatchedShard.jobs!.tests!.strategy as Record<string, unknown>)
    .matrix as Record<string, unknown>;
  const mismatchedShardCount = (mismatchedMatrix.shard as number[]).length - 1;
  const testStep = (mismatchedShard.jobs!.tests!.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Run test phase shard",
  )!;
  testStep.env = {
    TAKOSUMI_TEST_SHARD: "${{ matrix.shard }}/" + mismatchedShardCount,
  };
  expect(() => assertWorkflow(mismatchedShard)).toThrow();

  const missingNeed = structuredClone(workflow);
  missingNeed.jobs!.check!.needs = ["static", "tests", "dashboard-browser"];
  expect(() => assertWorkflow(missingNeed)).toThrow();

  const miswiredResult = structuredClone(workflow);
  const aggregateStep = (miswiredResult.jobs!.check!.steps as Record<string, unknown>[]).find(
    (step) => step.name === "Require all quality jobs to succeed",
  )!;
  const aggregateEnv = aggregateStep.env as Record<string, unknown>;
  aggregateEnv.STATIC_RESULT = "${{ needs.tests.result }}";
  expect(() => assertWorkflow(miswiredResult)).toThrow();
});
