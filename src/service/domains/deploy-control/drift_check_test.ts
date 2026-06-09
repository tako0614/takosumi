/**
 * Installation drift-check tests (Core Specification §19 `drift_check`; Phase 8
 * advanced).
 *
 * A drift check is a plan-kind internal run flagged `driftCheck` that:
 *   - projects to the §19 `drift_check` run type;
 *   - NEVER parks waiting_approval (even in a production environment / on
 *     delete-replace changes that would normally require approval);
 *   - can NEVER be applied (`createApplyRun` rejects it);
 *   - on completion with a non-empty change summary emits
 *     `installation.drift_detected` with counts plus provider/resource
 *     type/action aggregates and public-safe remediation hints only; on an
 *     empty summary emits nothing and never changes the Installation status.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
} from "./mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import type { PlanRunSummary } from "@takosumi/internal/deploy-control-api";
import type { ActivityRecorder, RecordActivityInput } from "../activity/mod.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedInstallationModel,
  type SeedModelOptions,
} from "./test_model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}

/** A runner whose plan returns the given change summary/change projection. */
function summaryRunner(
  summary?: PlanRunSummary,
  over: Partial<OpenTofuPlanResult> = {},
): OpenTofuRunner {
  return {
    plan: (_job: OpenTofuPlanJob) =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        ...(summary ? { summary } : {}),
        ...over,
      }),
    apply: (_job: OpenTofuApplyJob) => Promise.resolve({}),
  };
}

/** Captures the Activity events the controller emits. */
function recordingActivity(): {
  recorder: ActivityRecorder;
  events: RecordActivityInput[];
} {
  const events: RecordActivityInput[] = [];
  const recorder: ActivityRecorder = {
    record: (event) => {
      events.push(event);
      return Promise.resolve(undefined);
    },
  };
  return { recorder, events };
}

async function seededDriftController(
  runner: OpenTofuRunner,
  options: SeedModelOptions = {},
): Promise<{
  store: OpenTofuDeploymentStore;
  controller: OpenTofuDeploymentController;
  events: RecordActivityInput[];
}> {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedInstallationModel(store, { environment: "preview", ...options });
  const { recorder, events } = recordingActivity();
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: fakeProviderVault() as never,
    activity: recorder,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  return { store, controller, events };
}

test("drift check succeeds, never parks waiting_approval, and projects type drift_check", async () => {
  // Production environment: a normal plan would require approval, but a drift
  // check must NOT park waiting_approval.
  const { controller } = await seededDriftController(
    summaryRunner({ add: 0, change: 2, destroy: 0 }),
    { environment: "production" },
  );

  const { planRun } =
    await controller.createInstallationDriftCheck("inst_fixture");
  expect(planRun.driftCheck).toBe(true);
  expect(planRun.status).toEqual("succeeded");

  const run = await controller.getRun(planRun.id);
  expect(run.type).toEqual("drift_check");
  expect(run.status).toEqual("succeeded");
});

test("a drift-check plan can never be applied", async () => {
  const { controller } = await seededDriftController(
    summaryRunner({ change: 1 }),
  );

  const { planRun } =
    await controller.createInstallationDriftCheck("inst_fixture");
  expect(planRun.status).toEqual("succeeded");

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    }),
  ).rejects.toThrow(/drift_check/);
});

