/**
 * Run-failure Activity tests (Core Specification §27 audit_events / §34
 * Activity).
 *
 * A plan / destroy_plan / apply / destroy_apply that reaches a `failed` terminal
 * state records a Workspace-scoped `run.failed` Activity event so the dashboard's
 * Activity view shows the failure (not only the per-run audit trail). The event
 * carries PUBLIC-SAFE metadata only: a compact error CODE (never the raw
 * diagnostic message), the run phase, the operation, and the targeted
 * Capsule id.
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
  ActivityRecorder,
  RecordActivityInput,
} from "../../../../core/domains/activity/mod.ts";
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

/** A runner whose `plan` rejects with the given snake_case error code prefix. */
function planFailingRunner(message: string): OpenTofuRunner {
  return {
    plan: (_job: OpenTofuPlanJob) => Promise.reject(new Error(message)),
    apply: (_job: OpenTofuApplyJob) => Promise.resolve({}),
  };
}

/** A runner whose `plan` succeeds but whose `apply` rejects. */
function applyFailingRunner(
  message: string,
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
        ...over,
      }),
    apply: (_job: OpenTofuApplyJob) => Promise.reject(new Error(message)),
  };
}

async function seededFailureController(
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

test("a failed plan records a Workspace run.failed Activity event with a compact error code", async () => {
  const { controller, events } = await seededFailureController(
    planFailingRunner("runner_crashed: plan blew up at provider init"),
  );

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toEqual("failed");

  const failures = events.filter((e) => e.action === "run.failed");
  expect(failures).toHaveLength(1);
  const event = failures[0]!;
  expect(event.workspaceId).toEqual("ws_test001");
  expect(event.targetType).toEqual("run");
  expect(event.targetId).toEqual(planRun.id);
  expect(event.runId).toEqual(planRun.id);
  expect(event.metadata.phase).toEqual("plan");
  expect(event.metadata.operation).toEqual("create");
  expect(event.metadata.capsuleId).toEqual("cap_fixture1");
  // The compact CODE is surfaced; the raw diagnostic message is NOT.
  expect(event.metadata.errorCode).toEqual("plan_failed");
  expect(JSON.stringify(event.metadata)).not.toContain("blew up");
});

test("a failed apply records a Workspace run.failed Activity event tagged phase apply", async () => {
  const { controller, events } = await seededFailureController(
    applyFailingRunner("apply_rejected: provider returned 500"),
  );

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toEqual("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("failed");

  const failures = events.filter((e) => e.action === "run.failed");
  // Exactly one failure event (the apply), keyed to the apply run.
  expect(failures).toHaveLength(1);
  const event = failures[0]!;
  expect(event.workspaceId).toEqual("ws_test001");
  expect(event.targetId).toEqual(applyRun.id);
  expect(event.runId).toEqual(applyRun.id);
  expect(event.metadata.phase).toEqual("apply");
  expect(event.metadata.capsuleId).toEqual("cap_fixture1");
  expect(event.metadata.errorCode).toEqual("apply_failed");
});

test("a successful plan + apply records NO run.failed Activity event", async () => {
  // A plan that succeeds and an apply that returns a clean result must not emit
  // any failure event onto the Workspace Activity ledger.
  const { controller, events } = await seededFailureController({
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
      }),
    apply: (_job: OpenTofuApplyJob) => Promise.resolve({}),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toEqual("succeeded");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  expect(events.filter((e) => e.action === "run.failed")).toHaveLength(0);
});
