import { expect, test } from "bun:test";

import {
  ConnectionVaultError,
  PhaseMintBundle,
  StaticSecretConnectionVault,
  type RegisterConnectionInput,
} from "../../../../core/adapters/vault/mod.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";

function makeVault(
  overrides: {
    fetch?: typeof fetch;
    store?: InMemoryOpenTofuControlStore;
    now?: () => Date;
    managedProviderCredentialIssuer?: ConstructorParameters<
      typeof StaticSecretConnectionVault
    >[0]["managedProviderCredentialIssuer"];
  } = {},
) {
  const store = overrides.store ?? new InMemoryOpenTofuControlStore();
  let counter = 0;
  const subject = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: overrides.now ?? (() => new Date("2026-06-04T00:00:00.000Z")),
    newId: () => `conn_test${(counter += 1).toString().padStart(12, "0")}`,
    fetch: overrides.fetch as never,
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
        (recipe) => recipe.id === id,
      ),
    credentialDrivers:
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
    ...(overrides.managedProviderCredentialIssuer
      ? {
          managedProviderCredentialIssuer:
            overrides.managedProviderCredentialIssuer,
        }
      : {}),
  });
  const vault = explicitRecipeFixtureVault(subject);
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

async function registerProvider(
  store: InMemoryOpenTofuControlStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  );
}

async function registerCloudflareTokenVending(
  store: InMemoryOpenTofuControlStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      scopeHints: {
        providerSettings: {
          tokenVending: {
            ttlSeconds: 900,
            namePrefix: "takosumi-test",
            policies: [
              {
                effect: "allow",
                permission_groups: [{ id: "perm_workers_write" }],
                resources: {
                  "com.cloudflare.api.account.acct_123": "*",
                },
              },
            ],
          },
        },
      },
      values: { CLOUDFLARE_API_TOKEN: "cf-bootstrap-token" },
    }),
  );
}

async function registerHttps(
  store: InMemoryOpenTofuControlStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "source_git_https_token",
      kind: "source_git_https_token",
      authMethod: "static_secret",
      scopeHints: { providerSettings: { username: "git-bot" } },
      values: { GIT_HTTPS_TOKEN: "ghp_secret_token" },
    }),
  );
}

async function registerSsh(
  store: InMemoryOpenTofuControlStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "source_git_ssh_key",
      kind: "source_git_ssh_key",
      authMethod: "static_secret",
      scopeHints: {
        providerSettings: {
          knownHostsEntry: "github.com ssh-ed25519 AAAAC3Nz...",
        },
      },
      values: {
        GIT_SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
      },
    }),
  );
}

// --- Git connection registration -------------------------------------------

test("registers source_git_https_token with kind and single env", async () => {
  const { store, vault } = makeVault();
  const conn = await registerHttps(store, vault);
  expect(conn.kind).toBe("source_git_https_token");
  expect(conn.provider).toBe("source_git_https_token");
  expect(conn.envNames).toEqual(["GIT_HTTPS_TOKEN"]);
  expect(conn.scope).toBe("workspace");
  expect(conn.scopeHints).toEqual({
    providerSettings: { username: "git-bot" },
  });
  expect(JSON.stringify(conn)).not.toContain("ghp_secret_token");
});

