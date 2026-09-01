import { expect, test } from "bun:test";

import type {
  ProviderConnection,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import {
  resolvedProviderBindingsDigest,
  type ResolvedCapsuleProviderBinding,
} from "../../../../core/domains/connections/mod.ts";
import type { RunCredentials } from "../../../../core/domains/deploy-control/mod.ts";
import {
  RUN_ENV_REDACTION_PROFILE_ID,
  RunEnvironmentResolutionError,
  RunEnvResolver,
} from "../../../../core/domains/deploy-control/run_env_resolver.ts";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";
const AWS_PROVIDER = "registry.opentofu.org/hashicorp/aws";
const NULL_PROVIDER = "registry.opentofu.org/hashicorp/null";

function planRun(over: Partial<PlanRun> = {}): PlanRun {
  return {
    id: "plan_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    source: {
      kind: "git",
      url: "https://example.com/app.git",
      ref: "main",
      modulePath: "infra",
    },
    sourceDigest: "sha256:src",
    operation: "create",
    runnerProfileId: "opentofu-default",
    capsuleContext: {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      environment: "production",
    },
    variablesDigest: "sha256:vars",
    requiredProviders: [CLOUDFLARE_PROVIDER],
    status: "running",
    policy: { status: "passed", reasons: [], checkedAt: 1000 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function connection(
  over: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "conn_1",
    workspaceId: "workspace_1",
    provider: CLOUDFLARE_PROVIDER,
    providerSource: CLOUDFLARE_PROVIDER,
    kind: "cloudflare_api_token",
    materialization: "secret",
    scope: "workspace",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    credentialRecipe: {
      id: "cloudflare",
      authMode: "api_token",
      terraformSource: CLOUDFLARE_PROVIDER,
      secretPartition: "provider-credentials",
      envNames: ["CLOUDFLARE_API_TOKEN"],
      fileEnvNames: [],
      requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
    },
    secretPartition: "provider-credentials",
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...over,
  };
}

function runCredentials(env: Readonly<Record<string, string>>): RunCredentials {
  return {
    env,
    manifest: {
      bindings: [
        {
          providerSource: CLOUDFLARE_PROVIDER,
          connectionId: "conn_1",
          recipeId: "cloudflare",
          authMode: "api_token",
          envNames: Object.keys(env),
          fileEnvNames: [],
          requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
        },
      ],
    },
  };
}

function resolver(input: {
  readonly resolved: readonly ResolvedCapsuleProviderBinding[] | undefined;
  readonly credentials: () => RunCredentials | undefined;
  readonly releaseCredentials?: () => RunCredentials | undefined;
  readonly calls?: Array<{
    phase: string;
    auditRunId: string;
    credentialRunId?: string;
    context: "opentofu" | "release_command";
  }>;
}): RunEnvResolver {
  return new RunEnvResolver({
    credentials: {
      mintRunCredentials: async (_planRun, phase, auditRunId) => {
        input.calls?.push({ phase, auditRunId, context: "opentofu" });
        return input.credentials();
      },
      mintReleaseCommandCredentials: async (
        _planRun,
        phase,
        auditRunId,
        credentialRunId,
      ) => {
        input.calls?.push({
          phase,
          auditRunId,
          ...(credentialRunId !== auditRunId ? { credentialRunId } : {}),
          context: "release_command",
        });
        return input.releaseCredentials?.() ?? input.credentials();
      },
    },
    resolveRunProviderBindings: async () => input.resolved,
  });
}

test("RunEnvResolver resolves secret Provider Connections without hashing secret values", async () => {
  let secret = "first-secret";
  const calls: Array<{
    phase: string;
    auditRunId: string;
    context: "opentofu" | "release_command";
  }> = [];
  const conn = connection();
  const subject = resolver({
    calls,
    resolved: [
      {
        provider: CLOUDFLARE_PROVIDER,
        materialization: "secret",
        connection: conn,
      },
    ],
    credentials: () => runCredentials({ CLOUDFLARE_API_TOKEN: secret }),
  });

  const first = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_1",
  });
  secret = "second-secret";
  const second = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_1",
  });

  expect(calls).toEqual([
    { phase: "plan", auditRunId: "plan_1", context: "opentofu" },
    { phase: "plan", auditRunId: "plan_1", context: "opentofu" },
  ]);
  expect(first.credentials?.env.CLOUDFLARE_API_TOKEN).toBe("first-secret");
  expect(second.credentials?.env.CLOUDFLARE_API_TOKEN).toBe("second-secret");
  expect(first.runEnvironmentEvidenceDigest).toBe(
    second.runEnvironmentEvidenceDigest,
  );
  expect(first.providerResolutions[0]).toMatchObject({
    status: "resolved_provider_connection",
    connectionId: conn.id,
    materialization: "secret",
    evidence: {
      kind: "provider_connection",
      connectionId: conn.id,
      materialization: "secret",
      requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    },
  });
  expect(first.providerResolutions[0]?.requirement).toMatchObject({
    providerSource: CLOUDFLARE_PROVIDER,
    providerName: "cloudflare",
    modulePath: "infra",
    requiredForPhases: ["plan", "apply"],
  });
  expect(first.redactionProfileId).toBe(RUN_ENV_REDACTION_PROFILE_ID);
  expect(first.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});

