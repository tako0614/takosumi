/**
 * Type-shape pins for the Workspace-direct OpenTofu Capsule DAG contract. These
 * tests freeze the canonical field sets so
 * accidental contract drift fails loudly, mirroring the existing contract
 * test idiom.
 */
import { expect, test } from "bun:test";

import type {
  CapsuleProviderEnvBinding,
  ProviderConnection,
} from "../../contract/connections.ts";
import type { CredentialRecipe } from "../../contract/credential-recipes.ts";
import {
  isProviderDeliveryMode,
  isProviderResolutionStatus,
  PROVIDER_DELIVERY_MODES,
  PROVIDER_RESOLUTION_STATUSES,
  type PublicProviderResolution,
  type ProviderRequirement,
  type ProviderResolution,
  type RunEnvironment,
  type RuntimeGrantProjection,
} from "../../contract/provider-resolution.ts";
import type {
  BillingAccount,
  BillingAutoRechargeAttempt,
  BillingPlan,
  BillingSettings,
  CreditReservation,
  InvoiceUsageReconciliation,
  UsageEvent,
} from "../../contract/billing.ts";
import {
  RUNNER_MINUTE_USD_MICROS,
  runnerMinuteUsdMicros,
} from "../../contract/billing.ts";
import type { CapsuleCompatibilityReport } from "../../contract/capsules.ts";
import type {
  Dependency,
  DependencySnapshot,
} from "../../contract/dependencies.ts";
import type { Connection } from "../../contract/internal-deploy-control-api.ts";
import type { Deployment, StateVersion } from "../../contract/deployments.ts";
import type { InstallConfig, Capsule } from "../../contract/installations.ts";
import type { OutputShare, Output } from "../../contract/outputs.ts";
import type { Run, RunGroup } from "../../contract/runs.ts";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "../../contract/security.ts";
import type { TargetPool } from "../../contract/target.ts";
import {
  formatCapsuleFullName,
  type Workspace,
} from "../../contract/workspaces.ts";

