import { expect, test } from "bun:test";

import {
  ConnectionVaultError,
  CredentialBundle,
  StaticSecretConnectionVault,
} from "../../../../core/adapters/vault/mod.ts";
import type { Connection } from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { MultiCloudSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";

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

async function markVerified(
  store: InMemoryOpenTofuDeploymentStore,
  connection: Connection,
): Promise<Connection> {
  const now = "2026-06-04T00:00:00.000Z";
  const verified: Connection = {
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

test("register rejects unknown providers without a declared generic-env recipe", async () => {
  const { vault } = makeVault();
  await expect(
    vault.register({
      spaceId: "space_1",
      provider: "does-not-exist",
      values: { X: "y" },
    }),
  ).rejects.toThrow(/has no built-in Credential Recipe/);

  const generic = await vault.register({
    spaceId: "space_1",
    provider: "registry.opentofu.org/snowflake-labs/snowflake",
    kind: "generic_env_provider",
    values: {
      SNOWFLAKE_ACCOUNT: "test-account",
      SNOWFLAKE_USER: "test-user",
      SNOWFLAKE_PASSWORD: "secret",
    },
  });
  expect(generic.provider).toBe(
    "registry.opentofu.org/snowflake-labs/snowflake",
  );
  expect(generic.envNames).toEqual([
    "SNOWFLAKE_ACCOUNT",
    "SNOWFLAKE_PASSWORD",
    "SNOWFLAKE_USER",
  ]);
});

test("register rejects a hybrid { spaceId, scope: operator } privilege escalation", async () => {
  const { store, vault } = makeVault();
  // Gateway-backed operator coverage has NO owning Space, so a caller-supplied
  // `scope: "operator"` must never win against a present spaceId — otherwise the
  // row would bypass the cross-tenant mint guard and let any Space bind it.
  const err = await vault
    .register({
      spaceId: "space_a",
      scope: "operator",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("invalid_argument");
  expect((err as ConnectionVaultError).message).toMatch(/owning space/);

  // Nothing was persisted by the rejected register.
  expect(await store.listConnections("space_a")).toEqual([]);
});

test("mint round-trips the decrypted values into a credential bundle", async () => {
  const { store, vault } = makeVault();
  await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: {
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_ACCOUNT_ID: "acct_xyz",
      },
    }),
  );

  const bundle = await vault.mint("space_1", ["cloudflare"]);
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
      spaceId: "space_1",
      provider: "cloudflare",
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
      spaceId: "space_1",
      provider: "cloudflare",
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

test("opening a blob moved to a different space fails the aad bind", async () => {
  const { store, vault } = makeVault();
  const original = await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  );
  const sealed = await store.getSecretBlob(original.id);
  expect(sealed).toBeDefined();

  // Re-home the verified connection (and its blob) into a different Space. The
  // blob's AAD is bound to space_1, so the cross-space row can no longer open it.
  await store.putConnection({ ...original, spaceId: "space_2" });
  await store.putSecretBlob({ ...sealed!, spaceId: "space_2" });

  await expect(vault.mint("space_2", ["cloudflare"])).rejects.toThrow();
});

test("mint refuses a pending connection before verification", async () => {
  const { vault } = makeVault();
  await vault.register({
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });

  await expect(vault.mint("space_1", ["cloudflare"])).rejects.toThrow(
    /pending \(not verified\)/,
  );
});

test("credential bundle never serializes its secret values", async () => {
  const { store, vault } = makeVault();
  await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  );
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
    spaceId: "space_1",
    provider: "cloudflare",
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

test("test() reaches verified for a generic-env provider connection (was permanently pending)", async () => {
  // Before the per-kind verify drivers, a generic_env_provider backing Connection fell
  // through to a `pending` "no verification driver" result and could NEVER
  // reach verified, so every mint for it failed permanently. It now verifies
  // structurally when all declared env names are present.
  const { store, vault } = makeVault();
  const connection = await vault.register({
    spaceId: "space_1",
    provider: "registry.opentofu.org/vercel/vercel",
    authMethod: "static_secret",
    kind: "generic_env_provider",
    values: { VERCEL_API_TOKEN: "vercel-secret" },
  });
  expect(connection.kind).toBe("generic_env_provider");

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
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    kind: "generic_env_provider",
    values: {
      CLOUDFLARE_API_TOKEN: "cf-secret-token",
      CLOUDFLARE_CUSTOM_ENDPOINT: "https://api.example.test/client/v4",
    },
  });
  expect(connection.kind).toBe("generic_env_provider");

  const result = await vault.test(connection.id);
  expect(result.status).toBe("verified");
  expect(fetchCalled).toBe(false);

  const persisted = await store.getConnection(connection.id);
  expect(persisted?.status).toBe("verified");
  expect(persisted?.verifiedAt).toBeDefined();
});

test("operator-scoped provider connections have no owning Space", async () => {
  const { vault } = makeVault();
  const connection = await vault.register({
    scope: "operator",
    provider: "cloudflare",
    values: { CLOUDFLARE_API_TOKEN: "operator-secret" },
  });

  expect(connection.spaceId).toBeUndefined();
  expect(connection.scope).toBe("operator");
  expect(connection.materialization).toBe("secret");
});

test("register rejects operator-scoped generic-env provider connections", async () => {
  const { store, vault } = makeVault();
  const err = await vault
    .register({
      scope: "operator",
      provider: "registry.opentofu.org/integrations/github",
      kind: "generic_env_provider",
      materialization: "gateway",
      credentialDriver: "generic_env",
      authMethod: "static_secret",
      values: { GITHUB_TOKEN: "github-secret-token" },
    })
    .catch((e) => e);

  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("failed_precondition");
  expect((err as ConnectionVaultError).message).toContain("Space-scoped");
  expect(await store.listOperatorConnections()).toEqual([]);
});

test("test() keeps reserved gcp helpers pending", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    spaceId: "space_1",
    provider: "google",
    kind: "gcp_service_account_impersonation",
    authMethod: "static_secret",
    values: { GOOGLE_CREDENTIALS: '{"type":"service_account"}' },
    scopeHints: {
      gcpServiceAccountEmail: "svc@example.iam.gserviceaccount.com",
      gcpProjectId: "project-1",
    },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("pending");
  expect(result.detail).toContain("reserved");

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
    spaceId: "space_1",
    provider: "google",
    kind: "gcp_service_account_json",
    credentialDriver: "gcp_service_account_json",
    authMethod: "static_secret",
    values: {
      GOOGLE_CREDENTIALS: serviceAccountJson,
      GOOGLE_CLOUD_PROJECT: "   ",
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

  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    {
      provider: "registry.opentofu.org/hashicorp/google",
      connectionId: connection.id,
    },
  ]);
  expect(bundle.env.TF_VAR_google_credentials).toEqual(serviceAccountJson);
  expect(bundle.env.TF_VAR_google_project).toEqual("project-1");
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      providerEnvId: connection.id,
      connectionId: connection.id,
      provider: "google",
      delivery: "generated_root_variable",
      rootOnly: true,
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    },
  ]);
});

