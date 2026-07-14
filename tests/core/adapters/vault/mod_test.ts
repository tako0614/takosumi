import { expect, test } from "bun:test";

import {
  ConnectionVaultError,
  CredentialBundle,
  StaticSecretConnectionVault,
  type RegisterConnectionInput,
} from "../../../../core/adapters/vault/mod.ts";
import {
  DECLARED_ENV_CREDENTIAL_RECIPE_DRIVER,
  REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
  credentialRecipeDriverKey,
} from "../../../../providers/registry.ts";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";

function makeCrypto(): PartitionedSecretBoundaryCrypto {
  // Real AES-GCM via WebCrypto (the production multi-cloud crypto), driven by a
  // test passphrase so the vault round-trip exercises the genuine seal/open path.
  return new PartitionedSecretBoundaryCrypto({
    globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
  });
}

function makeVault(overrides: { fetch?: typeof fetch } = {}) {
  const store = new InMemoryOpenTofuControlStore();
  let counter = 0;
  const subject = new StaticSecretConnectionVault({
    store,
    crypto: makeCrypto(),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => `conn_test${(counter += 1).toString().padStart(12, "0")}`,
    fetch: overrides.fetch as never,
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
        (recipe) => recipe.id === id,
      ),
    credentialDrivers:
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
  });
  const vault = explicitRecipeFixtureVault(subject);
  return { store, vault };
}

function makeUnimplementedPreRunVault() {
  const store = new InMemoryOpenTofuControlStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: makeCrypto(),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => "conn_unimplemented_pre_run",
    credentialRecipeResolver: (id) =>
      id === "operator-generated"
        ? {
            id,
            displayName: "Operator generated credential",
            terraformSource: "*",
            envNames: ["UPSTREAM_TOKEN"],
            requiredEnvGroups: [["UPSTREAM_TOKEN"]],
            authModes: {
              exchange: {
                env: {
                  UPSTREAM_TOKEN: { from: "secret", name: "upstream_token" },
                  GENERATED_TOKEN: {
                    from: "generated",
                    name: "generated_token",
                  },
                },
                preRun: { type: "operator_token_exchange" },
              },
            },
          }
        : undefined,
  });
  return { store, vault };
}