test("RunEnvResolver mints provider env for release command context", async () => {
  const calls: Array<{
    phase: string;
    auditRunId: string;
    context: "opentofu" | "release_command";
  }> = [];
  const subject = resolver({
    calls,
    resolved: [
      {
        provider: CLOUDFLARE_PROVIDER,
        materialization: "secret",
        connection: connection(),
      },
    ],
    credentials: () =>
      runCredentials({
        CLOUDFLARE_API_TOKEN: "fixture-provider-token",
      }),
    releaseCredentials: () =>
      runCredentials({
        CLOUDFLARE_API_TOKEN: "fixture-provider-token",
      }),
  });

  const result = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "apply",
    auditRunId: "release_apply_1",
    credentialRunId: "apply_1",
    credentialContext: "release_command",
  });

  expect(calls).toEqual([
    {
      phase: "apply",
      auditRunId: "release_apply_1",
      credentialRunId: "apply_1",
      context: "release_command",
    },
  ]);
  expect(result.credentials?.env).toEqual({
    CLOUDFLARE_API_TOKEN: "fixture-provider-token",
  });
  expect(result.providerConfigurations).toEqual({
    format: "takosumi.provider-configurations@v1",
    providers: [
      {
        provider: CLOUDFLARE_PROVIDER,
        alias: null,
        configuration: {},
      },
    ],
  });
  expect(result.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});

