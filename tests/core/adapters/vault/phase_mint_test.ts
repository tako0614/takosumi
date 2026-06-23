import { expect, test } from "bun:test";

import {
  ConnectionVaultError,
  PhaseMintBundle,
  StaticSecretConnectionVault,
} from "../../../../core/adapters/vault/mod.ts";
import type { Connection } from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { MultiCloudSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";

function makeVault(
  overrides: {
    fetch?: typeof fetch;
    store?: InMemoryOpenTofuDeploymentStore;
    now?: () => Date;
  } = {},
) {
  const store = overrides.store ?? new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: overrides.now ?? (() => new Date("2026-06-04T00:00:00.000Z")),
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

async function registerProvider(
  store: InMemoryOpenTofuDeploymentStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
    }),
  );
}

async function registerCloudflareTokenVending(
  store: InMemoryOpenTofuDeploymentStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      scopeHints: {
        cloudflareTokenVending: {
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
      values: { CLOUDFLARE_API_TOKEN: "cf-bootstrap-token" },
    }),
  );
}

async function registerHttps(
  store: InMemoryOpenTofuDeploymentStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "source_git_https_token",
      kind: "source_git_https_token",
      authMethod: "static_secret",
      scopeHints: { username: "git-bot" },
      values: { GIT_HTTPS_TOKEN: "ghp_secret_token" },
    }),
  );
}

async function registerSsh(
  store: InMemoryOpenTofuDeploymentStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "source_git_ssh_key",
      kind: "source_git_ssh_key",
      authMethod: "static_secret",
      scopeHints: { knownHostsEntry: "github.com ssh-ed25519 AAAAC3Nz..." },
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
  expect(conn.scope).toBe("space");
  expect(conn.scopeHints).toEqual({ username: "git-bot" });
  expect(JSON.stringify(conn)).not.toContain("ghp_secret_token");
});

test("source_git_ssh_key REQUIRES scopeHints.knownHostsEntry", async () => {
  const { store, vault } = makeVault();
  const err = await vault
    .register({
      spaceId: "space_1",
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
      spaceId: "space_1",
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
      spaceId: "space_1",
      phase: "source",
      providers: ["cloudflare"],
    }),
  ).rejects.toThrow(/source phase must not request provider/);
});

// Rule 2: source + git https connection -> env + askpass file.
test("rule 2a: source phase mints https git creds as env + askpass file", async () => {
  const { store, vault } = makeVault();
  const conn = await registerHttps(store, vault);
  const bundle = await vault.mintForPhase({
    spaceId: "space_1",
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
      spaceId: "space_1",
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
      spaceId: "space_1",
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
      spaceId: "space_1",
      phase: "build",
      providers: ["cloudflare"],
    }),
  ).rejects.toThrow(/build phase must not request/);
  const conn = await registerHttps(store, vault);
  await expect(
    vault.mintForPhase({
      spaceId: "space_1",
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
      spaceId: "space_1",
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
        spaceId: "space_1",
        phase,
        providers: ["cloudflare"],
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
        spaceId: "space_1",
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
        spaceId: "space_1",
        phase,
        providers: ["cloudflare"],
      }),
    ).rejects.toThrow(/no connection registered for provider cloudflare/);
  });
}

test("source phase rejects a provider env binding passed as sourceConnectionId", async () => {
  const { store, vault } = makeVault();
  const provider = await registerProvider(store, vault);
  await expect(
    vault.mintForPhase({
      spaceId: "space_1",
      phase: "source",
      sourceConnectionId: provider.id,
    }),
  ).rejects.toThrow(/not a git source connection/);
});

test("source phase rejects a connection from another space", async () => {
  const { store, vault } = makeVault();
  const conn = await registerHttps(store, vault);
  await expect(
    vault.mintForPhase({
      spaceId: "space_2",
      phase: "source",
      sourceConnectionId: conn.id,
    }),
  ).rejects.toThrow(/not found in space space_2/);
});

test("mint (legacy provider path) never selects a git connection", async () => {
  const { store, vault } = makeVault();
  await registerHttps(store, vault);
  await expect(vault.mint("space_1", ["cloudflare"])).rejects.toThrow(
    /no connection registered for provider cloudflare/,
  );
});

