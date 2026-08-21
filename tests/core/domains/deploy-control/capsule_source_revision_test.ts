import { expect, test } from "bun:test";

import type {
  ApplyRun,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import {
  CAPSULE_SOURCE_REVISION_LINEAGE_MISMATCH_REASON,
  getCapsuleAdoptedSourceSnapshot,
} from "../../../../core/domains/deploy-control/capsule_source_revision.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const NOW = "2026-08-21T00:00:00.000Z";

async function seededAppliedLineage() {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_revision_lineage",
    capsuleId: "cap_revision_lineage",
    sourceId: "src_revision_lineage",
    snapshotId: "snap_revision_lineage",
    environment: "preview",
  });
  const plan: PlanRun = {
    id: "plan_revision_lineage",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    capsuleCurrentStateVersionId: null,
    source: {
      kind: "git",
      url: seeded.source.url,
      commit: seeded.snapshot.resolvedCommit,
    },
    sourceDigest: "sha256:source",
    operation: "create",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: "sha256:plan",
    sourceSnapshotId: seeded.snapshot.id,
    capsuleContext: {
      workspaceId: seeded.capsule.workspaceId,
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
    },
    appliedApplyRunId: "apply_revision_lineage",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const apply: ApplyRun = {
    id: "apply_revision_lineage",
    planRunId: plan.id,
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    stateVersionId: "state_revision_lineage_1",
    operation: "create",
    runnerProfileId: plan.runnerProfileId,
    status: "succeeded",
    expected: {
      planRunId: plan.id,
      capsuleId: seeded.capsule.id,
      currentStateVersionId: null,
      runnerProfileId: plan.runnerProfileId,
      sourceDigest: plan.sourceDigest,
      variablesDigest: plan.variablesDigest,
      policyDecisionDigest: plan.policyDecisionDigest,
      planDigest: plan.planDigest!,
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "operator-managed", ref: "state://test" },
    stateLock: { status: "recorded", backendRef: "state://test" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(plan);
  await store.putApplyRun(apply);
  await store.putStateVersion({
    id: apply.stateVersionId!,
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: "state://generation/1",
    digest: "sha256:state-1",
    createdByRunId: apply.id,
    createdAt: NOW,
  });
  const capsule = await store.putCapsule({
    ...seeded.capsule,
    currentStateVersionId: apply.stateVersionId,
    currentStateGeneration: 1,
    status: "active",
    updatedAt: NOW,
  });
  return { store, seeded, capsule };
}

test("adopted Source revision follows an exact restore provenance edge", async () => {
  const { store, seeded, capsule } = await seededAppliedLineage();
  await store.putBackupRun({
    id: "restore_revision_lineage",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    type: "restore",
    status: "succeeded",
    restoredFromStateVersionId: capsule.currentStateVersionId,
    restoredStateVersionId: "state_revision_lineage_2",
    createdBy: "user_test",
    createdAt: NOW,
    finishedAt: NOW,
  });
  await store.putStateVersion({
    id: "state_revision_lineage_2",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 2,
    stateRef: "state://generation/2",
    digest: "sha256:state-2",
    createdByRunId: "restore_revision_lineage",
    createdAt: NOW,
  });
  const restored = await store.putCapsule({
    ...capsule,
    currentStateVersionId: "state_revision_lineage_2",
    currentStateGeneration: 2,
    status: "stale",
  });

  expect(await getCapsuleAdoptedSourceSnapshot(store, restored)).toEqual(
    seeded.snapshot,
  );
});

test("adopted Source revision fails closed on a cross-Workspace snapshot", async () => {
  const { store, seeded, capsule } = await seededAppliedLineage();
  await store.putSourceSnapshot({
    ...seeded.snapshot,
    workspaceId: "ws_foreign",
  });

  try {
    await getCapsuleAdoptedSourceSnapshot(store, capsule);
    throw new Error("expected lineage mismatch");
  } catch (error) {
    expect(error).toBeInstanceOf(OpenTofuControllerError);
    expect((error as OpenTofuControllerError).details).toEqual({
      reason: CAPSULE_SOURCE_REVISION_LINEAGE_MISMATCH_REASON,
    });
  }
});