test("source_git_ssh_key REQUIRES scopeHints.knownHostsEntry", async () => {
  const { store, vault } = makeVault();
  const err = await vault
    .register({
      workspaceId: "space_1",
      provider: "source_git_ssh_key",
      kind: "source_git_ssh_key",
      authMethod: "static_secret",
      values: { GIT_SSH_PRIVATE_KEY: "-----BEGIN-----" },
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("invalid_argument");
  expect((err as Error).message).toMatch(/knownHostsEntry/);
});

test("source_git_https_token rejects wrong env name", async () => {
  const { store, vault } = makeVault();
  await expect(
    vault.register({
      workspaceId: "space_1",
      provider: "source_git_https_token",
      kind: "source_git_https_token",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "x" },
    }),
  ).rejects.toThrow(/requires exactly one value: GIT_HTTPS_TOKEN/);
});

// --- The 8 phase rules ------------------------------------------------------

// Rule 1: source + providers -> rejected.
test("rule 1: source phase rejects provider request", async () => {
  const { store, vault } = makeVault();
  await registerProvider(store, vault);
  await expect(
    vault.mintForPhase({
      workspaceId: "space_1",
      phase: "source",
      providers: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/source phase must not request provider/);
});

// Rule 2: source + git https connection -> env + askpass file.
test("rule 2a: source phase mints https git creds as env + askpass file", async () => {
  const { store, vault } = makeVault();
  const conn = await registerHttps(store, vault);
  const bundle = await vault.mintForPhase({
    workspaceId: "space_1",
    phase: "source",
    sourceConnectionId: conn.id,
  });
  expect(bundle).toBeInstanceOf(PhaseMintBundle);
  const response = bundle.toMintResponse();
  expect(response.env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(response.files).toHaveLength(1);
  expect(response.files?.[0].path).toBe("askpass.sh");
  expect(response.files?.[0].mode).toBe(0o700);
  expect(response.files?.[0].content).toContain("ghp_secret_token");
  expect(response.files?.[0].content).toContain("git-bot");
  // The bundle never serializes its values.
  expect(JSON.stringify(bundle)).not.toContain("ghp_secret_token");
});

// Rule 2: source + git ssh connection -> ssh key file + known_hosts, strict.
test("rule 2b: source phase mints ssh git credential files without command env", async () => {
  const { store, vault } = makeVault();
  const conn = await registerSsh(store, vault);
  const response = (
    await vault.mintForPhase({
      workspaceId: "space_1",
      phase: "source",
      sourceConnectionId: conn.id,
    })
  ).toMintResponse();
  expect(response.env.GIT_SSH_COMMAND).toBeUndefined();
  const paths = (response.files ?? []).map((f) => f.path).sort();
  expect(paths).toEqual(["id_source", "known_hosts"]);
  const keyFile = response.files?.find((f) => f.path.endsWith("id_source"));
  expect(keyFile?.mode).toBe(0o600);
  expect(keyFile?.content).toContain("BEGIN OPENSSH PRIVATE KEY");
});

// Rule 3: source + no connection (public repo) -> empty.
test("rule 3: source phase with no connection is empty", async () => {
  const { store, vault } = makeVault();
  const response = (
    await vault.mintForPhase({
      workspaceId: "space_1",
      phase: "source",
    })
  ).toMintResponse();
  expect(response.env).toEqual({});
  expect(response.files ?? []).toEqual([]);
});

// Rule 4: build + anything -> rejected.
test("rule 4: build phase rejects any credential request", async () => {
  const { store, vault } = makeVault();
  await expect(
    vault.mintForPhase({
      workspaceId: "space_1",
      phase: "build",
      providers: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/build phase must not request/);
  const conn = await registerHttps(store, vault);
  await expect(
    vault.mintForPhase({
      workspaceId: "space_1",
      phase: "build",
      sourceConnectionId: conn.id,
    }),
  ).rejects.toThrow(/build phase must not request/);
});

// Rule 5: build + nothing -> empty.
test("rule 5: build phase with nothing requested is empty", async () => {
  const { store, vault } = makeVault();
  const response = (
    await vault.mintForPhase({
      workspaceId: "space_1",
      phase: "build",
    })
  ).toMintResponse();
  expect(response.env).toEqual({});
});

// Rules 6/7/8: plan/apply/destroy -> provider env only, git excluded.
for (const phase of ["plan", "apply", "destroy"] as const) {
  test(`rule: ${phase} phase mints provider env only`, async () => {
    const { store, vault } = makeVault();
    await registerProvider(store, vault);
    const response = (
      await vault.mintForPhase({
        workspaceId: "space_1",
        phase,
        providers: ["registry.opentofu.org/cloudflare/cloudflare"],
      })
    ).toMintResponse();
    expect(response.env.CLOUDFLARE_API_TOKEN).toBe("cf-secret-token");
    expect(response.files ?? []).toEqual([]);
  });

  test(`rule: ${phase} phase rejects a git source connection`, async () => {
    const { store, vault } = makeVault();
    const conn = await registerHttps(store, vault);
    await expect(
      vault.mintForPhase({
        workspaceId: "space_1",
        phase,
        sourceConnectionId: conn.id,
      }),
    ).rejects.toThrow(/must not request a git source connection/);
  });

  test(`rule: ${phase} phase never selects a git connection for a provider`, async () => {
    const { store, vault } = makeVault();
    // Only a git connection exists; a provider mint must NOT pick it up.
    await registerHttps(store, vault);
    await expect(
      vault.mintForPhase({
        workspaceId: "space_1",
        phase,
        providers: ["registry.opentofu.org/cloudflare/cloudflare"],
      }),
    ).rejects.toThrow(
      /no connection registered for provider registry\.opentofu\.org\/cloudflare\/cloudflare/,
    );
  });
}

test("source phase rejects a provider env binding passed as sourceConnectionId", async () => {
  const { store, vault } = makeVault();
  const provider = await registerProvider(store, vault);
  await expect(
    vault.mintForPhase({
      workspaceId: "space_1",
      phase: "source",
      sourceConnectionId: provider.id,
    }),
  ).rejects.toThrow(/not a git source connection/);
});

test("source phase rejects a connection from another Workspace", async () => {
  const { store, vault } = makeVault();
  const conn = await registerHttps(store, vault);
  await expect(
    vault.mintForPhase({
      workspaceId: "space_2",
      phase: "source",
      sourceConnectionId: conn.id,
    }),
  ).rejects.toThrow(/connection not found in this workspace/);
});

test("mint (legacy provider path) never selects a git connection", async () => {
  const { store, vault } = makeVault();
  await registerHttps(store, vault);
  await expect(
    vault.mint("space_1", ["registry.opentofu.org/cloudflare/cloudflare"]),
  ).rejects.toThrow(
    /no connection registered for provider registry\.opentofu\.org\/cloudflare\/cloudflare/,
  );
});

// --- Operator-scoped connections + provider-connection connection pool (§8 / §9) -

test("registers an operator-scoped connection without a Workspace", async () => {
  const { store, vault } = makeVault();
  const conn = await vault.register({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
  });
  expect(conn.scope).toBe("operator");
  expect(conn.workspaceId).toBeUndefined();
  expect(JSON.stringify(conn)).not.toContain("operator-cf-token");
});

test("provider-connection connection pool mints an operator connection from any Workspace", async () => {
  const { store, vault } = makeVault();
  const operatorConn = await markVerified(
    store,
    await vault.register({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
    }),
  );
  // The Workspace itself has NO cloudflare connection: only the resolved
  // provider-connection pool supplies one through operator-level provider
  // compatibility coverage.
  const bundle = await vault.mintForPhase({
    workspaceId: "space_other",
    phase: "plan",
    providers: ["registry.opentofu.org/cloudflare/cloudflare"],
    connectionIds: [operatorConn.id],
  });
  expect(bundle.env.CLOUDFLARE_API_TOKEN).toBe("operator-cf-token");
});

test("provider-connection connection pool mints a pending managed-provider connection through the issuer", async () => {
  const { vault } = makeVault({
    managedProviderCredentialIssuer: async () => ({
      values: {
        CLOUDFLARE_API_TOKEN: "takmpt_provider_env",
        CLOUDFLARE_ACCOUNT_ID: "ts_acc_takosumi_cloud",
        CLOUDFLARE_API_BASE_URL:
          "https://app.takosumi.com/compat/cloudflare/client/v4",
      },
      issuer: "takosumi_managed_provider_token",
      temporary: true,
      expiresAt: "2026-06-04T00:15:00.000Z",
      ttlSeconds: 900,
      secretValueStored: false,
    }),
  });
  const operatorConn = await vault.register({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-static-token" },
    scopeHints: {
      managedProvider: true,
      managedProviderProfile: "compat.cloudflare.workers.v1",
      providerConfig: {
        base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
      },
      managedPublicBaseDomain: "app-staging.takos.jp",
    },
  });
  expect(operatorConn.status).toBe("pending");
  expect(operatorConn.scopeHints?.managedPublicBaseDomain).toBe(
    "app-staging.takos.jp",
  );

  const bundle = await vault.mintForPhase({
    workspaceId: "space_other",
    phase: "plan",
    providers: ["registry.opentofu.org/cloudflare/cloudflare"],
    connectionIds: [operatorConn.id],
  });

  expect(bundle.env.CLOUDFLARE_API_TOKEN).toBe("takmpt_provider_env");
  expect(bundle.env.CLOUDFLARE_ACCOUNT_ID).toBe("ts_acc_takosumi_cloud");
  expect(bundle.env.CLOUDFLARE_API_BASE_URL).toBe(
    "https://app.takosumi.com/compat/cloudflare/client/v4",
  );
  expect(bundle.providerCredentialEvidence[0]).toMatchObject({
    connectionId: operatorConn.id,
    issuer: "takosumi_managed_provider_token",
    secretValueStored: false,
  });
  expect(JSON.stringify(bundle)).not.toContain("operator-static-token");
});

test("provider-connection connection pool still rejects a pending non-managed connection", async () => {
  const { vault } = makeVault();
  const operatorConn = await vault.register({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
  });
  expect(operatorConn.status).toBe("pending");

  await expect(
    vault.mintForPhase({
      workspaceId: "space_other",
      phase: "plan",
      providers: ["registry.opentofu.org/cloudflare/cloudflare"],
      connectionIds: [operatorConn.id],
    }),
  ).rejects.toThrow(`connection ${operatorConn.id} is pending (not verified)`);
});

test("provider-connection connection pool rejects a connection from another Workspace", async () => {
  const { store, vault } = makeVault();
  const spaceConn = await registerProvider(store, vault); // space_1
  const err = await vault
    .mintForPhase({
      workspaceId: "space_other",
      phase: "plan",
      providers: ["registry.opentofu.org/cloudflare/cloudflare"],
      connectionIds: [spaceConn.id],
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("belongs to another Workspace");
});

test("provider-connection connection pool restricts selection: provider outside the pool fails", async () => {
  const { store, vault } = makeVault();
  // space_1 HAS a cloudflare connection, but the resolved pool is empty-handed
  // for aws — the mint must not silently fall back to the Workspace-wide pool.
  await registerProvider(store, vault);
  const gitConn = await registerHttps(store, vault);
  const err = await vault
    .mintForPhase({
      workspaceId: "space_1",
      phase: "plan",
      providers: ["registry.opentofu.org/cloudflare/cloudflare"],
      connectionIds: [gitConn.id],
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("no connection registered");
});

// --- §13 per-binding credential mint (mintForCapsuleProviderBindings) --------------------

async function registerAws(
  store: InMemoryOpenTofuControlStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/hashicorp/aws",
      authMethod: "static_secret",
      values: {
        AWS_ACCESS_KEY_ID: "AKIA_secret_id",
        AWS_SECRET_ACCESS_KEY: "aws_secret_key_value",
        AWS_SESSION_TOKEN: "aws_session_token_value",
      },
    }),
  );
}

async function registerAwsAssumeRole(
  store: InMemoryOpenTofuControlStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
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
    }),
  );
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

test("mintForCapsuleProviderBindings preserves declared Cloudflare env", async () => {
  const { store, vault } = makeVault();
  const conn = await registerProvider(store, vault);
  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      alias: "main",
      connectionId: conn.id,
    },
  ]);
  expect(bundle.env).toEqual({
    CLOUDFLARE_API_TOKEN: "cf-secret-token",
  });
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    },
  ]);
});

