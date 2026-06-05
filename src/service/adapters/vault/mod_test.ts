import { expect, test } from "bun:test";

import {
  ConnectionVaultError,
  CredentialBundle,
  StaticSecretConnectionVault,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../domains/deploy-control/store.ts";
import { MultiCloudSecretBoundaryCrypto } from "../secret-store/memory.ts";

function makeCrypto(): MultiCloudSecretBoundaryCrypto {
  // Real AES-GCM via WebCrypto (the production multi-cloud crypto), driven by a
  // test passphrase so the vault round-trip exercises the genuine seal/open path.
  return new MultiCloudSecretBoundaryCrypto({
    globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
  });
}

function makeVault(overrides: { fetch?: typeof fetch } = {}) {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: makeCrypto(),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => `conn_test${(counter += 1).toString().padStart(12, "0")}`,
    fetch: overrides.fetch as never,
  });
  return { store, vault };
}

test("register seals values and returns a public Connection with no secret material", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    displayName: "prod cloudflare",
    scope: { accountId: "acct_xyz" },
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  expect(connection.id).toMatch(/^conn_/);
  expect(connection.status).toBe("pending");
  expect(connection.provider).toBe("cloudflare");
  expect(connection.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
  expect(connection.scope).toEqual({ accountId: "acct_xyz" });
  // The public Connection must never carry the secret value.
  expect(JSON.stringify(connection)).not.toContain("cf-secret-token");

  // The sealed blob exists but only holds ciphertext.
  const blob = await store.getSecretBlob(connection.id);
  expect(blob).toBeDefined();
  expect(JSON.stringify(blob)).not.toContain("cf-secret-token");
});

test("register rejects unknown env names and unsatisfied required groups", async () => {
  const { vault } = makeVault();
  await expect(
    vault.register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { NOT_A_CLOUDFLARE_VAR: "x" },
    }),
  ).rejects.toThrow(/not allowed for provider/);

  // account id alone does not satisfy any required group.
  const err = await vault
    .register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_ACCOUNT_ID: "acct" },
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("invalid_argument");
  expect((err as ConnectionVaultError).missingEnvGroups).toContainEqual([
    "CLOUDFLARE_API_TOKEN",
  ]);
});

test("register rejects unknown provider and non-static authMethod", async () => {
  const { vault } = makeVault();
  await expect(
    vault.register({
      spaceId: "space_1",
      provider: "does-not-exist",
      authMethod: "static_secret",
      values: { X: "y" },
    }),
  ).rejects.toThrow(/unknown provider/);

  await expect(
    vault.register({
      spaceId: "space_1",
      provider: "aws",
      // deliberately wrong authMethod for Phase 1.
      authMethod: "aws_assume_role" as never,
      values: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" },
    }),
  ).rejects.toThrow(/not implemented/);
});

test("mint round-trips the decrypted values into a credential bundle", async () => {
  const { vault } = makeVault();
  await vault.register({
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: {
      CLOUDFLARE_API_TOKEN: "cf-secret-token",
      CLOUDFLARE_ACCOUNT_ID: "acct_xyz",
    },
  });

  const bundle = await vault.mint("space_1", ["cloudflare"]);
  expect(bundle).toBeInstanceOf(CredentialBundle);
  expect(bundle.env.CLOUDFLARE_API_TOKEN).toBe("cf-secret-token");
  expect(bundle.env.CLOUDFLARE_ACCOUNT_ID).toBe("acct_xyz");
  // pending (unverified) connection is flagged.
  expect(bundle.warnings.join(" ")).toMatch(/pending/);
});

test("credential bundle never serializes its secret values", async () => {
  const { vault } = makeVault();
  await vault.register({
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });
  const bundle = await vault.mint("space_1", ["cloudflare"]);

  expect(JSON.stringify(bundle)).toBe('"[credential-bundle]"');
  expect(JSON.stringify({ wrapped: bundle })).toBe(
    '{"wrapped":"[credential-bundle]"}',
  );
  expect(`${bundle}`).toBe("[credential-bundle]");
  expect(String(bundle)).not.toContain("cf-secret-token");
  // The dispatch-path getter is the only way to read values.
  expect(bundle.env.CLOUDFLARE_API_TOKEN).toBe("cf-secret-token");
});

test("mint with no registered connection throws a typed error listing env groups", async () => {
  const { vault } = makeVault();
  const err = await vault.mint("space_1", ["cloudflare"]).catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("not_found");
  expect((err as ConnectionVaultError).missingEnvGroups).toContainEqual([
    "CLOUDFLARE_API_TOKEN",
  ]);
});

test("test() verifies a cloudflare token via injected fetch and persists verified", async () => {
  let calledWith: { url: string; auth: string | null } | undefined;
  const fakeFetch = (input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calledWith = { url: input, auth: headers.get("authorization") };
    return Promise.resolve(
      new Response(
        JSON.stringify({ success: true, result: { status: "active" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  const { store, vault } = makeVault({ fetch: fakeFetch as never });
  const connection = await vault.register({
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");
  expect(calledWith?.url).toBe(
    "https://api.cloudflare.com/client/v4/user/tokens/verify",
  );
  expect(calledWith?.auth).toBe("Bearer cf-secret-token");

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");
  expect(persisted?.verifiedAt).toBeDefined();
});

test("test() stays pending when the provider reports the token is inactive", async () => {
  const fakeFetch = (): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({ success: true, result: { status: "disabled" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const { store, vault } = makeVault({ fetch: fakeFetch as never });
  const connection = await vault.register({
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("pending");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
});

test("revoke deletes both the connection and the sealed blob", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  expect(await vault.revoke(connection.id)).toBe(true);
  expect(await store.getConnection(connection.id)).toBeUndefined();
  expect(await store.getSecretBlob(connection.id)).toBeUndefined();
  expect(await vault.revoke(connection.id)).toBe(false);
});
