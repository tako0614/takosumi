import { test, expect } from "bun:test";
import type { PlanRun } from "../../../../contract/internal-deploy-control-api.ts";
import type { ProviderConnection } from "../../../../contract/connections.ts";
import type { Workspace } from "../../../../contract/workspaces.ts";
import { RunCredentialBroker } from "../../../../core/domains/deploy-control/run_credential_broker.ts";
import type { ResolvedCapsuleProviderBinding } from "../../../../core/domains/connections/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  PhaseMintBundle,
  type CapsuleProviderBindingMintEntry,
  type ConnectionVault,
} from "../../../../core/adapters/vault/mod.ts";
import { mergePolicyConfigs } from "../../../../core/domains/deploy-control/provider_policy.ts";
import {
  RuntimeInputBundle,
  runtimeInputProviderInstance,
  type RuntimeInputMaterializer,
} from "../../../../core/domains/deploy-control/runtime_input_materializer.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const NOW = "2026-06-06T00:00:00.000Z";

function connection(
  id: string,
  providerSource: string,
  envName: string,
): ProviderConnection {
  return {
    id,
    workspaceId: "workspace_1",
    provider: providerSource,
    providerSource,
    scope: "workspace",
    status: "active",
    materialization: "static",
    envNames: [envName],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function resolvedBinding(
  providerSource: string,
  id: string,
  envName: string,
): ResolvedCapsuleProviderBinding {
  return {
    provider: providerSource,
    connection: connection(id, providerSource, envName),
    materialization: "static",
  };
}

const CLOUDFLARE = resolvedBinding(
  "registry.opentofu.org/cloudflare/cloudflare",
  "conn_cloudflare",
  "CLOUDFLARE_API_TOKEN",
);
const AWS = resolvedBinding(
  "registry.opentofu.org/hashicorp/aws",
  "conn_aws",
  "AWS_SECRET_ACCESS_KEY",
);

function planRun(requiredProviders: readonly string[]): PlanRun {
  return {
    id: "plan_1",
    workspaceId: "workspace_1",
    capsuleId: "cap_1",
    capsuleContext: {
      workspaceId: "workspace_1",
      capsuleId: "cap_1",
      environment: "production",
    },
    source: { kind: "git", url: "https://example.test/repo.git", ref: "main" },
    sourceDigest: `sha256:${"1".repeat(64)}`,
    operation: "plan",
    runnerProfileId: "opentofu-default",
    variablesDigest: `sha256:${"2".repeat(64)}`,
    requiredProviders,
    status: "queued",
    policy: { decision: "pass", reasons: [] },
    policyDecisionDigest: `sha256:${"3".repeat(64)}`,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as PlanRun;
}

function brokerFor(resolved: readonly ResolvedCapsuleProviderBinding[]): {
  readonly broker: RunCredentialBroker;
  readonly mintedEntries: CapsuleProviderBindingMintEntry[][];
  readonly store: InMemoryOpenTofuControlStore;
} {
  const mintedEntries: CapsuleProviderBindingMintEntry[][] = [];
  const vault = {
    mintForCapsuleProviderBindings: (
      _workspaceId: string,
      entries: readonly CapsuleProviderBindingMintEntry[],
    ) => {
      mintedEntries.push([...entries]);
      const env: Record<string, string> = {};
      for (const entry of entries) {
        const match = resolved.find(
          (candidate) => candidate.connection.id === entry.connectionId,
        );
        for (const name of match?.connection.envNames ?? []) {
          env[name] = `minted:${entry.connectionId}`;
        }
      }
      return Promise.resolve(
        new PhaseMintBundle(
          { env },
          [],
          entries.map((entry) => ({
            provider: entry.provider,
            connectionId: entry.connectionId,
            temporary: true,
            ttlEnforced: true,
          })),
        ),
      );
    },
  } as unknown as ConnectionVault;
  let counter = 0;
  const store = new InMemoryOpenTofuControlStore();
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => resolved,
    policyForPlanRun: async () => undefined,
  });
  return { broker, mintedEntries, store };
}

test("run credential mint is narrowed to the plan's declared providers", async () => {
  // A Capsule keeps one Provider Binding set covering every provider it has
  // ever used. Minting the whole set for a run that declared only one provider
  // hands the runner live credentials it was never reviewed to receive.
  const { broker, mintedEntries, store } = brokerFor([CLOUDFLARE, AWS]);
  const credentials = await broker.mintRunCredentials(
    planRun(["registry.opentofu.org/cloudflare/cloudflare"]),
    "plan",
    "run_1",
  );
  expect(mintedEntries).toEqual([
    [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        connectionId: "conn_cloudflare",
      },
    ],
  ]);
  expect(Object.keys(credentials?.env ?? {})).toEqual(["CLOUDFLARE_API_TOKEN"]);
  // The manifest is the runner's credential allowlist AND its
  // required-env assertion, so it must describe exactly what was minted.
  expect(
    credentials?.manifest.bindings.map((binding) => binding.providerSource),
  ).toEqual(["registry.opentofu.org/cloudflare/cloudflare"]);
  expect(await store.listCredentialMintEventsForRun("run_1")).toMatchObject([{
    connectionId: "conn_cloudflare",
    providerCredentialEvidence: [{
      connectionId: "conn_cloudflare",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      temporary: true,
      ttlEnforced: true,
    }],
  }]);
});

