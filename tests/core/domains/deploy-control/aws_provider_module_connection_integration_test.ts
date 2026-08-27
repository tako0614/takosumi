import { expect, test } from "bun:test";

import type {
  OpenTofuApplyJob,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { analyzeOpenTofuCapsuleFiles } from "../../../../core/domains/sources/capsule_compatibility.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";
import {
  FIXTURE_AWS_MIRROR_EVIDENCE,
  FIXTURE_STATE_DIGEST,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";

const AWS_PROVIDER = "registry.opentofu.org/hashicorp/aws";
const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";
const WORKSPACE_ID = "workspace_aws_generic_e2e";
const NOW = "2026-08-25T00:00:00.000Z";
const AWS_ACCESS_KEY_ID = "AKIA_AWS_GENERIC_E2E";
const AWS_SECRET_ACCESS_KEY = "aws-generic-secret-e2e";
const AWS_SESSION_TOKEN = "aws-generic-session-e2e";
const CLOUDFLARE_TOKEN = "cloudflare-unrelated-e2e";

const awsModuleSource = {
  path: "main.tf",
  text: `terraform {
  required_providers {
    aws = {
      source  = "${AWS_PROVIDER}"
      version = "= 5.0.0"
    }
  }
}

resource "aws_s3_bucket" "smoke" {
  bucket = "aws-generic-e2e"
}

output "launch_url" {
  value = "https://aws-generic-e2e.example.test"
}
`,
} as const;

function runnerProfile(): RunnerProfile {
  return {
    id: "aws-generic-e2e-runner",
    name: "AWS generic e2e runner",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: [AWS_PROVIDER, CLOUDFLARE_PROVIDER],
    requireProviderBindings: true,
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    networkPolicy: { mode: "operator-managed" },
    secretExposurePolicy: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
    createdAt: Date.parse(NOW),
  };
}

function recordingRunner(observed: {
  plan?: OpenTofuPlanJob;
  apply?: OpenTofuApplyJob;
}): OpenTofuRunner {
  return {
    plan: async (job): Promise<OpenTofuPlanResult> => {
      observed.plan = job;
      return {
        planDigest: `sha256:${"a".repeat(64)}`,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://aws-generic-e2e/tfplan",
          digest: `sha256:${"a".repeat(64)}`,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: `sha256:${"b".repeat(64)}`,
        // The source module declares AWS only. The Capsule still has an
        // unrelated Cloudflare binding, which the broker must not mint.
        requiredProviders: [AWS_PROVIDER],
        providerInstallation: [FIXTURE_AWS_MIRROR_EVIDENCE],
      };
    },
    apply: async (job) => {
      observed.apply = job;
      return {
        stateDigest: FIXTURE_STATE_DIGEST,
        rawOutputRef: job.rawOutputRef,
        outputs: {},
      };
    },
    destroy: async () => ({ stateDigest: FIXTURE_STATE_DIGEST }),
  };
}

async function makeVault(store: OpenTofuControlStore) {
  let nextConnectionId = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "aws-generic-e2e-passphrase-0123456789",
    }),
    now: () => new Date(NOW),
    newId: () => `conn_aws_generic_${++nextConnectionId}`,
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
        (recipe) => recipe.id === id,
      ),
    credentialDrivers:
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
  });
  const aws = await vault.register({
    workspaceId: WORKSPACE_ID,
    provider: AWS_PROVIDER,
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
    },
    values: {
      AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN,
      AWS_REGION: "us-east-1",
    },
  });
  const cloudflare = await vault.register({
    workspaceId: WORKSPACE_ID,
    provider: CLOUDFLARE_PROVIDER,
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
    },
    values: { CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN },
  });
  await expect(vault.test(aws.id)).resolves.toMatchObject({
    status: "verified",
  });
  await expect(vault.test(cloudflare.id)).resolves.toMatchObject({
    status: "verified",
  });
  const verifiedAws = await store.getConnection(aws.id);
  const verifiedCloudflare = await store.getConnection(cloudflare.id);
  if (!verifiedAws || !verifiedCloudflare) {
    throw new Error("Vault verification did not persist both connections");
  }
  expect(verifiedAws.status).toBe("verified");
  expect(verifiedCloudflare.status).toBe("verified");
  return { vault, aws: verifiedAws, cloudflare: verifiedCloudflare };
}

