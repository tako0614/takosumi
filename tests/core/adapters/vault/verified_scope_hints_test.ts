import { expect, test } from "bun:test";

import type { CredentialRecipeRuntimeDriver } from "takosumi-contract/credential-recipe-host";
import {
  ConnectionVaultError,
  StaticSecretConnectionVault,
} from "../../../../core/adapters/vault/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import type { ProviderConnection } from "takosumi-contract/connections";

function makeCrypto(): PartitionedSecretBoundaryCrypto {
  return new PartitionedSecretBoundaryCrypto({
    globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
  });
}

function seedWorkspace(
  store: InMemoryOpenTofuControlStore,
  workspaceId: string,
): void {
  void store.putWorkspace({
    id: workspaceId,
    handle: `fixture-${workspaceId.replace(/[^a-z0-9-]/gi, "-")}`,
    displayName: "Fixture Workspace",
    type: "personal",
    ownerUserId: "fixture-owner",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  });
}

const recipe = {
  id: "verified-hints",
  displayName: "Verified hints",
  terraformSource: ["registry.opentofu.org/example/verified-hints"],
  envNames: ["EXAMPLE_TOKEN"],
  requiredEnvGroups: [["EXAMPLE_TOKEN"]],
  authModes: {
    token: {
      env: { EXAMPLE_TOKEN: { from: "secret" as const, name: "token" } },
    },
  },
};

function makeVault(driver: CredentialRecipeRuntimeDriver) {
  const store = new InMemoryOpenTofuControlStore();
  seedWorkspace(store, "workspace_1");
  let sequence = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: makeCrypto(),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => `conn_hints${String(++sequence).padStart(12, "0")}`,
    credentialRecipeResolver: (id) => (id === recipe.id ? recipe : undefined),
    credentialDrivers: { "verified-hints/token": driver },
  });
  return { store, vault };
}

function makeRacyVault(
  store: InMemoryOpenTofuControlStore,
  driver: CredentialRecipeRuntimeDriver,
) {
  seedWorkspace(store, "workspace_1");
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: makeCrypto(),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => "conn_hints_racy01",
    credentialRecipeResolver: (id) => (id === recipe.id ? recipe : undefined),
    credentialDrivers: { "verified-hints/token": driver },
  });
  return vault;
}

async function register(
  vault: StaticSecretConnectionVault,
  scopeHints?: ProviderConnection["scopeHints"],
) {
  return await vault.register({
    workspaceId: "workspace_1",
    provider: "registry.opentofu.org/example/verified-hints",
    credentialRecipe: {
      id: recipe.id,
      authMode: "token",
      secretPartition: "provider-credentials",
    },
    values: { EXAMPLE_TOKEN: "sealed-token" },
    ...(scopeHints ? { scopeHints } : {}),
  }, undefined, null);
}

test("Vault registration rejects scope hint values that equal supplied secrets", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    async verify() {
      return { ok: true };
    },
  });

  const error = await vault
    .register({
      workspaceId: "workspace_1",
      provider: "registry.opentofu.org/example/verified-hints",
      credentialRecipe: {
        id: recipe.id,
        authMode: "token",
        secretPartition: "provider-credentials",
      },
      values: { EXAMPLE_TOKEN: "sealed-token" },
      scopeHints: { providerSettings: { accountId: "sealed-token" } },
    }, undefined, null)
    .catch((caught) => caught);

  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("invalid_argument");
  expect(await store.listConnections("workspace_1")).toEqual([]);
  expect(await store.getSecretBlob("conn_hints000000000001")).toBeUndefined();
});

test("Vault does not infer a host attestation for legacy verified rows", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    async verify() {
      return { ok: true };
    },
  });
  const connection = await register(vault);
  await store.putConnection({
    ...connection,
    status: "verified",
    verifiedAt: "2026-06-04T00:00:00.000Z",
  });

  const legacy = await store.getConnection(connection.id);
  expect(legacy?.status).toBe("verified");
  expect(legacy?.credentialVerification).toBeUndefined();
  expect(legacy?.scopeHints).toBeUndefined();
});

test("Vault rejects an unbounded trusted verifier id", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "https://attacker.example.invalid/verifier",
    async verify() {
      return { ok: true };
    },
  });
  const connection = await register(vault);

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("failed_precondition");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
  expect((await store.getConnection(connection.id))?.credentialVerification).toBeUndefined();
});

