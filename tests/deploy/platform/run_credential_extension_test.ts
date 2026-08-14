import { describe, expect, test } from "bun:test";
import { createRunCredentialToken } from "../../../core/shared/run_credential_tokens.ts";
import {
  verifyPlatformExtensionRunCredentialToken,
  verifyPlatformResourceFormTransitionRunCredential,
  type PlatformExtensionRunCredentialLedger,
  type PlatformResourceFormTransitionRunCredentialLedger,
  type PlatformExtensionRoute,
} from "../../../deploy/platform/worker.ts";

const NOW = Date.now();
const SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
const RUN_ISSUANCE = {
  context: "capsule-run.v1",
  operatorConnection: "workspace-bindable",
  storedMaterial: "none",
  audience: "extension.example.v1",
  scopes: ["extension:invoke"],
} as const;
const ROUTE = {
  basePath: "/extensions/run-credential",
  handlerKey: "RUN_EXTENSION",
  authDelivery: "context",
  runCredential: {
    audience: "extension.example.v1",
    requiredScopes: ["extension:invoke"],
  },
} as const satisfies PlatformExtensionRoute;
const TOKEN_INPUT = {
  secret: SIGNING_SECRET,
  audience: "extension.example.v1",
  subject: "token-subject-is-not-authority",
  workspaceId: "workspace_1",
  capsuleId: "capsule_1",
  runId: "apply_1",
  installingPrincipalId: "principal_installer",
  connectionId: "connection_1",
  provider: "registry.example/provider",
  phase: "apply" as const,
  scopes: ["extension:invoke"],
  now: () => NOW,
  jti: "jti_1",
};

