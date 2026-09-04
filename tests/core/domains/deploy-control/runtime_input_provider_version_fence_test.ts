// The two provider-block arguments for run-scoped sensitive inputs exist only
// from Takoform Provider 4.0.0. Below that floor the provider refuses them with
// `Unsupported argument`, and the refusal lands only after the reviewed root is
// already baked — so the wiring must stay inert instead, without failing a
// Capsule that never needed it.
import { expect, test } from "bun:test";

import type { InstallConfig } from "takosumi-contract/install-configs";
import type { OpenTofuPlanJob } from "../../../../core/domains/deploy-control/mod.ts";
import type {
  OpenTofuPlanResult,
  OpenTofuRunner,
  RunnerProfile,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import {
  createRuntimeInputMaterializer,
  type RuntimeInputOidcClientSource,
} from "../../../../core/domains/deploy-control/runtime_input_materializer.ts";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { analyzeOpenTofuCapsuleFiles } from "../../../../core/domains/sources/capsule_compatibility.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";
import {
  seedCapsuleModel,
  transitionProviderBindingSetForFixture,
} from "../../../helpers/deploy-control/model_fixture.ts";

const PROVIDER = "registry.opentofu.org/tako0614/takoform";
const WORKSPACE_ID = "workspace_runtime_input_fence";
const NOW = "2026-09-01T00:00:00.000Z";
const VARIABLE = "takosumi_runtime_inputs__takoform";

const installConfig: InstallConfig = {
  id: "cfg_runtime_input_fence",
  workspaceId: WORKSPACE_ID,
  name: "runtime-input-fence",
  variableMapping: {},
  outputAllowlist: {},
  policy: { providerCredentials: { requiredProviders: [PROVIDER] } },
  runtimeBindingMaterialization: {
    contract: "takosumi.runtime-binding-profile/v2",
    generatedSecrets: [{ binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" }],
  },
  createdAt: NOW,
  updatedAt: NOW,
};

function moduleFile(version: string) {
  return {
    path: "main.tf",
    text: `terraform {
  required_providers {
    takoform = {
      source  = "tako0614/takoform"
      version = "= ${version}"
    }
  }
}

resource "takoform_edge_worker_version" "app" {
  name = "fence"
}

output "launch_url" {
  value = takoform_edge_worker_version.app.url
}
`,
  } as const;
}

function runnerProfile(): RunnerProfile {
  return {
    id: "runtime-input-fence-runner",
    name: "Runtime input fence runner",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: [PROVIDER],
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
      ref: "runner-local://fence/tfplan",
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
      },
    ],
  };
}

async function seedFenceModel(
  store: OpenTofuControlStore,
  options: {
    readonly providerVersion: string;
    readonly capsuleId: string;
    /** Profile override, for a Capsule that also delivers OIDC by bindings. */
    readonly installConfig?: InstallConfig;
    readonly oidcClient?: RuntimeInputOidcClientSource;
  },
) {
  const config = options.installConfig ?? installConfig;
  const seeded = await seedCapsuleModel(store, {
    workspaceId: WORKSPACE_ID,
    installConfigId: config.id,
    capsuleId: options.capsuleId,
    name: "runtime-input-fence",
    installConfig: config,
  });
  const compatibility = analyzeOpenTofuCapsuleFiles({
    sourceId: seeded.source.id,
    sourceSnapshot: seeded.snapshot,
    files: [moduleFile(options.providerVersion)],
    policy: config.policy,
  });
  expect(compatibility.rootProviderRequirements).toEqual([
    {
      source: PROVIDER,
      moduleLocalName: "takoform",
      version: options.providerVersion,
      credentialRequired: true,
    },
  ]);
  const compatibilityReportId = `caprep_${options.capsuleId}`;
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
      globalPassphrase: "runtime-input-fence-passphrase-0123456789",
    }),
    now: () => new Date(NOW),
    newId: () => `conn_${options.capsuleId}`,
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
      TAKOFORM_SPACE: "space_fence",
      TAKOFORM_TOKEN: "takoform-token-never-persisted",
    },
  });
  // The protocol descriptor is recipe authority, pinned at registration.
  expect(connection.credentialRecipe?.runtimeInputs).toEqual({
    contract: "takosumi.provider-runtime-inputs/v1",
    nonceArgument: "runtime_input_nonce",
    mapArgument: "runtime_inputs",
    minimumProviderVersion: "4.0.0",
  });
  await vault.test(connection.id);
  await transitionProviderBindingSetForFixture(store, {
    id: `ipcset_${options.capsuleId}`,
    workspaceId: WORKSPACE_ID,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      { provider: PROVIDER, moduleLocalName: "takoform", connectionId: connection.id },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const observed: { plan?: OpenTofuPlanJob } = {};
  let runId = 0;
  const controller = new OpenTofuController({
    store,
    runner: {
      plan: async (job) => {
        observed.plan = job;
        return planResult();
      },
      apply: async () => ({ stateDigest: `sha256:${"d".repeat(64)}` }),
      destroy: async () => ({ stateDigest: `sha256:${"d".repeat(64)}` }),
    } as OpenTofuRunner,
    vault,
    runtimeInputMaterializer: createRuntimeInputMaterializer({
      store,
      crypto: new PartitionedSecretBoundaryCrypto({
        globalPassphrase: "runtime-input-fence-material-0123456789",
      }),
      clock: () => new Date(NOW),
      ...(options.oidcClient ? { oidcClient: options.oidcClient } : {}),
    }),
    runnerProfiles: [runnerProfile()],
    defaultRunnerProfileId: runnerProfile().id,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => Date.parse(NOW),
    newId: (prefix) =>
      `${prefix}_${options.capsuleId}_${String((runId += 1)).padStart(2, "0")}`,
  });
  return { seeded, controller, observed, compatibilityReportId };
}

test("a provider pinned at or above the floor receives the run-scoped sensitive input wiring", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { seeded, controller, observed, compatibilityReportId } =
    await seedFenceModel(store, {
      providerVersion: "4.0.0",
      capsuleId: "cap_fence_ready",
    });

  const planned = await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId },
  );
  expect(planned.planRun.status).toBe("succeeded");

  const files = observed.plan?.generatedRoot?.files ?? {};
  expect(files["variables.tf"]).toContain(`variable "${VARIABLE}"`);
  expect(files["variables.tf"]).toContain("ephemeral = true");
  expect(files["main.tf"]).toContain("runtime_input_nonce = ");
  expect(files["main.tf"]).toContain(`runtime_inputs = var.${VARIABLE}`);
  // Plan carries the reviewed name set with no values.
  expect(observed.plan?.credentials?.runtimeInputs).toEqual([
    { variableName: VARIABLE, names: ["ENCRYPTION_KEY"], values: {} },
  ]);
  expect(planned.planRun.diagnostics ?? []).toEqual([]);
});