// --- Operator-scoped connections + provider-connection connection pool (§8 / §9) -

test("registers an operator-scoped connection without a space", async () => {
  const { store, vault } = makeVault();
  const conn = await vault.register({
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
  });
  expect(conn.scope).toBe("operator");
  expect(conn.spaceId).toBeUndefined();
  expect(JSON.stringify(conn)).not.toContain("operator-cf-token");
});

test("provider-connection connection pool mints an operator connection from any space", async () => {
  const { store, vault } = makeVault();
  const operatorConn = await markVerified(
    store,
    await vault.register({
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
    }),
  );
  // The space itself has NO cloudflare connection: only the resolved
  // provider-connection pool supplies one through Gateway-backed operator coverage.
  const bundle = await vault.mintForPhase({
    spaceId: "space_other",
    phase: "plan",
    providers: ["cloudflare"],
    connectionIds: [operatorConn.id],
  });
  expect(bundle.env.CLOUDFLARE_API_TOKEN).toBe("operator-cf-token");
});

test("provider-connection connection pool rejects a connection from another space", async () => {
  const { store, vault } = makeVault();
  const spaceConn = await registerProvider(store, vault); // space_1
  const err = await vault
    .mintForPhase({
      spaceId: "space_other",
      phase: "plan",
      providers: ["cloudflare"],
      connectionIds: [spaceConn.id],
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("belongs to another space");
});

test("provider-connection connection pool restricts selection: provider outside the pool fails", async () => {
  const { store, vault } = makeVault();
  // space_1 HAS a cloudflare connection, but the resolved pool is empty-handed
  // for aws — the mint must not silently fall back to the space-wide pool.
  await registerProvider(store, vault);
  const gitConn = await registerHttps(store, vault);
  const err = await vault
    .mintForPhase({
      spaceId: "space_1",
      phase: "plan",
      providers: ["cloudflare"],
      connectionIds: [gitConn.id],
    })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("no connection registered");
});

// --- §13 per-binding credential mint (mintForInstallationProviderEnvBindings) --------------------

async function registerAws(
  store: InMemoryOpenTofuDeploymentStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "aws",
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
  store: InMemoryOpenTofuDeploymentStore,
  vault: StaticSecretConnectionVault,
) {
  return await markVerified(
    store,
    await vault.register({
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

test("mintForInstallationProviderEnvBindings maps cloudflare env to TF_VAR_<provider>_<alias>_api_token", async () => {
  const { store, vault } = makeVault();
  const conn = await registerProvider(store, vault);
  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    { provider: "cloudflare", alias: "main", connectionId: conn.id },
  ]);
  expect(bundle.env).toEqual({
    TF_VAR_cloudflare_main_api_token: "cf-secret-token",
  });
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      providerEnvId: conn.id,
      provider: "cloudflare",
      delivery: "generated_root_variable",
      rootOnly: true,
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    },
  ]);
});

test("mintForInstallationProviderEnvBindings records TTL evidence for expiring static provider credentials", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      expiresAt: "2026-06-04T00:30:00.000Z",
      values: { CLOUDFLARE_API_TOKEN: "cf-expiring-token" },
    }),
  );

  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    { provider: "cloudflare", alias: "main", connectionId: conn.id },
  ]);

  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      providerEnvId: conn.id,
      provider: "cloudflare",
      delivery: "generated_root_variable",
      rootOnly: true,
      temporary: false,
      ttlEnforced: true,
      expiresAt: "2026-06-04T00:30:00.000Z",
      ttlSeconds: 1800,
      issuer: "static_secret",
    },
  ]);
});

