// TASK-0118 Phase 9: the golden test pins every scopeRef-derived value at its
// leaf function. This file drives the RunEngine itself with a Capsule whose
// frozen scopeRef differs from its live Workspace id, so reverting a CALLER to
// the Workspace id fails here even though every leaf still passes.
import { expect, test } from "bun:test";

import type { InstallConfig } from "takosumi-contract/install-configs";
import type {
  OpenTofuApplyJob,
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
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createRuntimeInputMaterializer,
  runtimeInputProviderInstanceForStorage,
} from "../../../../core/domains/deploy-control/runtime_input_materializer.ts";
import { destroyRuntimeInputNonce } from "../../../../core/domains/deploy-control/run-engine/run_engine.ts";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { analyzeOpenTofuCapsuleFiles } from "../../../../core/domains/sources/capsule_compatibility.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";
import {
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fixtureExecutionEvidence,
  seedCapsuleModel,
  transitionProviderBindingSetForFixture,
} from "../../../helpers/deploy-control/model_fixture.ts";

const PROVIDER = "registry.opentofu.org/tako0614/takoform";
const WORKSPACE_ID = "ws_scope_wiring_live";
/** Frozen before the (simulated) Workspace move; every derivation reads it. */
const SCOPE_REF = "ws_scope_wiring_frozen";
const CAPSULE_ID = "cap_scope_wiring";
const NOW = "2026-10-30T00:00:00.000Z";

