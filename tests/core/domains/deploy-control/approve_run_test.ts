import { expect, test } from "bun:test";

import {
  applyExpectedGuardFromPlanRun,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  planRunExecutionInputsDigestMaterial,
  type OpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * Seeds a plan parked in the persisted `waiting_approval` state so we can
 * drive the approve transition directly.
 */
async function seedWaitingApprovalPlan(
  store: InMemoryOpenTofuControlStore,
  id = "plan_wait",
): Promise<PlanRun> {
  await store.putWorkspace({
    id: "workspace_1",
    handle: "workspace-1",
    displayName: "Workspace 1",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  });
  const management = await store.getWorkspaceManagement("workspace_1");
  if (!management || management.managementState !== "active") {
    throw new Error("fixture Workspace workspace_1 is not active");
  }
  const inputs = { planRunId: id, variables: {} } as const;
  const planRun: PlanRun = {
    id,
    workspaceId: "workspace_1",
    source: { kind: "git", url: "https://x/r.git", ref: "main", path: "." },
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: await stableJsonDigest(inputs.variables),
    executionInputsDigest: await stableJsonDigest(
      planRunExecutionInputsDigestMaterial(inputs, undefined),
    ),
    requiredProviders: [],
    status: "waiting_approval",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: PLAN_DIGEST,
    planArtifact: {
      kind: "runner-local",
      ref: "rl://plan",
      digest: PLAN_DIGEST,
    },
    requiresApproval: true,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.preparePlanRun({
    run: planRun,
    inputs,
    expectedWorkspaceManagementAuthority: {
      workspaceId: management.workspaceId,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    },
  });
  return planRun;
}

async function activeWorkspaceAuthority(
  store: OpenTofuControlStore,
): Promise<WorkspaceManagementAuthority> {
  const management = await store.getWorkspaceManagement("workspace_1");
  if (!management || management.managementState !== "active") {
    throw new Error("fixture Workspace workspace_1 is not active");
  }
  return {
    workspaceId: management.workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  };
}

function restoreWaitingApprovalRun(id: string): Run {
  return {
    id,
    workspaceId: "workspace_1",
    type: "restore",
    status: "waiting_approval",
    backupId: `backup_${id}`,
    capsuleId: `capsule_${id}`,
    restoreStateGeneration: 1,
    createdBy: "operator",
    createdAt: "2026-09-08T00:00:00.000Z",
  };
}

async function seedRestoreRun(
  store: OpenTofuControlStore,
  id: string,
  status: Run["status"] = "waiting_approval",
): Promise<Run> {
  await store.putWorkspace({
    id: "workspace_1",
    handle: "workspace-1",
    displayName: "Workspace 1",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  });
  const authority = await activeWorkspaceAuthority(store);
  const restore = { ...restoreWaitingApprovalRun(id), status } as Run;
  if (status === "waiting_approval") {
    await store.beginRestoreRun(restore, authority);
  } else {
    const queued = { ...restore, status: "queued" as const };
    await store.beginRestoreRun(queued, authority);
    await store.transitionRun({
      id,
      kind: "restore",
      expectFrom: ["queued"],
      run: restore,
    });
  }
  return restore;
}

async function d1ApprovalFixture(): Promise<{
  readonly database: SqliteFakeD1;
  readonly store: OpenTofuControlStore;
  readonly plan: PlanRun;
}> {
  const database = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(database);
  const store = new CloudflareD1OpenTofuControlStore(database);
  await store.putWorkspace({
    id: "workspace_1",
    handle: "workspace-1",
    displayName: "Workspace 1",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  });
  const authority = await activeWorkspaceAuthority(store);
  const inputs = { planRunId: "plan_d1_approval", variables: {} } as const;
  const plan: PlanRun = {
    id: inputs.planRunId,
    workspaceId: "workspace_1",
    source: { kind: "git", url: "https://x/r.git", ref: "main", path: "." },
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: await stableJsonDigest(inputs.variables),
    executionInputsDigest: await stableJsonDigest(
      planRunExecutionInputsDigestMaterial(inputs, undefined),
    ),
    requiredProviders: [],
    status: "waiting_approval",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: PLAN_DIGEST,
    planArtifact: { kind: "runner-local", ref: "rl://plan", digest: PLAN_DIGEST },
    requiresApproval: true,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.preparePlanRun({
    run: plan,
    inputs,
    expectedWorkspaceManagementAuthority: authority,
  });
  return { database, store, plan };
}

async function d1RestoreFixture(): Promise<{
  readonly database: SqliteFakeD1;
  readonly store: OpenTofuControlStore;
  readonly restore: Run;
}> {
  const database = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(database);
  const store = new CloudflareD1OpenTofuControlStore(database);
  const restore = await seedRestoreRun(store, "restore_d1_approval");
  return { database, store, restore };
}

function controller(store: OpenTofuControlStore) {
  return new OpenTofuController({ store, now: () => 100 });
}

test("a destructive-confirmation plan projects as waiting_approval", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWaitingApprovalPlan(store);
  const run = await controller(store).getRun("plan_wait");
  expect(run.status).toBe("waiting_approval");
});

test("approveRun clears the gate and the run projects as succeeded", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWaitingApprovalPlan(store);
  const ctrl = controller(store);
  const approved = await ctrl.approveRun("plan_wait", { approvedBy: "ops" });
  expect(approved.status).toBe("succeeded");
  // The approval is persisted on the plan record.
  const persisted = await store.getPlanRun("plan_wait");
  expect(persisted?.approval?.approvedBy).toBe("ops");
  // A subsequent getRun no longer reports waiting_approval.
  expect((await ctrl.getRun("plan_wait")).status).toBe("succeeded");
});

test("approveRun refuses a plan while Workspace management is draining", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWaitingApprovalPlan(store, "plan_draining");
  const authority = await activeWorkspaceAuthority(store);
  expect(
    (await store.beginWorkspaceDraining("workspace_1", authority)).status,
  ).toBe("started");

  await expect(
    controller(store).approveRun("plan_draining"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect((await store.getPlanRun("plan_draining"))?.status).toBe(
    "waiting_approval",
  );
});

test("approveRun refuses a plan admitted before a Workspace drain and resume", async () => {
  const fixture = await d1ApprovalFixture();
  const authority = await activeWorkspaceAuthority(fixture.store);
  expect(
    (
      await fixture.store.beginWorkspaceDraining(
        "workspace_1",
        authority,
      )
    ).status,
  ).toBe("started");
  const resumed = await fixture.database
    .prepare(
      "update workspaces set management_state = 'active', management_epoch = 3 where id = ? and management_state = 'draining'",
    )
    .bind("workspace_1")
    .run();
  expect(resumed.meta?.changes).toBe(1);

  await expect(
    controller(fixture.store).approveRun(fixture.plan.id),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect((await fixture.store.getPlanRun(fixture.plan.id))?.status).toBe(
    "waiting_approval",
  );
});

test("approveRun refuses a legacy plan without persisted Workspace authority", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedWaitingApprovalPlan(store, "plan_legacy_seed");
  const legacy = { ...seeded, id: "plan_legacy" };
  await store.putPlanRun(legacy);

  await expect(
    controller(store).approveRun("plan_legacy"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect((await store.getPlanRun("plan_legacy"))?.status).toBe(
    "waiting_approval",
  );
});

test("approveRun refuses a Restore admitted before a Workspace drain and resume", async () => {
  const fixture = await d1RestoreFixture();
  const authority = await activeWorkspaceAuthority(fixture.store);
  expect(
    (await fixture.store.beginWorkspaceDraining("workspace_1", authority))
      .status,
  ).toBe("started");
  const resumed = await fixture.database
    .prepare(
      "update workspaces set management_state = 'active', management_epoch = 3 where id = ? and management_state = 'draining'",
    )
    .bind("workspace_1")
    .run();
  expect(resumed.meta?.changes).toBe(1);

  const ctrl = new OpenTofuController({
    store: fixture.store,
    now: () => 100,
    enqueueRun: async () => {},
  });
  await expect(ctrl.approveRun(fixture.restore.id)).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect((await fixture.store.getBackupRun(fixture.restore.id))?.status).toBe(
    "waiting_approval",
  );
});

test("approveRun approves a Restore in the same active Workspace epoch", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const restore = await seedRestoreRun(store, "restore_active_approval");
  const ctrl = new OpenTofuController({
    store,
    now: () => 100,
    enqueueRun: async () => {},
  });

  const approved = await ctrl.approveRun(restore.id, { approvedBy: "ops" });
  expect(approved.status).toBe("queued");
  expect((await store.getBackupRun(restore.id))?.status).toBe("queued");
});

test("approveRun returns already-queued, running, and succeeded Restore rows unchanged", async () => {
  for (const status of ["queued", "running", "succeeded"] as const) {
    const store = new InMemoryOpenTofuControlStore();
    const restore = await seedRestoreRun(store, `restore_idempotent_${status}`, status);
    const before = await store.getBackupRun(restore.id);
    const observed = await new OpenTofuController({
      store,
      now: () => 100,
      enqueueRun: async () => {},
    }).approveRun(restore.id, { approvedBy: "someone-else" });
    expect(observed).toEqual(before);
    expect(await store.getBackupRun(restore.id)).toEqual(before);
  }
});

test("approveRun refuses a legacy Restore without persisted Workspace authority", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedRestoreRun(store, "restore_legacy_seed");
  const legacy = { ...seeded, id: "restore_legacy" };
  await store.putBackupRun(legacy);

  await expect(
    new OpenTofuController({ store, enqueueRun: async () => {} }).approveRun(
      legacy.id,
    ),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect((await store.getBackupRun(legacy.id))?.status).toBe(
    "waiting_approval",
  );
});

test("approveRun redacts secret-like approval reasons before persistence", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWaitingApprovalPlan(store);
  const ctrl = controller(store);
  await ctrl.approveRun("plan_wait", {
    approvedBy: "ops",
    reason:
      "Authorization: Bearer raw-token DATABASE_URL=postgres://user:pass@db/app sk-live-token-123456789",
  });

  const reason = (await store.getPlanRun("plan_wait"))?.approval?.reason ?? "";
  expect(reason).toContain("[REDACTED]");
  expect(reason).not.toContain("raw-token");
  expect(reason).not.toContain("user:pass@db");
  expect(reason).not.toContain("sk-live-token-123456789");
});

test("createApplyRun redacts approval reasons before persistence", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const planRun = await seedWaitingApprovalPlan(store);
  await store.putPlanRun({
    ...planRun,
    status: "succeeded",
    requiresApproval: false,
  });

  const created = await controller(store).createApplyRun({
    planRunId: "plan_wait",
    expected: applyExpectedGuardFromPlanRun({
      ...planRun,
      status: "succeeded",
      requiresApproval: false,
    }),
    approval: {
      approvedBy: "ops",
      reason:
        "Authorization: Bearer apply-token DATABASE_URL=postgres://user:pass@db/app sk-live-token-123456789",
    },
  });

  const applyRun = await store.getApplyRun(created.applyRun.id);
  const reason = applyRun?.approval?.reason ?? "";
  expect(reason).toContain("[REDACTED]");
  expect(reason).not.toContain("apply-token");
  expect(reason).not.toContain("user:pass@db");
  expect(reason).not.toContain("sk-live-token-123456789");
});

test("createApplyRun refuses a delete/replace plan that still awaits approval", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // A §25 action-policy delete/replace plan persists `succeeded` and carries its
  // gate in `requiresApproval`; the §19 projection and the auto-apply hook both
  // treat it as parked, so the apply route must refuse it exactly like a
  // destroy — otherwise the review of the most destructive changes is
  // display-only.
  const planRun = await seedWaitingApprovalPlan(store, "plan_gated1");
  const succeeded: PlanRun = { ...planRun, status: "succeeded" };
  await store.putPlanRun(succeeded);

  await expect(
    controller(store).createApplyRun({
      planRunId: "plan_gated1",
      expected: applyExpectedGuardFromPlanRun(succeeded),
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createApplyRun accepts the same delete/replace plan once approved", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const planRun = await seedWaitingApprovalPlan(store, "plan_gated2");
  const succeeded: PlanRun = { ...planRun, status: "succeeded" };
  await store.putPlanRun(succeeded);
  const ctrl = controller(store);
  await ctrl.approveRun("plan_gated2", { approvedBy: "ops" });

  const created = await ctrl.createApplyRun({
    planRunId: "plan_gated2",
    expected: applyExpectedGuardFromPlanRun(succeeded),
  });

  expect(created.applyRun.planRunId).toBe("plan_gated2");
});

test("approveRun is idempotent on an already-approved plan", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seedWaitingApprovalPlan(store);
  const ctrl = controller(store);
  await ctrl.approveRun("plan_wait", { approvedBy: "ops" });
  const again = await ctrl.approveRun("plan_wait", {
    approvedBy: "someone-else",
  });
  expect(again.status).toBe("succeeded");
  // The first approver is retained (idempotent no-op on re-approval).
  expect((await store.getPlanRun("plan_wait"))?.approval?.approvedBy).toBe(
    "ops",
  );
});

test("approveRun rejects a plan that is not awaiting approval", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // A succeeded plan with no action-policy gate is not awaiting approval.
  const planRun = await seedWaitingApprovalPlan(store, "plan_ready");
  await store.putPlanRun({
    ...planRun,
    status: "succeeded",
    requiresApproval: false,
  });
  await expect(
    controller(store).approveRun("plan_ready"),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("concurrent approveRun cannot double-approve a modern waiting_approval plan", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // The row parks in the persisted `waiting_approval` status. Two concurrent
  // approves both read waiting_approval;
  // the fenced CAS (expectFrom scoped to the read status) must let exactly one
  // win so the approval record + audit trail are not duplicated.
  const seeded = await seedWaitingApprovalPlan(store, "plan_modern");
  await store.putPlanRun({ ...seeded, status: "waiting_approval" });
  const ctrl = controller(store);

  const results = await Promise.allSettled([
    ctrl.approveRun("plan_modern", { approvedBy: "alice" }),
    ctrl.approveRun("plan_modern", { approvedBy: "bob" }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  // Exactly one approve wins; the other loses the CAS (failed_precondition).
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
    code: "failed_precondition",
  });

  // The persisted plan carries exactly ONE approval and ONE plan.approved
  // audit event (no duplicate from the loser).
  const persisted = await store.getPlanRun("plan_modern");
  expect(persisted?.approval).toBeDefined();
  expect(
    persisted?.auditEvents.filter((e) => e.type === "plan.approved").length,
  ).toBe(1);
});

test("approveRun throws not_found for an unknown id", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await expect(
    controller(store).approveRun("plan_missing"),
  ).rejects.toMatchObject({ code: "not_found" });
});
