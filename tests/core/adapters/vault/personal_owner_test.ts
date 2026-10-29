import { expect, test } from "bun:test";
import {
  StaticSecretConnectionVault,
  type RegisterConnectionInput,
} from "../../../../core/adapters/vault/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";

test("personal v3 registration takes its owner from the authenticated actor", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    newId: () => "conn_personal_owner",
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find((recipe) => recipe.id === id),
  });
  const input: RegisterConnectionInput = {
    scope: "personal",
    ownerAccountId: "forged-owner",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    credentialRecipe: {
      id: "cloudflare",
      authMode: "api_token",
      secretPartition: "provider-credentials",
    },
    values: { CLOUDFLARE_API_TOKEN: "fixture-secret" },
  };
  const connection = await vault.register(input, undefined, "actual-owner");
  expect(connection.ownerAccountId).toBe("actual-owner");
  expect((await store.getSecretBlob(connection.id))!.aad).toContain('"ownerAccountId":"actual-owner"');
  await expect(vault.register(input, undefined, null)).rejects.toThrow(/authority is unavailable/);
  await expect(vault.register({ ...input, workspaceId: "space_1" }, undefined, "actual-owner"))
    .rejects.toThrow(/personal connections must not carry/);
});