test("a credential-free provider set mints nothing at all", async () => {
  const { broker, mintedEntries } = brokerFor([CLOUDFLARE, AWS]);
  const credentials = await broker.mintRunCredentials(
    planRun(["registry.opentofu.org/hashicorp/http"]),
    "plan",
    "run_1",
  );
  expect(mintedEntries).toEqual([]);
  expect(credentials?.env).toEqual({});
  expect(credentials?.manifest.bindings).toEqual([]);
});

test("broker rejects a wrong recipe before vault mint even when binding bypasses UI", async () => {
  const wrongRecipe = {
    ...CLOUDFLARE,
    connection: {
      ...CLOUDFLARE.connection,
      credentialRecipe: { id: "cloudflare", authMode: "oauth" },
    },
  };
  let mintCalled = false;
  const store = new InMemoryOpenTofuControlStore();
  const vault = {
    mintForCapsuleProviderBindings: () => {
      mintCalled = true;
      return Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: "should-not-mint" } },
          [],
          [],
        ),
      );
    },
  } as unknown as ConnectionVault;
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_policy`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => [wrongRecipe],
    policyForPlanRun: async () => ({
      providerCredentials: {
        allowedConnectionScopes: ["workspace"],
        allowedCredentialRecipes: [
          { id: "cloudflare", authMode: "api_token" },
        ],
      },
    }),
  });

  await expect(
    broker.mintRunCredentials(
      planRun([CLOUDFLARE.provider]),
      "plan",
      "run_wrong_recipe",
    ),
  ).rejects.toThrow(/credential_policy_failed.*cloudflare:oauth/);
  expect(mintCalled).toBe(false);
});

test("broker rejects a connection without required credential capabilities", async () => {
  let mintCalled = false;
  const store = new InMemoryOpenTofuControlStore();
  const vault = {
    mintForCapsuleProviderBindings: () => {
      mintCalled = true;
      return Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: "should-not-mint" } },
          [],
          [],
        ),
      );
    },
  } as unknown as ConnectionVault;
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_verifier_policy`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => [
      {
        ...CLOUDFLARE,
        connection: {
          ...CLOUDFLARE.connection,
          credentialRecipe: { id: "cloudflare", authMode: "api_token" },
        },
      },
    ],
    policyForPlanRun: async () => ({
      providerCredentials: {
        requiredCredentialCapabilities: [
          "cloudflare.account-workers-subdomain.v1",
        ],
      },
    }),
  });

  await expect(
    broker.mintRunCredentials(
      planRun([CLOUDFLARE.provider]),
      "plan",
      "run_legacy_verifier",
    ),
  ).rejects.toThrow(
    /credential_policy_failed.*credential capabilities missing cloudflare\.account-workers-subdomain\.v1/,
  );
  expect(mintCalled).toBe(false);
});