function explicitRecipeFixtureVault(
  subject: StaticSecretConnectionVault,
): StaticSecretConnectionVault {
  return new Proxy(subject, {
    get(target, property) {
      if (property === "register") {
        return (input: RegisterConnectionInput) =>
          target.register(withExplicitRecipe(input));
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function withExplicitRecipe(
  input: RegisterConnectionInput,
): RegisterConnectionInput {
  if (input.credentialRecipe || input.kind?.startsWith("source_git_")) {
    return input;
  }
  const provider = input.provider;
  const recipe = provider.endsWith("/cloudflare/cloudflare")
    ? {
        id: "cloudflare",
        authMode: input.kind === "cloudflare_oauth" ? "oauth" : "api_token",
      }
    : provider.endsWith("/hashicorp/aws")
      ? { id: "aws", authMode: "assume_role" }
      : provider.endsWith("/hashicorp/google")
        ? {
            id: "google",
            authMode:
              input.kind === "gcp_service_account_json"
                ? "service_account_json"
                : "oauth",
          }
        : undefined;
  return recipe
    ? {
        ...input,
        credentialRecipe: {
          ...recipe,
          secretPartition: "provider-credentials",
        },
      }
    : input;
}

function declaredEnvRecipe(): NonNullable<
  RegisterConnectionInput["credentialRecipe"]
> {
  return {
    id: "generic-env",
    authMode: "env",
    secretPartition: "provider-credentials",
    declaredEnv: true,
  };
}

test("Vault does not treat the reference recipe asset as an implicit catalog", async () => {
  const vault = new StaticSecretConnectionVault({
    store: new InMemoryOpenTofuControlStore(),
    crypto: makeCrypto(),
  });

  const error = await vault
    .register({
      workspaceId: "workspace_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      credentialRecipe: {
        id: "cloudflare",
        authMode: "api_token",
        secretPartition: "provider-credentials",
      },
      values: { CLOUDFLARE_API_TOKEN: "secret" },
    })
    .catch((caught) => caught);

  expect(error).toBeInstanceOf(ConnectionVaultError);
  expect((error as ConnectionVaultError).code).toBe("failed_precondition");
  expect((error as ConnectionVaultError).message).toContain(
    "credential recipe cloudflare is not installed",
  );
});

test("an explicitly installed reference composition keeps generic env open", async () => {
  const vault = new StaticSecretConnectionVault({
    store: new InMemoryOpenTofuControlStore(),
    crypto: makeCrypto(),
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
        (recipe) => recipe.id === id,
      ),
    credentialDrivers:
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
  });

  const connection = await vault.register({
    workspaceId: "workspace_1",
    provider: "registry.opentofu.org/example/example",
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
    },
    values: { EXAMPLE_TOKEN: "secret" },
  });

  expect(connection.providerSource).toBe(
    "registry.opentofu.org/example/example",
  );
  expect(connection.envNames).toEqual(["EXAMPLE_TOKEN"]);
  expect(connection.credentialRecipe?.id).toBe("generic-env");
});

test("declared-env behavior is selected by recipe capability, not a reserved id", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: makeCrypto(),
    newId: () => "conn_operatorenv0001",
    credentialRecipeResolver: (id) =>
      id === "operator-env"
        ? {
            id,
            displayName: "Operator env/file recipe",
            terraformSource: "*",
            declaredEnv: true,
            authModes: {
              materialize: {
                env: { "*": { from: "user_defined" } },
                files: { "*": { from: "user_defined" } },
              },
            },
          }
        : undefined,
    credentialDrivers: {
      [credentialRecipeDriverKey({
        id: "operator-env",
        authMode: "materialize",
      })]: DECLARED_ENV_CREDENTIAL_RECIPE_DRIVER,
    },
  });

  const connection = await vault.register({
    workspaceId: "workspace_1",
    provider: "registry.opentofu.org/example/unknown",
    credentialRecipe: {
      id: "operator-env",
      authMode: "materialize",
      secretPartition: "operator-partition",
    },
    values: { UNKNOWN_PROVIDER_TOKEN: "secret" },
  });

  expect(connection.credentialRecipe?.id).toBe("operator-env");
  expect(connection.secretPartition).toBe("operator-partition");
  expect(connection.envNames).toEqual(["UNKNOWN_PROVIDER_TOKEN"]);
  await expect(vault.test(connection.id)).resolves.toEqual({
    status: "verified",
  });
  const bundle = await vault.mint("workspace_1", [
    "registry.opentofu.org/example/unknown",
  ]);
  expect(bundle.env).toEqual({ UNKNOWN_PROVIDER_TOKEN: "secret" });
});

test("request-declared capability cannot widen an installed fixed-env recipe", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: makeCrypto(),
    newId: () => "conn_fixedrecipe0001",
    credentialRecipeResolver: (id) =>
      id === "fixed-env"
        ? {
            id,
            displayName: "Fixed env recipe",
            terraformSource: "*",
            envNames: ["FIXED_TOKEN"],
            requiredEnvGroups: [["FIXED_TOKEN"]],
            authModes: {
              env: {
                env: { FIXED_TOKEN: { from: "secret", name: "token" } },
              },
            },
          }
        : undefined,
  });
  const callerClaimedRecipe = {
    id: "fixed-env",
    authMode: "env",
    secretPartition: "provider-credentials",
    declaredEnv: true,
  } as const;

  await expect(
    vault.register({
      workspaceId: "workspace_1",
      provider: "registry.opentofu.org/example/example",
      credentialRecipe: callerClaimedRecipe,
      values: { ARBITRARY_TOKEN: "secret" },
    }),
  ).rejects.toThrow("env name ARBITRARY_TOKEN is not allowed");

  await expect(
    vault.register({
      workspaceId: "workspace_1",
      provider: "registry.opentofu.org/example/example",
      credentialRecipe: callerClaimedRecipe,
      values: { FIXED_TOKEN: "secret" },
      files: [{ path: "credential.json", content: "secret" }],
    }),
  ).rejects.toThrow(
    "provider credential files require an installed declared-env recipe",
  );

  expect(await store.listConnections("workspace_1")).toEqual([]);
  expect(await store.getSecretBlob("conn_fixedrecipe0001")).toBeUndefined();
});