test("mintForCapsuleProviderBindings records TTL evidence for expiring static provider credentials", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      expiresAt: "2026-06-04T00:30:00.000Z",
      values: { CLOUDFLARE_API_TOKEN: "cf-expiring-token" },
    }),
  );

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      alias: "main",
      connectionId: conn.id,
    },
  ]);

  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      temporary: false,
      ttlEnforced: true,
      expiresAt: "2026-06-04T00:30:00.000Z",
      ttlSeconds: 1800,
      issuer: "static_secret",
    },
  ]);
});

test("mintForCapsuleProviderBindings vends a TTL-bound Cloudflare env token", async () => {
  let called:
    | {
        readonly url: string;
        readonly method: string | undefined;
        readonly auth: string | null;
        readonly contentType: string | null;
        readonly body: Record<string, unknown>;
      }
    | undefined;
  const fakeFetch = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    called = {
      url: input,
      method: init?.method,
      auth: new Headers(init?.headers).get("authorization"),
      contentType: new Headers(init?.headers).get("content-type"),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          id: "cf_token_id",
          value: "cf-run-scoped-token",
          expires_on: "2026-06-04T00:15:00.000Z",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const { store, vault } = makeVault({ fetch: fakeFetch as never });
  const conn = await registerCloudflareTokenVending(store, vault);

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      alias: "main",
      connectionId: conn.id,
    },
  ]);

  expect(called?.url).toBe("https://api.cloudflare.com/client/v4/user/tokens");
  expect(called?.method).toBe("POST");
  expect(called?.auth).toBe("Bearer cf-bootstrap-token");
  expect(called?.contentType).toBe("application/json");
  expect(called?.body.expires_on).toBe("2026-06-04T00:15:00.000Z");
  expect(String(called?.body.name)).toContain("takosumi-test");
  expect(called?.body.policies).toEqual([
    {
      effect: "allow",
      permission_groups: [{ id: "perm_workers_write" }],
      resources: {
        "com.cloudflare.api.account.acct_123": "*",
      },
    },
  ]);
  expect(bundle.env).toEqual({
    CLOUDFLARE_API_TOKEN: "cf-run-scoped-token",
  });
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      temporary: true,
      ttlEnforced: true,
      expiresAt: "2026-06-04T00:15:00.000Z",
      ttlSeconds: 900,
      issuer: "cloudflare_api_token_vending",
    },
  ]);
  expect(JSON.stringify(bundle)).not.toContain("cf-bootstrap-token");
});

