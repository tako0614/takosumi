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
    spaceId: "space_1",
    source: { kind: "git", url: "https://x/r.git", ref: "main", path: "." },
    sourceDigest: "sha256:src",
    operation: "create",
    runnerProfileId: "cloudflare-default",
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
    spaceId: "space_1",
    operation: "create",
    runnerProfileId: "cloudflare-default",
    status: "succeeded",
    expected: {
      planRunId: "plan_1",
      runnerProfileId: "cloudflare-default",
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
          scope: { cloudflareAccountId: "acct_public" },
        },
      ],
      baseStateGeneration: 3,
      compatibilityReportId: "caprep_1",
    }),
    {
      sourceSnapshotId: "snap_1",
      installationId: "inst_1",
      environment: "production",
    },
  );
  expect(run.sourceSnapshotId).toBe("snap_1");
  expect(run.baseStateGeneration).toBe(3);
  expect(run.planDigest).toBe("sha256:plan");
  expect(run.planArtifactKey).toBe("key/plan.bin");
  expect(run.applyExpected).toEqual({
    planRunId: "plan_1",
    runnerProfileId: "cloudflare-default",
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
      scope: { cloudflareAccountId: "acct_public" },
    },
  ]);
  expect(run.compatibilityReportId).toBe("caprep_1");
  expect(run.policyStatus).toBe("pass");
  expect(run.installationId).toBe("inst_1");
  expect(run.environment).toBe("production");
  expect(run.createdBy).toBe("system");
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
          status: "resolved_provider_env",
          envId: "penv_1",
          materialization: "secret",
          evidence: {
            kind: "provider_env",
            provider: "cloudflare",
            envId: "penv_1",
            materialization: "secret",
            requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          },
        },
      ],
      runEnvironmentEvidenceDigest: "sha256:runenv",
      redactionProfileId: "redact_provider_material",
    }),
  );
  expect(run.providerResolutions?.[0]?.status).toBe("resolved_provider_env");
  expect(run.runEnvironmentEvidenceDigest).toBe("sha256:runenv");
  expect(run.redactionProfileId).toBe("redact_provider_material");
});

test("projectPlanRun surfaces a compact error code from a failed plan", () => {
  const run = projectPlanRun(
    planRun({
      status: "failed",
      diagnostics: [
        {
          severity: "error",
          message: "state_generation_mismatch: plan ... is now at generation 2",
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
          status: "resolved_provider_env",
          envId: "penv_secret",
          materialization: "secret",
          evidence: {
            kind: "provider_env",
            provider: "cloudflare",
            envId: "penv_secret",
            materialization: "secret",
            requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          },
        },
      ],
      runEnvironmentEvidenceDigest: "sha256:apply-runenv",
      redactionProfileId: "redact_provider_material",
    }),
  );
  expect(run.providerResolutions?.[0]?.status).toBe("resolved_provider_env");
  expect(run.runEnvironmentEvidenceDigest).toBe("sha256:apply-runenv");
  expect(run.redactionProfileId).toBe("redact_provider_material");
});

