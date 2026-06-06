import { expect, test } from "bun:test";

import {
  ConnectionVaultError,
  PhaseMintBundle,
  StaticSecretConnectionVault,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../domains/deploy-control/store.ts";
import { MultiCloudSecretBoundaryCrypto } from "../secret-store/memory.ts";

function makeVault() {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => `conn_test${(counter += 1).toString().padStart(12, "0")}`,
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
    scope: { username: "git-bot" },
    values: { GIT_HTTPS_TOKEN: "ghp_secret_token" },
  });
}

async function registerSsh(vault: StaticSecretConnectionVault) {
  return await vault.register({
    spaceId: "space_1",
    provider: "source_git_ssh_key",
    kind: "source_git_ssh_key",
    authMethod: "static_secret",
    scope: { knownHostsEntry: "github.com ssh-ed25519 AAAAC3Nz..." },
    values: { GIT_SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n" },
  });
}

// --- Git connection registration -------------------------------------------

test("registers source_git_https_token with kind and single env", async () => {
  const { vault } = makeVault();
  const conn = await registerHttps(vault);
  expect(conn.kind).toBe("source_git_https_token");
  expect(conn.provider).toBe("source_git_https_token");
  expect(conn.envNames).toEqual(["GIT_HTTPS_TOKEN"]);
  expect(conn.scope).toEqual({ username: "git-bot" });
  expect(JSON.stringify(conn)).not.toContain("ghp_secret_token");
});

test("source_git_ssh_key REQUIRES scope.knownHostsEntry", async () => {
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
  expect(response.env.GIT_ASKPASS).toBe("/work/.git-credentials/askpass.sh");
  expect(response.env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(response.files).toHaveLength(1);
  expect(response.files?.[0].path).toBe("/work/.git-credentials/askpass.sh");
  expect(response.files?.[0].mode).toBe(0o700);
  expect(response.files?.[0].content).toContain("ghp_secret_token");
  expect(response.files?.[0].content).toContain("git-bot");
  // The bundle never serializes its values.
  expect(JSON.stringify(bundle)).not.toContain("ghp_secret_token");
});

// Rule 2: source + git ssh connection -> ssh key file + known_hosts, strict.
test("rule 2b: source phase mints ssh git creds with StrictHostKeyChecking=yes", async () => {
  const { vault } = makeVault();
  const conn = await registerSsh(vault);
  const response = (await vault.mintForPhase({
    spaceId: "space_1",
    phase: "source",
    sourceConnectionId: conn.id,
  })).toMintResponse();
  expect(response.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
  expect(response.env.GIT_SSH_COMMAND).not.toContain("StrictHostKeyChecking=no");
  const paths = (response.files ?? []).map((f) => f.path).sort();
  expect(paths).toEqual([
    "/work/.git-credentials/id_source",
    "/work/.git-credentials/known_hosts",
  ]);
  const keyFile = response.files?.find((f) => f.path.endsWith("id_source"));
  expect(keyFile?.mode).toBe(0o600);
  expect(keyFile?.content).toContain("BEGIN OPENSSH PRIVATE KEY");
});

// Rule 3: source + no connection (public repo) -> empty.
test("rule 3: source phase with no connection is empty", async () => {
  const { vault } = makeVault();
  const response = (await vault.mintForPhase({
    spaceId: "space_1",
    phase: "source",
  })).toMintResponse();
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
  const response = (await vault.mintForPhase({
    spaceId: "space_1",
    phase: "build",
  })).toMintResponse();
  expect(response.env).toEqual({});
});

// Rules 6/7/8: plan/apply/destroy -> provider env only, git excluded.
for (const phase of ["plan", "apply", "destroy"] as const) {
  test(`rule: ${phase} phase mints provider env only`, async () => {
    const { vault } = makeVault();
    await registerProvider(vault);
    const response = (await vault.mintForPhase({
      spaceId: "space_1",
      phase,
      providers: ["cloudflare"],
    })).toMintResponse();
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
