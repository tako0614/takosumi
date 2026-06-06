import { expect, test } from "bun:test";

import {
  projectApplyRun,
  projectPlanRun,
  projectSourceSyncRun,
} from "./projection_run.ts";
import type {
  ApplyRun,
  PlanRun,
} from "takosumi-contract/deploy-control-api";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type { UnifiedRunStatus } from "takosumi-contract/lanes";

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
  [PlanRun["status"], boolean, UnifiedRunStatus]
> = [
  ["queued", false, "queued"],
  ["running", false, "running"],
  ["succeeded", false, "succeeded"],
  ["succeeded", true, "waiting_approval"],
  ["blocked", true, "waiting_approval"],
  ["blocked", false, "failed"],
  ["failed", false, "failed"],
  ["cancelled", false, "cancelled"],
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

test("projectPlanRun maps a destroy plan to destroy_plan", () => {
  const run = projectPlanRun(planRun({ operation: "destroy", status: "succeeded" }), {
    awaitingApproval: true,
  });
  expect(run.type).toBe("destroy_plan");
  expect(run.status).toBe("waiting_approval");
});

test("projectPlanRun carries snapshot id, generation, plan digest, policy pass", () => {
  const run = projectPlanRun(
    planRun({
      planDigest: "sha256:plan",
      planArtifact: { kind: "object-storage", ref: "key/plan.bin", digest: "d" },
      baseStateGeneration: 3,
    }),
    { sourceSnapshotId: "snap_1", appId: "app_1", environmentId: "env_1" },
  );
  expect(run.sourceSnapshotId).toBe("snap_1");
  expect(run.baseStateGeneration).toBe(3);
  expect(run.planDigest).toBe("sha256:plan");
  expect(run.planArtifactKey).toBe("key/plan.bin");
  expect(run.policyStatus).toBe("pass");
  expect(run.appId).toBe("app_1");
  expect(run.environmentId).toBe("env_1");
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
