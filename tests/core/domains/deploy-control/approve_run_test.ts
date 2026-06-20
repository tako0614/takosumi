import { expect, test } from "bun:test";

import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * Seeds a succeeded plan run flagged `requiresConfirmation` (the
 * waiting_approval gate) so we can drive the approve transition directly.
 */
async function seedWaitingApprovalPlan(
  store: InMemoryOpenTofuDeploymentStore,
  id = "plan_wait",
): Promise<PlanRun> {
  const planRun: PlanRun = {
    id,
    spaceId: "space_1",
    source: { kind: "git", url: "https://x/r.git", ref: "main", path: "." },
    sourceDigest: "sha256:src",
    operation: "update",
    runnerProfileId: "cloudflare-default",
    variablesDigest: "sha256:vars",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: PLAN_DIGEST,
    planArtifact: {
      kind: "runner-local",
      ref: "rl://plan",
      digest: PLAN_DIGEST,
    },
    templateBinding: {
      templateId: "tpl",
      templateVersion: "1",
      requiresConfirmation: true,
    },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(planRun);
  return planRun;
}

function controller(store: InMemoryOpenTofuDeploymentStore) {
  return new OpenTofuDeploymentController({ store, now: () => 100 });
}

test("a destructive-confirmation plan projects as waiting_approval", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedWaitingApprovalPlan(store);
  const run = await controller(store).getRun("plan_wait");
  expect(run.status).toBe("waiting_approval");
});

test("approveRun clears the gate and the run projects as succeeded", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
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

test("approveRun redacts secret-like approval reasons before persistence", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
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
  const store = new InMemoryOpenTofuDeploymentStore();
  const planRun = await seedWaitingApprovalPlan(store);
  await store.putPlanRun({
    ...planRun,
    templateBinding: undefined,
    status: "succeeded",
  });

  const created = await controller(store).createApplyRun({
    planRunId: "plan_wait",
    expected: applyExpectedGuardFromPlanRun({
      ...planRun,
      templateBinding: undefined,
      status: "succeeded",
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

test("approveRun is idempotent on an already-approved plan", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
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
  const store = new InMemoryOpenTofuDeploymentStore();
  // A plan with no destructive-confirmation flag is not awaiting approval.
  const planRun = await seedWaitingApprovalPlan(store, "plan_ready");
  await store.putPlanRun({ ...planRun, templateBinding: undefined });
  await expect(
    controller(store).approveRun("plan_ready"),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("concurrent approveRun cannot double-approve a modern waiting_approval plan", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  // A modern row parks in the persisted `waiting_approval` status (not the
  // legacy `succeeded`). Two concurrent approves both read waiting_approval;
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
  const store = new InMemoryOpenTofuDeploymentStore();
  await expect(
    controller(store).approveRun("plan_missing"),
  ).rejects.toMatchObject({ code: "not_found" });
});