test("cloudflare token vending fails closed when Cloudflare omits expires_on", async () => {
  const { store, vault } = makeVault({
    fetch: (async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: { value: "cf-run-scoped-token" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as never,
  });
  const conn = await registerCloudflareTokenVending(store, vault);

  const err = await vault
    .mintForCapsuleProviderBindings("space_1", [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: conn.id,
      },
    ])
    .catch((e) => e);

  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("expires_on");
});

test("expired connections fail closed before any provider credential mint", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      expiresAt: "2026-06-04T00:30:00.000Z",
      values: { CLOUDFLARE_API_TOKEN: "cf-expiring-token" },
    }),
  );
  const lateVault = makeVault({
    store,
    now: () => new Date("2026-06-04T00:31:00.000Z"),
  }).vault;

  await expect(
    lateVault.mintForCapsuleProviderBindings("space_1", [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: conn.id,
      },
    ]),
  ).rejects.toThrow("expired at 2026-06-04T00:30:00.000Z");
  expect((await store.getConnection(conn.id))?.status).toBe("expired");
  await expect(
    vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      expiresAt: "2026-06-03T23:59:59.000Z",
      values: { CLOUDFLARE_API_TOKEN: "already-expired" },
    }),
  ).rejects.toThrow("expiresAt must be in the future");
});

