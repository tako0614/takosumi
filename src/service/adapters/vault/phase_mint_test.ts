import { expect, test } from "bun:test";

import {
  ConnectionVaultError,
  PhaseMintBundle,
  StaticSecretConnectionVault,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../domains/deploy-control/store.ts";
import { MultiCloudSecretBoundaryCrypto } from "../secret-store/memory.ts";

function makeVault(overrides: { fetch?: typeof fetch } = {}) {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => `conn_test${(counter += 1).toString().padStart(12, "0")}`,
    fetch: overrides.fetch as never,
  });
  return { store, vault };
}

async function registerProvider(vault: StaticSecretConnectionVault) {
  return await vault.register({
    spaceId: "space_1",
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "cf-secret-token" },
  });
}

async function registerHttps(vault: StaticSecretConnectionVault) {
  return await vault.register({
    spaceId: "space_1",
    provider: "source_git_https_token",
    kind: "source_git_https_token",
    authMethod: "static_secret",
    scopeHints: { username: "git-bot" },
    values: { GIT_HTTPS_TOKEN: "ghp_secret_token" },
  });
}

async function registerSsh(vault: StaticSecretConnectionVault) {
  return await vault.register({
    spaceId: "space_1",
    provider: "source_git_ssh_key",
    kind: "source_git_ssh_key",
    authMethod: "static_secret",
    scopeHints: { knownHostsEntry: "github.com ssh-ed25519 AAAAC3Nz..." },
    values: {
      GIT_SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
    },
  });
}

// --- Git connection registration -------------------------------------------

test("registers source_git_https_token with kind and single env", async () => {
  const { vault } = makeVault();
  const conn = await registerHttps(vault);
  expect(conn.kind).toBe("source_git_https_token");
  expect(conn.provider).toBe("source_git_https_token");
  expect(conn.envNames).toEqual(["GIT_HTTPS_TOKEN"]);
  expect(conn.scope).toBe("space");
  expect(conn.scopeHints).toEqual({ username: "git-bot" });
  expect(JSON.stringify(conn)).not.toContain("ghp_secret_token");
});

test("source_git_ssh_key REQUIRES scopeHints.knownHostsEntry", async () => {
  const { vault } = makeVault();
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
  const { vault } = makeVault();
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
  const { vault } = makeVault();
  await registerProvider(vault);
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
  const { vault } = makeVault();
  const conn = await registerHttps(vault);
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
  const { vault } = makeVault();
  const conn = await registerSsh(vault);
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
  const { vault } = makeVault();
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
  const { vault } = makeVault();
  await expect(
    vault.mintForPhase({
      spaceId: "space_1",
      phase: "build",
      providers: ["cloudflare"],
    }),
  ).rejects.toThrow(/build phase must not request/);
  const conn = await registerHttps(vault);
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
  const { vault } = makeVault();
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
    const { vault } = makeVault();
    await registerProvider(vault);
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
    const { vault } = makeVault();
    const conn = await registerHttps(vault);
    await expect(
      vault.mintForPhase({
        spaceId: "space_1",
        phase,
        sourceConnectionId: conn.id,
      }),
    ).rejects.toThrow(/must not request a git source connection/);
  });

  test(`rule: ${phase} phase never selects a git connection for a provider`, async () => {
    const { vault } = makeVault();
    // Only a git connection exists; a provider mint must NOT pick it up.
    await registerHttps(vault);
    await expect(
      vault.mintForPhase({
        spaceId: "space_1",
        phase,
        providers: ["cloudflare"],
      }),
    ).rejects.toThrow(/no connection registered for provider cloudflare/);
  });
}

test("source phase rejects a provider connection passed as sourceConnectionId", async () => {
  const { vault } = makeVault();
  const provider = await registerProvider(vault);
  await expect(
    vault.mintForPhase({
      spaceId: "space_1",
      phase: "source",
      sourceConnectionId: provider.id,
    }),
  ).rejects.toThrow(/not a git source connection/);
});

