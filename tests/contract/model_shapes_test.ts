/**
 * Type-shape pins for the Workspace-direct OpenTofu Capsule DAG contract. These
 * tests freeze the canonical field sets so
 * accidental contract drift fails loudly, mirroring the existing contract
 * test idiom.
 */
import { expect, test } from "bun:test";

import type {
  ProviderBinding,
  ProviderConnection,
} from "../../contract/connections.ts";
import { isProviderConnectionMaterialization } from "../../contract/connections.ts";
import type { CredentialRecipe } from "../../contract/credential-recipes.ts";
import {
  isProviderResolutionStatus,
  PROVIDER_RESOLUTION_STATUSES,
  type PublicProviderResolution,
  type ProviderRequirement,
  type ProviderResolution,
  type RunEnvironment,
} from "../../contract/provider-resolution.ts";
import type { BillingSettings, UsageEvent } from "../../contract/billing.ts";
import { NOOP_SHOWBACK_RATER } from "../../contract/billing.ts";
import type {
  Capsule,
  CapsuleCompatibilityReport,
} from "../../contract/capsules.ts";
import type {
  Dependency,
  DependencySnapshot,
} from "../../contract/dependencies.ts";
import type { StateVersion } from "../../contract/state-versions.ts";
import type { InstallConfig } from "../../contract/install-configs.ts";
import type { OutputShare, Output } from "../../contract/outputs.ts";
import type { Run, RunGroup } from "../../contract/runs.ts";
import type {
  CredentialMintEvent,
  SecurityFinding,
} from "../../contract/security.ts";
import type { TargetPool } from "../../contract/target.ts";
import type { ObjectBucketSpec } from "../../contract/resource-shape.ts";
import {
  formatCapsuleFullName,
  type Workspace,
} from "../../contract/workspaces.ts";

test("ObjectBucket portable storage class shape", () => {
  const bucket: ObjectBucketSpec = {
    name: "assets",
    storageClass: "infrequent_access",
    interfaces: ["s3_api"],
  };
  expect(bucket.storageClass).toBe("infrequent_access");
});

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

test("Capsule + InstallConfig shape", () => {
  const config: InstallConfig = {
    id: "cfg_talk",
    name: "talk",
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
      },
      scopeBoundary: {
        mode: "strict",
        rules: [
          {
            resourceTypePattern: "cloudflare_*",
            dimensions: {
              account_id: {
                selector: "/account_id",
                allowedValues: ["acct_public"],
              },
            },
          },
        ],
      },
    },
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  const capsule: Capsule = {
    id: "inst_talk",
    workspaceId: "ws_1",
    projectId: "prj_default",
    name: "talk",
    slug: "talk",
    sourceId: "src_talk",
    installConfigId: config.id,
    environment: "production",
    currentStateGeneration: 0,
    compatibilityReportId: "caprep_1",
    status: "pending",
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  expect(capsule.environment).toBe("production");
  expect(config.outputAllowlist.public_url?.type).toBe("url");
});

test("Capsule compatibility report shape", () => {
  const report: CapsuleCompatibilityReport = {
    id: "caprep_1",
    sourceSnapshotId: "snap_1",
    level: "ready",
    findings: [
      {
        severity: "info",
        code: "backend_state_isolated",
        message:
          "backend block remains unchanged while Takosumi isolates Run state",
        path: "main.tf",
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
        status: "blocked_missing_connection",
        blockedReason: "AWS Provider ProviderConnection is required",
        evidence: {
          kind: "blocked",
          provider: "aws",
          reason: "AWS Provider ProviderConnection is required",
        },
      },
    ],
    createdAt: "2026-06-07T00:00:00Z",
  };
  expect(report.level).toBe("ready");
  expect(report.providerResolutions?.[0]?.status).toBe(
    "blocked_missing_connection",
  );
});