test("mintForCapsuleProviderBindings preserves recipe env across providers", async () => {
  const { store, vault } = makeVault();
  const cf = await registerProvider(store, vault);
  const aws = await registerAws(store, vault);
  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      alias: "main",
      connectionId: cf.id,
    },
    { provider: "hashicorp/aws", alias: "archive", connectionId: aws.id },
  ]);
  expect(bundle.env).toEqual({
    CLOUDFLARE_API_TOKEN: "cf-secret-token",
    AWS_ACCESS_KEY_ID: "AKIA_secret_id",
    AWS_SECRET_ACCESS_KEY: "aws_secret_key_value",
    AWS_SESSION_TOKEN: "aws_session_token_value",
  });
});

test("aws assume-role connection mints short-lived STS credentials for tofu phases", async () => {
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
  await registerAwsAssumeRole(store, vault);

  const bundle = await vault.mintForPhase({
    workspaceId: "space_1",
    phase: "plan",
    providers: ["registry.opentofu.org/hashicorp/aws"],
  });
  const response = bundle.toMintResponse();

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
  expect(response.env).toEqual({
    AWS_ACCESS_KEY_ID: "ASIA_assumed",
    AWS_SECRET_ACCESS_KEY: "assumed_secret",
    AWS_SESSION_TOKEN: "assumed_session",
    AWS_REGION: "us-west-2",
    AWS_DEFAULT_REGION: "us-west-2",
  });
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: "conn_test000000000001",
      provider: "registry.opentofu.org/hashicorp/aws",
      temporary: true,
      ttlEnforced: true,
      expiresAt: "2026-06-04T01:00:00.000Z",
      ttlSeconds: 3600,
      issuer: "aws_sts_assume_role",
    },
  ]);
  expect(JSON.stringify(response)).not.toContain("source_secret");
});

test("mintForCapsuleProviderBindings returns assumed AWS recipe env", async () => {
  const { store, vault } = makeVault({
    fetch: (() =>
      Promise.resolve(
        new Response(stsSuccessXml(), {
          status: 200,
          headers: { "content-type": "text/xml" },
        }),
      )) as never,
  });
  const aws = await registerAwsAssumeRole(store, vault);

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    { provider: "hashicorp/aws", alias: "archive", connectionId: aws.id },
  ]);

  expect(bundle.env).toEqual({
    AWS_ACCESS_KEY_ID: "ASIA_assumed",
    AWS_SECRET_ACCESS_KEY: "assumed_secret",
    AWS_SESSION_TOKEN: "assumed_session",
    AWS_REGION: "us-west-2",
    AWS_DEFAULT_REGION: "us-west-2",
  });
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: aws.id,
      provider: "registry.opentofu.org/hashicorp/aws",
      temporary: true,
      ttlEnforced: true,
      expiresAt: "2026-06-04T01:00:00.000Z",
      ttlSeconds: 3600,
      issuer: "aws_sts_assume_role",
    },
  ]);
});

test("aws assume-role mint fails closed when STS rejects the role", async () => {
  const { store, vault } = makeVault({
    fetch: (() =>
      Promise.resolve(
        new Response(
          "<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>",
          { status: 403, headers: { "content-type": "text/xml" } },
        ),
      )) as never,
  });
  await registerAwsAssumeRole(store, vault);

  const err = await vault
    .mintForPhase({
      workspaceId: "space_1",
      phase: "plan",
      providers: ["registry.opentofu.org/hashicorp/aws"],
    })
    .catch((e) => e);

  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("failed_precondition");
  expect(String(err)).toContain("AccessDenied");
});

