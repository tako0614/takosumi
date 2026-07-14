import { expect, test } from "bun:test";

import {
  projectApplyRun,
  projectPlanRun,
  projectPlanRunCost,
  projectSourceSyncRun,
} from "../../../../core/domains/deploy-control/projection_run.ts";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type { RunStatus } from "takosumi-contract/runs";

function planRun(over: Partial<PlanRun> = {}): PlanRun {
  return {
    id: "plan_1",
    workspaceId: "workspace_1",
    source: { kind: "git", url: "https://x/r.git", ref: "main", path: "." },
    sourceDigest: "sha256:src",
    operation: "create",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:vars",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1000 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

function applyRun(over: Partial<ApplyRun> = {}): ApplyRun {
  return {
    id: "apply_1",
    planRunId: "plan_1",
    workspaceId: "workspace_1",
    operation: "create",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId: "plan_1",
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:src",
      variablesDigest: "sha256:vars",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

// --- The §6.8 status mapping table ----------------------------------------

const PLAN_STATUS_TABLE: ReadonlyArray<
  [PlanRun["status"], boolean, RunStatus]
> = [
  ["queued", false, "queued"],
  ["running", false, "running"],
  // `waiting_approval` is now a PERSISTED status; it passes through.
  ["waiting_approval", false, "waiting_approval"],
  ["succeeded", false, "succeeded"],
  // Back-compat: a legacy row persisted `succeeded` that the caller still
  // observes as awaiting approval is mapped to `waiting_approval`.
  ["succeeded", true, "waiting_approval"],
  ["failed", false, "failed"],
  ["cancelled", false, "cancelled"],
  ["expired", false, "expired"],
];

for (const [internal, awaiting, expected] of PLAN_STATUS_TABLE) {
  test(`plan status ${internal} (awaiting=${awaiting}) -> ${expected}`, () => {
    const run = projectPlanRun(planRun({ status: internal }), {
      awaitingApproval: awaiting,
    });
    expect(run.status).toBe(expected);
    expect(run.type).toBe("plan");
  });
}

// A legacy row persisted `status: "blocked"` (before the unify) coerces to
// `failed` on projection — the read model never surfaces the retired status.
test("plan status legacy blocked coerces to failed", () => {
  const run = projectPlanRun(
    planRun({ status: "blocked" as unknown as PlanRun["status"] }),
    { awaitingApproval: false },
  );
  expect(run.status).toBe("failed");
});

test("projectPlanRun maps a destroy plan to destroy_plan", () => {
  const run = projectPlanRun(
    planRun({ operation: "destroy", status: "succeeded" }),
    {
      awaitingApproval: true,
    },
  );
  expect(run.type).toBe("destroy_plan");
  expect(run.status).toBe("waiting_approval");
  expect(run.requiresApproval).toBe(true);
});

test("projectPlanRun exposes destructive approval requirement", () => {
  const run = projectPlanRun(
    planRun({ status: "succeeded", requiresApproval: true }),
    { awaitingApproval: false },
  );
  expect(run.status).toBe("succeeded");
  expect(run.requiresApproval).toBe(true);
});

test("projectPlanRun carries snapshot id, generation, plan digest, policy pass", () => {
  const run = projectPlanRun(
    planRun({
      planDigest: "sha256:plan",
      planArtifact: {
        kind: "object-storage",
        ref: "key/plan.bin",
        digest: "sha256:artifact",
      },
      summary: { add: 2, change: 1, destroy: 0 },
      planResourceChanges: [
        {
          address: "cloudflare_workers_script.api",
          type: "cloudflare_workers_script",
          actions: ["update"],
          scope: { facts: { account_id: "acct_public" } },
        },
      ],
      baseStateGeneration: 3,
      compatibilityReportId: "caprep_1",
    }),
    {
      sourceSnapshotId: "snap_1",
      capsuleId: "inst_1",
      environment: "production",
    },
  );
  expect(run.sourceSnapshotId).toBe("snap_1");
  expect(run.baseStateGeneration).toBe(3);
  expect(run.planDigest).toBe("sha256:plan");
  expect(run.planArtifactRef).toBe("key/plan.bin");
  expect(run.applyExpected).toEqual({
    planId: "plan_1",
    runnerId: "opentofu-default",
    sourceDigest: "sha256:src",
    variablesDigest: "sha256:vars",
    policyDecisionDigest: "sha256:policy",
    planDigest: "sha256:plan",
    planArtifactDigest: "sha256:artifact",
  });
  expect(run.summary).toEqual({ add: 2, change: 1, destroy: 0 });
  expect(run.planResources).toEqual([
    {
      address: "cloudflare_workers_script.api",
      type: "cloudflare_workers_script",
      actions: ["update"],
      scope: { facts: { account_id: "acct_public" } },
    },
  ]);
  expect(run.compatibilityReportId).toBe("caprep_1");
  expect(run.policyStatus).toBe("pass");
  expect(run.capsuleId).toBe("inst_1");
  expect(run.environment).toBe("production");
  expect(run.createdBy).toBe("system");
});

test("Resource plan/apply project a Resource subject without Capsule identity", () => {
  const resourceContext = {
    workspaceId: "workspace_1",
    resourceId: "tkrn:space_1:EdgeWorker:api",
    environment: "production",
    providerBinding: {
      provider: "cloudflare",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    },
  };
  const plan = projectPlanRun(
    planRun({ workspaceId: "workspace_1", resourceContext }),
    { environment: resourceContext.environment },
  );
  const apply = projectApplyRun(applyRun({ workspaceId: "workspace_1" }), {
    resourceId: resourceContext.resourceId,
    environment: resourceContext.environment,
  });

  for (const run of [plan, apply]) {
    expect(run.subject).toEqual({
      kind: "resource",
      id: resourceContext.resourceId,
    });
    expect(run.environment).toBe("production");
    expect(run.capsuleId).toBeUndefined();
  }
});

test("projectPlanRun projects non-secret run environment evidence", () => {
  const run = projectPlanRun(
    planRun({
      providerResolutions: [
        {
          requirement: {
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            providerName: "cloudflare",
            modulePath: ".",
            discoveredFrom: "required_providers",
            requiredForPhases: ["plan", "apply"],
          },
          status: "resolved_provider_connection",
          connectionId: "penv_1",
          materialization: "secret",
          evidence: {
            kind: "provider_env",
            provider: "cloudflare",
            connectionId: "penv_1",
            materialization: "secret",
            requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          },
        },
      ],
      runEnvironmentEvidenceDigest: "sha256:runenv",
      redactionProfileId: "redact_provider_material",
    }),
  );
  expect(run.providerResolutions?.[0]?.status).toBe(
    "resolved_provider_connection",
  );
  expect(run.runEnvironmentEvidenceDigest).toBe("sha256:runenv");
  expect(run.redactionProfileId).toBe("redact_provider_material");
});

test("projectPlanRun surfaces a structured error code from a failed plan", () => {
  const run = projectPlanRun(
    planRun({
      status: "failed",
      diagnostics: [
        {
          severity: "error",
          code: "state_generation_mismatch",
          message: "the state generation changed after planning",
        },
      ],
    }),
  );
  expect(run.status).toBe("failed");
  expect(run.errorCode).toBe("state_generation_mismatch");
});

test("projectApplyRun maps create apply and a destroy apply", () => {
  expect(projectApplyRun(applyRun()).type).toBe("apply");
  expect(projectApplyRun(applyRun({ operation: "destroy" })).type).toBe(
    "destroy_apply",
  );
  const failed = projectApplyRun(applyRun({ status: "failed" }));
  expect(failed.status).toBe("failed");
});

test("projectApplyRun projects non-secret run environment evidence", () => {
  const run = projectApplyRun(
    applyRun({
      providerResolutions: [
        {
          requirement: {
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            providerName: "cloudflare",
            modulePath: ".",
            discoveredFrom: "required_providers",
            requiredForPhases: ["plan", "apply"],
          },
          status: "resolved_provider_connection",
          connectionId: "penv_secret",
          materialization: "secret",
          evidence: {
            kind: "provider_env",
            provider: "cloudflare",
            connectionId: "penv_secret",
            materialization: "secret",
            requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          },
        },
      ],
      runEnvironmentEvidenceDigest: "sha256:apply-runenv",
      redactionProfileId: "redact_provider_material",
    }),
  );
  expect(run.providerResolutions?.[0]?.status).toBe(
    "resolved_provider_connection",
  );
  expect(run.runEnvironmentEvidenceDigest).toBe("sha256:apply-runenv");
  expect(run.redactionProfileId).toBe("redact_provider_material");
});

test("projectSourceSyncRun maps the sync lifecycle and snapshot id", () => {
  const base: SourceSyncRun = {
    id: "ssr_1",
    kind: "source_sync",
    workspaceId: "workspace_1",
    sourceId: "src_1",
    url: "https://x/r.git",
    ref: "main",
    path: ".",
    archiveRef: "key",
    status: "succeeded",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:01:00.000Z",
    snapshotId: "snap_1",
  };
  const run = projectSourceSyncRun(base);
  expect(run.type).toBe("source_sync");
  expect(run.status).toBe("succeeded");
  expect(run.sourceSnapshotId).toBe("snap_1");

  // A queued sync does not yet expose a resolved snapshot id.
  const queued = projectSourceSyncRun({ ...base, status: "queued" });
  expect(queued.status).toBe("queued");
  expect(queued.sourceSnapshotId).toBeUndefined();
});

// --- projectPlanRunCost (portable OSS estimate surface) --------------------

/** A `plan.policy_evaluated` audit event carrying the recorded billing audit. */
function billingAuditEvent(
  billing: Readonly<Record<string, unknown>>,
): PlanRun["auditEvents"][number] {
  return {
    id: "evt_1",
    type: "plan.policy_evaluated",
    at: 1500,
    data: { status: "blocked", billing } as never,
  };
}

test("projectPlanRunCost projects the OSS showback USD estimate", () => {
  const cost = projectPlanRunCost(
    planRun({
      status: "succeeded",
      policy: { status: "passed", reasons: [], checkedAt: 1500 },
      auditEvents: [
        billingAuditEvent({
          mode: "showback",
          estimatedUsdMicros: 12_000_000,
          ratingStatus: "rated",
          blocked: false,
          reasons: [],
        }),
      ],
    }),
  );
  expect(cost.runId).toBe("plan_1");
  expect(cost.billingMode).toBe("showback");
  expect(cost.estimatedUsdMicros).toBe(12_000_000);
  expect(cost.ratingStatus).toBe("rated");
  expect(cost.blocked).toBe(false);
  expect(cost.reasons).toEqual([]);
});

test("projectPlanRunCost selects the last policy event that carries billing", () => {
  const cost = projectPlanRunCost(
    planRun({
      auditEvents: [
        {
          id: "evt_preflight",
          type: "plan.policy_evaluated",
          at: 1200,
          data: { status: "passed" },
        },
        {
          ...billingAuditEvent({
            mode: "showback",
            estimatedUsdMicros: 3_000_000,
            ratingStatus: "rated",
            blocked: false,
            reasons: [],
          }),
          id: "evt_billing",
          at: 1500,
        },
        {
          id: "evt_postflight",
          type: "plan.policy_evaluated",
          at: 1800,
          data: { status: "passed" },
        },
      ],
    }),
  );
  expect(cost.billingMode).toBe("showback");
  expect(cost.estimatedUsdMicros).toBe(3_000_000);
});

test("projectPlanRunCost preserves a host extension without interpreting it", () => {
  const cost = projectPlanRunCost(
    planRun({
      status: "succeeded",
      policy: { status: "passed", reasons: [], checkedAt: 1500 },
      auditEvents: [
        billingAuditEvent({
          mode: "showback",
          estimatedUsdMicros: 250_000,
          ratingStatus: "rated",
          blocked: false,
          reasons: [],
          extension: { hostEstimateClass: "operator.v2" },
        }),
      ],
    }),
  );
  expect(cost.estimatedUsdMicros).toBe(250_000);
  expect(cost.extension).toEqual({ hostEstimateClass: "operator.v2" });
});

test("projectPlanRunCost defaults to disabled/zero when no billing audit exists", () => {
  const cost = projectPlanRunCost(planRun({ status: "queued" }));
  expect(cost.billingMode).toBe("disabled");
  expect(cost.estimatedUsdMicros).toBe(0);
  expect(cost.ratingStatus).toBe("not_applicable");
  expect(cost.blocked).toBe(false);
  expect(cost.reasons).toEqual([]);
});

test("projectPlanRunCost does not turn a non-billing policy denial into a billing block", () => {
  const cost = projectPlanRunCost(
    planRun({
      status: "failed",
      policy: {
        status: "blocked",
        reasons: ["resource action denied by Workspace policy"],
        checkedAt: 1500,
      },
      auditEvents: [
        billingAuditEvent({
          mode: "showback",
          estimatedUsdMicros: 8_000_000,
          ratingStatus: "rated",
          blocked: false,
          reasons: [],
        }),
      ],
    }),
  );
  expect(cost.billingMode).toBe("showback");
  expect(cost.estimatedUsdMicros).toBe(8_000_000);
  expect(cost.blocked).toBe(false);
  expect(cost.reasons).toEqual([]);
});

test("projectPlanRunCost does not treat a pre-rating amount as rated", () => {
  const cost = projectPlanRunCost(
    planRun({
      auditEvents: [
        billingAuditEvent({
          mode: "showback",
          estimatedUsdMicros: 9_000_000,
          blocked: false,
          reasons: [],
        }),
      ],
    }),
  );

  expect(cost.ratingStatus).toBe("unrated");
  expect(cost.estimatedUsdMicros).toBe(0);
});