test("RunEnvResolver delivers deterministic alias-aware non-secret provider configurations without minting credentials", async () => {
  const calls: Array<{
    phase: string;
    auditRunId: string;
    context: "opentofu" | "release_command";
  }> = [];
  const cloudflareDefault = connection({
    id: "conn_cf_default",
    scopeHints: {
      providerConfig: {
        retries: 3,
        base_url: "https://api.example.test/client/v4",
      },
    },
  });
  const cloudflareEdge = connection({
    id: "conn_cf_edge",
    scopeHints: {
      providerConfig: {
        request: { timeout_ms: 5000, mode: "strict" },
      },
    },
  });
  const aws = connection({
    id: "conn_aws",
    provider: AWS_PROVIDER,
    providerSource: AWS_PROVIDER,
    kind: "generic_env",
    envNames: ["AWS_REGION"],
    scopeHints: {
      providerConfig: { region: "ap-northeast-1" },
    },
  });
  const resolved: readonly ResolvedCapsuleProviderBinding[] = [
    {
      provider: AWS_PROVIDER,
      materialization: "secret",
      connection: aws,
    },
    {
      provider: CLOUDFLARE_PROVIDER,
      alias: "edge",
      materialization: "secret",
      connection: cloudflareEdge,
    },
    {
      provider: "cloudflare/cloudflare",
      materialization: "secret",
      connection: cloudflareDefault,
    },
  ];
  const subject = resolver({
    calls,
    resolved,
    credentials: () => undefined,
  });

  const result = await subject.resolveRunEnvironment({
    planRun: planRun({
      requiredProviders: [AWS_PROVIDER, CLOUDFLARE_PROVIDER],
    }),
    phase: "apply",
    auditRunId: "release_apply_1",
    credentialContext: "release_command",
    mintCredentials: false,
  });
  const reordered = await resolver({
    resolved: [...resolved].reverse(),
    credentials: () => undefined,
  }).resolveRunEnvironment({
    planRun: planRun({
      requiredProviders: [AWS_PROVIDER, CLOUDFLARE_PROVIDER],
    }),
    phase: "apply",
    auditRunId: "release_apply_1",
    credentialContext: "release_command",
    mintCredentials: false,
  });

  expect(calls).toEqual([]);
  expect(result.credentials).toBeUndefined();
  expect(result.providerConfigurations).toEqual({
    format: "takosumi.provider-configurations@v1",
    providers: [
      {
        provider: CLOUDFLARE_PROVIDER,
        alias: null,
        configuration: {
          base_url: "https://api.example.test/client/v4",
          retries: 3,
        },
      },
      {
        provider: CLOUDFLARE_PROVIDER,
        alias: "edge",
        configuration: {
          request: { mode: "strict", timeout_ms: 5000 },
        },
      },
      {
        provider: AWS_PROVIDER,
        alias: null,
        configuration: { region: "ap-northeast-1" },
      },
    ],
  });
  expect(JSON.stringify(reordered.providerConfigurations)).toBe(
    JSON.stringify(result.providerConfigurations),
  );
  expect(reordered.runEnvironmentEvidenceDigest).toBe(
    result.runEnvironmentEvidenceDigest,
  );
});

test("RunEnvResolver chooses the lexical alias, connection id, and first equal candidate", async () => {
  const resolved: readonly ResolvedCapsuleProviderBinding[] = [
    {
      provider: CLOUDFLARE_PROVIDER,
      alias: "zeta",
      rootAlias: "root-zeta",
      materialization: "secret",
      connection: connection({
        id: "conn_zeta",
        envNames: ["ZETA_TOKEN"],
      }),
    },
    {
      // The shorthand source must still match the fully-qualified requirement.
      provider: "cloudflare/cloudflare",
      alias: "alpha",
      rootAlias: "root-alpha-z",
      materialization: "secret",
      connection: connection({
        id: "conn_z",
        envNames: ["ALPHA_Z_TOKEN"],
      }),
    },
    {
      provider: CLOUDFLARE_PROVIDER,
      alias: "alpha",
      rootAlias: "root-alpha-first",
      materialization: "first-candidate",
      connection: connection({
        id: "conn_a",
        envNames: ["ALPHA_FIRST_TOKEN"],
      }),
    },
    {
      provider: CLOUDFLARE_PROVIDER,
      alias: "alpha",
      rootAlias: "root-alpha-second",
      materialization: "second-candidate",
      connection: connection({
        id: "conn_a",
        envNames: ["ALPHA_SECOND_TOKEN"],
      }),
    },
    {
      provider: CLOUDFLARE_PROVIDER,
      alias: "beta",
      rootAlias: "root-beta",
      materialization: "secret",
      connection: connection({
        id: "conn_0",
        envNames: ["BETA_TOKEN"],
      }),
    },
  ];

  const result = await resolver({
    resolved,
    credentials: () => undefined,
  }).resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_1",
    mintCredentials: false,
  });

  expect(result.providerResolutions).toHaveLength(1);
  expect(result.providerResolutions[0]).toMatchObject({
    connectionId: "conn_a",
    materialization: "first-candidate",
    evidence: {
      provider: CLOUDFLARE_PROVIDER,
      connectionId: "conn_a",
      materialization: "first-candidate",
      requiredEnvNames: ["ALPHA_FIRST_TOKEN"],
    },
  });
});