test("mintForCapsuleProviderBindings re-validates ids: a connection from another Workspace is rejected", async () => {
  const { store, vault } = makeVault();
  const conn = await registerProvider(store, vault); // space_1
  const err = await vault
    .mintForCapsuleProviderBindings("space_other", [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: conn.id,
      },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("belongs to another Workspace");
});

test("mintForCapsuleProviderBindings re-validates ids: an unknown connection fails closed", async () => {
  const { store, vault } = makeVault();
  const err = await vault
    .mintForCapsuleProviderBindings("space_1", [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: "conn_missing",
      },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("not_found");
});

test("mintForCapsuleProviderBindings mints an operator connection from any Workspace", async () => {
  const { store, vault } = makeVault();
  const operatorConn = await markVerified(
    store,
    await vault.register({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
    }),
  );
  const bundle = await vault.mintForCapsuleProviderBindings("space_other", [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      alias: "zone",
      connectionId: operatorConn.id,
    },
  ]);
  expect(bundle.env).toEqual({
    CLOUDFLARE_API_TOKEN: "operator-cf-token",
  });
});

test("mintForCapsuleProviderBindings uses managed-provider issuer before stored operator material", async () => {
  const calls: {
    readonly workspaceId: string;
    readonly capsuleId?: string;
    readonly connectionId: string;
    readonly managedProviderProfile: string;
  }[] = [];
  const { store, vault } = makeVault({
    managedProviderCredentialIssuer: async (request) => {
      calls.push({
        workspaceId: request.workspaceId,
        ...(request.capsuleId ? { capsuleId: request.capsuleId } : {}),
        connectionId: request.connection.id,
        managedProviderProfile: request.managedProviderProfile,
      });
      return {
        values: { CLOUDFLARE_API_TOKEN: "takmpt_run_scoped" },
        issuer: "takosumi_managed_provider_token",
        temporary: true,
        expiresAt: "2026-06-04T00:15:00.000Z",
        ttlSeconds: 900,
        secretValueStored: false,
      };
    },
  });
  const operatorConn = await markVerified(
    store,
    await vault.register({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-static-token" },
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.cloudflare.workers.v1",
        providerConfig: {
          base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
        },
      },
    }),
  );

  const bundle = await vault.mintForCapsuleProviderBindings(
    "space_other",
    [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "zone",
        connectionId: operatorConn.id,
      },
    ],
    { capsuleId: "cap_1234567890abcdef" },
  );

  expect(bundle.env).toEqual({
    CLOUDFLARE_API_TOKEN: "takmpt_run_scoped",
  });
  expect(calls).toEqual([
    {
      workspaceId: "space_other",
      capsuleId: "cap_1234567890abcdef",
      connectionId: operatorConn.id,
      managedProviderProfile: "compat.cloudflare.workers.v1",
    },
  ]);
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: operatorConn.id,
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      temporary: true,
      ttlEnforced: true,
      expiresAt: "2026-06-04T00:15:00.000Z",
      ttlSeconds: 900,
      issuer: "takosumi_managed_provider_token",
      secretValueStored: false,
    },
  ]);
});

test("mintForCapsuleProviderBindings mints a pending managed-provider connection through the issuer", async () => {
  const calls: {
    readonly workspaceId: string;
    readonly capsuleId?: string;
    readonly connectionId: string;
    readonly managedProviderProfile: string;
  }[] = [];
  const { vault } = makeVault({
    managedProviderCredentialIssuer: async (request) => {
      calls.push({
        workspaceId: request.workspaceId,
        ...(request.capsuleId ? { capsuleId: request.capsuleId } : {}),
        connectionId: request.connection.id,
        managedProviderProfile: request.managedProviderProfile,
      });
      return {
        values: { CLOUDFLARE_API_TOKEN: "takmpt_run_scoped" },
        issuer: "takosumi_managed_provider_token",
        temporary: true,
        expiresAt: "2026-06-04T00:15:00.000Z",
        ttlSeconds: 900,
        secretValueStored: false,
      };
    },
  });
  const operatorConn = await vault.register({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-static-token" },
    scopeHints: {
      managedProvider: true,
      managedProviderProfile: "compat.cloudflare.workers.v1",
      providerConfig: {
        base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
      },
    },
  });
  expect(operatorConn.status).toBe("pending");

  const bundle = await vault.mintForCapsuleProviderBindings(
    "space_other",
    [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "zone",
        connectionId: operatorConn.id,
      },
    ],
    { capsuleId: "cap_1234567890abcdef" },
  );

  expect(bundle.env).toEqual({
    CLOUDFLARE_API_TOKEN: "takmpt_run_scoped",
  });
  expect(calls).toEqual([
    {
      workspaceId: "space_other",
      capsuleId: "cap_1234567890abcdef",
      connectionId: operatorConn.id,
      managedProviderProfile: "compat.cloudflare.workers.v1",
    },
  ]);
  expect(JSON.stringify(bundle)).not.toContain("operator-static-token");
});

test("mintForCapsuleProviderBindings still rejects a pending non-managed connection", async () => {
  const { vault } = makeVault();
  const operatorConn = await vault.register({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
  });
  expect(operatorConn.status).toBe("pending");

  await expect(
    vault.mintForCapsuleProviderBindings("space_other", [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "zone",
        connectionId: operatorConn.id,
      },
    ]),
  ).rejects.toThrow(`connection ${operatorConn.id} is pending (not verified)`);
});

test("managed provider registration rejects an unprofiled row even when providerConfig has a base_url", async () => {
  const { store, vault } = makeVault();
  await expect(
    vault.register({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-static-token" },
      scopeHints: {
        managedProvider: true,
        providerConfig: {
          base_url: "https://provider.example.test/api",
        },
      },
    }),
  ).rejects.toThrow(
    "scopeHints.managedProviderProfile is required when managedProvider is true",
  );
  expect(await store.listOperatorConnections()).toEqual([]);
});