async function markVerified(
  store: InMemoryOpenTofuControlStore,
  connection: ProviderConnection,
): Promise<ProviderConnection> {
  const now = "2026-06-04T00:00:00.000Z";
  const verified: ProviderConnection = {
    ...connection,
    status: "verified",
    verifiedAt: now,
    updatedAt: now,
  };
  await store.putConnection(verified);
  return verified;
}

function stsSuccessXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>ASIA_assumed</AccessKeyId>
      <SecretAccessKey>assumed_secret</SecretAccessKey>
      <SessionToken>assumed_session</SessionToken>
      <Expiration>2026-06-04T01:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleResult>
</AssumeRoleResponse>`;
}

test("register seals values and returns a public ProviderConnection with no secret material", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    displayName: "prod cloudflare",
    scope: { accountId: "acct_xyz" },
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  expect(connection.id).toMatch(/^conn_/);
  expect(connection.status).toBe("pending");
  expect(connection.provider).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );
  expect(connection.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
  expect(connection.scope).toEqual({ accountId: "acct_xyz" });
  // The public ProviderConnection must never carry the secret value.
  expect(JSON.stringify(connection)).not.toContain("cf-secret-token");

  // The sealed blob exists but only holds ciphertext.
  const blob = await store.getSecretBlob(connection.id);
  expect(blob).toBeDefined();
  expect(JSON.stringify(blob)).not.toContain("cf-secret-token");

  // The connection row IS the resolver record now (the former ProviderEnv
  // projection folded onto it): it carries the canonical providerSource +
  // materialization.
  expect(connection.providerSource).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );
  expect(connection.materialization).toBe("secret");
});

test("register rejects unknown env names and unsatisfied required groups", async () => {
  const { vault } = makeVault();
  await expect(
    vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { NOT_A_CLOUDFLARE_VAR: "x" },
    }),
  ).rejects.toThrow(/not allowed for provider/);

  // account id alone does not satisfy any required group.
  const err = await vault
    .register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
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

test("register rejects unknown providers without a declared generic-env recipe", async () => {
  const { vault } = makeVault();
  await expect(
    vault.register({
      workspaceId: "space_1",
      provider: "does-not-exist",
      values: { X: "y" },
    }),
  ).rejects.toThrow(/credentialRecipe is required/);

  const generic = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/snowflake-labs/snowflake",
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "tenant:analytics",
    },
    materialization: "operator-helper",
    values: {
      SNOWFLAKE_ACCOUNT: "test-account",
      SNOWFLAKE_USER: "test-user",
      SNOWFLAKE_PASSWORD: "secret",
    },
  });
  expect(generic.provider).toBe(
    "registry.opentofu.org/snowflake-labs/snowflake",
  );
  expect(generic.secretPartition).toBe("tenant:analytics");
  expect(generic.materialization).toBe("operator-helper");
  expect(generic.envNames).toEqual([
    "SNOWFLAKE_ACCOUNT",
    "SNOWFLAKE_PASSWORD",
    "SNOWFLAKE_USER",
  ]);
});

test("register rejects credential-shaped values in non-secret provider metadata before persistence", async () => {
  const cases = [
    {
      scopeHints: {
        providerConfig: { api_token: "must-not-be-public" },
      },
      path: "scopeHints.providerConfig.api_token",
    },
    {
      scopeHints: {
        providerConfig: {
          request: { headers: { authorization: "Bearer must-not-be-public" } },
        },
      },
      path: "scopeHints.providerConfig.request.headers.authorization",
    },
    {
      scopeHints: {
        moduleInputDefaults: { password: "must-not-be-public" },
      },
      path: "scopeHints.moduleInputDefaults.password",
    },
  ] as const;

  for (const entry of cases) {
    const { store, vault } = makeVault();
    const error = await vault
      .register({
        workspaceId: "space_1",
        provider: "registry.opentofu.org/snowflake-labs/snowflake",
        credentialRecipe: declaredEnvRecipe(),
        values: { SNOWFLAKE_TOKEN: "sealed-secret" },
        scopeHints: entry.scopeHints,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConnectionVaultError);
    expect((error as ConnectionVaultError).code).toBe("invalid_argument");
    expect((error as ConnectionVaultError).message).toContain(entry.path);
    expect(await store.listConnections("space_1")).toEqual([]);
    expect(await store.getSecretBlob("conn_test000000000001")).toBeUndefined();
  }
});

test("register keeps descriptive non-secret provider metadata", async () => {
  const { vault } = makeVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/hashicorp/local",
    credentialRecipe: declaredEnvRecipe(),
    values: { LOCAL_PROVIDER_MARKER: "sealed-secret" },
    scopeHints: {
      providerConfig: {
        endpoint: "https://provider.example.test",
        retry: { max_attempts: 3 },
      },
      moduleInputDefaults: {
        secret_name: "app-credentials",
        password_policy: "generated",
      },
    },
  });

  expect(connection.scopeHints?.providerConfig).toEqual({
    endpoint: "https://provider.example.test",
    retry: { max_attempts: 3 },
  });
  expect(connection.scopeHints?.moduleInputDefaults).toEqual({
    secret_name: "app-credentials",
    password_policy: "generated",
  });
});

test("register rejects a hybrid { workspaceId, scope: operator } privilege escalation", async () => {
  const { store, vault } = makeVault();
  // Operator-level provider compatibility coverage has NO owning Workspace, so a
  // caller-supplied `scope: "operator"` must never win against a present
  // workspaceId — otherwise the row would bypass the cross-tenant mint guard and
  // let any Workspace bind it.
  const err = await vault
    .register({
      workspaceId: "space_a",
      scope: "operator",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("invalid_argument");
  expect((err as ConnectionVaultError).message).toMatch(/owning Workspace/);

  // Nothing was persisted by the rejected register.
  expect(await store.listConnections("space_a")).toEqual([]);
});

test("mint round-trips the decrypted values into a credential bundle", async () => {
  const { store, vault } = makeVault();
  await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: {
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_ACCOUNT_ID: "acct_xyz",
      },
    }),
  );

  const bundle = await vault.mint("space_1", [
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);
  expect(bundle).toBeInstanceOf(CredentialBundle);
  expect(bundle.env.CLOUDFLARE_API_TOKEN).toBe("cf-secret-token");
  expect(bundle.env.CLOUDFLARE_ACCOUNT_ID).toBe("acct_xyz");
  expect(bundle.warnings).toEqual([]);
});

test("opening a blob swapped onto a different connection id fails the aad bind", async () => {
  const { store, vault } = makeVault();
  const original = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  );
  const sealed = await store.getSecretBlob(original.id);
  expect(sealed).toBeDefined();

  // Attacker registers a second connection and overwrites its sealed blob with
  // the FIRST connection's ciphertext (a swap). The ciphertext carries the
  // original connection's identity in its AAD, so opening it under the second
  // connection's row must fail to decrypt.
  const victim = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "other-token" },
    }),
  );
  await store.putSecretBlob({
    ...sealed!,
    id: `secret_${victim.id}`,
    connectionId: victim.id,
  });

  // The vault re-derives the AAD from the victim row's identity; the swapped
  // ciphertext was bound to the original id, so the auth tag rejects it.
  await expect(vault.test(victim.id)).rejects.toThrow();
});

test("opening a blob moved to a different Workspace fails the aad bind", async () => {
  const { store, vault } = makeVault();
  const original = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  );
  const sealed = await store.getSecretBlob(original.id);
  expect(sealed).toBeDefined();

  // Re-home the verified connection (and its blob) into a different Workspace. The
  // blob's AAD is bound to the first Workspace, so the cross-Workspace row can no longer open it.
  await store.putConnection({ ...original, workspaceId: "space_2" });
  await store.putSecretBlob({ ...sealed!, workspaceId: "space_2" });

  await expect(
    vault.mint("space_2", ["registry.opentofu.org/cloudflare/cloudflare"]),
  ).rejects.toThrow();
});

test("mint refuses a pending connection before verification", async () => {
  const { vault } = makeVault();
  await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  await expect(
    vault.mint("space_1", ["registry.opentofu.org/cloudflare/cloudflare"]),
  ).rejects.toThrow(/pending \(not verified\)/);
});

test("credential bundle never serializes its secret values", async () => {
  const { store, vault } = makeVault();
  await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  );
  const bundle = await vault.mint("space_1", [
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);

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
  const err = await vault
    .mint("space_1", ["registry.opentofu.org/cloudflare/cloudflare"])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("not_found");
  expect((err as ConnectionVaultError).missingEnvGroups).toEqual([]);
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
    workspaceId: "space_1",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
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

test("test() accepts a cloudflare oauth bearer when account access probe succeeds", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fakeFetch = (input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: input, auth: headers.get("authorization") });
    if (input.endsWith("/user/tokens/verify")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1000, message: "Invalid API Token" }],
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (input.endsWith("/accounts/acct_oauth")) {
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  const { store, vault } = makeVault({ fetch: fakeFetch as never });
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: {
      CLOUDFLARE_API_TOKEN: "wrangler-oauth-bearer",
      CLOUDFLARE_ACCOUNT_ID: "acct_oauth",
    },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");
  expect(calls).toEqual([
    {
      url: "https://api.cloudflare.com/client/v4/user/tokens/verify",
      auth: "Bearer wrangler-oauth-bearer",
    },
    {
      url: "https://api.cloudflare.com/client/v4/accounts/acct_oauth",
      auth: "Bearer wrangler-oauth-bearer",
    },
  ]);

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");
  expect(persisted?.verifiedAt).toBeDefined();
});

test("test() reaches verified for a declared-env recipe connection", async () => {
  // Before explicit recipe-driven verification, a declared-env ProviderConnection fell
  // through to a `pending` "no verification driver" result and could NEVER
  // reach verified, so every mint for it failed permanently. It now verifies
  // structurally when all declared env names are present.
  const { store, vault } = makeVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/vercel/vercel",
    authMethod: "static_secret",
    credentialRecipe: declaredEnvRecipe(),
    values: { VERCEL_API_TOKEN: "vercel-secret" },
  });
  expect(connection.kind).toBeUndefined();
  expect(connection.credentialRecipe).toMatchObject({
    id: "generic-env",
    authMode: "env",
    declaredEnv: true,
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");
  expect(persisted?.verifiedAt).toBeDefined();
});

test("test() structurally verifies generic-env even for guided providers", async () => {
  let fetchCalled = false;
  const { store, vault } = makeVault({
    fetch: (() => {
      fetchCalled = true;
      throw new Error("generic-env verification must not call provider APIs");
    }) as never,
  });
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    credentialRecipe: declaredEnvRecipe(),
    values: {
      CLOUDFLARE_API_TOKEN: "cf-secret-token",
      CLOUDFLARE_CUSTOM_ENDPOINT: "https://api.example.test/client/v4",
    },
  });
  expect(connection.kind).toBeUndefined();
  expect(connection.credentialRecipe?.declaredEnv).toBe(true);

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");
  expect(fetchCalled).toBe(false);

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");
  expect(persisted?.verifiedAt).toBeDefined();
});

test("operator-scoped provider connections have no owning Workspace", async () => {
  const { vault } = makeVault();
  const connection = await vault.register({
    scope: "operator",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    values: { CLOUDFLARE_API_TOKEN: "operator-secret" },
  });

  expect(connection.workspaceId).toBeUndefined();
  expect(connection.scope).toBe("operator");
  expect(connection.materialization).toBe("secret");
});

test("register rejects operator-scoped declared-env recipe connections", async () => {
  const { store, vault } = makeVault();
  const err = await vault
    .register({
      scope: "operator",
      provider: "registry.opentofu.org/integrations/github",
      credentialRecipe: declaredEnvRecipe(),
      materialization: "gateway",
      credentialDriver: "generic_env",
      authMethod: "static_secret",
      values: { GITHUB_TOKEN: "github-secret-token" },
    })
    .catch((e) => e);

  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("failed_precondition");
  expect((err as ConnectionVaultError).message).toContain("Workspace-scoped");
  expect(await store.listOperatorConnections()).toEqual([]);
});

test("static reference recipes verify structurally and mint without provider drivers", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/integrations/github",
    credentialRecipe: {
      id: "github",
      authMode: "token",
      secretPartition: "provider-credentials",
    },
    authMethod: "static_secret",
    values: { GITHUB_TOKEN: "github-secret-token" },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/integrations/github",
      connectionId: connection.id,
    },
  ]);
  expect(bundle.env).toEqual({ GITHUB_TOKEN: "github-secret-token" });
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: connection.id,
      provider: "registry.opentofu.org/integrations/github",
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    },
  ]);
});

test("static env/file recipes verify and mint structurally without a driver", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: makeCrypto(),
    credentialRecipeResolver: (id) =>
      id === "operator-static-files"
        ? {
            id,
            displayName: "Operator static env/file",
            terraformSource: "*",
            declaredEnv: true,
            authModes: {
              materialize: {
                env: { "*": { from: "user_defined" } },
                files: { "*": { from: "user_defined" } },
              },
            },
          }
        : undefined,
  });
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/example/file-provider",
    credentialRecipe: {
      id: "operator-static-files",
      authMode: "materialize",
      secretPartition: "operator-static-files",
    },
    values: {},
    files: [
      {
        path: "credential.json",
        content: '{"secret":"value"}',
        envName: "EXAMPLE_CREDENTIAL_FILE",
      },
    ],
  });

  await expect(vault.test(connection.id)).resolves.toEqual({
    status: "verified",
  });
  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/example/file-provider",
      connectionId: connection.id,
    },
  ]);
  expect(bundle.env).toEqual({});
  expect(bundle.files).toEqual([
    {
      path: "credential.json",
      content: '{"secret":"value"}',
      mode: 0o600,
      envName: "EXAMPLE_CREDENTIAL_FILE",
    },
  ]);
});

test("test() keeps an unimplemented pre-run recipe pending", async () => {
  const { store, vault } = makeUnimplementedPreRunVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/example/generated",
    credentialRecipe: {
      id: "operator-generated",
      authMode: "exchange",
      secretPartition: "provider-credentials",
    },
    values: { UPSTREAM_TOKEN: "upstream-secret" },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("pending");
  expect(result.detail).toContain("pre-run credential recipe");
  expect(result.detail).toContain("no mint driver is installed");

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("pending");
  expect(persisted?.verifiedAt).toBeUndefined();
});

test("test() verifies and mints gcp service account JSON Provider Connections", async () => {
  const { store, vault } = makeVault();
  const serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: "project-1",
    client_email: "svc@project-1.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----\\n",
  });
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/hashicorp/google",
    kind: "gcp_service_account_json",
    credentialDriver: "gcp_service_account_json",
    authMethod: "static_secret",
    values: {
      GOOGLE_CREDENTIALS: serviceAccountJson,
      GOOGLE_CLOUD_PROJECT: "project-1",
    },
  });
  expect(connection.envNames).toEqual([
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CREDENTIALS",
  ]);

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");
  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/hashicorp/google",
      connectionId: connection.id,
    },
  ]);
  expect(bundle.env.GOOGLE_CREDENTIALS).toEqual(serviceAccountJson);
  expect(bundle.env.GOOGLE_CLOUD_PROJECT).toEqual("project-1");
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: connection.id,
      provider: "registry.opentofu.org/hashicorp/google",
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    },
  ]);
});

test("mint rejects unavailable pre-run drivers even if a row is manually verified", async () => {
  const { store, vault } = makeUnimplementedPreRunVault();
  const connection = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/example/generated",
      credentialRecipe: {
        id: "operator-generated",
        authMode: "exchange",
        secretPartition: "provider-credentials",
      },
      values: { UPSTREAM_TOKEN: "upstream-secret" },
    }),
  );

  const err = await vault
    .mintForCapsuleProviderBindings("space_1", [
      {
        provider: "registry.opentofu.org/example/generated",
        connectionId: connection.id,
      },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("not_implemented");
  expect((err as ConnectionVaultError).message).toContain("not installed");
});

test("test() reaches verified for a git https source connection", async () => {
  // A git source ProviderConnection (no live probe URL configured) verifies
  // structurally once its token is present, so the source phase can mint it.
  const { store, vault } = makeVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "source_git_https_token",
    kind: "source_git_https_token",
    authMethod: "static_secret",
    values: { GIT_HTTPS_TOKEN: "ghp_token" },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");
  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");
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
    workspaceId: "space_1",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("pending");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
});

test("test() verifies an aws assume-role connection via STS and persists verified", async () => {
  let called:
    | {
        readonly url: string;
        readonly auth: string | null;
        readonly body: string;
      }
    | undefined;
  const fakeFetch = (input: string, init?: RequestInit): Promise<Response> => {
    called = {
      url: input,
      auth: new Headers(init?.headers).get("authorization"),
      body: String(init?.body ?? ""),
    };
    return Promise.resolve(
      new Response(stsSuccessXml(), {
        status: 200,
        headers: { "content-type": "text/xml" },
      }),
    );
  };
  const { store, vault } = makeVault({ fetch: fakeFetch as never });
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/hashicorp/aws",
    authMethod: "static_secret",
    scopeHints: {
      providerSettings: {
        roleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
        externalId: "space_1",
        region: "us-west-2",
      },
    },
    values: {
      AWS_ACCESS_KEY_ID: "AKIA_source",
      AWS_SECRET_ACCESS_KEY: "source_secret",
    },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");
  expect(called?.url).toBe("https://sts.us-west-2.amazonaws.com/");
  expect(called?.body).toContain("Action=AssumeRole");
  expect(called?.body).toContain(
    "RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Ftakosumi-prod",
  );
  expect(called?.body).toContain("ExternalId=space_1");
  expect(called?.auth).toContain("AWS4-HMAC-SHA256");
  expect(called?.auth).toContain(
    "Credential=AKIA_source/20260604/us-west-2/sts/aws4_request",
  );

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");
  expect(persisted?.verifiedAt).toBeDefined();
});

test("test() keeps aws assume-role pending when STS rejects the role", async () => {
  const { store, vault } = makeVault({
    fetch: (() =>
      Promise.resolve(
        new Response(
          "<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>",
          { status: 403, headers: { "content-type": "text/xml" } },
        ),
      )) as never,
  });
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/hashicorp/aws",
    authMethod: "static_secret",
    scopeHints: {
      providerSettings: {
        roleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
        externalId: "space_1",
        region: "us-west-2",
      },
    },
    values: {
      AWS_ACCESS_KEY_ID: "AKIA_source",
      AWS_SECRET_ACCESS_KEY: "source_secret",
    },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("pending");
  expect(result.detail).toContain("AccessDenied");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
});

test("test() keeps aws assume-role pending when role ARN is missing", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/hashicorp/aws",
    authMethod: "static_secret",
    values: {
      AWS_ACCESS_KEY_ID: "AKIA_source",
      AWS_SECRET_ACCESS_KEY: "source_secret",
    },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("pending");
  expect(result.detail).toContain("scopeHints.providerSettings.roleArn");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
});

test("test() keeps aws assume-role pending when source credentials are missing", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/hashicorp/aws",
    authMethod: "static_secret",
    scopeHints: {
      providerSettings: {
        roleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
      },
    },
    values: {
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/takosumi-prod",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/token",
    },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("pending");
  expect(result.detail).toContain("AWS_ACCESS_KEY_ID");
  expect(result.detail).toContain("AWS_SECRET_ACCESS_KEY");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
});

test("revoke deletes both the connection and the sealed blob", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    workspaceId: "space_1",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  expect(await vault.revoke(connection.id)).toBe(true);
  expect(await store.getConnection(connection.id)).toBeUndefined();
  expect(await store.getSecretBlob(connection.id)).toBeUndefined();
  expect(await vault.revoke(connection.id)).toBe(false);
});