describe("platform extension Run credential", () => {
  test("rejects weak verifier configuration before accepting a token", async () => {
    const issued = await createRunCredentialToken(TOKEN_INPUT);
    await expect(
      verifyPlatformExtensionRunCredentialToken(
        { TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: "short-secret" } as never,
        issued.token,
        ROUTE,
        ledger(),
      ),
    ).rejects.toThrow("32-4096 UTF-8 bytes");
  });

  test("returns typed canonical installer context without raw bearer material", async () => {
    const issued = await createRunCredentialToken(TOKEN_INPUT);
    const session = await verifyPlatformExtensionRunCredentialToken(
      { TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: SIGNING_SECRET } as never,
      issued.token,
      ROUTE,
      ledger(),
    );

    expect(session).toEqual({
      authenticated: true,
      authKind: "run-credential",
      subject: "principal_installer",
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      runId: "apply_1",
      installingPrincipalId: "principal_installer",
      phase: "apply",
      audience: "extension.example.v1",
      scopes: ["extension:invoke"],
    });
    expect(JSON.stringify(session)).not.toContain(issued.token);
    expect(session.subject).not.toBe(TOKEN_INPUT.subject);
  });

  test("rejects absent route authority and wrong audience or scope", async () => {
    const issued = await createRunCredentialToken(TOKEN_INPUT);
    const env = {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: SIGNING_SECRET,
    } as never;
    expect(
      await verifyPlatformExtensionRunCredentialToken(
        env,
        issued.token,
        undefined,
        ledger(),
      ),
    ).toEqual({ authenticated: false });
    expect(
      await verifyPlatformExtensionRunCredentialToken(
        env,
        issued.token,
        {
          ...ROUTE,
          runCredential: {
            ...ROUTE.runCredential,
            audience: "other-extension.v1",
          },
        },
        ledger(),
      ),
    ).toEqual({ authenticated: false });
    expect(
      await verifyPlatformExtensionRunCredentialToken(
        env,
        issued.token,
        {
          ...ROUTE,
          runCredential: {
            ...ROUTE.runCredential,
            requiredScopes: ["extension:admin"],
          },
        },
        ledger(),
      ),
    ).toEqual({ authenticated: false });
  });

  test("rejects token scope expansion and route descriptors outside the live recipe authority", async () => {
    const env = {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: SIGNING_SECRET,
    } as never;
    for (const scopes of [
      ["extension:invoke", "extension:extra"],
      ["extension:invoke", "admin"],
    ]) {
      const expanded = await createRunCredentialToken({
        ...TOKEN_INPUT,
        scopes,
        jti: `jti_${scopes.at(-1)}`,
      });
      expect(
        await verifyPlatformExtensionRunCredentialToken(
          env,
          expanded.token,
          ROUTE,
          ledger(),
        ),
      ).toEqual({ authenticated: false });
    }

    const widerIssuance = {
      ...RUN_ISSUANCE,
      scopes: ["extension:invoke", "extension:mutate"],
    } as const;
    const wider = await createRunCredentialToken({
      ...TOKEN_INPUT,
      scopes: widerIssuance.scopes,
      jti: "jti_wider_descriptor",
    });
    expect(
      await verifyPlatformExtensionRunCredentialToken(
        env,
        wider.token,
        ROUTE,
        ledger({
          connection: {
            credentialRecipe: {
              id: "operator-run-credential",
              authMode: "broker",
              preRunAction: "issue_run_credential",
              runIssuance: widerIssuance,
            },
          },
        }),
      ),
    ).toEqual({ authenticated: false });
  });

  test("rejects stale, cross-Workspace, missing-installer, and wrong-phase ledger context", async () => {
    const env = {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: SIGNING_SECRET,
    } as never;
    const issued = await createRunCredentialToken(TOKEN_INPUT);
    for (const currentLedger of [
      ledger({ apply: { status: "succeeded" } }),
      ledger({ capsule: { workspaceId: "workspace_other" } }),
      ledger({ capsule: { installingPrincipalId: undefined } }),
    ]) {
      expect(
        await verifyPlatformExtensionRunCredentialToken(
          env,
          issued.token,
          ROUTE,
          currentLedger,
        ),
      ).toEqual({ authenticated: false });
    }

    const wrongPhase = await createRunCredentialToken({
      ...TOKEN_INPUT,
      phase: "destroy",
      jti: "jti_destroy",
    });
    expect(
      await verifyPlatformExtensionRunCredentialToken(
        env,
        wrongPhase.token,
        ROUTE,
        ledger(),
      ),
    ).toEqual({ authenticated: false });
  });

  test("rechecks durable runtime safety at the platform boundary", async () => {
    const env = {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: SIGNING_SECRET,
    } as never;
    const issued = await createRunCredentialToken(TOKEN_INPUT);
    for (const safety of [
      { phase: "unknown", runId: "restore_1", runType: "restore" },
      {
        phase: "terminating",
        runId: "destroy_apply_other",
        runType: "destroy_apply",
      },
      {
        phase: "retired",
        runId: "destroy_apply_done",
        runType: "destroy_apply",
      },
    ] as const) {
      expect(
        await verifyPlatformExtensionRunCredentialToken(
          env,
          issued.token,
          ROUTE,
          ledger({ safety }),
        ),
      ).toEqual({ authenticated: false });
    }
  });

  test("rechecks the exact live connection authority and zero stored material", async () => {
    const env = {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: SIGNING_SECRET,
    } as never;
    const issued = await createRunCredentialToken(TOKEN_INPUT);
    for (const currentLedger of [
      ledger({ connection: null }),
      ledger({ connection: { provider: "registry.example/other/provider" } }),
      ledger({
        connection: { providerSource: "registry.example/tampered/provider" },
      }),
      ledger({ connection: { status: "revoked" } }),
      ledger({ connection: { credentialRecipe: undefined } }),
      ledger({
        connection: {
          credentialRecipe: {
            id: "operator-run-credential",
            authMode: "broker",
            preRunAction: "issue_run_credential",
            runIssuance: {
              ...RUN_ISSUANCE,
              audience: "unowned.example.v1",
            },
          },
        },
      }),
      ledger({
        connection: { scopeHints: { managedProvider: "legacy-authority" } },
      }),
      ledger({ blob: { partition: "unexpected", sealed: "material" } }),
    ]) {
      expect(
        await verifyPlatformExtensionRunCredentialToken(
          env,
          issued.token,
          ROUTE,
          currentLedger,
        ),
      ).toEqual({ authenticated: false });
    }
  });
});

