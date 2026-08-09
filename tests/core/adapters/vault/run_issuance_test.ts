import { describe, expect, test } from "bun:test";
import type {
  ApplyRun,
  PlanRun,
  ProviderConnection,
} from "@takosumi/internal/deploy-control-api";
import {
  ConnectionVaultError,
  StaticSecretConnectionVault,
} from "../../../../core/adapters/vault/mod.ts";
import type { CredentialRecipeRunCredentialIssuer } from "../../../../core/adapters/vault/driver_ports.ts";
import {
  credentialRecipeDriverKey,
  type CredentialRecipeDriverRunContext,
  type CredentialRecipeIssueRunCredential,
  type CredentialRecipeRuntimeDriver,
} from "@takosumi/providers/types";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const PROVIDER = "registry.example/operator/provider";
const AUDIENCE = "extension.example.v1";
const SCOPES = ["extension:invoke"] as const;
const RUN_ISSUANCE = {
  context: "capsule-run.v1",
  operatorConnection: "workspace-bindable",
  storedMaterial: "none",
  audience: AUDIENCE,
  scopes: SCOPES,
} as const;

describe("Vault run-issued credential recipe", () => {
  test("stores zero material and mints only after canonical Run revalidation", async () => {
    let verifyValues: Readonly<Record<string, string>> | undefined;
    let mintRun: CredentialRecipeDriverRunContext | undefined;
    let retainedIssue: CredentialRecipeIssueRunCredential | undefined;
    let boundIssue:
      | Parameters<CredentialRecipeRunCredentialIssuer>[0]
      | undefined;
    const { store, vault } = fixture(
      {
        evidenceIssuer: "fixture_run_credential",
        verify: async ({ values, files, run, issueRunCredential }) => {
          verifyValues = values;
          expect(files).toEqual([]);
          expect(run).toBeUndefined();
          expect(issueRunCredential).toBeUndefined();
          return { ok: true };
        },
        mint: async (context) => {
          expect(context.values).toEqual({});
          expect(context.files).toEqual([]);
          expect(context.connection).not.toHaveProperty("secretPartition");
          expect(context).not.toHaveProperty("secret");
          expect(context).not.toHaveProperty("claims");
          if (!context.run || !context.issueRunCredential) {
            throw new Error("canonical Run issuer callback missing");
          }
          mintRun = context.run;
          retainedIssue = context.issueRunCredential;
          const issued = await context.issueRunCredential({ ttlSeconds: 600 });
          return {
            env: { RUN_CREDENTIAL_TOKEN: issued.token },
            evidence: {
              connectionId: context.connection.id,
              provider: context.connection.provider,
              temporary: true,
              ttlEnforced: true,
              expiresAt: issued.expiresAt,
              ttlSeconds: issued.ttlSeconds,
              issuer: "fixture_run_credential",
              secretValueStored: false,
            },
          };
        },
      },
      {
        runCredentialIssuer: async (input) => {
          boundIssue = input;
          return {
            token: `signed:${input.request.audience}:${input.run.runId}`,
            expiresAt: "2026-06-04T00:10:00.000Z",
            ttlSeconds: input.request.ttlSeconds ?? 900,
          };
        },
      },
    );

    const connection = await register(vault);
    expect(connection).toMatchObject({
      scope: "operator",
      status: "pending",
      envNames: ["RUN_CREDENTIAL_TOKEN"],
      materialization: "run-issued",
      credentialRecipe: { runIssuance: RUN_ISSUANCE },
    });
    expect(connection).not.toHaveProperty("workspaceId");
    expect(connection).not.toHaveProperty("secretPartition");
    expect(await store.getSecretBlob(connection.id)).toBeUndefined();

    expect(await vault.test(connection.id)).toEqual({ status: "verified" });
    expect(verifyValues).toEqual({});
    const verified = await store.getConnection(connection.id);
    expect(verified?.status).toBe("verified");
    await seedRunningPlan(store);

    const bundle = await vault.mintForCapsuleProviderBindings(
      "workspace_1",
      [{ provider: PROVIDER, connectionId: connection.id }],
      { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
    );
    expect(bundle.env).toEqual({
      RUN_CREDENTIAL_TOKEN: "signed:extension.example.v1:plan_1",
    });
    expect(mintRun).toEqual({
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      runId: "plan_1",
      installingPrincipalId: "principal_installer",
      phase: "plan",
    });
    expect(boundIssue).toEqual({
      connection: verified,
      run: mintRun,
      request: {
        audience: AUDIENCE,
        scopes: SCOPES,
        ttlSeconds: 600,
      },
    });
    expect(bundle.providerCredentialEvidence).toEqual([{
      connectionId: connection.id,
      provider: PROVIDER,
      temporary: true,
      ttlEnforced: true,
      expiresAt: "2026-06-04T00:10:00.000Z",
      ttlSeconds: 600,
      issuer: "fixture_run_credential",
      secretValueStored: false,
    }]);
    expect(await store.getSecretBlob(connection.id)).toBeUndefined();

    await store.putConnection({
      ...verified!,
      providerSource: "registry.example/tampered/provider",
    });
    await expect(
      retainedIssue!({}),
    ).rejects.toThrow(/no longer has the bound Run credential authority/);
    await store.putConnection(verified!);

    await store.putConnection({
      ...verified!,
      credentialRecipe: {
        ...verified!.credentialRecipe!,
        runIssuance: {
          ...RUN_ISSUANCE,
          audience: "unowned.example.v1",
        },
      },
    });
    await expect(
      retainedIssue!({}),
    ).rejects.toThrow(/no longer has the bound Run credential authority/);
    await store.putConnection(verified!);

    const plan = await store.getPlanRun("plan_1");
    await store.putPlanRun({ ...plan!, status: "succeeded" });
    await expect(
      retainedIssue!({}),
    ).rejects.toThrow(/canonical Capsule Run credential context is unavailable/);
  });

  test("requires empty material, operator scope, exact driver, and resolved descriptor", async () => {
    for (const input of [
      { values: { RAW_OPERATOR_SECRET: "must-not-store" } },
      {
        values: {},
        files: [{ path: "token", content: "must-not-store" }],
      },
      { values: {}, workspaceId: "workspace_1", scope: "workspace" as const },
      {
        values: {},
        credentialRecipe: {
          id: "run-issued",
          authMode: "broker",
          runIssuance: RUN_ISSUANCE,
        },
      },
    ]) {
      const { vault } = fixture(validDriver());
      await expect(
        vault.register({
          provider: PROVIDER,
          scope: "operator",
          credentialRecipe: { id: "run-issued", authMode: "broker" },
          ...input,
        }),
      ).rejects.toBeInstanceOf(ConnectionVaultError);
    }

    for (const driver of [
      { verify: validDriver().verify },
      { mint: validDriver().mint },
    ]) {
      const { vault } = fixture(driver);
      await expect(register(vault)).rejects.toThrow(/verify and mint/);
    }
  });

  test("fails closed on unexpected stored material and non-canonical Run state", async () => {
    const { store, vault } = fixture(validDriver());
    const connection = await verifiedConnection(store, vault);
    await seedRunningPlan(store);
    await store.putSecretBlob({
      id: `secret_${connection.id}`,
      connectionId: connection.id,
      kind: "synthetic-unexpected",
      ciphertext: "AA==",
      encryptedDek: "synthetic",
      nonce: "AA==",
      aad: "{}",
      keyVersion: 1,
      createdAt: "2026-06-04T00:00:00.000Z",
    });
    await expect(
      vault.mintForCapsuleProviderBindings(
        "workspace_1",
        [{ provider: PROVIDER, connectionId: connection.id }],
        { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
      ),
    ).rejects.toThrow(/unexpectedly has stored material/);
    await store.deleteSecretBlob(connection.id);

    const plan = await store.getPlanRun("plan_1");
    await store.putPlanRun({ ...plan!, status: "succeeded" });
    await expect(
      vault.mintForCapsuleProviderBindings(
        "workspace_1",
        [{ provider: PROVIDER, connectionId: connection.id }],
        { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
      ),
    ).rejects.toThrow(/plan_run_mismatch/);
  });

  test("rejects driver output outside the pinned env/file declaration", async () => {
    for (const minted of [
      { env: { UNDECLARED: "secret" } },
      {
        env: { RUN_CREDENTIAL_TOKEN: "token" },
        files: [
          {
            path: "/run/credential",
            content: "secret",
            mode: 0o600,
            envName: "UNDECLARED_FILE",
          },
        ],
      },
    ]) {
      const { store, vault } = fixture({
        evidenceIssuer: "fixture_run_credential",
        verify: validDriver().verify,
        mint: async ({ connection }) => ({
          ...minted,
          evidence: {
            connectionId: connection.id,
            provider: connection.provider,
            temporary: true,
            ttlEnforced: true,
            issuer: "fixture",
            secretValueStored: false,
          },
        }),
      });
      const connection = await verifiedConnection(store, vault);
      await seedRunningPlan(store);
      await expect(
        vault.mintForCapsuleProviderBindings(
          "workspace_1",
          [{ provider: PROVIDER, connectionId: connection.id }],
          { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
        ),
      ).rejects.toThrow(/credential driver failed/);
    }
  });

  test("revalidates ApplyRun phase parity and exact installer", async () => {
    const { store, vault } = fixture(validDriver());
    const connection = await verifiedConnection(store, vault);
    await seedRunningPlan(store);
    await store.putApplyRun(applyRun());
    await expect(
      vault.mintForCapsuleProviderBindings(
        "workspace_1",
        [{ provider: PROVIDER, connectionId: connection.id }],
        { phase: "destroy", capsuleId: "capsule_1", runId: "apply_1" },
      ),
    ).rejects.toThrow(/apply_run_mismatch/);

    const capsule = await store.getCapsule("capsule_1");
    await store.putCapsule({
      ...capsule!,
      installingPrincipalId: undefined,
    });
    await expect(
      vault.mintForCapsuleProviderBindings(
        "workspace_1",
        [{ provider: PROVIDER, connectionId: connection.id }],
        { phase: "apply", capsuleId: "capsule_1", runId: "apply_1" },
      ),
    ).rejects.toThrow(/capsule_unavailable/);
  });

  test("does not expose arbitrary claims or mint without the OSS issuer port", async () => {
    const claimInjection = fixture({
      evidenceIssuer: "fixture_run_credential",
      verify: validDriver().verify,
      mint: async (context) => {
        if (!context.issueRunCredential) throw new Error("issuer missing");
        await context.issueRunCredential({
          audience: "attacker.example.v1",
          scopes: ["admin"],
          subject: "caller-controlled-subject",
        } as never);
        throw new Error("claim injection unexpectedly succeeded");
      },
    });
    const injectedConnection = await verifiedConnection(
      claimInjection.store,
      claimInjection.vault,
    );
    await seedRunningPlan(claimInjection.store);
    await expect(
      claimInjection.vault.mintForCapsuleProviderBindings(
        "workspace_1",
        [{ provider: PROVIDER, connectionId: injectedConnection.id }],
        { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
      ),
    ).rejects.toThrow(/credential driver failed/);

    const noIssuer = fixture(validDriver(), { runCredentialIssuer: null });
    const noIssuerConnection = await verifiedConnection(
      noIssuer.store,
      noIssuer.vault,
    );
    await seedRunningPlan(noIssuer.store);
    await expect(
      noIssuer.vault.mintForCapsuleProviderBindings(
        "workspace_1",
        [{ provider: PROVIDER, connectionId: noIssuerConnection.id }],
        { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
      ),
    ).rejects.toThrow(/credential driver failed/);
  });

  test("rejects malformed or lifetime-inconsistent issuer output", async () => {
    for (const issued of [
      {
        token: "token with whitespace",
        expiresAt: "2026-06-04T00:15:00.000Z",
        ttlSeconds: 900,
      },
      {
        token: "synthetic-token",
        expiresAt: "2026-06-04T00:05:00.000Z",
        ttlSeconds: 900,
      },
    ]) {
      const current = fixture(
        {
          evidenceIssuer: "fixture_run_credential",
          verify: async () => ({ ok: true }),
          mint: async (context) => {
            if (!context.issueRunCredential) throw new Error("issuer missing");
            await context.issueRunCredential({});
            throw new Error("malformed issuer output unexpectedly accepted");
          },
        },
        { runCredentialIssuer: async () => issued },
      );
      const connection = await verifiedConnection(current.store, current.vault);
      await seedRunningPlan(current.store);
      await expect(
        current.vault.mintForCapsuleProviderBindings(
          "workspace_1",
          [{ provider: PROVIDER, connectionId: connection.id }],
          { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
        ),
      ).rejects.toThrow(/credential driver failed/);
    }
  });

  test("rejects secret-bearing evidence and sanitizes driver failures", async () => {
    const rawToken = "raw-run-credential-token-that-must-never-leak";
    const issued = {
      token: rawToken,
      expiresAt: "2026-06-04T00:15:00.000Z",
      ttlSeconds: 900,
    } as const;
    for (const driver of [
      {
        evidenceIssuer: "fixture_run_credential",
        verify: async () => ({ ok: true }),
        mint: async (context) => {
          if (!context.issueRunCredential) throw new Error("issuer missing");
          const credential = await context.issueRunCredential({});
          return {
            env: { RUN_CREDENTIAL_TOKEN: credential.token },
            evidence: {
              connectionId: context.connection.id,
              provider: context.connection.provider,
              temporary: true,
              ttlEnforced: true,
              expiresAt: credential.expiresAt,
              ttlSeconds: credential.ttlSeconds,
              issuer: `driver:${credential.token}`,
              secretValueStored: false as const,
            },
          };
        },
      },
      {
        evidenceIssuer: "fixture_run_credential",
        verify: async () => ({ ok: true }),
        mint: async (context) => {
          if (!context.issueRunCredential) throw new Error("issuer missing");
          const credential = await context.issueRunCredential({});
          throw new Error(`driver failed with ${credential.token}`);
        },
      },
    ] satisfies CredentialRecipeRuntimeDriver[]) {
      const current = fixture(driver, {
        runCredentialIssuer: async () => issued,
      });
      const connection = await verifiedConnection(current.store, current.vault);
      await seedRunningPlan(current.store);
      const error = await current.vault
        .mintForCapsuleProviderBindings(
          "workspace_1",
          [{ provider: PROVIDER, connectionId: connection.id }],
          { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
        )
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );
      expect(error).toBeInstanceOf(ConnectionVaultError);
      expect(String(error)).not.toContain(rawToken);
      expect((error as Error).message).toMatch(/credential driver failed/);
    }
  });
});

function fixture(
  driver: CredentialRecipeRuntimeDriver,
  options: {
    readonly runCredentialIssuer?: CredentialRecipeRunCredentialIssuer | null;
  } = {},
): {
  readonly store: InMemoryOpenTofuControlStore;
  readonly vault: StaticSecretConnectionVault;
} {
  const store = new InMemoryOpenTofuControlStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-06-04T00:00:00.000Z"),
    newId: () => "connection_run_issued",
    credentialRecipeResolver: (id) =>
      id === "run-issued"
        ? {
            id,
            displayName: "Run issued credential",
            terraformSource: "*",
            envNames: ["RUN_CREDENTIAL_TOKEN"],
            authModes: {
              broker: {
                preRun: { type: "issue_run_credential" },
                runIssuance: RUN_ISSUANCE,
              },
            },
          }
        : undefined,
    credentialDrivers: {
      [credentialRecipeDriverKey({ id: "run-issued", authMode: "broker" })]:
        driver,
    },
    ...(options.runCredentialIssuer !== null
      ? {
          runCredentialIssuer:
            options.runCredentialIssuer ?? defaultRunCredentialIssuer,
        }
      : {}),
  });
  return { store, vault };
}

const defaultRunCredentialIssuer: CredentialRecipeRunCredentialIssuer = async (
  { request, run },
) => ({
  token: `issued:${run.runId}`,
  expiresAt: "2026-06-04T00:15:00.000Z",
  ttlSeconds: request.ttlSeconds ?? 900,
});

function validDriver(): CredentialRecipeRuntimeDriver {
  return {
    evidenceIssuer: "fixture",
    verify: async () => ({ ok: true }),
    mint: async ({ connection, run }) => ({
      env: { RUN_CREDENTIAL_TOKEN: `issued:${run?.runId}` },
      evidence: {
        connectionId: connection.id,
        provider: connection.provider,
        temporary: true,
        ttlEnforced: true,
        issuer: "fixture",
        secretValueStored: false,
      },
    }),
  };
}

async function register(vault: StaticSecretConnectionVault) {
  return await vault.register({
    provider: PROVIDER,
    scope: "operator",
    credentialRecipe: { id: "run-issued", authMode: "broker" },
    values: {},
  });
}

async function verifiedConnection(
  store: InMemoryOpenTofuControlStore,
  vault: StaticSecretConnectionVault,
): Promise<ProviderConnection> {
  const connection = await register(vault);
  await vault.test(connection.id);
  return (await store.getConnection(connection.id))!;
}

async function seedRunningPlan(
  store: InMemoryOpenTofuControlStore,
): Promise<void> {
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
  });
  await store.putCapsule({
    ...capsule,
    status: "active",
    installingPrincipalId: "principal_installer",
  });
  await store.putPlanRun(planRun());
}

function planRun(): PlanRun {
  return {
    id: "plan_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    capsuleContext: {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      environment: "production",
    },
    source: { kind: "git", url: "https://example.com/app.git", ref: "main" },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [PROVIDER],
    status: "running",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function applyRun(): ApplyRun {
  return {
    id: "apply_1",
    planRunId: "plan_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "running",
    expected: {
      planRunId: "plan_1",
      capsuleId: "capsule_1",
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "managed", ref: "state" },
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}