test("mintForInstallationProviderEnvBindings vends a TTL-bound Cloudflare token for root-only provider args", async () => {
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

  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    { provider: "cloudflare", alias: "main", connectionId: conn.id },
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
    TF_VAR_cloudflare_main_api_token: "cf-run-scoped-token",
  });
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: conn.id,
      providerEnvId: conn.id,
      provider: "cloudflare",
      delivery: "generated_root_variable",
      rootOnly: true,
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
    .mintForInstallationProviderEnvBindings("space_1", [
      { provider: "cloudflare", alias: "main", connectionId: conn.id },
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
      spaceId: "space_1",
      provider: "cloudflare",
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
    lateVault.mintForInstallationProviderEnvBindings("space_1", [
      { provider: "cloudflare", alias: "main", connectionId: conn.id },
    ]),
  ).rejects.toThrow("expired at 2026-06-04T00:30:00.000Z");
  expect((await store.getConnection(conn.id))?.status).toBe("expired");
  await expect(
    vault.register({
      spaceId: "space_1",
      provider: "cloudflare",
      authMethod: "static_secret",
      expiresAt: "2026-06-03T23:59:59.000Z",
      values: { CLOUDFLARE_API_TOKEN: "already-expired" },
    }),
  ).rejects.toThrow("expiresAt must be in the future");
});

test("mintForInstallationProviderEnvBindings maps the three aws args and supports multiple provider aliases", async () => {
  const { store, vault } = makeVault();
  const cf = await registerProvider(store, vault);
  const aws = await registerAws(store, vault);
  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    { provider: "cloudflare", alias: "main", connectionId: cf.id },
    { provider: "hashicorp/aws", alias: "archive", connectionId: aws.id },
  ]);
  expect(bundle.env).toEqual({
    TF_VAR_cloudflare_main_api_token: "cf-secret-token",
    TF_VAR_aws_archive_access_key: "AKIA_secret_id",
    TF_VAR_aws_archive_secret_key: "aws_secret_key_value",
    TF_VAR_aws_archive_token: "aws_session_token_value",
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
    spaceId: "space_1",
    phase: "plan",
    providers: ["aws"],
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
      providerEnvId: "conn_test000000000001",
      provider: "aws",
      delivery: "provider_env",
      rootOnly: false,
      temporary: true,
      ttlEnforced: true,
      expiresAt: "2026-06-04T01:00:00.000Z",
      ttlSeconds: 3600,
      issuer: "aws_sts_assume_role",
    },
  ]);
  expect(JSON.stringify(response)).not.toContain("source_secret");
});

test("mintForInstallationProviderEnvBindings uses assumed AWS credentials for per-binding TF_VAR mapping", async () => {
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

  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    { provider: "hashicorp/aws", alias: "archive", connectionId: aws.id },
  ]);

  expect(bundle.env).toEqual({
    TF_VAR_aws_archive_access_key: "ASIA_assumed",
    TF_VAR_aws_archive_secret_key: "assumed_secret",
    TF_VAR_aws_archive_token: "assumed_session",
  });
  expect(bundle.providerCredentialEvidence).toEqual([
    {
      connectionId: aws.id,
      providerEnvId: aws.id,
      provider: "aws",
      delivery: "generated_root_variable",
      rootOnly: true,
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
      spaceId: "space_1",
      phase: "plan",
      providers: ["aws"],
    })
    .catch((e) => e);

  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("failed_precondition");
  expect(String(err)).toContain("AccessDenied");
});

test("mintForInstallationProviderEnvBindings re-validates ids: a connection from another space is rejected", async () => {
  const { store, vault } = makeVault();
  const conn = await registerProvider(store, vault); // space_1
  const err = await vault
    .mintForInstallationProviderEnvBindings("space_other", [
      { provider: "cloudflare", alias: "main", connectionId: conn.id },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("belongs to another space");
});

test("mintForInstallationProviderEnvBindings re-validates ids: an unknown connection fails closed", async () => {
  const { store, vault } = makeVault();
  const err = await vault
    .mintForInstallationProviderEnvBindings("space_1", [
      { provider: "cloudflare", alias: "main", connectionId: "conn_missing" },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("not_found");
});

test("mintForInstallationProviderEnvBindings mints an operator connection from any space", async () => {
  const { store, vault } = makeVault();
  const operatorConn = await markVerified(
    store,
    await vault.register({
      provider: "cloudflare",
      authMethod: "static_secret",
      values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
    }),
  );
  const bundle = await vault.mintForInstallationProviderEnvBindings(
    "space_other",
    [{ provider: "cloudflare", alias: "zone", connectionId: operatorConn.id }],
  );
  expect(bundle.env).toEqual({
    TF_VAR_cloudflare_zone_api_token: "operator-cf-token",
  });
});

test("mintForInstallationProviderEnvBindings contributes no TF_VAR for a provider without an arg mapping", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "kubernetes",
      authMethod: "static_secret",
      values: { KUBE_CONFIG_PATH: "/work/.kube/config" },
    }),
  );
  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    { provider: "kubernetes", alias: "main", connectionId: conn.id },
  ]);
  expect(bundle.env).toEqual({});
});