test("Workspace shape", () => {
  const space: Workspace = {
    id: "space_1",
    handle: "acme",
    displayName: "Acme",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  expect(
    formatCapsuleFullName({
      workspaceHandle: space.handle,
      capsuleName: "chat",
    }),
  ).toBe("@acme/chat");
});

test("BillingPlan shape", () => {
  const plan: BillingPlan = {
    id: "pro",
    name: "Pro",
    monthlyBasePrice: 2000,
    includedCredits: 1000,
    limits: {
      maxEstimatedCreditsPerRun: 100,
      quota: { resources: 20 },
    },
    createdAt: "2026-06-07T00:00:00Z",
    updatedAt: "2026-06-07T00:00:00Z",
  };
  expect(plan.limits.quota?.resources).toBe(20);
});

test("Capsule + InstallConfig shape", () => {
  const config: InstallConfig = {
    id: "cfg_talk",
    name: "talk",
    installType: "opentofu_module",
    trustLevel: "official",
    normalization: {
      allowBackendRewrite: true,
      allowProviderLift: true,
      allowAliasInjection: true,
    },
    modulePath: "deploy",
    variableMapping: {},
    outputAllowlist: {
      public_url: { from: "public_url", type: "url", required: true },
    },
    policy: {
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      allowedResourceTypes: ["cloudflare_workers_script"],
      destructiveChanges: { requireExplicitConfirmation: true },
      providerLockfile: { requireDigest: true },
      providerInstallation: { requireMirror: true },
      providerCredentials: {
        requireTemporary: true,
        requireTtlEnforced: true,
        requireRootOnly: true,
      },
    },
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  const installation: Capsule = {
    id: "inst_talk",
    workspaceId: "ws_1",
    projectId: "prj_default",
    name: "talk",
    slug: "talk",
    sourceId: "src_talk",
    installType: config.installType,
    installConfigId: config.id,
    environment: "production",
    currentStateGeneration: 0,
    compatibilityReportId: "caprep_1",
    status: "pending",
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  expect(installation.environment).toBe("production");
  expect(config.outputAllowlist.public_url?.type).toBe("url");
});

test("Capsule compatibility report shape", () => {
  const report: CapsuleCompatibilityReport = {
    id: "caprep_1",
    sourceSnapshotId: "snap_1",
    level: "auto_capsulized",
    findings: [
      {
        severity: "warning",
        code: "backend_overridden",
        message:
          "backend block will be overridden by Takosumi-controlled state",
        path: "main.tf",
        suggestion: "Remove the backend block and let Takosumi manage state.",
      },
    ],
    providers: [
      {
        source: "registry.opentofu.org/hashicorp/aws",
        aliases: ["storage"],
        allowed: true,
      },
    ],
    resources: [{ type: "aws_s3_bucket", count: 1, allowed: true }],
    dataSources: [],
    provisioners: [],
    providerRequirements: [
      {
        providerSource: "registry.opentofu.org/hashicorp/aws",
        providerName: "aws",
        alias: "storage",
        modulePath: "deploy",
        discoveredFrom: "required_providers",
        requiredForPhases: ["plan", "apply"],
      },
    ],
    providerResolutions: [
      {
        requirement: {
          providerSource: "registry.opentofu.org/hashicorp/aws",
          providerName: "aws",
          alias: "storage",
          modulePath: "deploy",
          discoveredFrom: "required_providers",
          requiredForPhases: ["plan", "apply"],
        },
        status: "blocked_missing_env",
        blockedReason: "AWS Provider Connection is required",
        evidence: {
          kind: "blocked",
          provider: "aws",
          reason: "AWS Provider Connection is required",
        },
      },
    ],
    normalizedObjectKey:
      "spaces/space_1/sources/src_talk/snapshots/snap_1/normalized-module.json",
    normalizedDigest: "sha256:normalized",
    createdAt: "2026-06-07T00:00:00Z",
  };
  expect(report.level).toBe("auto_capsulized");
  expect(report.providerResolutions?.[0]?.status).toBe("blocked_missing_env");
});

test("unified Provider Connection + binding shape uses concrete connection ids", () => {
  const providerConnection: ProviderConnection = {
    id: "conn_space_cf",
    workspaceId: "space_1",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    scope: "space",
    displayName: "Cloudflare",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  const binding: CapsuleProviderEnvBinding = {
    provider: "cloudflare",
    alias: "main",
    connectionId: providerConnection.id,
  };
  const recipe: CredentialRecipe = {
    id: "cloudflare",
    displayName: "Cloudflare",
    providerRule: "cloudflare",
    terraformSource: ["cloudflare/cloudflare"],
    envNames: ["CLOUDFLARE_API_TOKEN"],
    requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
    authModes: {
      api_token: {
        env: {
          CLOUDFLARE_API_TOKEN: { from: "secret", name: "api_token" },
        },
      },
    },
  };
  const bindings: readonly CapsuleProviderEnvBinding[] = [
    { provider: "cloudflare", alias: "main", connectionId: "conn_cf_other" },
    {
      provider: "cloudflare",
      alias: "zone",
      connectionId: providerConnection.id,
    },
  ];
  expect(binding.connectionId).toBe("conn_space_cf");
  expect(providerConnection.materialization).toBe("secret");
  expect(recipe.authModes.api_token).toBeDefined();
  expect(bindings).toHaveLength(2);
});

test("Provider resolution exposes OSS ProviderConnection delivery without Gateway evidence", () => {
  const requirement: ProviderRequirement = {
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    providerName: "cloudflare",
    alias: "main",
    versionConstraint: "~> 5.0",
    modulePath: "deploy",
    discoveredFrom: "required_providers",
    requiredForPhases: ["init", "plan", "apply"],
  };
  const resolution: ProviderResolution = {
    requirement,
    status: "resolved_provider_env",
    envId: "penv_cf_secret",
    materialization: "secret",
    evidence: {
      kind: "provider_env",
      provider: "cloudflare",
      envId: "penv_cf_secret",
      materialization: "secret",
      requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    },
  };
  const publicResolution: PublicProviderResolution = {
    requirement,
    status: "resolved_provider_connection",
    connectionId: "conn_cf_main",
    evidence: {
      kind: "provider_connection",
      provider: "cloudflare",
      connectionId: "conn_cf_main",
      requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    },
  };
  const runEnvironment: RunEnvironment = {
    runId: "run_plan",
    phase: "plan",
    generatedRootRef: "artifact_generated_root",
    env: { TF_DATA_DIR: "/tmp/tfdata" },
    files: [
      {
        path: "tofu.rc",
        purpose: "cli_config",
        secret: false,
      },
      {
        path: "cloudflare-api-token",
        purpose: "credential",
        secret: true,
      },
    ],
    providerResolutions: [resolution],
    allowedEgressProfileId: "egress_gateway_only",
    redactionProfileId: "redact_provider_material",
    stateBackendRef: "state_backend_run_plan",
    savedPlanDigest: "sha256:plan",
  };
  const runtimeGrant: RuntimeGrantProjection = {
    grantId: "sg_1",
    serviceExportId: "se_1",
    serviceBindingId: "sb_1",
    capsuleId: "inst_1",
    capability: "object.readwrite",
    rotationPolicyId: "rotate_runtime_grants",
  };

  expect(PROVIDER_DELIVERY_MODES).toEqual(["oauth", "secret"]);
  expect(PROVIDER_RESOLUTION_STATUSES).toContain("resolved_provider_env");
  expect(isProviderDeliveryMode("gateway")).toBe(false);
  expect(isProviderDeliveryMode("runner_token")).toBe(false);
  expect(isProviderResolutionStatus(resolution.status)).toBe(true);
  expect(runEnvironment.providerResolutions[0]?.materialization).toBe("secret");
  expect(runEnvironment.providerResolutions[0]?.envId).toBe("penv_cf_secret");
  expect(publicResolution.connectionId).toBe("conn_cf_main");
  expect(runtimeGrant.serviceBindingId).toBe("sb_1");
});

test("TargetPool can carry operator-declared implementation capabilities", () => {
  const pool: TargetPool = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "TargetPool",
    metadata: { name: "default", space: "prod" },
    spec: {
      targets: [
        {
          name: "containers-main",
          type: "kubernetes",
          ref: "cluster-prod",
          priority: 90,
          implementations: [
            {
              shape: "ContainerService",
              implementation: "custom_container_runtime",
              nativeResourceType: "custom.container_service",
              interfaces: {
                oci_container: "native",
                public_http: "shim",
                "custom.mesh": "native",
              },
            },
          ],
        },
      ],
    },
  };

  const implementation = pool.spec.targets[0]?.implementations?.[0];
  expect(implementation?.shape).toBe("ContainerService");
  expect(implementation?.interfaces["custom.mesh"]).toBe("native");
});

test("Connection expiry shape", () => {
  const connection: Connection = {
    id: "conn_1",
    workspaceId: "space_1",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    scope: "space",
    status: "expired",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00Z",
    updatedAt: "2026-06-08T00:00:00Z",
    expiresAt: "2026-06-08T00:00:00Z",
  };
  expect(connection.status).toBe("expired");
  expect(connection.expiresAt).toBe("2026-06-08T00:00:00Z");
});

test("Dependency + DependencySnapshot shape", () => {
  const dependency: Dependency = {
    id: "dep_1",
    workspaceId: "space_1",
    producerCapsuleId: "inst_core",
    consumerCapsuleId: "inst_talk",
    mode: "variable_injection",
    outputs: {
      base_domain: {
        from: "base_domain",
        to: "base_domain",
        required: true,
        type: "hostname",
      },
      member_issuer: {
        from: "member_issuer",
        to: "member_issuer",
        required: true,
        type: "url",
      },
    },
    visibility: "space",
    createdAt: "2026-06-06T00:00:00Z",
  };
  const snapshot: DependencySnapshot = {
    id: "depsnap_1",
    runId: "run_1",
    dependencies: [
      {
        dependencyId: dependency.id,
        producerCapsuleId: dependency.producerCapsuleId,
        producerStateGeneration: 3,
        producerStateVersionId: "state_3",
        producerStateObjectKey:
          "spaces/space_1/installations/inst_core/envs/production/states/00000003.tfstate.enc",
        producerStateDigest: "sha256:state",
        producerOutputId: "out_3",
        producerOutputDigest: "sha256:abc",
        valuesDigest: "sha256:def",
        values: { base_domain: "shota.example.com" },
      },
    ],
    mode: "strict",
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(snapshot.mode).toBe("strict");
  expect(snapshot.dependencies[0]?.producerStateGeneration).toBe(3);
});

test("Output projects raw -> space/public lanes", () => {
  const snapshot: Output = {
    id: "out_1",
    workspaceId: "space_1",
    capsuleId: "inst_core",
    stateGeneration: 1,
    rawOutputArtifactKey:
      "spaces/space_1/installations/inst_core/runs/run_1/outputs.raw.json.enc",
    publicOutputs: { public_origin: "https://shota.example.com" },
    workspaceOutputs: { base_domain: "shota.example.com" },
    outputDigest: "sha256:abc",
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(snapshot.rawOutputArtifactKey.endsWith(".enc")).toBe(true);
});

test("OutputShare lifecycle states", () => {
  const share: OutputShare = {
    id: "share_1",
    fromWorkspaceId: "space_company",
    toWorkspaceId: "space_1",
    producerCapsuleId: "inst_domain",
    outputs: [{ name: "domain", sensitive: false }],
    status: "pending",
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(share.status).toBe("pending");
});

test("single Run table covers all run kinds", () => {
  const run: Run = {
    id: "run_1",
    workspaceId: "space_1",
    capsuleId: "inst_talk",
    environment: "production",
    type: "plan",
    status: "waiting_approval",
    sourceSnapshotId: "snap_1",
    dependencySnapshotId: "depsnap_1",
    baseStateGeneration: 3,
    planDigest: "sha256:abc",
    policyStatus: "pass",
    planResources: [
      {
        address: "cloudflare_workers_script.app",
        type: "cloudflare_workers_script",
        actions: ["delete", "create"],
        scope: { cloudflareAccountId: "acct_public" },
      },
    ],
    providerResolutions: [
      {
        requirement: {
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          providerName: "cloudflare",
          modulePath: "deploy",
          discoveredFrom: "required_providers",
          requiredForPhases: ["plan", "apply"],
        },
        status: "resolved_provider_env",
        envId: "penv_space_cf",
        materialization: "secret",
        evidence: {
          kind: "provider_env",
          provider: "cloudflare",
          envId: "penv_space_cf",
          materialization: "secret",
          requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
        },
      },
    ],
    runEnvironmentEvidenceDigest: "sha256:runenv",
    redactionProfileId: "redact_provider_material",
    createdBy: "user_1",
    createdAt: "2026-06-06T00:00:00Z",
  };
  const group: RunGroup = {
    id: "rg_1",
    workspaceId: "space_1",
    type: "space_update",
    status: "queued",
    graphJson: JSON.stringify({ order: [["inst_core"], ["inst_talk"]] }),
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(run.type).toBe("plan");
  expect(run.planResources?.[0]?.actions).toEqual(["delete", "create"]);
  expect(run.planResources?.[0]?.scope?.cloudflareAccountId).toBe(
    "acct_public",
  );
  expect(run.providerResolutions?.[0]?.status).toBe("resolved_provider_env");
  expect(group.type).toBe("space_update");
  const driftGroup: RunGroup = {
    ...group,
    id: "rg_drift",
    type: "space_drift_check",
  };
  expect(driftGroup.type).toBe("space_drift_check");
});

test("compatibility_check Run kind is part of the unified ledger", () => {
  const run: Run = {
    id: "run_compat",
    workspaceId: "space_1",
    capsuleId: "inst_talk",
    environment: "production",
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: "snap_1",
    compatibilityReportId: "caprep_1",
    createdBy: "user_1",
    createdAt: "2026-06-07T00:00:00Z",
  };
  expect(run.type).toBe("compatibility_check");
});

test("Deployment + StateVersion shape", () => {
  // Retired Deployment ledger keeps its frozen legacy field names.
  const deployment: Deployment = {
    id: "dpl_1",
    spaceId: "space_1",
    installationId: "inst_talk",
    environment: "production",
    applyRunId: "run_2",
    sourceSnapshotId: "snap_1",
    dependencySnapshotId: "depsnap_1",
    stateGeneration: 4,
    outputSnapshotId: "out_4",
    outputsPublic: { public_url: "https://talk.shota.example.com" },
    status: "active",
    createdAt: "2026-06-06T00:00:00Z",
  };
  const state: StateVersion = {
    id: "state_4",
    workspaceId: "space_1",
    capsuleId: "inst_talk",
    environment: "production",
    generation: 4,
    objectKey:
      "spaces/space_1/installations/inst_talk/envs/production/states/00000004.tfstate.enc",
    digest: "sha256:abc",
    createdByRunId: "run_2",
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(deployment.stateGeneration).toBe(state.generation);
});

test("Billing and security ledger shapes", () => {
  const billing: BillingAccount = {
    id: "ba_1",
    ownerType: "user",
    ownerId: "user_1",
    provider: "stripe",
    status: "active",
    createdAt: "2026-06-07T00:00:00Z",
    updatedAt: "2026-06-07T00:00:00Z",
  };
  const settings: BillingSettings = {
    mode: "showback",
    provider: "none",
  };
  const reservation: CreditReservation = {
    id: "cr_1",
    workspaceId: "space_1",
    runId: "run_1",
    estimatedCredits: 32,
    status: "reserved",
    mode: "showback",
    createdAt: "2026-06-07T00:00:00Z",
    expiresAt: "2026-06-07T01:00:00Z",
  };
  const usage: UsageEvent = {
    id: "usage_1",
    workspaceId: "space_1",
    capsuleId: "inst_talk",
    runId: "run_1",
    kind: "runner_minute",
    quantity: 3,
    credits: 3,
    source: "runner",
    idempotencyKey: "run_1:runner",
    createdAt: "2026-06-07T00:00:00Z",
  };
  const autoRechargeAttempt: BillingAutoRechargeAttempt = {
    id: "takosumi-autorecharge:space_1:run_1",
    workspaceId: "space_1",
    runId: "run_1",
    billingAccountId: "ba_1",
    idempotencyKey: "takosumi-autorecharge:space_1:run_1",
    periodStart: "2026-06-01T00:00:00Z",
    periodEnd: "2026-07-01T00:00:00Z",
    requestedUsdMicros: 1_000_000,
    monthlyLimitUsdMicros: 10_000_000,
    chargedUsdMicros: 1_000_000,
    status: "succeeded",
    stripePaymentIntentId: "pi_123",
    providerStatus: "succeeded",
    createdAt: "2026-06-07T00:00:00Z",
    updatedAt: "2026-06-07T00:00:01Z",
  };
  const invoiceReconciliation: InvoiceUsageReconciliation = {
    invoiceId: "in_123",
    periodStart: "2026-06-07T00:00:00Z",
    periodEnd: "2026-06-08T00:00:00Z",
    meteredCredits: 3,
    invoicedCredits: 4,
    adjustmentCredits: 1,
    usageEvent: {
      id: "usage_reconcile",
      workspaceId: "space_1",
      kind: "operation",
      quantity: 1,
      credits: 1,
      source: "billing_reconciliation",
      idempotencyKey: "invoice-reconciliation:space_1:in_123",
      createdAt: "2026-06-08T00:00:00Z",
    },
  };
  const mint: CredentialMintEvent = {
    id: "mint_1",
    runId: "run_1",
    workspaceId: "space_1",
    capsuleId: "inst_talk",
    connectionId: "conn_1",
    phase: "plan",
    capabilities: ["cloudflare"],
    createdAt: "2026-06-07T00:00:00Z",
  };
  const finding: SecurityFinding = {
    id: "sec_1",
    workspaceId: "space_1",
    capsuleId: "inst_talk",
    runId: "run_1",
    severity: "warning",
    type: "capsule_gate",
    message: "backend block was overridden",
    metadata: { code: "backend_overridden" },
    createdAt: "2026-06-07T00:00:00Z",
  };
  expect(billing.provider).toBe("stripe");
  expect(settings.mode).toBe("showback");
  expect(reservation.estimatedCredits).toBe(32);
  expect(usage.kind).toBe("runner_minute");
  expect(autoRechargeAttempt.status).toBe("succeeded");
  expect(invoiceReconciliation.adjustmentCredits).toBe(1);
  expect(mint.capabilities).toEqual(["cloudflare"]);
  expect(finding.severity).toBe("warning");
});

test("runner minute billing uses fine grained USD micros", () => {
  expect(RUNNER_MINUTE_USD_MICROS).toBe(10_000);
  expect(runnerMinuteUsdMicros(0)).toBe(0);
  expect(runnerMinuteUsdMicros(0.00001)).toBe(1);
  expect(runnerMinuteUsdMicros(0.5)).toBe(5_000);
  expect(runnerMinuteUsdMicros(1)).toBe(10_000);
  expect(() => runnerMinuteUsdMicros(-1)).toThrow(
    "runner minute quantity must be non-negative",
  );
});