test("drift check emits installation.drift_detected with provider/type/action aggregates and hints", async () => {
  const { controller, events } = await seededDriftController(
    summaryRunner(
      { add: 1, change: 2, destroy: 3 },
      {
        planResourceChanges: [
          {
            address: "cloudflare_workers_script.talk",
            type: "cloudflare_workers_script",
            actions: ["update"],
            scope: { cloudflareAccountId: "acct_must_not_leak" },
          },
          {
            address: "cloudflare_dns_record.talk",
            type: "cloudflare_dns_record",
            actions: ["delete", "create"],
            scope: { cloudflareZoneId: "zone_must_not_leak" },
          },
          {
            address: "random_pet.noop",
            type: "random_pet",
            actions: ["no-op"],
          },
          {
            address: "aws_s3_bucket.assets",
            type: "aws_s3_bucket",
            actions: ["create"],
            scope: {
              awsAccountId: "aws_account_must_not_leak",
              awsRegion: "us-east-1",
            },
          },
        ],
      },
    ),
  );

  const { planRun } =
    await controller.createInstallationDriftCheck("inst_fixture");

  const drift = events.filter(
    (e) => e.action === "installation.drift_detected",
  );
  expect(drift).toHaveLength(1);
  const event = drift[0]!;
  expect(event.spaceId).toEqual("space_test");
  expect(event.targetType).toEqual("installation");
  expect(event.targetId).toEqual("inst_fixture");
  expect(event.runId).toEqual(planRun.id);
  // Counts + provider/resource class only; never resource addresses, scope ids,
  // or values.
  expect(event.metadata).toEqual({
    installationId: "inst_fixture",
    add: 1,
    change: 2,
    destroy: 3,
    resourceTypes: {
      aws_s3_bucket: 1,
      cloudflare_dns_record: 1,
      cloudflare_workers_script: 1,
    },
    providers: {
      aws: 1,
      cloudflare: 2,
    },
    actions: {
      create: 1,
      "delete+create": 1,
      update: 1,
    },
    remediationHints: [
      {
        code: "review_replacements",
        severity: "warning",
        category: "replacement",
        action: "create a reviewed update plan before applying remediation",
      },
      {
        code: "cloudflare_dns_drift",
        severity: "info",
        provider: "cloudflare",
        category: "dns",
        action: "compare zone records against the last reviewed plan",
      },
      {
        code: "cloudflare_workers_drift",
        severity: "info",
        provider: "cloudflare",
        category: "compute",
        action:
          "compare Worker script and route settings against the last reviewed plan",
      },
      {
        code: "aws_storage_drift",
        severity: "info",
        provider: "aws",
        category: "storage",
        action:
          "compare bucket configuration against the last reviewed plan",
      },
    ],
  });
  const metadataJson = JSON.stringify(event.metadata);
  expect(metadataJson).not.toContain("cloudflare_dns_record.talk");
  expect(metadataJson).not.toContain("aws_s3_bucket.assets");
  expect(metadataJson).not.toContain("acct_must_not_leak");
  expect(metadataJson).not.toContain("zone_must_not_leak");
  expect(metadataJson).not.toContain("aws_account_must_not_leak");
  expect(metadataJson).not.toContain("us-east-1");
});

test("drift check emits NOTHING on an empty plan and does not change the Installation status", async () => {
  // No summary at all (no changes observed).
  const { store, controller, events } = await seededDriftController(
    summaryRunner(undefined),
  );

  const before = (await store.getInstallation("inst_fixture"))!.status;
  const { planRun } =
    await controller.createInstallationDriftCheck("inst_fixture");
  expect(planRun.status).toEqual("succeeded");

  expect(
    events.filter((e) => e.action === "installation.drift_detected"),
  ).toHaveLength(0);
  // No status change (the spec has no `drifted` status).
  const after = (await store.getInstallation("inst_fixture"))!.status;
  expect(after).toEqual(before);
});

test("drift check with an all-zero summary emits nothing (no drift)", async () => {
  const { controller, events } = await seededDriftController(
    summaryRunner({ add: 0, change: 0, destroy: 0 }),
  );

  await controller.createInstallationDriftCheck("inst_fixture");
  expect(
    events.filter((e) => e.action === "installation.drift_detected"),
  ).toHaveLength(0);
});

test("listActiveInstallations returns only active installations, bounded", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  // Seed three installations: two active, one pending.
  await seedInstallationModel(store, {
    installationId: "inst_a",
    sourceId: "src_a",
    installConfigId: "cfg_a",
    name: "a",
  });
  await seedInstallationModel(store, {
    installationId: "inst_b",
    sourceId: "src_b",
    installConfigId: "cfg_b",
    name: "b",
  });
  await seedInstallationModel(store, {
    installationId: "inst_c",
    sourceId: "src_c",
    installConfigId: "cfg_c",
    name: "c",
  });
  // Promote a + b to active; c stays pending.
  await store.patchInstallation("inst_a", { status: "active" });
  await store.patchInstallation("inst_b", { status: "active" });

  const controller = new OpenTofuDeploymentController({ store });
  const active = await controller.listActiveInstallations(20);
  expect(active.map((i) => i.id).sort()).toEqual(["inst_a", "inst_b"]);

  // Bounded: a limit of 1 returns at most one.
  expect((await controller.listActiveInstallations(1)).length).toEqual(1);
  // Non-positive limit returns empty.
  expect((await controller.listActiveInstallations(0)).length).toEqual(0);
});