test("broker re-reads Workspace policy after vault mint before returning credentials", async () => {
  const resolved = {
    ...CLOUDFLARE,
    connection: {
      ...CLOUDFLARE.connection,
      credentialRecipe: { id: "cloudflare", authMode: "api_token" },
    },
  };
  const store = new InMemoryOpenTofuControlStore();
  const workspace: Workspace = {
    id: "workspace_1",
    handle: "workspace-one",
    displayName: "Workspace One",
    type: "personal",
    ownerUserId: "account_1",
    policy: {
      providerCredentials: {
        allowedConnectionScopes: ["workspace"],
        allowedCredentialRecipes: [
          { id: "cloudflare", authMode: "api_token" },
        ],
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.putWorkspace(workspace);
  const installPolicy = {
    providerCredentials: {
      requiredProviders: [CLOUDFLARE.provider],
    },
  };
  let mintCalled = false;
  const vault = {
    mintForCapsuleProviderBindings: async () => {
      mintCalled = true;
      await store.putWorkspace({
        ...workspace,
        policy: {
          providerCredentials: {
            allowedConnectionScopes: ["operator"],
            allowedCredentialRecipes: [
              { id: "cloudflare", authMode: "api_token" },
            ],
          },
        },
      });
      return new PhaseMintBundle(
        { env: { CLOUDFLARE_API_TOKEN: "minted-but-now-prohibited" } },
        [],
        [{
          provider: resolved.provider,
          connectionId: resolved.connection.id,
          temporary: true,
          ttlEnforced: true,
        }],
      );
    },
  } as unknown as ConnectionVault;
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_workspace_policy`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => [resolved],
    policyForPlanRun: async () => {
      const current = await store.getWorkspace("workspace_1");
      return mergePolicyConfigs(current?.policy, installPolicy);
    },
  });

  await expect(
    broker.mintRunCredentials(
      planRun([CLOUDFLARE.provider]),
      "plan",
      "run_workspace_policy_race",
    ),
  ).rejects.toThrow(/credential_policy_failed.*scope workspace/);
  expect(mintCalled).toBe(true);
  expect(
    await store.listCredentialMintEventsForRun("run_workspace_policy_race"),
  ).toEqual([]);
});

test("broker re-reads required capabilities after vault mint", async () => {
  const requiredCapability = "cloudflare.account-workers-subdomain.v1";
  const resolved = {
    ...CLOUDFLARE,
    connection: {
      ...CLOUDFLARE.connection,
      credentialRecipe: { id: "cloudflare", authMode: "api_token" },
      credentialVerification: {
        kind: "takosumi.credential-verification@v1" as const,
        verifierId: "unrelated-verifier@v1",
        capabilities: [requiredCapability],
      },
    },
  };
  const store = new InMemoryOpenTofuControlStore();
  const workspace: Workspace = {
    id: "workspace_1",
    handle: "workspace-one",
    displayName: "Workspace One",
    type: "personal",
    ownerUserId: "account_1",
    policy: {
      providerCredentials: {
        allowedConnectionScopes: ["workspace"],
        requiredCredentialCapabilities: [requiredCapability],
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.putWorkspace(workspace);
  let mintCalled = false;
  const vault = {
    mintForCapsuleProviderBindings: async () => {
      mintCalled = true;
      await store.putWorkspace({
        ...workspace,
        policy: {
          providerCredentials: {
            allowedConnectionScopes: ["workspace"],
            requiredCredentialCapabilities: ["other.capability"],
          },
        },
      });
      return new PhaseMintBundle(
        { env: { CLOUDFLARE_API_TOKEN: "minted-but-now-unverified" } },
        [],
        [{
          provider: resolved.provider,
          connectionId: resolved.connection.id,
          temporary: true,
          ttlEnforced: true,
        }],
      );
    },
  } as unknown as ConnectionVault;
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_verifier_race`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => [resolved],
    policyForPlanRun: async () => {
      const current = await store.getWorkspace("workspace_1");
      return current?.policy;
    },
  });

  await expect(
    broker.mintRunCredentials(
      planRun([CLOUDFLARE.provider]),
      "plan",
      "run_verifier_race",
    ),
  ).rejects.toThrow(/credential_policy_failed.*credential capabilities missing/);
  expect(mintCalled).toBe(true);
  expect(await store.listCredentialMintEventsForRun("run_verifier_race"))
    .toEqual([]);
});

test("broker rejects secret-bearing evidence before mint-event persistence", async () => {
  const rawToken = "raw-provider-token-that-must-never-be-audited";
  const store = new InMemoryOpenTofuControlStore();
  const vault = {
    mintForCapsuleProviderBindings: () =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: rawToken } },
          [],
          [{
            provider: CLOUDFLARE.provider,
            connectionId: CLOUDFLARE.connection.id,
            temporary: true,
            ttlEnforced: true,
            issuer: `driver:${rawToken}`,
            secretValueStored: false,
          }],
        ),
      ),
  } as unknown as ConnectionVault;
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_1`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => [CLOUDFLARE],
    policyForPlanRun: async () => undefined,
  });

  const error = await broker
    .mintRunCredentials(
      planRun([CLOUDFLARE.provider]),
      "plan",
      "run_secret_evidence",
    )
    .then(
      () => undefined,
      (failure: unknown) => failure,
    );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(rawToken);
  expect(await store.listCredentialMintEventsForRun("run_secret_evidence"))
    .toEqual([]);
});

const RUNTIME_INPUT_PROVIDER = "registry.opentofu.org/tako0614/takoform";
const RUNTIME_INPUT_VARIABLE = "takosumi_runtime_inputs__takoform";
const RUNTIME_INPUT_INSTANCE = runtimeInputProviderInstance({
  moduleLocalName: "takoform",
});
const RUNTIME_INPUT_NONCE = "8Jd1nQ2vK7pR4sT6wX9zB0cE3fH5jL8mN1qS4uV7yA0";
const RUNTIME_INPUT_PROFILE_DIGEST = `sha256:${"7".repeat(64)}`;
const RUNTIME_INPUT_VALUES = {
  ENCRYPTION_KEY: "a".repeat(64),
  SIGNING_KEY: "b".repeat(64),
} as const;

function runtimeInputBinding(
  overrides: {
    readonly rootAlias?: string;
    readonly moduleLocalName?: string;
    readonly connectionId?: string;
  } = {},
): ResolvedCapsuleProviderBinding {
  const base = resolvedBinding(
    RUNTIME_INPUT_PROVIDER,
    overrides.connectionId ?? "conn_takoform",
    "TAKOFORM_TOKEN",
  );
  return {
    ...base,
    moduleLocalName: overrides.moduleLocalName ?? "takoform",
    ...(overrides.rootAlias ? { rootAlias: overrides.rootAlias } : {}),
    connection: {
      ...base.connection,
      credentialRecipe: {
        id: "takoform",
        authMode: "token",
        runtimeInputs: {
          contract: "takosumi.provider-runtime-inputs/v1",
          nonceArgument: "runtime_input_nonce",
          mapArgument: "runtime_inputs",
          minimumProviderVersion: "4.0.0",
        },
      },
    },
  } as ResolvedCapsuleProviderBinding;
}

function runtimeInputDescriptor(
  overrides: Partial<{
    readonly nonce: string;
    readonly names: readonly string[];
    readonly profileDigest: string;
    readonly variableName: string;
  }> = {},
) {
  return {
    contract: "takosumi.dispatch-runtime-inputs/v1" as const,
    variableName: overrides.variableName ?? RUNTIME_INPUT_VARIABLE,
    providerInstance: RUNTIME_INPUT_INSTANCE,
    nonce: overrides.nonce ?? RUNTIME_INPUT_NONCE,
    names: overrides.names ?? ["ENCRYPTION_KEY", "SIGNING_KEY"],
    profileDigest: overrides.profileDigest ?? RUNTIME_INPUT_PROFILE_DIGEST,
  };
}

function runtimeInputMaterializerStub(
  overrides: Partial<{
    readonly nonce: string;
    readonly names: readonly string[];
    readonly profileDigest: string;
    readonly values: Readonly<Record<string, string>>;
  }> = {},
): RuntimeInputMaterializer {
  const profileDigest = (overrides.profileDigest ??
    RUNTIME_INPUT_PROFILE_DIGEST) as `sha256:${string}`;
  const names = overrides.names ?? ["ENCRYPTION_KEY", "SIGNING_KEY"];
  return {
    profile: async () => ({ profileDigest, names }),
    nonce: async () => overrides.nonce ?? RUNTIME_INPUT_NONCE,
    materialize: async () =>
      new RuntimeInputBundle({
        contract: "takosumi.runner-runtime-inputs/v1",
        profileDigest,
        nonce: overrides.nonce ?? RUNTIME_INPUT_NONCE,
        names,
        values: overrides.values ?? RUNTIME_INPUT_VALUES,
      }),
    retire: async () => {},
  } as unknown as RuntimeInputMaterializer;
}

async function runtimeInputBrokerFor(options: {
  readonly resolved: readonly ResolvedCapsuleProviderBinding[];
  readonly descriptors?: readonly unknown[];
  readonly materializer?: RuntimeInputMaterializer;
}) {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store);
  const vault = {
    mintForCapsuleProviderBindings: (
      _workspaceId: string,
      entries: readonly CapsuleProviderBindingMintEntry[],
    ) =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { TAKOFORM_TOKEN: "minted" } },
          [],
          entries.map((entry) => ({
            provider: entry.provider,
            connectionId: entry.connectionId,
            temporary: true,
            ttlEnforced: true,
          })),
        ),
      ),
  } as unknown as ConnectionVault;
  let counter = 0;
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => options.resolved,
    policyForPlanRun: async () => undefined,
    runtimeInputsForPlanRun: async () =>
      (options.descriptors ?? [runtimeInputDescriptor()]) as never,
    ...(options.materializer
      ? { runtimeInputMaterializer: options.materializer }
      : { runtimeInputMaterializer: runtimeInputMaterializerStub() }),
  });
  const run = {
    ...planRun([RUNTIME_INPUT_PROVIDER]),
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    capsuleContext: {
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
    },
  } as PlanRun;
  return { broker, run, seeded, store };
}

test("plan and destroy carry the reviewed name set with no values", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
  });
  for (const phase of ["plan", "destroy"] as const) {
    const credentials = await broker.mintRunCredentials(run, phase, "run_1");
    expect(credentials?.runtimeInputs).toEqual([
      {
        variableName: RUNTIME_INPUT_VARIABLE,
        names: ["ENCRYPTION_KEY", "SIGNING_KEY"],
        values: {},
      },
    ]);
  }
});

test("apply opens the sealed material for exactly the reviewed name set", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
  });
  const credentials = await broker.mintRunCredentials(run, "apply", "run_1");
  expect(credentials?.runtimeInputs).toHaveLength(1);
  const entry = credentials!.runtimeInputs![0]!;
  expect(entry.variableName).toBe(RUNTIME_INPUT_VARIABLE);
  expect(Object.keys(entry.values).sort()).toEqual([...entry.names]);
  expect(entry.values).toEqual(RUNTIME_INPUT_VALUES);
});

test("apply fails closed when the material generation moved since the plan", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
    materializer: runtimeInputMaterializerStub({
      nonce: "Q2vK7pR4sT6wX9zB0cE3fH5jL8mN1qS4uV7yA8Jd1n0",
    }),
  });
  await expect(
    broker.mintRunCredentials(run, "apply", "run_1"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "runtime_inputs_nonce_changed" },
  });
});

test("apply fails closed when the deliverable name set moved since the plan", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
    materializer: runtimeInputMaterializerStub({
      names: ["ENCRYPTION_KEY", "SESSION_KEY", "SIGNING_KEY"],
      values: {
        ENCRYPTION_KEY: "a".repeat(64),
        SESSION_KEY: "c".repeat(64),
        SIGNING_KEY: "b".repeat(64),
      },
    }),
  });
  await expect(
    broker.mintRunCredentials(run, "apply", "run_1"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "runtime_inputs_name_set_changed" },
  });
});

test("two declaring provider instances fail closed instead of sharing one value set", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [
      runtimeInputBinding(),
      runtimeInputBinding({
        rootAlias: "edge",
        connectionId: "conn_takoform_edge",
      }),
    ],
  });
  await expect(
    broker.mintRunCredentials(run, "plan", "run_1"),
  ).rejects.toMatchObject({
    details: { reason: "runtime_inputs_ambiguous_provider_instance" },
  });
});

test("a plan that never wired run-scoped sensitive inputs delivers none", async () => {
  // A destroy plan, a provider version below the floor, and a Capsule whose
  // Connection does not declare the protocol all pin no descriptor. The
  // reviewed root then declares no ephemeral variable, so there is nothing to
  // deliver and nothing to fail.
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
    descriptors: [],
  });
  for (const phase of ["plan", "apply", "destroy"] as const) {
    const credentials = await broker.mintRunCredentials(run, phase, "run_1");
    expect(credentials?.runtimeInputs).toBeUndefined();
  }
});

test("an apply whose reviewed plan pinned wiring the resolution lost fails closed", async () => {
  // The reviewed root declares a defaultless ephemeral variable, so silently
  // delivering nothing would die inside `tofu` with an unattributable
  // "No value for required variable".
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [
      resolvedBinding(RUNTIME_INPUT_PROVIDER, "conn_plain", "TAKOFORM_TOKEN"),
    ],
  });
  await expect(
    broker.mintRunCredentials(run, "apply", "run_1"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "runtime_inputs_wiring_missing" },
  });
});

test("a moved generated-root variable is not reported as a rotated nonce", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
    descriptors: [
      runtimeInputDescriptor({
        variableName: "takosumi_runtime_inputs__takoform__edge",
      }),
    ],
  });
  await expect(
    broker.mintRunCredentials(run, "apply", "run_1"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "runtime_inputs_variable_changed" },
  });
});

test("a lifecycle release command mints no run-scoped sensitive inputs", async () => {
  // A release command dispatch has no generated root and no ephemeral
  // variable, so nothing there could consume a map.
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
  });
  const credentials = await broker.mintReleaseCommandCredentials(
    run,
    "apply",
    "run_1",
  );
  expect(credentials?.env).toBeDefined();
  expect(credentials?.runtimeInputs).toBeUndefined();
});

test("a value below the runner redaction floor is refused at the Core boundary", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
    materializer: runtimeInputMaterializerStub({
      values: { ENCRYPTION_KEY: "short", SIGNING_KEY: "b".repeat(64) },
    }),
  });
  await expect(
    broker.mintRunCredentials(run, "apply", "run_1"),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    details: { reason: "runtime_inputs_limit_exceeded" },
  });
});

test("an over-wide reviewed name set is refused before the provider sees it", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
    descriptors: [
      runtimeInputDescriptor({
        names: Array.from({ length: 65 }, (_unused, index) => `NAME_${index}`),
      }),
    ],
  });
  await expect(
    broker.mintRunCredentials(run, "plan", "run_1"),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    details: { reason: "runtime_inputs_limit_exceeded" },
  });
});

test("a Capsule with no declaring Provider Connection stays completely inert", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [
      resolvedBinding(RUNTIME_INPUT_PROVIDER, "conn_plain", "TAKOFORM_TOKEN"),
    ],
    descriptors: [],
  });
  const credentials = await broker.mintRunCredentials(run, "apply", "run_1");
  expect(credentials?.runtimeInputs).toBeUndefined();
});

test("an over-wide name set is refused whatever the value lengths", async () => {
  const { broker, run } = await runtimeInputBrokerFor({
    resolved: [runtimeInputBinding()],
    descriptors: [
      runtimeInputDescriptor({
        names: Array.from({ length: 17 }, (_unused, index) => `NAME_${index}`),
      }),
    ],
  });
  await expect(
    broker.mintRunCredentials(run, "plan", "run_1"),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    details: { reason: "runtime_inputs_limit_exceeded" },
  });
});
