import { expect, test } from "bun:test";

import type { Capsule } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type {
  OpenTofuApplyJob,
  OpenTofuApplyResult,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
  RunnerProfile,
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
import { ConnectionsService } from "../../../../core/domains/connections/mod.ts";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { analyzeOpenTofuCapsuleFiles } from "../../../../core/domains/sources/capsule_compatibility.ts";
import { RunCredentialBroker } from "../../../../core/domains/deploy-control/run_credential_broker.ts";
import { generateOpenTofuChildModuleRoot } from "../../../../lib/rootgen/src/mod.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";

const TAKOSERVER_PROVIDER = "registry.terraform.io/tako0614/takoform";
const TAKOSERVER_TOKEN = "takoserver-provider-token-never-persisted";
const WORKSPACE_ID = "workspace_takoserver";
const SOURCE_URL = "https://git.example.test/takoserver-capsule.git";
const NOW = "2026-08-17T00:00:00.000Z";
const SNAPSHOT_DIGEST = `sha256:${"a".repeat(64)}`;

const repositoryManifest = {
  apiVersion: "takosumi.com/v2.1",
  kind: "Repository",
  install: {
    modules: { ".": { inputs: [] } },
  },
} satisfies RepositoryManifestDocument;

const source: Source = {
  id: "src_takoserver",
  workspaceId: WORKSPACE_ID,
  name: "takoserver-capsule",
  url: SOURCE_URL,
  defaultRef: "main",
  defaultPath: ".",
  status: "active",
  autoSync: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const snapshot: SourceSnapshot = {
  id: "snap_takoserver",
  origin: "git",
  workspaceId: WORKSPACE_ID,
  sourceId: source.id,
  url: source.url,
  ref: source.defaultRef,
  resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
  path: ".",
  archiveRef: "test://takoserver/source.tar.zst",
  archiveDigest: SNAPSHOT_DIGEST,
  archiveSizeBytes: 1,
  repositoryManifest: {
    status: "present",
    digest: `sha256:${"b".repeat(64)}`,
    document: repositoryManifest,
  },
  fetchedByRunId: "run_takoserver_sync",
  fetchedAt: NOW,
};

const installConfig: InstallConfig = {
  id: "cfg_takoserver",
  name: "takoserver-capsule",
  sourceSelector: { url: SOURCE_URL, path: "." },
  modulePath: ".",
  variableMapping: {},
  outputAllowlist: {
    object_bucket_id: {
      from: "object_bucket_id",
      type: "string",
      required: true,
    },
  },
  policy: {
    allowedProviders: [TAKOSERVER_PROVIDER],
    providerCredentials: {
      requiredProviders: [TAKOSERVER_PROVIDER],
    },
  },
  store: {
    source: { url: SOURCE_URL, path: "." },
    order: 1,
    surface: "service",
    kind: "provider",
    provider: "takoform",
    suggestedName: "takoserver-capsule",
    badge: { ja: "Takoserver", en: "Takoserver" },
    name: { ja: "Takoserver", en: "Takoserver" },
    description: {
      ja: "独立した Takoserver を Takoform provider として使います。",
      en: "Use an independent Takoserver through the Takoform provider.",
    },
    deploymentProfile: {
      key: "takoform-v2",
      label: { ja: "Takoform", en: "Takoform" },
      description: {
        ja: "SourceSnapshot の module を Takoserver に接続します。",
        en: "Connect the SourceSnapshot module to Takoserver.",
      },
      order: 1,
      recommended: true,
      management: {
        kind: "external_console",
        href: "https://console.takoserver.com/",
        label: { ja: "Takoserverで管理", en: "Manage in Takoserver" },
      },
    },
  },
  createdAt: NOW,
  updatedAt: NOW,
};

const providerSourceFile = {
  path: "main.tf",
  text: `terraform {
  required_providers {
    takoform = {
      source  = "${TAKOSERVER_PROVIDER}"
      version = "= 2.1.1"
    }
  }
}

resource "takoform_edge_object_bucket" "smoke" {
  name = "takoserver-smoke"
}

output "object_bucket_id" {
  value = takoform_edge_object_bucket.smoke.uid
}
`,
} as const;

function runnerProfile(): RunnerProfile {
  return {
    id: "takoserver-provider-test-runner",
    name: "Takoserver provider test runner",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: [TAKOSERVER_PROVIDER],
    requireProviderBindings: true,
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    stateLock: { kind: "native" },
    networkPolicy: { mode: "operator-managed" },
    secretExposure: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
    createdAt: Date.parse(NOW),
  };
}

function planResult(): OpenTofuPlanResult {
  return {
    planDigest: `sha256:${"c".repeat(64)}`,
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://takoserver/tfplan",
      digest: `sha256:${"c".repeat(64)}`,
      contentType: "application/vnd.opentofu.plan",
    },
    providerLockDigest: `sha256:${"a".repeat(64)}`,
    requiredProviders: [TAKOSERVER_PROVIDER],
    providerInstallation: [
      {
        provider: TAKOSERVER_PROVIDER,
        mirrored: true,
        installationMethod: "filesystem_mirror",
        attested: true,
        attestationMethod: "test_filesystem_mirror",
        mirrorPath:
          "/opt/opentofu/provider-mirror/registry.terraform.io/tako0614/takoform",
      },
    ],
  };
}

function applyResult(job: OpenTofuApplyJob): OpenTofuApplyResult {
  return {
    outputs: {
      object_bucket_id: {
        sensitive: false,
        value: "bucket_takoserver_smoke",
      },
    },
    stateDigest: `sha256:${"d".repeat(64)}`,
    rawOutputRef: job.rawOutputRef,
  };
}

function recordingRunner(observed: {
  plan?: OpenTofuPlanJob;
  apply?: OpenTofuApplyJob;
}): OpenTofuRunner {
  return {
    plan: async (job) => {
      observed.plan = job;
      return planResult();
    },
    apply: async (job) => {
      observed.apply = job;
      return applyResult(job);
    },
    destroy: async () => ({
      stateDigest: `sha256:${"d".repeat(64)}`,
    }),
  } as OpenTofuRunner;
}

function planRunForBroker(
  capsule: Capsule,
  sourceSnapshot: SourceSnapshot,
): PlanRun {
  return {
    id: "plan_takoserver",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      environment: capsule.environment,
    },
    source: { kind: "git", url: sourceSnapshot.url, ref: sourceSnapshot.ref },
    sourceDigest: sourceSnapshot.archiveDigest,
    sourceSnapshotId: sourceSnapshot.id,
    operation: "plan",
    runnerProfileId: runnerProfile().id,
    variablesDigest: `sha256:${"e".repeat(64)}`,
    requiredProviders: [TAKOSERVER_PROVIDER],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: Date.parse(NOW) },
    policyDecisionDigest: `sha256:${"f".repeat(64)}`,
    createdAt: NOW,
    updatedAt: NOW,
  } as PlanRun;
}