test("Vault persists trusted verified scope hints on successful verification", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verificationCapabilities: [
      "example.scope.z.v1",
      "example.scope.a.v1",
      "example.scope.z.v1",
    ],
    verifiedScopeHintKeys: {
      providerSettings: ["accountId"],
      moduleInputDefaults: ["cloudflare_account_id"],
    },
    async verify() {
      return {
        ok: true,
        verifiedScopeHints: {
          providerSettings: { accountId: "acct_verified" },
          moduleInputDefaults: { cloudflare_account_id: "acct_verified" },
        },
      };
    },
  });
  const connection = await register(vault);

  await expect(vault.test(connection.id, undefined, null)).resolves.toEqual({
    status: "verified",
  });
  expect((await store.getConnection(connection.id))?.scopeHints).toEqual({
    providerSettings: { accountId: "acct_verified" },
    moduleInputDefaults: { cloudflare_account_id: "acct_verified" },
  });
  expect((await store.getConnection(connection.id))?.credentialVerification).toEqual({
    kind: "takosumi.credential-verification@v1",
    verifierId: "credential-recipe-driver@v1",
    capabilities: ["example.scope.a.v1", "example.scope.z.v1"],
  });
});

test("Vault ignores verification capabilities returned by driver code", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verificationCapabilities: ["example.host-owned.v1"],
    async verify() {
      return {
        ok: true,
        verificationCapabilities: ["attacker.result-owned.v1"],
      } as never;
    },
  });
  const connection = await register(vault);

  await expect(vault.test(connection.id, undefined, null)).resolves.toEqual({
    status: "verified",
  });
  expect((await store.getConnection(connection.id))?.credentialVerification).toEqual({
    kind: "takosumi.credential-verification@v1",
    verifierId: "credential-recipe-driver@v1",
    capabilities: ["example.host-owned.v1"],
  });
});

test("Vault does not attest capabilities for a descriptor without a verifier", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verificationCapabilities: ["example.host-owned.v1"],
  });
  const connection = await register(vault);

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("failed_precondition");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
  expect(
    (await store.getConnection(connection.id))?.credentialVerification,
  ).toBeUndefined();
});

test("Vault fails closed on malformed trusted verification capabilities", async () => {
  for (const verificationCapabilities of [
    ["https://attacker.example.invalid/capability"],
    Array.from({ length: 65 }, (_, index) => `example.capability-${index}.v1`),
  ]) {
    const { store, vault } = makeVault({
      evidenceIssuer: "verified_hints_test",
      verifierId: "credential-recipe-driver@v1",
      verificationCapabilities,
      async verify() {
        return { ok: true };
      },
    });
    const connection = await register(vault);

    const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConnectionVaultError);
    expect((error as ConnectionVaultError).code).toBe("failed_precondition");
    expect((await store.getConnection(connection.id))?.status).toBe("pending");
    expect(
      (await store.getConnection(connection.id))?.credentialVerification,
    ).toBeUndefined();
  }
});

test("Vault rejects verified scope hints without trusted ownership declaration", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    async verify() {
      return {
        ok: true,
        verifiedScopeHints: {
          providerSettings: { accountId: "acct_unowned" },
        },
      };
    },
  });
  const connection = await register(vault);

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("failed_precondition");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
  expect((await store.getConnection(connection.id))?.scopeHints).toBeUndefined();
});

test("Vault rejects secret collisions in verified scope hints before writing the verified row", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verifiedScopeHintKeys: { providerSettings: ["accountId"] },
    async verify() {
      return {
        ok: true,
        verifiedScopeHints: {
          providerSettings: { api_token: "do-not-persist" },
        },
      };
    },
  });
  const connection = await register(vault);

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("invalid_argument");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
  expect((await store.getConnection(connection.id))?.scopeHints).toBeUndefined();
});

test("Vault rejects opened secret values under benign verified hint keys", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verifiedScopeHintKeys: { providerSettings: ["accountId"] },
    async verify() {
      return {
        ok: true,
        verifiedScopeHints: {
          providerSettings: { accountId: "sealed-token" },
        },
      };
    },
  });
  const connection = await register(vault);

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("invalid_argument");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
  expect((await store.getConnection(connection.id))?.scopeHints).toBeUndefined();
});

test("Vault validates the final merged scope hints before a successful CAS", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verifiedScopeHintKeys: { providerSettings: ["accountId"] },
    async verify() {
      return { ok: true };
    },
  });
  const connection = await register(vault);
  await store.putConnection({
    ...connection,
    status: "verified",
    verifiedAt: "2026-06-04T00:00:00.000Z",
    scopeHints: { providerSettings: { accountId: "sealed-token" } },
  });

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("invalid_argument");
  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("pending");
  expect(persisted?.scopeHints).toBeUndefined();
  expect(persisted?.credentialVerification).toBeUndefined();
});