test("source phase rejects a connection from another space", async () => {
  const { vault } = makeVault();
  const conn = await registerHttps(vault);
  await expect(
    vault.mintForPhase({
      spaceId: "space_2",
      phase: "source",
      sourceConnectionId: conn.id,
    }),
  ).rejects.toThrow(/not found in space space_2/);
});

test("mint (legacy provider path) never selects a git connection", async () => {
  const { vault } = makeVault();
  await registerHttps(vault);
  await expect(vault.mint("space_1", ["cloudflare"])).rejects.toThrow(
    /no connection registered for provider cloudflare/,
  );
});

// --- Operator-scoped connections + capability pool (spec §8 / §9) -----------

test("registers an operator-scoped connection without a space", async () => {
  const { vault } = makeVault();
  const conn = await vault.register({
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
  });
  expect(conn.scope).toBe("operator");
  expect(conn.spaceId).toBeUndefined();
  expect(JSON.stringify(conn)).not.toContain("operator-cf-token");
});

test("capability pool mints an operator connection from any space", async () => {
  const { vault } = makeVault();
  const operatorConn = await vault.register({
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
  });
  // The space itself has NO cloudflare connection: only the resolved
  // capability pool supplies one (operator default, spec §9).
  const bundle = await vault.mintForPhase({
    spaceId: "space_other",
    phase: "plan",
    providers: ["cloudflare"],
    connectionIds: [operatorConn.id],
  });
  expect(bundle.env.CLOUDFLARE_API_TOKEN).toBe("operator-cf-token");
});