test("a provider below the floor stays inert and the plan says why", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { seeded, controller, observed, compatibilityReportId } =
    await seedFenceModel(store, {
      providerVersion: "3.0.0",
      capsuleId: "cap_fence_old",
    });

  const planned = await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId },
  );
  // A Capsule that does not need run-scoped sensitive inputs must still plan.
  expect(planned.planRun.status).toBe("succeeded");

  const files = observed.plan?.generatedRoot?.files ?? {};
  expect(Object.keys(files).sort()).toEqual([
    "main.tf",
    "outputs.tf",
    "versions.tf",
  ]);
  expect(files["main.tf"]).not.toContain("runtime_input_nonce");
  expect(files["main.tf"]).not.toContain("runtime_inputs");
  expect(observed.plan?.credentials?.runtimeInputs).toBeUndefined();

  const stored = await store.getPlanRun(planned.planRun.id);
  const diagnostic = (stored?.diagnostics ?? []).find(
    (entry) => entry.code === "runtime_inputs_provider_version_unproven",
  );
  expect(diagnostic?.severity).toBe("warning");
  expect(diagnostic?.message).toContain("4.0.0");
  // The notice names the floor and the pinned version, and nothing else.
  expect(JSON.stringify(stored?.diagnostics)).not.toContain("ENCRYPTION_KEY");
  // No material was minted for a Capsule the path never reached.
  expect(
    await store.getSecretBlob(`runtime_input_${seeded.capsule.id}`),
  ).toBeUndefined();
});