async function putCompatibilityReport(input: {
  readonly store: OpenTofuControlStore;
  readonly sourceSnapshot: SourceSnapshot;
  readonly installConfig: InstallConfig;
  readonly capsuleId: string;
}): Promise<CapsuleCompatibilityReport> {
  const analysis = analyzeOpenTofuCapsuleFiles({
    sourceId: input.sourceSnapshot.sourceId,
    sourceSnapshot: input.sourceSnapshot,
    files: [awsModuleSource],
    policy: input.installConfig.policy,
  });
  expect(analysis.level).toBe("ready");
  expect(analysis.providerPackages.map((provider) => provider.source)).toEqual([
    AWS_PROVIDER,
  ]);
  const report: CapsuleCompatibilityReport = {
    id: "caprep_aws_generic_e2e",
    sourceId: input.sourceSnapshot.sourceId,
    capsuleId: input.capsuleId,
    sourceSnapshotId: input.sourceSnapshot.id,
    modulePath: ".",
    level: analysis.level,
    findings: analysis.findings,
    providerPackages: analysis.providerPackages,
    rootProviderRequirements: analysis.rootProviderRequirements,
    resources: analysis.resources,
    dataSources: analysis.dataSources,
    provisioners: analysis.provisioners,
    rootModuleVariables: analysis.rootModuleVariables,
    rootModuleVariableDeclarations: analysis.rootModuleVariableDeclarations,
    rootModuleOutputs: analysis.rootModuleOutputs,
    createdAt: NOW,
  };
  await input.store.putCapsuleCompatibilityReport(report);
  return report;
}

test("AWS module + verified Workspace binding mints only its declared provider", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const installConfig: Partial<InstallConfig> = {
    policy: {
      allowedProviders: [AWS_PROVIDER, CLOUDFLARE_PROVIDER],
      providerCredentials: { requiredProviders: [AWS_PROVIDER] },
    },
  };
  const seeded = await seedCapsuleModel(store, {
    workspaceId: WORKSPACE_ID,
    capsuleId: "cap_aws_generic_e2e",
    environment: "preview",
    installConfig,
  });
  const { vault, aws, cloudflare } = await makeVault(store);
  await store.putProviderBindingSet({
    id: "bindings_aws_generic_e2e",
    workspaceId: WORKSPACE_ID,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: AWS_PROVIDER,
        moduleLocalName: "aws",
        connectionId: aws.id,
      },
      {
        provider: CLOUDFLARE_PROVIDER,
        moduleLocalName: "cloudflare",
        connectionId: cloudflare.id,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const report = await putCompatibilityReport({
    store,
    sourceSnapshot: seeded.snapshot,
    installConfig: (await store.getInstallConfig(seeded.installConfig.id))!,
    capsuleId: seeded.capsule.id,
  });
  const observed: { plan?: OpenTofuPlanJob; apply?: OpenTofuApplyJob } = {};
  const profile = runnerProfile();
  const controller = new OpenTofuController({
    store,
    runner: recordingRunner(observed),
    vault,
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => Date.parse(NOW),
    newId: (prefix) => `${prefix}_aws_generic_e2e`,
  });

  const planned = await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId: report.id },
  );

  expect(planned.planRun.status).toBe("succeeded");
  expect(planned.planRun.requiredProviders).toEqual([AWS_PROVIDER]);
  expect(observed.plan?.generatedRoot?.files["versions.tf"]).toContain(
    AWS_PROVIDER,
  );
  expect(observed.plan?.credentials?.env).toEqual({
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN,
    AWS_REGION: "us-east-1",
  });
  expect(observed.plan?.credentials?.env).not.toHaveProperty(
    "CLOUDFLARE_API_TOKEN",
  );
  expect(observed.plan?.credentials?.manifest.bindings.map((binding) =>
    binding.providerSource
  )).toEqual([AWS_PROVIDER]);
  expect(JSON.stringify(observed.plan?.generatedRoot)).not.toContain(
    AWS_SECRET_ACCESS_KEY,
  );
  expect(
    (await store.listCredentialMintEventsForRun(planned.planRun.id)).map(
      (event) => event.connectionId,
    ),
  ).toEqual([aws.id]);

  const applied = await controller.createApplyRun({
    planRunId: planned.planRun.id,
    expected: applyExpectedGuardFromPlanRun(planned.planRun),
  });
  expect(applied.applyRun.status).toBe("succeeded");
  expect(observed.apply?.credentials?.env).toEqual(
    observed.plan?.credentials?.env,
  );
  expect(observed.apply?.credentials?.env).not.toHaveProperty(
    "CLOUDFLARE_API_TOKEN",
  );
  expect(
    (await store.listCredentialMintEventsForRun(applied.applyRun.id)).map(
      (event) => event.connectionId,
    ),
  ).toEqual([aws.id]);
});