test("capability pool rejects a connection from another space", async () => {
  const { vault } = makeVault();
  const spaceConn = await registerProvider(vault); // space_1
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

test("capability pool restricts selection: provider outside the pool fails", async () => {
  const { vault } = makeVault();
  // space_1 HAS a cloudflare connection, but the resolved pool is empty-handed
  // for aws — the mint must not silently fall back to the space-wide pool.
  await registerProvider(vault);
  const gitConn = await registerHttps(vault);
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

// --- §13 per-alias credential mint (mintForCapabilities) --------------------

async function registerAws(vault: StaticSecretConnectionVault) {
  return await vault.register({
    spaceId: "space_1",
    provider: "aws",
    authMethod: "static_secret",
    values: {
      AWS_ACCESS_KEY_ID: "AKIA_secret_id",
      AWS_SECRET_ACCESS_KEY: "aws_secret_key_value",
      AWS_SESSION_TOKEN: "aws_session_token_value",
    },
  });
}

async function registerAwsAssumeRole(vault: StaticSecretConnectionVault) {
  return await vault.register({
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

test("mintForCapabilities maps cloudflare env to TF_VAR_<provider>_<capability>_api_token", async () => {
  const { vault } = makeVault();
  const conn = await registerProvider(vault);
  const bundle = await vault.mintForCapabilities("space_1", [
    { capability: "compute", connectionId: conn.id },
  ]);
  expect(bundle.env).toEqual({
    TF_VAR_cloudflare_compute_api_token: "cf-secret-token",
  });
});

test("mintForCapabilities maps the three aws args and supports multiple capabilities", async () => {
  const { vault } = makeVault();
  const cf = await registerProvider(vault);
  const aws = await registerAws(vault);
  const bundle = await vault.mintForCapabilities("space_1", [
    { capability: "compute", connectionId: cf.id },
    { capability: "storage", connectionId: aws.id },
  ]);
  expect(bundle.env).toEqual({
    TF_VAR_cloudflare_compute_api_token: "cf-secret-token",
    TF_VAR_aws_storage_access_key: "AKIA_secret_id",
    TF_VAR_aws_storage_secret_key: "aws_secret_key_value",
    TF_VAR_aws_storage_token: "aws_session_token_value",
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
  const { vault } = makeVault({ fetch: fakeFetch as never });
  await registerAwsAssumeRole(vault);

  const response = (
    await vault.mintForPhase({
      spaceId: "space_1",
      phase: "plan",
      providers: ["aws"],
    })
  ).toMintResponse();

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
  expect(JSON.stringify(response)).not.toContain("source_secret");
});

test("mintForCapabilities uses assumed AWS credentials for per-alias TF_VAR mapping", async () => {
  const { vault } = makeVault({
    fetch: (() =>
      Promise.resolve(
        new Response(stsSuccessXml(), {
          status: 200,
          headers: { "content-type": "text/xml" },
        }),
      )) as never,
  });
  const aws = await registerAwsAssumeRole(vault);

  const bundle = await vault.mintForCapabilities("space_1", [
    { capability: "storage", connectionId: aws.id },
  ]);

  expect(bundle.env).toEqual({
    TF_VAR_aws_storage_access_key: "ASIA_assumed",
    TF_VAR_aws_storage_secret_key: "assumed_secret",
    TF_VAR_aws_storage_token: "assumed_session",
  });
});

test("aws assume-role mint fails closed when STS rejects the role", async () => {
  const { vault } = makeVault({
    fetch: (() =>
      Promise.resolve(
        new Response(
          "<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>",
          { status: 403, headers: { "content-type": "text/xml" } },
        ),
      )) as never,
  });
  await registerAwsAssumeRole(vault);

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

test("mintForCapabilities re-validates ids: a connection from another space is rejected", async () => {
  const { vault } = makeVault();
  const conn = await registerProvider(vault); // space_1
  const err = await vault
    .mintForCapabilities("space_other", [
      { capability: "compute", connectionId: conn.id },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("belongs to another space");
});

test("mintForCapabilities re-validates ids: an unknown connection fails closed", async () => {
  const { vault } = makeVault();
  const err = await vault
    .mintForCapabilities("space_1", [
      { capability: "compute", connectionId: "conn_missing" },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect((err as ConnectionVaultError).code).toBe("not_found");
});

test("mintForCapabilities mints an operator connection from any space", async () => {
  const { vault } = makeVault();
  const operatorConn = await vault.register({
    provider: "cloudflare",
    authMethod: "static_secret",
    values: { CLOUDFLARE_API_TOKEN: "operator-cf-token" },
  });
  const bundle = await vault.mintForCapabilities("space_other", [
    { capability: "dns", connectionId: operatorConn.id },
  ]);
  expect(bundle.env).toEqual({
    TF_VAR_cloudflare_dns_api_token: "operator-cf-token",
  });
});

test("mintForCapabilities contributes no TF_VAR for a provider without an arg mapping", async () => {
  const { vault } = makeVault();
  const conn = await vault.register({
    spaceId: "space_1",
    provider: "kubernetes",
    authMethod: "static_secret",
    values: { KUBE_CONFIG_PATH: "/work/.kube/config" },
  });
  const bundle = await vault.mintForCapabilities("space_1", [
    { capability: "compute", connectionId: conn.id },
  ]);
  expect(bundle.env).toEqual({});
});

test("mintForCapabilities rejects a git source connection", async () => {
  const { vault } = makeVault();
  const git = await registerHttps(vault);
  const err = await vault
    .mintForCapabilities("space_1", [
      { capability: "source", connectionId: git.id },
    ])
    .catch((e) => e);
  expect(err).toBeInstanceOf(ConnectionVaultError);
  expect(String(err)).toContain("git source connection");
});

test("mintForCapabilities is tofu-phase only", async () => {
  const { vault } = makeVault();
  const conn = await registerProvider(vault);
  await expect(
    vault.mintForCapabilities(
      "space_1",
      [{ capability: "compute", connectionId: conn.id }],
      { phase: "build" },
    ),
  ).rejects.toThrow(/tofu-phase only/);
});

test("mintForCapabilities bundle never serializes its values", async () => {
  const { vault } = makeVault();
  const conn = await registerProvider(vault);
  const bundle = await vault.mintForCapabilities("space_1", [
    { capability: "compute", connectionId: conn.id },
  ]);
  expect(JSON.stringify(bundle)).not.toContain("cf-secret-token");
  expect(`${bundle}`).not.toContain("cf-secret-token");
});