test("mintForInstallationProviderEnvBindings maps approved generic-env variables to root-only TF_VARs", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "registry.opentofu.org/integrations/github",
      authMethod: "static_secret",
      kind: "generic_env_provider",
      values: {
        GITHUB_TOKEN: "github-secret",
      },
    }),
  );

  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    {
      provider: "registry.opentofu.org/integrations/github",
      alias: "main",
      connectionId: conn.id,
    },
  ]);

  expect(bundle.env).toEqual({
    TF_VAR_GITHUB_TOKEN: "github-secret",
  });
  expect(bundle.providerCredentialEvidence[0]?.rootOnly).toBe(true);
});

test("generic-env provider registration accepts arbitrary providers with explicit env names", async () => {
  const { store, vault } = makeVault();
  const provider =
    "registry.opentofu.org/not-a-real-provider/not-a-real-provider";
  const conn = await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider,
      authMethod: "static_secret",
      kind: "generic_env_provider",
      values: { NOT_A_REAL_PROVIDER_TOKEN: "secret" },
    }),
  );

  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    { provider: "not-a-real-provider/not-a-real-provider", connectionId: conn.id },
  ]);

  expect(bundle.env).toEqual({
    TF_VAR_NOT_A_REAL_PROVIDER_TOKEN: "secret",
  });
});

test("generic-env provider registration rejects env names outside the provider allowlist", async () => {
  const { vault } = makeVault();
  await expect(
    vault.register({
      spaceId: "space_1",
      provider: "registry.opentofu.org/integrations/github",
      authMethod: "static_secret",
      kind: "generic_env_provider",
      values: { GITHUB_TOKEN: "github-secret", VERCEL_API_TOKEN: "nope" },
    }),
  ).rejects.toThrow("is not allowed for provider");
});

test("mintForInstallationProviderEnvBindings re-validates InstallationProviderEnvBinding provider before opening values", async () => {
  const { store, vault } = makeVault();
  const conn = await markVerified(
    store,
    await vault.register({
      spaceId: "space_1",
      provider: "registry.opentofu.org/integrations/github",
      authMethod: "static_secret",
      kind: "generic_env_provider",
      values: { GITHUB_TOKEN: "github-secret" },
    }),
  );

  await expect(
    vault.mintForInstallationProviderEnvBindings("space_1", [
      { provider: "cloudflare", alias: "main", connectionId: conn.id },
    ]),
  ).rejects.toThrow(
    /provider registry\.opentofu\.org\/integrations\/github does not match InstallationProviderEnvBinding provider cloudflare/,
  );
});

test("mintForInstallationProviderEnvBindings rejects a git source connection", async () => {
  const { store, vault } = makeVault();
  const git = await registerHttps(store, vault);
  const err = await vault
    .mintForInstallationProviderEnvBindings("space_1", [
      { provider: "source", alias: "git", connectionId: git.id },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("git source connection");
});

test("mintForInstallationProviderEnvBindings is tofu-phase only", async () => {
  const { store, vault } = makeVault();
  const conn = await registerProvider(store, vault);
  await expect(
    vault.mintForInstallationProviderEnvBindings(
      "space_1",
      [{ provider: "cloudflare", alias: "main", connectionId: conn.id }],
      { phase: "build" },
    ),
  ).rejects.toThrow(/tofu-phase only/);
});

test("mintForInstallationProviderEnvBindings bundle never serializes its values", async () => {
  const { store, vault } = makeVault();
  const conn = await registerProvider(store, vault);
  const bundle = await vault.mintForInstallationProviderEnvBindings("space_1", [
    { provider: "cloudflare", alias: "main", connectionId: conn.id },
  ]);
  expect(JSON.stringify(bundle)).not.toContain("cf-secret-token");
  expect(`${bundle}`).not.toContain("cf-secret-token");
});
