import { expect, test } from "bun:test";

import { createInMemoryAppContext } from "../../core/app_context.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import {
  InMemoryGitInstallPlanStore,
  type GitInstallPlanStore,
} from "../../core/domains/install-plans/store.ts";
import { createInMemoryInterfaceStores } from "../../core/domains/interfaces/mod.ts";
import { InMemoryOfferingCatalogReader } from "../../core/domains/offerings/mod.ts";
import { StubResourceShapeAdapter } from "../../core/domains/resource-shape/mod.ts";
import { declaredDurableTestOpenTofuStore } from "../helpers/deploy-control/durable_test_store.ts";
import { credentialRecipeDriverKey } from "../../core/adapters/vault/driver_ports.ts";

function localContext() {
  return createInMemoryAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });
}

function declaredDurableTestGitInstallPlanStore(): GitInstallPlanStore {
  const store = new InMemoryGitInstallPlanStore();
  return {
    durable: true,
    create: (plan) => store.create(plan),
    get: (id) => store.get(id),
    claimReconcile: (input) => store.claimReconcile(input),
    completeReconcile: (input) => store.completeReconcile(input),
  };
}

test("production deploy ledger rejects ephemeral storage even when dev mode is requested", async () => {
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: {
        environment: "production",
        allowUnsafeProductionDefaults: true,
      },
      runtimeEnv: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "control-token",
      },
      context: localContext(),
      opentofuControlStore: new InMemoryOpenTofuControlStore(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the OpenTofu deploy API but no durable run ledger is configured",
  );
});

test("production Git install-plan coordinator rejects its implicit in-memory fallback", async () => {
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: {
        environment: "production",
        allowUnsafeProductionDefaults: true,
      },
      runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
      context: localContext(),
      opentofuControlStore: declaredDurableTestOpenTofuStore(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the Git install-plan coordinator but no durable GitInstallPlan store is configured",
  );
});

test("production Git install-plan coordinator rejects an injected in-memory store", async () => {
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: {
        environment: "production",
        allowUnsafeProductionDefaults: true,
      },
      runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
      context: localContext(),
      opentofuControlStore: declaredDurableTestOpenTofuStore(),
      gitInstallPlanStore: new InMemoryGitInstallPlanStore(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the Git install-plan coordinator but no durable GitInstallPlan store is configured",
  );
});

test("production Resource Shape API requires its own durable stores", async () => {
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: {
        environment: "production",
        allowUnsafeProductionDefaults: true,
      },
      runtimeEnv: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "control-token",
      },
      context: localContext(),
      opentofuControlStore: declaredDurableTestOpenTofuStore(),
      gitInstallPlanStore: declaredDurableTestGitInstallPlanStore(),
      resourceShapeAdapter: new StubResourceShapeAdapter(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the Resource Shape API but no durable Resource/ResolutionLock/TargetPool/SpacePolicy stores are configured",
  );
});

test("production Offering catalog API requires durable catalog authority", async () => {
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: {
        environment: "production",
        allowUnsafeProductionDefaults: true,
      },
      runtimeEnv: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "control-token",
      },
      context: localContext(),
      opentofuControlStore: declaredDurableTestOpenTofuStore(),
      gitInstallPlanStore: declaredDurableTestGitInstallPlanStore(),
      interfaceStores: {
        ...createInMemoryInterfaceStores(),
        persistence: "durable",
      },
    }),
  ).rejects.toThrow(
    "production runtime exposes the Offering catalog API but no durable Offering catalog store is configured",
  );
});

test("production Offering catalog API rejects an explicitly injected in-memory store", async () => {
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: {
        environment: "production",
        allowUnsafeProductionDefaults: true,
      },
      runtimeEnv: {
        TAKOSUMI_DEV_MODE: "1",
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "control-token",
      },
      context: localContext(),
      opentofuControlStore: declaredDurableTestOpenTofuStore(),
      gitInstallPlanStore: declaredDurableTestGitInstallPlanStore(),
      interfaceStores: {
        ...createInMemoryInterfaceStores(),
        persistence: "durable",
      },
      offeringCatalogStore: new InMemoryOfferingCatalogReader(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the Offering catalog API but no durable Offering catalog store is configured",
  );
});

test("service startup projects fixed operator connections without reconciling runtime DB rows", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let createAttempts = 0;
  const originalCreate = store.createConnectionIfAbsent.bind(store);
  store.createConnectionIfAbsent = async (connection) => {
    createAttempts += 1;
    return await originalCreate(connection);
  };
  const recipe = {
    id: "release-owned-provider",
    displayName: "Release owned provider",
    terraformSource: ["registry.example/operator/provider"],
    envNames: ["RUN_CREDENTIAL_TOKEN"],
    authModes: {
      broker: {
        preRun: { type: "issue_run_credential" },
        runIssuance: {
          context: "capsule-run.v1",
          operatorConnection: "workspace-bindable",
          storedMaterial: "none",
          audience: "operator.example.v1",
          scopes: ["provider:invoke"],
        },
      },
    },
  } as const;
  const driver = {
    evidenceIssuer: "release-owned-provider",
    verify: async () => ({ ok: true as const }),
    mint: async () => ({
      env: { RUN_CREDENTIAL_TOKEN: "fixture" },
      evidence: {
        connectionId: "conn_releaseowned01",
        provider: "registry.example/operator/provider",
        temporary: true,
        ttlEnforced: true,
        issuer: "release-owned-provider",
        secretValueStored: false,
      },
    }),
  };

  await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    context: localContext(),
    opentofuControlStore: store,
    credentialRecipes: [recipe],
    credentialRecipeDrivers: {
      [credentialRecipeDriverKey({
        id: recipe.id,
        authMode: "broker",
      })]: driver,
    },
    operatorProviderConnections: [
      {
        id: "conn_releaseowned01",
        providerSource: "registry.example/operator/provider",
        displayName: "Release owned provider",
        credentialRecipe: { id: recipe.id, authMode: "broker" },
      },
    ],
    allowOperatorScopedProviderConnections: true,
  });

  expect(createAttempts).toBe(0);
  expect(await store.getConnection("conn_releaseowned01")).toBeUndefined();
});
