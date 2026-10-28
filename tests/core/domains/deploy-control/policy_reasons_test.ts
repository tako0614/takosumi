import { expect, test } from "bun:test";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import {
  RUN_POLICY_LAYERS,
  RUN_POLICY_REASON_CODES,
  RUN_POLICY_REASON_LIMIT,
  type RunPolicyReason,
} from "takosumi-contract/runs";
import {
  evaluateProviderAllowlist,
  evaluateQuotaPolicy,
  evaluateResourceAllowlist,
  evaluateScopeBoundary,
} from "takosumi-policy";
import { evaluatePolicy } from "../../../../core/domains/deploy-control/policy.ts";
import {
  evaluateCompatibilityReportAgainstPolicy,
  evaluateProviderInstallationPolicy,
  evaluateProviderLockfilePolicy,
} from "../../../../core/domains/deploy-control/provider_policy.ts";
import {
  projectPlanRunPolicyReasons,
  resourceTypeFromAddress,
} from "../../../../core/domains/deploy-control/policy_reasons.ts";
import { projectPlanRun } from "../../../../core/domains/deploy-control/projection_run.ts";
import { createDefaultRunnerProfiles } from "../../../../core/domains/deploy-control/runner_profiles.ts";

const AWS = "registry.opentofu.org/hashicorp/aws";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
const PROFILE = createDefaultRunnerProfiles(1)[0]!;