describe("platform Resource Form transition Run credential", () => {
  test("derives exact audience/scopes and Capsule ownership from current ledgers", async () => {
    const issued = await createRunCredentialToken({
      ...TOKEN_INPUT,
      subject: TOKEN_INPUT.installingPrincipalId,
    });
    const session = await verifyPlatformResourceFormTransitionRunCredential(
      { TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: SIGNING_SECRET } as never,
      issued.token,
      transitionLedger(),
    );
    expect(session).toMatchObject({
      authenticated: true,
      authKind: "run-credential",
      subject: TOKEN_INPUT.installingPrincipalId,
      workspaceId: TOKEN_INPUT.workspaceId,
      capsuleId: TOKEN_INPUT.capsuleId,
      runId: TOKEN_INPUT.runId,
      phase: "apply",
      audience: RUN_ISSUANCE.audience,
      scopes: RUN_ISSUANCE.scopes,
    });
  });

  test("rejects caller claims not bound to the live ProviderBinding/recipe", async () => {
    const env = {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: SIGNING_SECRET,
    } as never;
    const issued = await createRunCredentialToken({
      ...TOKEN_INPUT,
      subject: TOKEN_INPUT.installingPrincipalId,
    });
    for (const current of [
      transitionLedger({ bindingConnectionId: "connection_other" }),
      transitionLedger({ bindingProvider: "registry.example/other/provider" }),
      transitionLedger({ bindingWorkspaceId: "workspace_other" }),
      transitionLedger({ bindingEnvironment: "staging" }),
      transitionLedger({ connection: { status: "revoked" } }),
    ]) {
      expect(
        await verifyPlatformResourceFormTransitionRunCredential(
          env,
          issued.token,
          current,
        ),
      ).toEqual({ authenticated: false });
    }
  });
});

function ledger(
  overrides: {
    readonly capsule?: Record<string, unknown>;
    readonly plan?: Record<string, unknown>;
    readonly apply?: Record<string, unknown>;
    readonly connection?: Record<string, unknown> | null;
    readonly blob?: Record<string, unknown>;
    readonly safety?: Record<string, unknown>;
  } = {},
): PlatformExtensionRunCredentialLedger {
  const capsule = {
    id: "capsule_1",
    workspaceId: "workspace_1",
    installingPrincipalId: "principal_installer",
    status: "active",
    ...overrides.capsule,
  };
  const plan = {
    id: "plan_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    operation: "update",
    status: "running",
    ...overrides.plan,
  };
  const apply = {
    id: "apply_1",
    planRunId: "plan_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    operation: "update",
    status: "running",
    ...overrides.apply,
  };
  const connection = overrides.connection === null
    ? undefined
    : {
        id: TOKEN_INPUT.connectionId,
        provider: TOKEN_INPUT.provider,
        providerSource: TOKEN_INPUT.provider,
        scope: "operator",
        status: "verified",
        envNames: ["RUN_CREDENTIAL_TOKEN"],
        materialization: "run-issued",
        credentialRecipe: {
          id: "operator-run-credential",
          authMode: "broker",
          preRunAction: "issue_run_credential",
          runIssuance: RUN_ISSUANCE,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides.connection,
      };
  return {
    getCapsule: async (id) => (id === capsule.id ? capsule : undefined) as never,
    getPlanRun: async (id) => (id === plan.id ? plan : undefined) as never,
    getApplyRun: async (id) => (id === apply.id ? apply : undefined) as never,
    getCapsuleRuntimeSafety: async () => overrides.safety as never,
    getConnection: async (id) =>
      (id === TOKEN_INPUT.connectionId ? connection : undefined) as never,
    getSecretBlob: async (id) =>
      (id === TOKEN_INPUT.connectionId ? overrides.blob : undefined) as never,
  };
}

function transitionLedger(
  overrides: Parameters<typeof ledger>[0] & {
    readonly bindingConnectionId?: string;
    readonly bindingProvider?: string;
    readonly bindingWorkspaceId?: string;
    readonly bindingEnvironment?: string;
  } = {},
): PlatformResourceFormTransitionRunCredentialLedger {
  const base = ledger({
    ...overrides,
    capsule: { environment: "production", ...overrides.capsule },
  });
  return {
    ...base,
    getProviderBindingSetByCapsule: async () => ({
      id: "bindings_1",
      workspaceId: overrides.bindingWorkspaceId ?? TOKEN_INPUT.workspaceId,
      capsuleId: TOKEN_INPUT.capsuleId,
      environment: overrides.bindingEnvironment ?? "production",
      bindings: [
        {
          provider: overrides.bindingProvider ?? TOKEN_INPUT.provider,
          connectionId:
            overrides.bindingConnectionId ?? TOKEN_INPUT.connectionId,
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  } as PlatformResourceFormTransitionRunCredentialLedger;
}