test("projectSourceSyncRun maps the sync lifecycle and snapshot id", () => {
  const base: SourceSyncRun = {
    id: "ssr_1",
    kind: "source_sync",
    spaceId: "space_1",
    sourceId: "src_1",
    url: "https://x/r.git",
    ref: "main",
    path: ".",
    archiveObjectKey: "key",
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

// --- projectPlanRunCost (public credit-shortfall surface) ------------------

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

test("projectPlanRunCost surfaces an enforce-mode credit shortfall as blocked", () => {
  const cost = projectPlanRunCost(
    planRun({
      status: "failed",
      policy: {
        status: "blocked",
        reasons: [
          "credit reservation failed: 12 credits estimated but only 5 available",
        ],
        checkedAt: 1500,
      },
      auditEvents: [
        billingAuditEvent({
          mode: "enforce",
          estimatedCredits: 12,
          availableCredits: 5,
          reservationStatus: "insufficient_credits",
        }),
      ],
    }),
  );
  expect(cost.runId).toBe("plan_1");
  // Public billingMode is always `showback` in OSS; the enforce decision lives
  // in the injected Cloud port's recorded audit and surfaces via `blocked`.
  expect(cost.billingMode).toBe("showback");
  expect(cost.estimatedUsdMicros).toBe(12_000_000);
  expect(cost.availableUsdMicros).toBe(5_000_000);
  expect(cost.shortfallUsdMicros).toBe(7_000_000);
  expect(cost.estimatedCredits).toBe(12);
  expect(cost.availableCredits).toBe(5);
  expect(cost.reservationStatus).toBe("insufficient_credits");
  expect(cost.creditShortfall).toBe(7);
  expect(cost.blocked).toBe(true);
  expect(cost.reasons).toEqual([
    "credit reservation failed: 12 credits estimated but only 5 available",
  ]);
});

test("projectPlanRunCost prefers USD micros audit values for fractional balances", () => {
  const cost = projectPlanRunCost(
    planRun({
      status: "failed",
      policy: {
        status: "blocked",
        reasons: [
          "USD balance reservation failed: $0.25 estimated but only $0.10 available",
        ],
        checkedAt: 1500,
      },
      auditEvents: [
        billingAuditEvent({
          mode: "enforce",
          estimatedUsdMicros: 250_000,
          availableUsdMicros: 100_000,
          reservationStatus: "insufficient_credits",
        }),
      ],
    }),
  );
  expect(cost.estimatedUsdMicros).toBe(250_000);
  expect(cost.availableUsdMicros).toBe(100_000);
  expect(cost.shortfallUsdMicros).toBe(150_000);
  expect(cost.estimatedCredits).toBe(0.25);
  expect(cost.availableCredits).toBe(0.1);
  expect(cost.creditShortfall).toBe(0.15);
  expect(cost.blocked).toBe(true);
  expect(cost.reasons).toEqual([
    "USD balance reservation failed: $0.25 estimated but only $0.10 available",
  ]);
});

test("projectPlanRunCost surfaces a reserved plan as non-blocked with no shortfall", () => {
  const cost = projectPlanRunCost(
    planRun({
      status: "succeeded",
      policy: { status: "passed", reasons: [], checkedAt: 1500 },
      auditEvents: [
        billingAuditEvent({
          mode: "enforce",
          estimatedCredits: 4,
          availableCredits: 40,
          reservationStatus: "reserved",
          reservationId: "creditres_1",
        }),
      ],
    }),
  );
  expect(cost.billingMode).toBe("showback");
  expect(cost.estimatedUsdMicros).toBe(4_000_000);
  expect(cost.availableUsdMicros).toBe(40_000_000);
  expect(cost.shortfallUsdMicros).toBeUndefined();
  expect(cost.estimatedCredits).toBe(4);
  expect(cost.availableCredits).toBe(40);
  expect(cost.reservationStatus).toBe("reserved");
  expect(cost.creditShortfall).toBeUndefined();
  expect(cost.blocked).toBe(false);
  expect(cost.reasons).toEqual([]);
});

test("projectPlanRunCost reports a billing-plan limit reason as blocked under enforce", () => {
  const cost = projectPlanRunCost(
    planRun({
      status: "failed",
      policy: {
        status: "blocked",
        reasons: [
          "billing plan free limits estimated credits per run to 5; plan estimated 9",
        ],
        checkedAt: 1500,
      },
      auditEvents: [
        billingAuditEvent({
          mode: "enforce",
          estimatedCredits: 9,
          planLimits: { maxEstimatedCreditsPerRun: 5 },
        }),
      ],
    }),
  );
  expect(cost.blocked).toBe(true);
  expect(cost.reasons).toEqual([
    "billing plan free limits estimated credits per run to 5; plan estimated 9",
  ]);
  // No reservation was attempted, so available credits / shortfall are absent.
  expect(cost.availableUsdMicros).toBeUndefined();
  expect(cost.shortfallUsdMicros).toBeUndefined();
  expect(cost.availableCredits).toBeUndefined();
  expect(cost.creditShortfall).toBeUndefined();
});

test("projectPlanRunCost defaults to disabled/zero when no billing audit exists", () => {
  const cost = projectPlanRunCost(planRun({ status: "queued" }));
  expect(cost.billingMode).toBe("disabled");
  expect(cost.estimatedUsdMicros).toBe(0);
  expect(cost.estimatedCredits).toBe(0);
  expect(cost.blocked).toBe(false);
  expect(cost.reasons).toEqual([]);
  expect(cost.reservationStatus).toBeUndefined();
});

test("projectPlanRunCost does not block a showback-mode plan even when policy blocked", () => {
  // showback never blocks apply; a blocked plan in showback (e.g. a non-billing
  // policy block) still reports blocked=false for the billing surface.
  const cost = projectPlanRunCost(
    planRun({
      status: "failed",
      policy: {
        status: "blocked",
        reasons: [
          "credit reservation failed: 8 credits estimated but only 2 available",
        ],
        checkedAt: 1500,
      },
      auditEvents: [
        billingAuditEvent({
          mode: "showback",
          estimatedCredits: 8,
          availableCredits: 2,
        }),
      ],
    }),
  );
  expect(cost.billingMode).toBe("showback");
  expect(cost.shortfallUsdMicros).toBe(6_000_000);
  expect(cost.creditShortfall).toBe(6);
  expect(cost.blocked).toBe(false);
});
