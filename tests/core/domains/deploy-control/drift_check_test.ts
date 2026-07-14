/**
 * Capsule drift-check tests (Core Specification §19 `drift_check`; Phase 8
 * advanced).
 *
 * A drift check is a plan-kind internal run flagged `driftCheck` that:
 *   - projects to the §19 `drift_check` run type;
 *   - NEVER parks waiting_approval (even in a production environment / on
 *     delete-replace changes that would normally require approval);
 *   - can NEVER be applied (`createApplyRun` rejects it);
 *   - on completion with a non-empty change summary emits
 *     `capsule.drift_detected` with counts plus provider/resource
 *     type/action aggregates and public-safe remediation hints only; on an
 *     empty summary emits nothing and never changes the Capsule status.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type {
  PlanRun,
  PlanRunSummary,
} from "@takosumi/internal/deploy-control-api";
import type {
  ActivityRecorder,
  RecordActivityInput,
} from "../../../../core/domains/activity/mod.ts";
import { DriftService } from "../../../../core/domains/deploy-control/drift_service.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
  type SeedCapsuleModelOptions,
} from "../../../helpers/deploy-control/model_fixture.ts";

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
  options: SeedCapsuleModelOptions = {},
): Promise<{
  store: OpenTofuControlStore;
  controller: OpenTofuController;
  events: RecordActivityInput[];
}> {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_test001",
    capsuleId: "cap_fixture1",
    environment: "preview",
    ...options,
  });
  await seedProviderConnections(store, seeded.capsule);
  const { recorder, events } = recordingActivity();
  const controller = new OpenTofuController({
    store,
    runner,
    vault: fakeProviderVault() as never,
    activity: recorder,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
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

  const { planRun } = await controller.createCapsuleDriftCheck("cap_fixture1");
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

  const { planRun } = await controller.createCapsuleDriftCheck("cap_fixture1");
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

test("drift check emits capsule.drift_detected with generic type/action aggregates and hints", async () => {
  const { controller, events } = await seededDriftController(
    summaryRunner(
      { add: 1, change: 2, destroy: 3 },
      {
        planResourceChanges: [
          {
            address: "cloudflare_workers_script.talk",
            type: "cloudflare_workers_script",
            actions: ["update"],
            scope: { facts: { account_id: "acct_must_not_leak" } },
          },
          {
            address: "cloudflare_dns_record.talk",
            type: "cloudflare_dns_record",
            actions: ["delete", "create"],
            scope: { facts: { zone_id: "zone_must_not_leak" } },
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
              facts: {
                account_id: "aws_account_must_not_leak",
                region: "us-east-1",
              },
            },
          },
        ],
      },
    ),
  );

  const { planRun } = await controller.createCapsuleDriftCheck("cap_fixture1");

  const drift = events.filter((e) => e.action === "capsule.drift_detected");
  expect(drift).toHaveLength(1);
  const event = drift[0]!;
  expect(event.workspaceId).toEqual("ws_test001");
  expect(event.targetType).toEqual("capsule");
  expect(event.targetId).toEqual("cap_fixture1");
  expect(event.runId).toEqual(planRun.id);
  // Counts + provider/resource class only; never resource addresses, scope ids,
  // or values.
  expect(event.metadata).toEqual({
    capsuleId: "cap_fixture1",
    add: 1,
    change: 2,
    destroy: 3,
    resourceTypes: {
      aws_s3_bucket: 1,
      cloudflare_dns_record: 1,
      cloudflare_workers_script: 1,
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

test("first-class Resource drift emits resource.drift_detected against the Resource subject", async () => {
  const events: RecordActivityInput[] = [];
  const drift = new DriftService({
    createPlanRun: () => {
      throw new Error("not used");
    },
    recordActivity: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  const planRun = {
    id: "plan_resource_drift_1",
    workspaceId: "ws_test001",
    summary: { add: 0, change: 1, destroy: 0 },
    resourceContext: {
      workspaceId: "ws_test001",
      resourceId: "tkrn:ws_test001:ObjectBucket:assets",
      environment: "production",
      providerBinding: {
        provider: "cloudflare",
        providerSource: FIXTURE_CLOUDFLARE_PROVIDER,
      },
    },
  } as PlanRun;

  await drift.recordDriftDetected(planRun, [
    {
      address: "cloudflare_r2_bucket.assets",
      type: "cloudflare_r2_bucket",
      actions: ["update"],
    },
  ]);

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: "resource.drift_detected",
    targetType: "resource",
    targetId: "tkrn:ws_test001:ObjectBucket:assets",
    metadata: {
      resourceId: "tkrn:ws_test001:ObjectBucket:assets",
      change: 1,
    },
  });
});

test("drift check emits NOTHING on an empty plan and does not change the Capsule status", async () => {
  // No summary at all (no changes observed).
  const { store, controller, events } = await seededDriftController(
    summaryRunner(undefined),
  );

  const before = (await store.getCapsule("cap_fixture1"))!.status;
  const { planRun } = await controller.createCapsuleDriftCheck("cap_fixture1");
  expect(planRun.status).toEqual("succeeded");

  expect(
    events.filter((e) => e.action === "capsule.drift_detected"),
  ).toHaveLength(0);
  // No status change (the spec has no `drifted` status).
  const after = (await store.getCapsule("cap_fixture1"))!.status;
  expect(after).toEqual(before);
});

test("drift check with an all-zero summary emits nothing (no drift)", async () => {
  const { controller, events } = await seededDriftController(
    summaryRunner({ add: 0, change: 0, destroy: 0 }),
  );

  await controller.createCapsuleDriftCheck("cap_fixture1");
  expect(
    events.filter((e) => e.action === "capsule.drift_detected"),
  ).toHaveLength(0);
});

test("listActiveCapsules returns only active Capsules, bounded", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // Seed three Capsules: two active, one pending.
  await seedCapsuleModel(store, {
    capsuleId: "cap_active01",
    sourceId: "src_a",
    installConfigId: "cfg_a",
    name: "a",
  });
  await seedCapsuleModel(store, {
    capsuleId: "cap_active02",
    sourceId: "src_b",
    installConfigId: "cfg_b",
    name: "b",
  });
  await seedCapsuleModel(store, {
    capsuleId: "cap_pending1",
    sourceId: "src_c",
    installConfigId: "cfg_c",
    name: "c",
  });
  // Promote a + b to active; c stays pending.
  await store.patchCapsule("cap_active01", { status: "active" });
  await store.patchCapsule("cap_active02", { status: "active" });

  const controller = new OpenTofuController({ store });
  const active = await controller.listActiveCapsules(20);
  expect(active.map((i) => i.id).sort()).toEqual([
    "cap_active01",
    "cap_active02",
  ]);

  // Bounded: a limit of 1 returns at most one.
  expect((await controller.listActiveCapsules(1)).length).toEqual(1);
  // Non-positive limit returns empty.
  expect((await controller.listActiveCapsules(0)).length).toEqual(0);
});