test("ProviderConnection + binding shape uses canonical Workspace connection ids", () => {
  const providerConnection: ProviderConnection = {
    id: "conn_space_cf",
    workspaceId: "ws_1",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    scope: "workspace",
    displayName: "Cloudflare",
    status: "verified",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  const binding: ProviderBinding = {
    provider: "cloudflare",
    alias: "main",
    connectionId: providerConnection.id,
  };
  const recipe: CredentialRecipe = {
    id: "cloudflare",
    displayName: "Cloudflare",
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
  const bindings: readonly ProviderBinding[] = [
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
    status: "resolved_provider_connection",
    connectionId: "penv_cf_secret",
    materialization: "secret",
    evidence: {
      kind: "provider_env",
      provider: "cloudflare",
      connectionId: "penv_cf_secret",
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
  expect(PROVIDER_RESOLUTION_STATUSES).toContain(
    "resolved_provider_connection",
  );
  expect(isProviderConnectionMaterialization("custom.adapter.v2")).toBe(true);
  expect(isProviderConnectionMaterialization("gateway")).toBe(false);
  expect(isProviderConnectionMaterialization("runner_token")).toBe(false);
  expect(isProviderResolutionStatus(resolution.status)).toBe(true);
  expect(runEnvironment.providerResolutions[0]?.materialization).toBe("secret");
  expect(runEnvironment.providerResolutions[0]?.connectionId).toBe(
    "penv_cf_secret",
  );
  expect(publicResolution.connectionId).toBe("conn_cf_main");
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

test("ProviderConnection expiry shape", () => {
  const connection: ProviderConnection = {
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
        producerStateRef:
          "workspaces/space_1/capsules/inst_core/environments/production/state-versions/00000003.tfstate.enc",
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

test("Output projects raw -> Workspace/public lanes", () => {
  const snapshot: Output = {
    id: "out_1",
    workspaceId: "space_1",
    capsuleId: "inst_core",
    stateGeneration: 1,
    rawArtifactRef:
      "workspaces/space_1/capsules/inst_core/runs/run_1/outputs.raw.json.enc",
    publicOutputs: { public_origin: "https://shota.example.com" },
    workspaceOutputs: { base_domain: "shota.example.com" },
    outputDigest: "sha256:abc",
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(snapshot.rawArtifactRef.endsWith(".enc")).toBe(true);
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
        scope: { facts: { account_id: "acct_public" } },
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
        status: "resolved_provider_connection",
        connectionId: "penv_space_cf",
        materialization: "secret",
        evidence: {
          kind: "provider_env",
          provider: "cloudflare",
          connectionId: "penv_space_cf",
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
    type: "workspace_update",
    status: "queued",
    graphJson: JSON.stringify({ order: [["inst_core"], ["inst_talk"]] }),
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(run.type).toBe("plan");
  expect(run.planResources?.[0]?.actions).toEqual(["delete", "create"]);
  expect(run.planResources?.[0]?.scope?.facts.account_id).toBe("acct_public");
  expect(run.providerResolutions?.[0]?.status).toBe(
    "resolved_provider_connection",
  );
  expect(group.type).toBe("workspace_update");
  const driftGroup: RunGroup = {
    ...group,
    id: "rg_drift",
    type: "workspace_drift_check",
  };
  expect(driftGroup.type).toBe("workspace_drift_check");
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

test("StateVersion shape", () => {
  const state: StateVersion = {
    id: "state_4",
    workspaceId: "space_1",
    capsuleId: "inst_talk",
    environment: "production",
    generation: 4,
    stateRef:
      "workspaces/space_1/capsules/inst_talk/environments/production/state-versions/00000004.tfstate.enc",
    digest: "sha256:abc",
    createdByRunId: "run_2",
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(state.generation).toBe(4);
  expect(state.createdByRunId).toBe("run_2");
});

test("showback usage and security ledger shapes", () => {
  const settings: BillingSettings = {
    mode: "showback",
  };
  const usage: UsageEvent = {
    id: "usage_1",
    workspaceId: "space_1",
    capsuleId: "inst_talk",
    runId: "run_1",
    kind: "runner_minute",
    quantity: 3,
    usdMicros: 30_000,
    ratingStatus: "rated",
    source: "runner",
    idempotencyKey: "run_1:runner",
    createdAt: "2026-06-07T00:00:00Z",
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
  expect(settings.mode).toBe("showback");
  expect(usage.kind).toBe("runner_minute");
  expect(usage.usdMicros).toBe(30_000);
  expect(usage.ratingStatus).toBe("rated");
  expect(mint.capabilities).toEqual(["cloudflare"]);
  expect(finding.severity).toBe("warning");
});

test("OSS showback keeps measurements explicitly unrated without a host price", async () => {
  expect(
    await NOOP_SHOWBACK_RATER.ratePlan({
      workspaceId: "ws_1",
      billingSubjectId: "user_1",
      runId: "run_1",
      planResourceChanges: [],
      now: 1,
    }),
  ).toEqual({ ratingStatus: "unrated", usdMicros: 0 });
  expect(
    await NOOP_SHOWBACK_RATER.rateUsage({
      workspaceId: "ws_1",
      billingSubjectId: "user_1",
      runId: "run_1",
      kind: "runner_minute",
      quantity: 0.5,
      source: "runner",
      createdAt: "2026-06-07T00:00:00.000Z",
    }),
  ).toEqual({ ratingStatus: "unrated", usdMicros: 0 });
});