test("RunEnvResolver orders an absent alias before an empty alias", async () => {
  const resolved: readonly ResolvedCapsuleProviderBinding[] = [
    {
      provider: CLOUDFLARE_PROVIDER,
      alias: "",
      rootAlias: "root-empty",
      materialization: "empty-alias",
      connection: connection({
        id: "conn_a",
        envNames: ["EMPTY_ALIAS_TOKEN"],
      }),
    },
    {
      provider: CLOUDFLARE_PROVIDER,
      rootAlias: "root-absent",
      materialization: "absent-alias",
      connection: connection({
        id: "conn_z",
        envNames: ["ABSENT_ALIAS_TOKEN"],
      }),
    },
  ];

  const result = await resolver({
    resolved,
    credentials: () => undefined,
  }).resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_1",
    mintCredentials: false,
  });

  expect(result.providerResolutions[0]).toMatchObject({
    connectionId: "conn_z",
    materialization: "absent-alias",
    evidence: {
      connectionId: "conn_z",
      materialization: "absent-alias",
      requiredEnvNames: ["ABSENT_ALIAS_TOKEN"],
    },
  });
});

test("RunEnvResolver scans matching bindings without rereading connection ids", async () => {
  const matchCount = 64;
  let connectionIdReads = 0;
  const resolved: readonly ResolvedCapsuleProviderBinding[] = Array.from(
    { length: matchCount },
    (_, index) => {
      const id = `conn_${String(matchCount - index).padStart(3, "0")}`;
      const providerConnection = connection({ id });
      Object.defineProperty(providerConnection, "id", {
        configurable: true,
        enumerable: true,
        get: () => {
          connectionIdReads += 1;
          return id;
        },
      });
      return {
        provider: CLOUDFLARE_PROVIDER,
        alias: "shared",
        rootAlias: `root-${index}`,
        materialization: "secret",
        connection: providerConnection,
      };
    },
  );

  const result = await resolver({
    resolved,
    credentials: () => undefined,
  }).resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_1",
    mintCredentials: false,
  });

  expect(result.providerResolutions[0]?.connectionId).toBe("conn_001");
  // One read per candidate during selection, plus the selected resolution's
  // two id projections. Sorting the candidates rereads ids in its comparator.
  expect(connectionIdReads).toBe(matchCount + 2);
});

