import { expect, test } from "bun:test";

import { createInMemoryAppContext } from "../../core/app_context.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import {
  InMemoryGitInstallPlanStore,
  type GitInstallPlanStore,
} from "../../core/domains/install-plans/store.ts";
import { createInMemoryInterfaceStores } from "../../core/domains/interfaces/mod.ts";
import { declaredDurableTestOpenTofuStore } from "../helpers/deploy-control/durable_test_store.ts";
import { credentialRecipeDriverKey } from "../../core/adapters/vault/driver_ports.ts";
import { D1AppOwnershipStore, InMemoryAppOwnershipStore } from "../../core/domains/app-ownership/store.ts";
import { CloudflareD1OpenTofuControlStore } from "../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../helpers/deploy-control/sqlite_fake_d1.ts";

function localContext() {
  return createInMemoryAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });
}

test("durable service startup refuses an omitted ownership authority before reading D1", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  db.prepare = () => { throw new Error("startup must refuse before touching D1"); };
  await expect(createTakosumiService({
    role: "takosumi-api", context: localContext(),
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" }, opentofuControlStore: store,
  })).rejects.toThrow("durable control store requires an AppOwnershipStore");
});

test("durable service startup refuses an unrelated in-memory ownership authority", async () => {
  const store = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());
  await expect(createTakosumiService({
    role: "takosumi-api", context: localContext(),
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" }, opentofuControlStore: store,
    appOwnershipStore: new InMemoryAppOwnershipStore(new InMemoryOpenTofuControlStore()),
  })).rejects.toThrow("durable control store requires a durable AppOwnershipStore");
});

test("in-memory ownership authority cannot silently read durable apps as ownerless", () => {
  const store = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());
  expect(() => new InMemoryAppOwnershipStore(store))
    .toThrow("InMemoryAppOwnershipStore requires in-memory ownership storage");
});

test("durable service startup shares the explicitly supplied D1 ownership authority", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  const appOwnershipStore = new D1AppOwnershipStore(db, store);
  const service = await createTakosumiService({
    role: "takosumi-api", context: localContext(),
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" }, opentofuControlStore: store,
    appOwnershipStore,
  });
  expect(service.operations.appOwnership).toBe(appOwnershipStore);
});

function declaredDurableTestGitInstallPlanStore(): GitInstallPlanStore {
  const store = new InMemoryGitInstallPlanStore();
  return {
    durable: true,
    create: (plan, authority) => store.create(plan, authority),
    get: (id) => store.get(id),
    getByScope: (scope) => store.getByScope(scope),
    preparingCoordinatorForCapsule: (id, workspaceId, options) =>
      store.preparingCoordinatorForCapsule(id, workspaceId, options),
    hasWorkspaceManagementBlockers: (id) => store.hasWorkspaceManagementBlockers(id),
    hasNonterminalPlanSourceReference: (workspaceId, sourceId, expiredBefore) =>
      store.hasNonterminalPlanSourceReference(workspaceId, sourceId, expiredBefore),
    claimReconcile: (input) => store.claimReconcile(input),
    completeReconcile: (input) => store.completeReconcile(input),
    transitionUnleased: (input) => store.transitionUnleased(input),
    listOpenAttempts: (input) => store.listOpenAttempts(input),
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

test("composed Capsule abandonment retires its owned Source after the ledger commit", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const now = "2026-10-28T00:00:00.000Z";
  await store.putWorkspace({
    id: "ws_retirement", handle: "retirement", displayName: "Retirement",
    type: "personal", ownerUserId: "user_one", createdAt: now, updatedAt: now,
  });
  const service = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    context: localContext(),
    opentofuControlStore: store,
  });
  const sourceId = "src_retirement0001";
  const capsuleId = "cap_retirement0001";
  await service.operations.ensureOwnedSource({
    id: sourceId, workspaceId: "ws_retirement", name: "repo",
    ownerCapsuleId: capsuleId, createdByInstallPlanId: "plan_retirement",
    url: "https://example.com/repo.git", ref: "main", path: ".", createdAt: now,
  });
  const created = await service.operations.capsules.createCapsuleInitialAuthority({
    capsuleId, workspaceId: "ws_retirement", name: "retirement",
    environment: "production", sourceId,
    installingPrincipalId: "user_one", providerBindingSetId: "pbind_retirement0001",
    providerBindings: [],
    installConfig: {
      id: "cfg_retirement0001", workspaceId: "ws_retirement", name: "retirement",
      variableMapping: {}, outputAllowlist: {}, policy: {},
      createdAt: now, updatedAt: now,
    },
  });
  // TASK-0118 Phase 9: a new Capsule freezes its derivation scope at creation.
  expect(created.capsule.scopeRef).toBe("ws_retirement");
  expect((await store.getCapsule(capsuleId))?.scopeRef).toBe("ws_retirement");
  const abandoned = await service.operations.capsules.abandonUnappliedCapsule(
    capsuleId, "user discarded install",
  );
  expect(abandoned.status).toBe("destroyed");
  expect(await store.getSource(sourceId)).toBeUndefined();
  expect(await store.getCapsule(capsuleId)).toMatchObject({ status: "destroyed" });
});

test("composed daily sweep requires an explicit retirement mark for a legacy orphan Source", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await store.putWorkspace({
    id: "ws_orphan", handle: "orphan", displayName: "Orphan",
    type: "personal", ownerUserId: "user_one", createdAt, updatedAt: createdAt,
  });
  await store.putSource({
    id: "src_orphan0001", workspaceId: "ws_orphan", name: "orphan",
    url: "https://example.com/orphan.git", defaultRef: "main", defaultPath: ".",
    status: "active", autoSync: false, hookSecretHash: "hash",
    createdAt, updatedAt: createdAt,
  });
  const service = await createTakosumiService({
    role: "takosumi-api", runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    context: localContext(), opentofuControlStore: store,
  });
  expect(await service.operations.sweepRetiredSources({ limit: 1 })).toMatchObject({
    attempted: 0, retired: 0, failures: 0,
  });
  const source = (await store.getSource("src_orphan0001"))!;
  await store.putSource({ ...source, status: "disabled", retiringAt: new Date().toISOString() });
  expect(await service.operations.sweepRetiredSources({ limit: 1 })).toMatchObject({
    attempted: 1, retired: 1, failures: 0,
  });
  expect(await store.getSource("src_orphan0001")).toBeUndefined();
});