test("mint rejects reserved gcp helpers even if a row is manually verified", async () => {
  const { store, vault } = makeVault();
  const connection = await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "google",
      kind: "gcp_service_account_impersonation",
      authMethod: "static_secret",
      values: { GOOGLE_CREDENTIALS: '{"type":"service_account"}' },
      scopeHints: {
        gcpServiceAccountEmail: "svc@example.iam.gserviceaccount.com",
        gcpProjectId: "project-1",
      },
    }),
  );

  const err = await vault
    .mintForInstallationProviderEnvBindings("space_1", [
      { provider: "google", connectionId: connection.id },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("not_implemented");
  expect((err as ConnectionVaultError).message).toContain("gcp");
});

test("test() reaches verified for a git https source connection", async () => {
  // A git source Connection (no live probe URL configured) verifies
  // structurally once its token is present, so the source phase can mint it.
  const { store, vault } = makeVault();
  const connection = await vault.register({
    spaceId: "space_1",
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
    spaceId: "space_1",
    provider: "cloudflare",
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
    spaceId: "space_1",
    provider: "aws",
    authMethod: "static_secret",
    scopeHints: {
      awsRoleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
      awsExternalId: "space_1",
      awsRegion: "us-west-2",
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
    spaceId: "space_1",
    provider: "aws",
    authMethod: "static_secret",
    scopeHints: {
      awsRoleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
      awsExternalId: "space_1",
      awsRegion: "us-west-2",
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
    spaceId: "space_1",
    provider: "aws",
    authMethod: "static_secret",
    values: {
      AWS_ACCESS_KEY_ID: "AKIA_source",
      AWS_SECRET_ACCESS_KEY: "source_secret",
    },
  });

  const result = await vault.test(connection.id);
  expect(result.status).toBe("pending");
  expect(result.detail).toContain("scopeHints.awsRoleArn");
  expect((await store.getConnection(connection.id))?.status).toBe("pending");
});

test("test() keeps aws assume-role pending when source credentials are missing", async () => {
  const { store, vault } = makeVault();
  const connection = await vault.register({
    spaceId: "space_1",
    provider: "aws",
    authMethod: "static_secret",
    scopeHints: {
      awsRoleArn: "arn:aws:iam::123456789012:role/takosumi-prod",
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