test("RunEnvResolver rejects secret-like provider configuration keys and values before lifecycle dispatch", async () => {
  const secretValue = "postgres://user:password@example.test/database";
  for (const providerConfig of [
    { api_token: "must-never-leak" },
    { endpoint: secretValue },
  ]) {
    const subject = resolver({
      resolved: [
        {
          provider: CLOUDFLARE_PROVIDER,
          materialization: "secret",
          connection: connection({ scopeHints: { providerConfig } }),
        },
      ],
      credentials: () => undefined,
    });
    let thrown: unknown;
    try {
      await subject.resolveRunEnvironment({
        planRun: planRun(),
        phase: "destroy",
        auditRunId: "release_destroy_1",
        credentialContext: "release_command",
        mintCredentials: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("secret-like");
    expect((thrown as Error).message).not.toContain(secretValue);
    expect((thrown as Error).message).not.toContain("must-never-leak");
  }
});

test("RunEnvResolver fences lifecycle provider configuration to the reviewed binding digest", async () => {
  const reviewed: readonly ResolvedCapsuleProviderBinding[] = [
    {
      provider: CLOUDFLARE_PROVIDER,
      alias: "main",
      materialization: "secret",
      connection: connection({
        scopeHints: {
          providerConfig: {
            base_url: "https://reviewed.example.test/api",
          },
        },
      }),
    },
  ];
  const live: readonly ResolvedCapsuleProviderBinding[] = [
    {
      ...reviewed[0]!,
      connection: connection({
        scopeHints: {
          providerConfig: {
            base_url: "https://changed.example.test/api",
          },
        },
      }),
    },
  ];
  const subject = resolver({ resolved: live, credentials: () => undefined });

  let thrown: unknown;
  try {
    await subject.resolveRunEnvironment({
      planRun: planRun({
        resolvedProviderBindingsDigest:
          await resolvedProviderBindingsDigest(reviewed),
      }),
      phase: "apply",
      auditRunId: "release_apply_1",
      credentialContext: "release_command",
      mintCredentials: false,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain("resolved_bindings_changed");
  expect((thrown as { details?: { reason?: string } }).details?.reason).toBe(
    "provider_connection_changed",
  );
});

test("RunEnvResolver rejects a missing live binding resolution after Plan review", async () => {
  const reviewed: readonly ResolvedCapsuleProviderBinding[] = [
    {
      provider: CLOUDFLARE_PROVIDER,
      materialization: "secret",
      connection: connection({
        scopeHints: {
          providerConfig: {
            base_url: "https://reviewed.example.test/api",
          },
        },
      }),
    },
  ];
  const subject = resolver({
    resolved: undefined,
    credentials: () => undefined,
  });

  let thrown: unknown;
  try {
    await subject.resolveRunEnvironment({
      planRun: planRun({
        resolvedProviderBindingsDigest:
          await resolvedProviderBindingsDigest(reviewed),
      }),
      phase: "destroy",
      auditRunId: "release_destroy_1",
      credentialContext: "release_command",
      mintCredentials: false,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain("resolved_bindings_changed");
  expect((thrown as { details?: { reason?: string } }).details?.reason).toBe(
    "provider_connection_changed",
  );
});

test("RunEnvResolver treats unresolved Capsule providers as no-credential providers after policy resolution", async () => {
  const calls: Array<{
    phase: string;
    auditRunId: string;
    context: "opentofu" | "release_command";
  }> = [];
  const subject = resolver({
    calls,
    resolved: [],
    credentials: () => undefined,
  });

  const result = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_1",
  });

  expect(calls).toEqual([
    { phase: "plan", auditRunId: "plan_1", context: "opentofu" },
  ]);
  expect(result.credentials).toBeUndefined();
  expect(result.providerResolutions).toEqual([]);
  expect(result.providerConfigurations).toEqual({
    format: "takosumi.provider-configurations@v1",
    providers: [],
  });
  expect(result.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});

test("RunEnvResolver does not require Provider Connections for credential-free providers", async () => {
  const calls: Array<{
    phase: string;
    auditRunId: string;
    context: "opentofu" | "release_command";
  }> = [];
  const subject = resolver({
    calls,
    resolved: [],
    credentials: () => undefined,
  });

  const result = await subject.resolveRunEnvironment({
    planRun: planRun({
      runnerProfileId: "opentofu-default",
      requiredProviders: [NULL_PROVIDER],
    }),
    phase: "plan",
    auditRunId: "plan_1",
  });

  expect(calls).toEqual([
    { phase: "plan", auditRunId: "plan_1", context: "opentofu" },
  ]);
  expect(result.credentials).toBeUndefined();
  expect(result.providerResolutions).toEqual([]);
  expect(result.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});

test("RunEnvResolver fails closed for raw runs without a Capsule or Resource subject", async () => {
  const subject = resolver({
    resolved: undefined,
    credentials: () => undefined,
  });

  let thrown: unknown;
  try {
    await subject.resolveRunEnvironment({
      planRun: planRun({ capsuleId: undefined, capsuleContext: undefined }),
      phase: "plan",
      auditRunId: "plan_1",
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(RunEnvironmentResolutionError);
  const error = thrown as RunEnvironmentResolutionError;
  expect(error.runEnvironment.credentials).toBeUndefined();
  expect(error.runEnvironment.providerResolutions[0]).toMatchObject({
    status: "blocked_missing_connection",
    blockedReason: `capsule provider connection evidence is required for provider ${CLOUDFLARE_PROVIDER}`,
  });
  expect(error.runEnvironment.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});