const installConfig: InstallConfig = {
  id: "cfg_scope_wiring",
  workspaceId: WORKSPACE_ID,
  name: "scope-wiring",
  variableMapping: {},
  installContextVariableMapping: {
    app_workspace_id: "workspace_id",
    app_capsule_id: "capsule_id",
  },
  outputAllowlist: {},
  policy: { providerCredentials: { requiredProviders: [PROVIDER] } },
  runtimeBindingMaterialization: {
    contract: "takosumi.runtime-binding-profile/v2",
    generatedSecrets: [{ binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" }],
  },
  createdAt: NOW,
  updatedAt: NOW,
};

const MODULE = {
  path: "main.tf",
  text: `terraform {
  required_providers {
    takoform = {
      source  = "tako0614/takoform"
      version = "= 4.0.0"
    }
  }
}

variable "app_workspace_id" {
  type = string
}

variable "app_capsule_id" {
  type = string
}

resource "takoform_edge_worker_version" "app" {
  name = "scope-wiring"
}

output "launch_url" {
  value = takoform_edge_worker_version.app.url
}
`,
} as const;

function runnerProfile(): RunnerProfile {
  return {
    id: "scope-wiring-runner",
    name: "Scope wiring runner",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: [PROVIDER],
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

function planResult(): OpenTofuPlanResult {
  return {
    planDigest: `sha256:${"c".repeat(64)}`,
    planArtifact: {
      kind: "runner-local",
      ref: "runner-local://scope-wiring/tfplan",
      digest: `sha256:${"c".repeat(64)}`,
      contentType: "application/vnd.opentofu.plan",
    },
    providerLockDigest: `sha256:${"a".repeat(64)}`,
    requiredProviders: [PROVIDER],
    providerInstallation: [
      {
        provider: PROVIDER,
        mirrored: true,
        installationMethod: "filesystem_mirror",
        attested: true,
        attestationMethod: "test_filesystem_mirror",
        mirrorPath: `/opt/opentofu/provider-mirror/${PROVIDER}`,
        installedDigest: `sha256:${"e".repeat(64)}`,
      },
    ],
  };
}

/**
 * A Capsule whose frozen scopeRef differs from its live Workspace id, as it
 * will once Workspace moves or is removed. Authority (the Workspace column,
 * connections, bindings) stays on the live Workspace.
 */
async function seedMovedCapsule() {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: WORKSPACE_ID,
    installConfigId: installConfig.id,
    capsuleId: CAPSULE_ID,
    name: "scope-wiring",
    installConfig,
  });
  await store.putCapsule({ ...seeded.capsule, scopeRef: SCOPE_REF });
  const stored = await store.getCapsule(CAPSULE_ID);
  expect(stored?.workspaceId).toBe(WORKSPACE_ID);
  expect(stored?.scopeRef).toBe(SCOPE_REF);

  const compatibility = analyzeOpenTofuCapsuleFiles({
    sourceId: seeded.source.id,
    sourceSnapshot: seeded.snapshot,
    files: [MODULE],
    policy: installConfig.policy,
  });
  const compatibilityReportId = `caprep_${CAPSULE_ID}`;
  await store.putCapsuleCompatibilityReport({
    id: compatibilityReportId,
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
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
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "scope-wiring-connection-passphrase-0123456789",
    }),
    now: () => new Date(NOW),
    newId: () => `conn_${CAPSULE_ID}`,
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
        (recipe) => recipe.id === id,
      ),
    credentialDrivers:
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
  });
  const connection = await vault.register({
    workspaceId: WORKSPACE_ID,
    provider: PROVIDER,
    credentialRecipe: {
      id: "takoform",
      authMode: "token",
      secretPartition: "provider-credentials",
    },
    values: {
      TAKOFORM_ENDPOINT: "https://forms.example.test",
      TAKOFORM_SPACE: "space_scope_wiring",
      TAKOFORM_TOKEN: "takoform-token-never-persisted",
    },
  }, undefined, null);
  await vault.test(connection.id, undefined, null);
  await transitionProviderBindingSetForFixture(store, {
    id: `ipcset_${CAPSULE_ID}`,
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    environment: seeded.capsule.environment,
    bindings: [
      { provider: PROVIDER, moduleLocalName: "takoform", connectionId: connection.id },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const observed: { plan?: OpenTofuPlanJob; apply?: OpenTofuApplyJob } = {};
  let runId = 0;
  const controller = new OpenTofuController({
    store,
    runner: {
      plan: async (job) => {
        observed.plan = job;
        return planResult();
      },
      apply: async (job) => {
        observed.apply = job;
        return {
          stateDigest: `sha256:${"d".repeat(64)}`,
          providerInstallation: planResult().providerInstallation,
          rawOutputRef: job.rawOutputRef,
          executionEvidence: fixtureExecutionEvidence(job, "apply"),
        };
      },
      destroy: async (job) => ({
        stateDigest: `sha256:${"d".repeat(64)}`,
        providerInstallation: planResult().providerInstallation,
        executionEvidence: fixtureExecutionEvidence(job, "destroy"),
      }),
    } as OpenTofuRunner,
    vault,
    runtimeInputMaterializer: createRuntimeInputMaterializer({
      store,
      crypto: new PartitionedSecretBoundaryCrypto({
        globalPassphrase: "scope-wiring-material-passphrase-0123456789",
      }),
      clock: () => new Date(NOW),
    }),
    runnerProfiles: [runnerProfile()],
    defaultRunnerProfileId: runnerProfile().id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    now: () => Date.parse(NOW),
    newId: (prefix) => `${prefix}_${CAPSULE_ID}_${String((runId += 1)).padStart(2, "0")}`,
  });
  return { store, controller, observed, compatibilityReportId };
}

test("Plan hands the module the frozen scopeRef as its install-context workspace_id", async () => {
  const { store, controller, observed, compatibilityReportId } = await seedMovedCapsule();

  const planned = await controller.createCapsulePlan(CAPSULE_ID, {}, { compatibilityReportId });
  expect(planned.planRun.status).toBe("succeeded");
  // Apps build storage paths, cookie contexts and resource names from this
  // input: it follows scopeRef, never the live Workspace id.
  expect(observed.plan?.variables).toMatchObject({
    app_workspace_id: SCOPE_REF,
    app_capsule_id: CAPSULE_ID,
  });
  expect(JSON.stringify(observed.plan?.variables)).not.toContain(WORKSPACE_ID);

  const applied = await controller.createApplyRun({
    planRunId: planned.planRun.id,
    expected: applyExpectedGuardFromPlanRun(planned.planRun),
  });
  expect(applied.applyRun.status).toBe("succeeded");
  // The sealed runtime input names the frozen scope in its AAD, while the
  // owner fence stays on the live Workspace column (authority).
  const sealed = await store.getSecretBlob(`runtime_input_${CAPSULE_ID}`);
  expect(JSON.parse(sealed?.aad ?? "{}")).toMatchObject({ workspaceId: SCOPE_REF });
  expect(sealed?.workspaceId).toBe(WORKSPACE_ID);
});

test("a destroy Plan bakes the destroy nonce derived from the frozen scopeRef", async () => {
  const { store, controller, observed, compatibilityReportId } = await seedMovedCapsule();
  const create = await controller.createCapsulePlan(CAPSULE_ID, {}, { compatibilityReportId });
  const applied = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  expect(applied.applyRun.status).toBe("succeeded");
  const capsule = await store.getCapsule(CAPSULE_ID);
  if (!capsule) throw new Error("fixture Capsule is missing");
  expect(capsule.scopeRef).toBe(SCOPE_REF);

  observed.plan = undefined;
  const destroy = await controller.createCapsuleDestroyPlan(CAPSULE_ID);
  expect(destroy.planRun.status).toBe("waiting_approval");
  const baked = observed.plan?.generatedRoot?.files["main.tf"]?.match(
    /runtime_input_nonce\s*=\s*"([A-Za-z0-9_-]{43})"/u,
  )?.[1];
  const cursor = {
    capsuleId: CAPSULE_ID,
    providerInstance: runtimeInputProviderInstanceForStorage({ moduleLocalName: "takoform" }),
    currentStateVersionId: capsule.currentStateVersionId ?? null,
    currentStateGeneration: capsule.currentStateGeneration,
  };
  expect(baked).toBe(await destroyRuntimeInputNonce({ ...cursor, scopeRef: SCOPE_REF }));
  expect(baked).not.toBe(await destroyRuntimeInputNonce({ ...cursor, scopeRef: WORKSPACE_ID }));
});