test("managed provider registration rejects Workspace-owned rows", async () => {
  const { store, vault } = makeVault();
  await expect(
    vault.register({
      workspaceId: "workspace_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "workspace-static-token" },
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.cloudflare.workers.v1",
      },
    }),
  ).rejects.toThrow(
    "managed provider connections must be operator-scoped and must not have an owning Workspace",
  );
  expect(await store.listConnections("workspace_1")).toEqual([]);
});

test("managed provider profile is inert unless the service-side marker is explicit", async () => {
  const { store, vault } = makeVault();
  await expect(
    vault.register({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-static-token" },
      scopeHints: {
        managedProviderProfile: "operator.example.provider.v1",
      },
    }),
  ).rejects.toThrow(
    "scopeHints.managedProviderProfile requires managedProvider: true",
  );
  expect(await store.listOperatorConnections()).toEqual([]);
});

test("mintForCapsuleProviderBindings rejects managed-provider connections without an issuer", async () => {
  const { store, vault } = makeVault();
  const operatorConn = await markVerified(
    store,
    await vault.register({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-static-token" },
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.cloudflare.workers.v1",
        providerConfig: {
          base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
        },
      },
    }),
  );

  let err: unknown;
  try {
    await vault.mintForCapsuleProviderBindings(
      "space_other",
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          alias: "zone",
          connectionId: operatorConn.id,
        },
      ],
      { capsuleId: "cap_1234567890abcdef" },
    );
  } catch (caught) {
    err = caught;
  }

  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("failed_precondition");
  expect((err as Error).message).toContain(
    "requires a managed provider credential issuer",
  );
});

test("mintForCapsuleProviderBindings rejects managed-provider connections when issuer returns no token", async () => {
  const { store, vault } = makeVault({
    managedProviderCredentialIssuer: async () => undefined,
  });
  const operatorConn = await markVerified(
    store,
    await vault.register({
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-static-token" },
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.cloudflare.workers.v1",
        providerConfig: {
          base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
        },
      },
    }),
  );

  let err: unknown;
  try {
    await vault.mintForCapsuleProviderBindings(
      "space_other",
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          alias: "zone",
          connectionId: operatorConn.id,
        },
      ],
      { capsuleId: "cap_1234567890abcdef" },
    );
  } catch (caught) {
    err = caught;
  }

  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("failed_precondition");
  expect((err as Error).message).toContain(
    "could not mint a run-scoped provider token",
  );
});

test("mintForCapsuleProviderBindings preserves env for every provider", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/hashicorp/kubernetes",
      authMethod: "static_secret",
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: "provider-credentials",
      },
      values: { KUBE_CONFIG_PATH: "/work/.kube/config" },
    }),
  );
  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/hashicorp/kubernetes",
      alias: "main",
      connectionId: conn.id,
    },
  ]);
  expect(bundle.env).toEqual({ KUBE_CONFIG_PATH: "/work/.kube/config" });
});

test("mintForCapsuleProviderBindings executes the generic-env recipe without a connection kind", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/integrations/github",
      authMethod: "static_secret",
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: "provider-credentials",
      },
      values: {
        GITHUB_TOKEN: "github-secret",
      },
    }),
  );

  expect(conn.kind).toBeUndefined();
  expect(conn.credentialRecipe).toEqual({
    id: "generic-env",
    authMode: "env",
    secretPartition: "provider-credentials",
    declaredEnv: true,
    envNames: ["GITHUB_TOKEN"],
    fileEnvNames: [],
    requiredEnvGroups: [],
  });

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/integrations/github",
      alias: "main",
      connectionId: conn.id,
    },
  ]);

  expect(bundle.env).toEqual({
    GITHUB_TOKEN: "github-secret",
  });
});

test("mintForCapsuleProviderBindings maps generic provider files to tofu credential files", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/example/envfile",
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: {
        GENERIC_API_TOKEN: "generic-secret",
      },
      files: [
        {
          path: "provider-credentials.json",
          content: '{"token":"file-secret"}',
          envName: "GENERIC_CREDENTIALS_FILE",
        },
      ],
    }),
  );

  expect(conn.envNames).toEqual([
    "GENERIC_API_TOKEN",
    "GENERIC_CREDENTIALS_FILE",
  ]);
  expect(conn.fileEnvNames).toEqual(["GENERIC_CREDENTIALS_FILE"]);

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/example/envfile",
      connectionId: conn.id,
    },
  ]);
  const response = bundle.toMintResponse();

  expect(response.env).toEqual({ GENERIC_API_TOKEN: "generic-secret" });
  expect(response.files).toEqual([
    {
      path: "provider-credentials.json",
      content: '{"token":"file-secret"}',
      mode: 0o600,
      envName: "GENERIC_CREDENTIALS_FILE",
    },
  ]);
  expect(JSON.stringify(bundle)).not.toContain("generic-secret");
  expect(JSON.stringify(bundle)).not.toContain("file-secret");
});