/**
 * Yurucommu's shape: one generated secret plus a binding-delivered OIDC grant.
 * Its Takoform WorkerVersion declares all five names in
 * `required_sensitive_vars`, and the Host refuses a map whose names differ, so
 * the reviewed plan must carry the whole set — and still no value.
 */
const OIDC_SENSITIVE_VARS = [
  "ENCRYPTION_KEY",
  "TAKOSUMI_ACCOUNTS_CLIENT_ID",
  "TAKOSUMI_ACCOUNTS_ISSUER_URL",
  "TAKOSUMI_ACCOUNTS_OWNER_SUB",
  "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
];

const oidcInstallConfig: InstallConfig = {
  ...installConfig,
  id: "cfg_runtime_input_fence_oidc",
  runtimeBindingMaterialization: {
    contract: "takosumi.runtime-binding-profile/v2",
    generatedSecrets: [
      { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
    ],
    oidcClient: {
      issuerBinding: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      clientIdBinding: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      ownerSubjectBinding: "TAKOSUMI_ACCOUNTS_OWNER_SUB",
      redirectUriBinding: "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
      callbackPath: "/api/auth/callback/takos",
      scopes: ["openid", "profile", "email"],
    },
  },
};

const fenceOidcClient: RuntimeInputOidcClientSource = {
  async generation() {
    return "sha256:fence-oidc-generation";
  },
  async materialize() {
    return {
      generation: "sha256:fence-oidc-generation",
      values: {
        TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.takosumi.test",
        TAKOSUMI_ACCOUNTS_CLIENT_ID: "tko_fence_client_identifier_value",
        TAKOSUMI_ACCOUNTS_OWNER_SUB: "tsub_fence_owner_subject_value",
        TAKOSUMI_ACCOUNTS_REDIRECT_URI:
          "https://fence.example.test/api/auth/callback/takos",
      },
    };
  },
};

test("a plan for an OIDC-delivering profile reviews all five names and no value", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { seeded, controller, observed, compatibilityReportId } =
    await seedFenceModel(store, {
      providerVersion: "4.0.0",
      capsuleId: "cap_fence_oidc",
      installConfig: oidcInstallConfig,
      oidcClient: fenceOidcClient,
    });

  const planned = await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId },
  );
  expect(planned.planRun.status).toBe("succeeded");
  expect(observed.plan?.credentials?.runtimeInputs).toEqual([
    { variableName: VARIABLE, names: OIDC_SENSITIVE_VARS, values: {} },
  ]);
  // The reviewed plan is value-free in every artifact it carries, including
  // the OIDC half the port supplies only at Apply.
  const planned_json = JSON.stringify(observed.plan);
  for (const fragment of [
    "accounts.takosumi.test",
    "tko_fence_client_identifier_value",
    "tsub_fence_owner_subject_value",
  ]) {
    expect(planned_json).not.toContain(fragment);
  }

  // A destroy plan pins no descriptor at all: its provider teardown never reads
  // the map, and minting for a teardown would widen exposure for no purpose.
  observed.plan = undefined;
  const destroyed = await controller.createCapsuleDestroyPlan(
    seeded.capsule.id,
    { compatibilityReportId },
  );
  // A destructive plan parks for approval; what matters here is that it was
  // planned at all, and that it pinned nothing to mint.
  expect(destroyed.planRun.status).toBe("waiting_approval");
  expect(observed.plan?.credentials?.runtimeInputs).toBeUndefined();
});