test("Vault invalidates a verified row when a re-test returns secret-shaped hints", async () => {
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verifiedScopeHintKeys: { providerSettings: ["accountId"] },
    async verify() {
      return {
        ok: true,
        verifiedScopeHints: { providerSettings: { api_token: "new-secret" } },
      };
    },
  });
  const connection = await register(vault);
  await store.putConnection({
    ...connection,
    status: "verified",
    verifiedAt: "2026-06-04T00:00:00.000Z",
  });

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("invalid_argument");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
  expect((await store.getConnection(connection.id))?.scopeHints).toBeUndefined();
});

test("Vault persists verified scope hints on a successful re-test", async () => {
  let accountId = "acct_first";
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verifiedScopeHintKeys: { providerSettings: ["accountId"] },
    async verify() {
      return {
        ok: true,
        verifiedScopeHints: {
          providerSettings: { accountId },
        },
      };
    },
  });
  const connection = await register(vault);

  await vault.test(connection.id, undefined, null);
  accountId = "acct_second";
  await vault.test(connection.id, undefined, null);

  expect((await store.getConnection(connection.id))?.scopeHints).toEqual({
    providerSettings: { accountId: "acct_second" },
  });
});

test("Vault failed re-test CASes verified rows to pending and clears attested hints", async () => {
  let shouldVerify = true;
  const { store, vault } = makeVault({
    evidenceIssuer: "verified_hints_test",
    verifierId: "credential-recipe-driver@v1",
    verificationCapabilities: ["example.account-metadata.v1"],
    verifiedScopeHintKeys: { providerSettings: ["accountId"] },
    async verify() {
      return shouldVerify
        ? {
            ok: true,
            verifiedScopeHints: {
              providerSettings: { accountId: "acct_first" },
            },
          }
        : { ok: false, detail: "verification failed" };
    },
  });
  const connection = await register(vault, {
    providerSettings: { roleArn: "arn:aws:iam::123456789012:role/retry" },
  });

  await vault.test(connection.id, undefined, null);
  expect((await store.getConnection(connection.id))?.credentialVerification).toEqual({
    kind: "takosumi.credential-verification@v1",
    verifierId: "credential-recipe-driver@v1",
    capabilities: ["example.account-metadata.v1"],
  });
  shouldVerify = false;
  await expect(vault.test(connection.id, undefined, null)).resolves.toEqual({
    status: "pending",
    detail: "verification failed",
  });

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("pending");
  expect(persisted?.verifiedAt).toBeUndefined();
  expect(persisted?.credentialVerification).toBeUndefined();
  expect(persisted?.scopeHints).toEqual({
    providerSettings: {
      roleArn: "arn:aws:iam::123456789012:role/retry",
    },
  });

  shouldVerify = true;
  await expect(vault.test(connection.id, undefined, null)).resolves.toEqual({
    status: "verified",
  });
  expect((await store.getConnection(connection.id))?.scopeHints).toEqual({
    providerSettings: {
      roleArn: "arn:aws:iam::123456789012:role/retry",
      accountId: "acct_first",
    },
  });
});

test("Vault fails closed when successful verification loses the connection CAS", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let interleaved = false;
  const vault = makeRacyVault(store, {
    evidenceIssuer: "verified_hints_test",
    async verify(input) {
      // Mutate through the real store write boundary while Vault is awaiting
      // the credential driver. The subsequent commit must lose its exact-row
      // CAS rather than overwrite this concurrent update.
      await store.putConnection({
        ...input.connection,
        displayName: "concurrent-update",
        updatedAt: "2026-06-04T00:00:01.000Z",
      });
      interleaved = true;
      return { ok: true };
    },
  });
  const connection = await register(vault);

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("failed_precondition");
  expect(interleaved).toBe(true);
  expect(await store.getConnection(connection.id)).toMatchObject({
    status: "pending",
    displayName: "concurrent-update",
  });
});

test("Vault failed re-test cannot overwrite a concurrent revoke", async () => {
  let shouldVerify = true;
  const store = new InMemoryOpenTofuControlStore();
  let interleaved = false;
  const vault = makeRacyVault(store, {
    evidenceIssuer: "verified_hints_test",
    async verify(input) {
      if (shouldVerify) return { ok: true };
      // Transition the real Connection row to revoked while the failed
      // verifier is in flight. The pending replacement must lose its exact-row
      // predicate rather than overwrite the concurrent revocation.
      await store.putConnection({
        ...input.connection,
        status: "revoked",
        updatedAt: "2026-06-04T00:00:01.000Z",
      });
      interleaved = true;
      return { ok: false };
    },
  });
  const connection = await register(vault);
  await vault.test(connection.id, undefined, null);
  shouldVerify = false;

  const error = await vault.test(connection.id, undefined, null).catch((caught) => caught);
  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("failed_precondition");
  expect(interleaved).toBe(true);
  expect((await store.getConnection(connection.id))?.status).toBe("revoked");
});