async function makeVault(store: OpenTofuControlStore) {
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "takoserver-test-passphrase-0123456789",
    }),
    now: () => new Date(NOW),
    newId: () => "conn_takoserver",
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
        (recipe) => recipe.id === id,
      ),
    credentialDrivers:
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
  });
  const connection = await vault.register({
    workspaceId: WORKSPACE_ID,
    provider: TAKOSERVER_PROVIDER,
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
    },
    values: {
      TAKOFORM_ENDPOINT: "https://api.takoserver.example",
      TAKOFORM_SPACE: "space_takoserver",
      TAKOFORM_TOKEN: TAKOSERVER_TOKEN,
    },
  });
  await vault.test(connection.id);
  return { vault, connection };
}

async function seedTakoserverRunModel(
  store: OpenTofuControlStore,
  options: { readonly capsuleId: string; readonly compatibilityReportId: string },
) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: WORKSPACE_ID,
    sourceId: source.id,
    sourceUrl: SOURCE_URL,
    installConfigId: installConfig.id,
    capsuleId: options.capsuleId,
    environment: "preview",
    name: "takoserver-capsule",
    installConfig,
  });
  await store.putSourceSnapshot(snapshot);
  const compatibility = analyzeOpenTofuCapsuleFiles({
    sourceId: source.id,
    sourceSnapshot: snapshot,
    files: [providerSourceFile],
    policy: installConfig.policy,
  });
  await store.putCapsuleCompatibilityReport({
    id: options.compatibilityReportId,
    sourceId: source.id,
    sourceSnapshotId: snapshot.id,
    modulePath: ".",
    level: compatibility.level,
    findings: compatibility.findings,
    providerPackages: compatibility.providerPackages,
    rootProviderRequirements: compatibility.rootProviderRequirements,
    resources: compatibility.resources,
    dataSources: compatibility.dataSources,
    provisioners: compatibility.provisioners,
    rootModuleVariables: compatibility.rootModuleVariables,
    rootModuleVariableDeclarations: compatibility.rootModuleVariableDeclarations,
    rootModuleOutputs: compatibility.rootModuleOutputs,
    createdAt: NOW,
  });
  const { vault, connection } = await makeVault(store);
  await store.putProviderBindingSet({
    id: `ipcset_${options.capsuleId}`,
    workspaceId: WORKSPACE_ID,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: TAKOSERVER_PROVIDER,
        moduleLocalName: "takoform",
        connectionId: connection.id,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { seeded, vault, connection };
}

test("generic Takoform install using a Takoserver Host connection uses the exact provider binding and runner-only env", async () => {
  const profileCompatibility = analyzeOpenTofuCapsuleFiles({
    sourceId: source.id,
    sourceSnapshot: snapshot,
    files: [providerSourceFile],
    policy: installConfig.policy,
  });
  expect(profileCompatibility.level).toBe("ready");
  expect(profileCompatibility.providerPackages).toEqual([
    {
      source: TAKOSERVER_PROVIDER,
      version: "2.1.1",
      allowed: true,
    },
  ]);
  expect(profileCompatibility.rootProviderRequirements).toEqual([
    {
      source: TAKOSERVER_PROVIDER,
      moduleLocalName: "takoform",
      version: "2.1.1",
      credentialRequired: true,
    },
  ]);

  const store = new InMemoryOpenTofuControlStore();
  const { seeded, vault, connection } =
    await seedTakoserverRunModel(store, {
      capsuleId: "cap_takoserver",
      compatibilityReportId: "caprep_takoserver",
    });

  const connections = new ConnectionsService({ store });
  const resolved = await connections.resolveProviderBindingsForRun(
    seeded.capsule,
    [
      {
        source: TAKOSERVER_PROVIDER,
        moduleLocalName: "takoform",
        version: "2.1.1",
        allowed: true,
        credentialRequired: true,
      },
    ],
  );
  expect(resolved).toHaveLength(1);
  expect(resolved[0]).toMatchObject({
    provider: TAKOSERVER_PROVIDER,
    moduleLocalName: "takoform",
    connection: {
      id: connection.id,
      provider: TAKOSERVER_PROVIDER,
      providerSource: TAKOSERVER_PROVIDER,
      envNames: [
        "TAKOFORM_ENDPOINT",
        "TAKOFORM_SPACE",
        "TAKOFORM_TOKEN",
      ],
    },
  });

  const generatedRoot = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      { source: TAKOSERVER_PROVIDER, moduleLocalName: "takoform" },
    ],
    inputs: {},
    outputAllowlist: installConfig.outputAllowlist,
    providerBindings: resolved.map((entry) => ({
      provider: entry.provider,
      moduleLocalName: entry.moduleLocalName,
    })),
  });
  expect(generatedRoot.files["versions.tf"]).toContain(TAKOSERVER_PROVIDER);
  expect(generatedRoot.files["versions.tf"]).not.toContain(
    "registry.opentofu.org/tako0614/takoform",
  );
  expect(JSON.stringify(generatedRoot)).not.toContain(TAKOSERVER_TOKEN);

  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_takoserver`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => resolved,
    policyForPlanRun: async () => installConfig.policy,
  });
  const credentials = await broker.mintRunCredentials(
    planRunForBroker(seeded.capsule, snapshot),
    "plan",
    "run_takoserver",
  );
  expect(credentials?.manifest).toEqual({
    bindings: [
      {
        providerSource: TAKOSERVER_PROVIDER,
        connectionId: connection.id,
        recipeId: "generic-env",
        authMode: "env",
        envNames: [
          "TAKOFORM_ENDPOINT",
          "TAKOFORM_SPACE",
          "TAKOFORM_TOKEN",
        ],
        fileEnvNames: [],
        requiredEnvGroups: [],
      },
    ],
  });
  expect(credentials?.env).toEqual({
    TAKOFORM_ENDPOINT: "https://api.takoserver.example",
    TAKOFORM_SPACE: "space_takoserver",
    TAKOFORM_TOKEN: TAKOSERVER_TOKEN,
  });

  const persisted = {
    installConfig,
    binding: resolved[0],
    manifest: credentials?.manifest,
    mintEvents: await store.listCredentialMintEventsForRun("run_takoserver"),
    state: { sourceSnapshotId: snapshot.id, digest: `sha256:${"1".repeat(64)}` },
    output: { object_bucket_id: "bucket_takoserver_smoke" },
  };
  expect(JSON.stringify(persisted)).not.toContain(TAKOSERVER_TOKEN);
});

test("generic Takoform install keeps Takoserver Host credentials dispatch-only through the Capsule apply ledger", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { seeded, vault, connection } = await seedTakoserverRunModel(store, {
    capsuleId: "cap_takoserver_apply",
    compatibilityReportId: "caprep_takoserver_apply",
  });

  const observed: { plan?: OpenTofuPlanJob; apply?: OpenTofuApplyJob } = {};
  const controller = new OpenTofuController({
    store,
    runner: recordingRunner(observed),
    vault,
    runnerProfiles: [runnerProfile()],
    defaultRunnerProfileId: runnerProfile().id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => Date.parse(NOW),
    newId: (prefix) => `${prefix}_takoserver`,
  });
  const planned = await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId: "caprep_takoserver_apply" },
  );
  expect(planned.planRun.requiredProviders).toEqual([TAKOSERVER_PROVIDER]);
  expect(observed.plan?.credentials?.manifest.bindings[0]?.providerSource).toBe(
    TAKOSERVER_PROVIDER,
  );
  expect(observed.plan?.credentials?.manifest.bindings[0]?.envNames).toEqual([
    "TAKOFORM_ENDPOINT",
    "TAKOFORM_SPACE",
    "TAKOFORM_TOKEN",
  ]);
  expect(JSON.stringify(observed.plan?.credentials?.manifest)).not.toContain(
    TAKOSERVER_TOKEN,
  );

  const applied = await controller.createApplyRun({
    planRunId: planned.planRun.id,
    expected: applyExpectedGuardFromPlanRun(planned.planRun),
  });
  expect(applied.applyRun.status).toBe("succeeded");
  expect(observed.apply?.credentials?.env.TAKOFORM_TOKEN).toBe(
    TAKOSERVER_TOKEN,
  );
  expect(JSON.stringify(observed.apply?.credentials?.manifest)).not.toContain(
    TAKOSERVER_TOKEN,
  );

  const state = await store.getStateVersion(applied.applyRun.stateVersionId!);
  const output = await store.getOutput(applied.applyRun.outputId!);
  const run = await controller.getRun(applied.applyRun.id);
  const mintEvents = await store.listCredentialMintEventsForRun(
    applied.applyRun.id,
  );
  expect(output?.publicOutputs).toEqual({
    object_bucket_id: "bucket_takoserver_smoke",
  });
  expect(output?.workspaceOutputs).toEqual({
    object_bucket_id: "bucket_takoserver_smoke",
  });
  expect(JSON.stringify({ state, output, run, mintEvents })).not.toContain(
    TAKOSERVER_TOKEN,
  );
});