test("generic-env provider registration rejects unsafe credential file declarations", async () => {
  const { vault } = makeVault();
  await expect(
    vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/example/envfile",
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: {},
      files: [
        {
          path: "../escape.json",
          content: "secret",
          envName: "GENERIC_CREDENTIALS_FILE",
        },
      ],
    }),
  ).rejects.toThrow("credential file path ../escape.json is unsafe");

  await expect(
    vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/example/envfile",
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: { GENERIC_CREDENTIALS_FILE: "also-a-value" },
      files: [
        {
          path: "provider.json",
          content: "secret",
          envName: "GENERIC_CREDENTIALS_FILE",
        },
      ],
    }),
  ).rejects.toThrow(
    "env name GENERIC_CREDENTIALS_FILE cannot be supplied both as a value and a credential file path",
  );
});

test("generic-env provider registration accepts arbitrary providers with explicit env names", async () => {
  const { store, vault } = makeVault();
  const provider =
    "registry.opentofu.org/not-a-real-provider/not-a-real-provider";
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider,
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: { NOT_A_REAL_PROVIDER_TOKEN: "secret" },
    }),
  );

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "not-a-real-provider/not-a-real-provider",
      connectionId: conn.id,
    },
  ]);

  expect(bundle.env).toEqual({
    NOT_A_REAL_PROVIDER_TOKEN: "secret",
  });
});

test("generic-env provider registration accepts explicit env names for guided providers", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/integrations/github",
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: {
        GITHUB_TOKEN: "github-secret",
        GITHUB_CUSTOM_ENDPOINT: "https://github.example.test",
      },
    }),
  );

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/integrations/github",
      connectionId: conn.id,
    },
  ]);

  expect(bundle.env).toEqual({
    GITHUB_CUSTOM_ENDPOINT: "https://github.example.test",
    GITHUB_TOKEN: "github-secret",
  });
});

test("generic-env provider registration passes raw env for root-mapped guided providers", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: {
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_CUSTOM_ENDPOINT: "https://api.example.test/client/v4",
      },
    }),
  );

  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      alias: "main",
      connectionId: conn.id,
    },
  ]);

  expect(bundle.env).toEqual({
    CLOUDFLARE_API_TOKEN: "cf-secret-token",
    CLOUDFLARE_CUSTOM_ENDPOINT: "https://api.example.test/client/v4",
  });
  expect(bundle.env.TF_VAR_cloudflare_main_api_token).toBeUndefined();
});

test("generic-env provider registration rejects runner-reserved env names", async () => {
  const { vault } = makeVault();
  await expect(
    vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/example/example",
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: { PATH: "/tmp/evil" },
    }),
  ).rejects.toThrow("reserved for the runner runtime");
  await expect(
    vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/example/example",
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: { TAKOSUMI_RUN_ID: "override" },
    }),
  ).rejects.toThrow("reserved for the runner runtime");
});

test("mintForCapsuleProviderBindings re-validates CapsuleProviderEnvBinding provider before opening values", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      workspaceId: "space_1",
      provider: "registry.opentofu.org/integrations/github",
      authMethod: "static_secret",
      credentialRecipe: declaredEnvRecipe(),
      values: { GITHUB_TOKEN: "github-secret" },
    }),
  );

  await expect(
    vault.mintForCapsuleProviderBindings("space_1", [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: conn.id,
      },
    ]),
  ).rejects.toThrow(
    /provider registry\.opentofu\.org\/integrations\/github does not match CapsuleProviderEnvBinding provider registry\.opentofu\.org\/cloudflare\/cloudflare/,
  );
});

test("mintForCapsuleProviderBindings rejects a git source connection", async () => {
  const { store, vault } = makeVault();
  const git = await registerHttps(store, vault);
  const err = await vault
    .mintForCapsuleProviderBindings("space_1", [
      { provider: "source", alias: "git", connectionId: git.id },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("git source connection");
});

test("mintForCapsuleProviderBindings is tofu-phase only", async () => {
  const { store, vault } = makeVault();
  const conn = await registerProvider(store, vault);
  await expect(
    vault.mintForCapsuleProviderBindings(
      "space_1",
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          alias: "main",
          connectionId: conn.id,
        },
      ],
      { phase: "build" },
    ),
  ).rejects.toThrow(/tofu-phase only/);
});

test("mintForCapsuleProviderBindings bundle never serializes its values", async () => {
  const { store, vault } = makeVault();
  const conn = await registerProvider(store, vault);
  const bundle = await vault.mintForCapsuleProviderBindings("space_1", [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      alias: "main",
      connectionId: conn.id,
    },
  ]);
  expect(JSON.stringify(bundle)).not.toContain("cf-secret-token");
  expect(`${bundle}`).not.toContain("cf-secret-token");
});