function planRun(over: Partial<PlanRun> = {}): PlanRun {
  return {
    id: "plan_policy",
    workspaceId: "ws_policy",
    source: { kind: "git", url: "https://x/r.git", ref: "main", path: "." },
    sourceDigest: "sha256:src",
    operation: "create",
    runnerProfileId: PROFILE.id,
    variablesDigest: "sha256:vars",
    requiredProviders: [],
    status: "failed",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function blocked(reasons: readonly string[], over: Partial<PlanRun> = {}): PlanRun {
  return planRun({ policy: { status: "blocked", reasons, checkedAt: 1 }, ...over });
}

function classify(reasons: readonly string[]): readonly RunPolicyReason[] {
  return projectPlanRunPolicyReasons(blocked(reasons)) ?? [];
}

function report(over: Partial<CapsuleCompatibilityReport> = {}): CapsuleCompatibilityReport {
  return {
    id: "report_secretish_id",
    sourceId: "src_1",
    sourceSnapshotId: "snap_1",
    level: "ready",
    findings: [],
    providerPackages: [],
    rootProviderRequirements: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-10-27T00:00:00.000Z",
    ...over,
  };
}

test("runner profile reasons written by evaluatePolicy map to stable codes", () => {
  const inactive = evaluatePolicy({
    profile: { ...PROFILE, lifecycle: { state: "candidate", reason: "hold" } },
    requiredProviders: [AWS],
    checkedAt: 1,
  });
  const unavailable = evaluatePolicy({
    profile: { ...PROFILE, availability: { state: "unavailable", reason: "maintenance" } },
    requiredProviders: [AWS],
    checkedAt: 1,
  });
  const noExecutor = evaluatePolicy({
    profile: { ...PROFILE, executorId: " " },
    requiredProviders: [AWS],
    checkedAt: 1,
  });
  const denied = evaluatePolicy({
    profile: { ...PROFILE, deniedProviders: [AWS] },
    requiredProviders: [AWS],
    checkedAt: 1,
  });
  const notAllowed = evaluatePolicy({
    profile: { ...PROFILE, allowedProviders: [CLOUDFLARE] },
    requiredProviders: [AWS],
    checkedAt: 1,
  });
  const undeclared = evaluatePolicy({
    profile: { ...PROFILE, allowedProviders: [CLOUDFLARE] },
    requiredProviders: [],
    checkedAt: 1,
  });
  expect(classify(inactive.reasons)).toEqual([
    { code: "runner_profile_inactive", layer: "runner_profile" },
  ]);
  expect(classify(unavailable.reasons)).toEqual([
    { code: "runner_profile_unavailable", layer: "runner_profile" },
  ]);
  expect(classify(noExecutor.reasons)).toEqual([
    { code: "runner_profile_no_executor", layer: "runner_profile" },
  ]);
  expect(classify(denied.reasons)).toEqual([
    { code: "provider_denied", layer: "runner_profile", provider: AWS },
  ]);
  expect(classify(notAllowed.reasons)).toEqual([
    { code: "provider_not_allowed", layer: "runner_profile", provider: AWS },
  ]);
  expect(classify(undeclared.reasons)).toEqual([
    { code: "providers_undeclared", layer: "runner_profile" },
  ]);
});

test("Workspace and InstallConfig layer reasons from takosumi-policy map to their layers", () => {
  const providers = evaluateProviderAllowlist([AWS, CLOUDFLARE], {
    allowed: [CLOUDFLARE, AWS],
    denied: [AWS],
  });
  const missing = evaluateProviderAllowlist([], { allowed: [AWS] });
  const notAllowed = evaluateProviderAllowlist([AWS], { allowed: [CLOUDFLARE] });
  const resources = evaluateResourceAllowlist(
    [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", actions: ["create"] }],
    ["aws_iam_role"],
  );
  const scope = evaluateScopeBoundary(
    [
      {
        address: 'module.app.aws_s3_bucket.logs["eu"]',
        type: "aws_s3_bucket",
        actions: ["create"],
        scope: { facts: { region: "eu-west-1" } },
      },
    ],
    {
      mode: "strict",
      rules: [
        {
          resourceTypePattern: "aws_*",
          dimensions: { region: { selector: "/region", allowedValues: ["us-east-1"] } },
        },
      ],
    } as never,
  );
  const quota = evaluateQuotaPolicy(
    [
      { address: "aws_s3_bucket.a", type: "aws_s3_bucket", actions: ["create"] },
      { address: "aws_s3_bucket.b", type: "aws_s3_bucket", actions: ["create"] },
    ],
    { resources: 1, aws_s3_bucket: 1, broken: -1 },
  );
  expect(scope.reasons.length).toBeGreaterThan(0);
  expect(classify([
    ...providers.reasons,
    ...missing.reasons,
    ...notAllowed.reasons,
    ...resources.reasons,
    ...scope.reasons,
    ...quota.reasons,
    "plan resource changes are unavailable, so the resource policy cannot be evaluated",
  ])).toEqual([
    { code: "provider_denied", layer: "provider", provider: AWS },
    { code: "providers_undeclared", layer: "provider" },
    { code: "provider_not_allowed", layer: "provider", provider: AWS },
    { code: "resource_type_not_allowed", layer: "resource", resourceType: "aws_s3_bucket" },
    { code: "resource_out_of_scope", layer: "scope", resourceType: "aws_s3_bucket" },
    { code: "quota_exceeded", layer: "quota", resourceType: "aws_s3_bucket" },
    { code: "quota_invalid", layer: "quota", resourceType: "broken" },
    { code: "quota_exceeded", layer: "quota" },
    { code: "resource_changes_unknown", layer: "resource" },
  ]);
});

test("supply-chain reasons name each provider without other detail", () => {
  const lockfile = evaluateProviderLockfilePolicy(undefined, {
    providerLockfile: { requireDigest: true },
  } as never, [AWS]);
  const none = evaluateProviderInstallationPolicy(undefined, {
    providerInstallation: { requireMirror: true },
  } as never, [AWS]);
  const partial = evaluateProviderInstallationPolicy(
    [
      {
        provider: CLOUDFLARE,
        mirrored: false,
        attested: true,
        installationMethod: "network",
      } as never,
    ],
    { providerInstallation: { requireMirror: true } } as never,
    [AWS, CLOUDFLARE],
  );
  expect(classify([
    ...(lockfile?.reasons ?? []),
    ...(none?.reasons ?? []),
    ...(partial?.reasons ?? []),
  ])).toEqual([
    { code: "provider_lockfile_missing", layer: "supply_chain" },
    { code: "provider_attestation_missing", layer: "supply_chain" },
    { code: "provider_attestation_missing", layer: "supply_chain", provider: AWS },
    { code: "provider_not_mirrored", layer: "supply_chain", provider: CLOUDFLARE },
  ]);
});

test("compatibility gate reasons map without report ids or finding prose", () => {
  const gated = evaluateCompatibilityReportAgainstPolicy(
    report({
      level: "unsupported",
      findings: [
        {
          severity: "error",
          compatibilityImpact: "unsupported",
          code: "backend_block_unsupported",
          message: "backend block at /secret/path is unsupported",
        },
      ],
      providerPackages: [{ source: AWS, allowed: true } as never],
      resources: [{ type: "aws_s3_bucket", allowed: true } as never],
      dataSources: [{ type: "external", allowed: true } as never],
      provisioners: [{ type: "local-exec", allowed: true } as never],
    }),
    {
      allowedProviders: [CLOUDFLARE],
      allowedResourceTypes: ["aws_iam_role"],
      allowedDataSourceTypes: [],
      allowedProvisionerTypes: [],
    } as never,
  );
  const reasons = classify([
    ...gated.reasons,
    "compatibility_report_missing: plan run plan_x references CompatibilityReport report_y which no longer exists",
    "compatibility_report_snapshot_mismatch: plan run plan_x uses SourceSnapshot snap_a but report report_y was created for snap_b",
  ]);
  expect(reasons).toEqual([
    { code: "compatibility_not_runnable", layer: "compatibility" },
    { code: "compatibility_finding", layer: "compatibility" },
    { code: "provider_not_allowed", layer: "compatibility", provider: AWS },
    { code: "resource_type_not_allowed", layer: "compatibility", resourceType: "aws_s3_bucket" },
    { code: "data_source_not_allowed", layer: "compatibility", resourceType: "external" },
    { code: "provisioner_not_allowed", layer: "compatibility" },
    { code: "compatibility_report_missing", layer: "compatibility" },
    { code: "compatibility_report_mismatch", layer: "compatibility" },
  ]);
  expect(JSON.stringify(reasons)).not.toContain("report_secretish_id");
  expect(JSON.stringify(reasons)).not.toContain("report_y");
  expect(JSON.stringify(reasons)).not.toContain("/secret/path");
});

test("declared-env credential reasons and billing reasons are classified", () => {
  const run = blocked(
    [
      `declared-env provider bindings on runner profile ${PROFILE.id} require requiredProviders before OpenTofu init`,
      `declared-env provider connection conn_private for ${AWS} must be Workspace-scoped`,
      "showback balance is insufficient for this plan",
    ],
    {
      auditEvents: [
        {
          id: "audit_1",
          type: "plan.policy_evaluated",
          at: 2,
          data: {
            billing: {
              mode: "showback",
              blocked: true,
              reasons: ["showback balance is insufficient for this plan"],
            },
          },
        },
      ],
    },
  );
  const reasons = projectPlanRunPolicyReasons(run);
  expect(reasons).toEqual([
    { code: "providers_undeclared", layer: "credential" },
    { code: "credential_connection_scope", layer: "credential", provider: AWS },
    { code: "billing_blocked", layer: "billing" },
  ]);
  expect(JSON.stringify(reasons)).not.toContain("conn_private");
});

test("unknown prose stays visible as unclassified and the list is bounded and deduplicated", () => {
  expect(classify(["a future evaluator said something new"])).toEqual([
    { code: "unclassified", layer: "unclassified" },
  ]);
  expect(projectPlanRunPolicyReasons(blocked([]))).toEqual([
    { code: "unclassified", layer: "unclassified" },
  ]);
  const many = Array.from(
    { length: RUN_POLICY_REASON_LIMIT + 20 },
    (_, index) => `resource type type_${index} is not allowed by policy`,
  );
  expect(classify([...many, ...many])).toHaveLength(RUN_POLICY_REASON_LIMIT);
  for (const reason of classify(many)) {
    expect(RUN_POLICY_REASON_CODES).toContain(reason.code);
    expect(RUN_POLICY_LAYERS).toContain(reason.layer);
  }
});

test("approval reasons follow requiresApproval and destroy plans", () => {
  const gated = planRun({
    status: "succeeded",
    requiresApproval: true,
    planResourceChanges: [
      { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", actions: ["delete", "create"] },
      { address: "aws_iam_role.app", type: "aws_iam_role", actions: ["update"] },
      { address: "aws_kms_key.k", type: "aws_kms_key", actions: ["no-op"], importing: true },
    ],
  });
  expect(projectPlanRunPolicyReasons(gated)).toEqual([
    { code: "approval_required_change", layer: "action", resourceType: "aws_kms_key" },
    { code: "approval_required_change", layer: "action", resourceType: "aws_s3_bucket" },
  ]);
  const destroy = planRun({ status: "waiting_approval", operation: "destroy" });
  expect(projectPlanRunPolicyReasons(destroy)).toEqual([
    { code: "approval_required_destroy", layer: "action" },
  ]);
  expect(projectPlanRunPolicyReasons(planRun({ status: "succeeded" }))).toBeUndefined();
  expect(
    projectPlanRunPolicyReasons(
      planRun({ status: "succeeded", operation: "update", driftCheck: true }),
    ),
  ).toBeUndefined();
});

test("the Run projection carries policyReasons only where policy blocked or gated", () => {
  const denied = projectPlanRun(
    blocked([`provider ${AWS} is denied by runner profile ${PROFILE.id}`]),
  );
  expect(denied.policyStatus).toBe("deny");
  expect(denied.errorCode).toBe("policy_denied");
  expect(denied.policyReasons).toEqual([
    { code: "provider_denied", layer: "runner_profile", provider: AWS },
  ]);
  expect(JSON.stringify(denied)).not.toContain(PROFILE.id + " ");
  expect(projectPlanRun(planRun({ status: "succeeded" })).policyReasons).toBeUndefined();
  expect(
    projectPlanRun(planRun({ status: "waiting_approval", operation: "destroy" })),
  ).toMatchObject({
    type: "destroy_plan",
    requiresApproval: true,
    policyReasons: [{ code: "approval_required_destroy", layer: "action" }],
  });
});

test("resource types are read from OpenTofu addresses only when the shape is exact", () => {
  expect(resourceTypeFromAddress("aws_s3_bucket.logs")).toBe("aws_s3_bucket");
  expect(resourceTypeFromAddress('module.a.module.b.aws_s3_bucket.logs["x.y"]')).toBe("aws_s3_bucket");
  expect(resourceTypeFromAddress("data.aws_iam_policy.read")).toBe("aws_iam_policy");
  expect(resourceTypeFromAddress("module.a")).toBeUndefined();
  expect(resourceTypeFromAddress("not an address")).toBeUndefined();
});
