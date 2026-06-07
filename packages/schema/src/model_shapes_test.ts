/**
 * Type-shape pins for the Space-direct OpenTofu Capsule DAG contract. These
 * tests freeze the canonical field sets so
 * accidental contract drift fails loudly, mirroring the existing contract
 * test idiom.
 */
import { expect, test } from "bun:test";

import type {
  CapabilityBinding,
  OperatorConnectionDefault,
} from "./capability-bindings.ts";
import type {
  BillingAccount,
  BillingSettings,
  CreditReservation,
  UsageEvent,
} from "./billing.ts";
import type { CapsuleCompatibilityReport } from "./capsules.ts";
import type { Dependency, DependencySnapshot } from "./dependencies.ts";
import type { Deployment, StateSnapshot } from "./deployments.ts";
import type { InstallConfig, Installation } from "./installations.ts";
import type { OutputShare, OutputSnapshot } from "./output-snapshots.ts";
import type { Run, RunGroup } from "./runs.ts";
import type { CredentialMintEvent, SecurityFinding } from "./security.ts";
import { formatInstallationFullName, type Space } from "./spaces.ts";

test("Space shape", () => {
  const space: Space = {
    id: "space_1",
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  expect(
    formatInstallationFullName({
      spaceHandle: space.handle,
      installationName: "talk",
    }),
  ).toBe("@shota/talk");
});

test("Installation + InstallConfig shape", () => {
  const config: InstallConfig = {
    id: "cfg_talk",
    name: "talk",
    installType: "opentofu_module",
    trustLevel: "official",
    capsulePath: "deploy",
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
    },
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  const installation: Installation = {
    id: "inst_talk",
    spaceId: "space_1",
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
        message: "backend block will be overridden by Takosumi managed state",
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
    normalizedObjectKey:
      "spaces/space_1/installations/inst_talk/runs/run_1/normalized-module.tar.zst",
    normalizedDigest: "sha256:normalized",
    createdAt: "2026-06-07T00:00:00Z",
  };
  expect(report.level).toBe("auto_capsulized");
});

test("CapabilityBinding modes", () => {
  const bindings: readonly CapabilityBinding[] = [
    { mode: "default" },
    { mode: "connection", connectionId: "conn_space_dns" },
    { mode: "manual", values: { type: "CNAME", name: "talk.example.com" } },
    { mode: "disabled" },
  ];
  expect(bindings).toHaveLength(4);
  const operatorDefault: OperatorConnectionDefault = {
    id: "ocd_compute",
    capability: "compute",
    provider: "cloudflare",
    connectionId: "conn_operator_cloudflare",
    createdAt: "2026-06-06T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
  };
  expect(operatorDefault.capability).toBe("compute");
});

test("Dependency + DependencySnapshot shape", () => {
  const dependency: Dependency = {
    id: "dep_1",
    spaceId: "space_1",
    producerInstallationId: "inst_core",
    consumerInstallationId: "inst_talk",
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
        producerInstallationId: dependency.producerInstallationId,
        producerStateGeneration: 3,
        producerOutputSnapshotId: "out_3",
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

test("OutputSnapshot projects raw -> space/public lanes", () => {
  const snapshot: OutputSnapshot = {
    id: "out_1",
    spaceId: "space_1",
    installationId: "inst_core",
    stateGeneration: 1,
    rawOutputArtifactKey:
      "spaces/space_1/installations/inst_core/runs/run_1/outputs.raw.json.enc",
    publicOutputs: { public_origin: "https://shota.example.com" },
    spaceOutputs: { base_domain: "shota.example.com" },
    outputDigest: "sha256:abc",
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(snapshot.rawOutputArtifactKey.endsWith(".enc")).toBe(true);
});

test("OutputShare lifecycle states", () => {
  const share: OutputShare = {
    id: "share_1",
    fromSpaceId: "space_company",
    toSpaceId: "space_1",
    producerInstallationId: "inst_domain",
    outputs: [{ name: "domain", sensitive: false }],
    status: "pending",
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(share.status).toBe("pending");
});

test("single Run table covers all run kinds", () => {
  const run: Run = {
    id: "run_1",
    spaceId: "space_1",
    installationId: "inst_talk",
    environment: "production",
    type: "plan",
    status: "waiting_approval",
    sourceSnapshotId: "snap_1",
    dependencySnapshotId: "depsnap_1",
    baseStateGeneration: 3,
    planDigest: "sha256:abc",
    policyStatus: "pass",
    createdBy: "user_1",
    createdAt: "2026-06-06T00:00:00Z",
  };
  const group: RunGroup = {
    id: "rg_1",
    spaceId: "space_1",
    type: "space_update",
    status: "queued",
    graphJson: JSON.stringify({ order: [["inst_core"], ["inst_talk"]] }),
    createdAt: "2026-06-06T00:00:00Z",
  };
  expect(run.type).toBe("plan");
  expect(group.type).toBe("space_update");
});

test("compatibility_check Run kind is part of the unified ledger", () => {
  const run: Run = {
    id: "run_compat",
    spaceId: "space_1",
    installationId: "inst_talk",
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

test("Deployment + StateSnapshot shape", () => {
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
  const state: StateSnapshot = {
    id: "state_4",
    spaceId: "space_1",
    installationId: "inst_talk",
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
    ownerType: "space",
    ownerId: "space_1",
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
    spaceId: "space_1",
    runId: "run_1",
    estimatedCredits: 32,
    status: "reserved",
    mode: "enforce",
    createdAt: "2026-06-07T00:00:00Z",
    expiresAt: "2026-06-07T01:00:00Z",
  };
  const usage: UsageEvent = {
    id: "usage_1",
    spaceId: "space_1",
    installationId: "inst_talk",
    runId: "run_1",
    kind: "runner_minute",
    quantity: 3,
    credits: 3,
    source: "runner",
    idempotencyKey: "run_1:runner",
    createdAt: "2026-06-07T00:00:00Z",
  };
  const mint: CredentialMintEvent = {
    id: "mint_1",
    runId: "run_1",
    spaceId: "space_1",
    installationId: "inst_talk",
    connectionId: "conn_1",
    phase: "plan",
    capabilities: ["compute"],
    createdAt: "2026-06-07T00:00:00Z",
  };
  const finding: SecurityFinding = {
    id: "sec_1",
    spaceId: "space_1",
    installationId: "inst_talk",
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
  expect(mint.capabilities).toEqual(["compute"]);
  expect(finding.severity).toBe("warning");
});
