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

test("RunEnvResolver records the exact required child alias resolution", async () => {
  const subject = resolver({
    resolved: [
      {
        provider: CLOUDFLARE_PROVIDER,
        moduleLocalName: "edge",
        childAlias: "account",
        rootAlias: "root_account",
        materialization: "secret",
        connection: connection({ id: "conn_cf_account" }),
      },
      {
        provider: CLOUDFLARE_PROVIDER,
        moduleLocalName: "edge",
        childAlias: "zone",
        rootAlias: "root_zone",
        materialization: "secret",
        connection: connection({ id: "conn_cf_zone" }),
      },
    ],
    credentials: () => undefined,
  });

  const result = await subject.resolveRunEnvironment({
    planRun: planRun({
      requiredProviderRequirements: [
        {
          source: CLOUDFLARE_PROVIDER,
          moduleLocalName: "edge",
          childAlias: "zone",
          allowed: true,
          credentialRequired: true,
        },
      ],
    }),
    phase: "plan",
    auditRunId: "plan_exact_zone",
  });

  expect(result.providerResolutions).toHaveLength(1);
  expect(result.providerResolutions[0]).toMatchObject({
    connectionId: "conn_cf_zone",
    requirement: {
      providerSource: CLOUDFLARE_PROVIDER,
      providerName: "edge",
      alias: "zone",
    },
    evidence: {
      provider: CLOUDFLARE_PROVIDER,
    },
  });
  expect(result.providerConfigurations).toEqual({
    format: "takosumi.provider-configurations@v1",
    providers: [
      {
        provider: CLOUDFLARE_PROVIDER,
        alias: "root_zone",
        configuration: {},
      },
    ],
  });
});

test("RunEnvResolver rejects same-source child-alias substitution after Plan review", async () => {
  const reviewed: readonly ResolvedCapsuleProviderBinding[] = [
    {
      provider: CLOUDFLARE_PROVIDER,
      moduleLocalName: "edge",
      childAlias: "zone",
      rootAlias: "root_zone",
      materialization: "secret",
      connection: connection({ id: "conn_cf_zone" }),
    },
  ];
  const live: readonly ResolvedCapsuleProviderBinding[] = [
    {
      provider: CLOUDFLARE_PROVIDER,
      moduleLocalName: "edge",
      childAlias: "account",
      rootAlias: "root_account",
      materialization: "secret",
      connection: connection({ id: "conn_cf_account" }),
    },
  ];
  const subject = resolver({ resolved: live, credentials: () => undefined });

  await expect(
    subject.resolveRunEnvironment({
      planRun: planRun({
        requiredProviderRequirements: [
          {
            source: CLOUDFLARE_PROVIDER,
            moduleLocalName: "edge",
            childAlias: "zone",
            allowed: true,
            credentialRequired: true,
          },
        ],
        resolvedProviderBindingsDigest:
          await resolvedProviderBindingsDigest(reviewed),
      }),
      phase: "apply",
      auditRunId: "apply_exact_zone",
    }),
  ).rejects.toMatchObject({
    message: expect.stringContaining("resolved_bindings_changed"),
    details: { reason: "provider_connection_changed" },
  });
});

test("RunEnvResolver never falls back from a present empty exact field", async () => {
  const subject = resolver({ resolved: [], credentials: () => undefined });

  await expect(
    subject.resolveRunEnvironment({
      planRun: planRun({ requiredProviderRequirements: [] }),
      phase: "plan",
      auditRunId: "plan_malformed_empty_exact",
    }),
  ).rejects.toThrow(/do not match requiredProviders/);
});

test("RunEnvResolver distinguishes a pre-field stored row from explicit empty requirements", async () => {
  const subject = resolver({
    resolved: [
      {
        provider: CLOUDFLARE_PROVIDER,
        materialization: "secret",
        connection: connection({ id: "conn_legacy_default" }),
      },
    ],
    credentials: () => undefined,
  });

  const legacy = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_legacy_default",
  });
  const explicitEmpty = await subject.resolveRunEnvironment({
    planRun: planRun({
      requiredProviders: [],
      requiredProviderRequirements: [],
    }),
    phase: "plan",
    auditRunId: "plan_explicit_empty",
  });

  expect(legacy.providerResolutions).toHaveLength(1);
  expect(legacy.providerResolutions[0]?.connectionId).toBe(
    "conn_legacy_default",
  );
  expect(explicitEmpty.providerResolutions).toEqual([]);
  expect(explicitEmpty.providerConfigurations).toEqual({
    format: "takosumi.provider-configurations@v1",
    providers: [],
  });
});

test("RunEnvResolver rejects duplicate exact requirement tuples", async () => {
  const requirement = {
    source: CLOUDFLARE_PROVIDER,
    moduleLocalName: "edge",
    childAlias: "zone",
    allowed: true,
  } as const;
  const subject = resolver({ resolved: [], credentials: () => undefined });

  await expect(
    subject.resolveRunEnvironment({
      planRun: planRun({
        requiredProviderRequirements: [requirement, requirement],
      }),
      phase: "plan",
      auditRunId: "plan_duplicate_exact",
    }),
  ).rejects.toThrow(/duplicate required provider identity/);
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
      moduleLocalName: "aws",
      materialization: "secret",
      connection: aws,
    },
    {
      provider: CLOUDFLARE_PROVIDER,
      moduleLocalName: "cloudflare",
      childAlias: "edge",
      rootAlias: "edge",
      materialization: "secret",
      connection: cloudflareEdge,
    },
    {
      provider: "cloudflare/cloudflare",
      moduleLocalName: "cloudflare",
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
      requiredProviderRequirements: [
        {
          source: AWS_PROVIDER,
          moduleLocalName: "aws",
          allowed: true,
        },
        {
          source: CLOUDFLARE_PROVIDER,
          moduleLocalName: "cloudflare",
          allowed: true,
        },
        {
          source: CLOUDFLARE_PROVIDER,
          moduleLocalName: "cloudflare",
          childAlias: "edge",
          allowed: true,
        },
      ],
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
      requiredProviderRequirements: [
        {
          source: AWS_PROVIDER,
          moduleLocalName: "aws",
          allowed: true,
        },
        {
          source: CLOUDFLARE_PROVIDER,
          moduleLocalName: "cloudflare",
          allowed: true,
        },
        {
          source: CLOUDFLARE_PROVIDER,
          moduleLocalName: "cloudflare",
          childAlias: "edge",
          allowed: true,
        },
      ],
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
      moduleLocalName: "cloudflare",
      rootAlias: "main",
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
        requiredProviderRequirements: [
          {
            source: CLOUDFLARE_PROVIDER,
            moduleLocalName: "cloudflare",
            allowed: true,
          },
        ],
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
    blockedReason: `capsule provider connection evidence is required for provider ${CLOUDFLARE_PROVIDER} (cloudflare default)`,
  });
  expect(error.runEnvironment.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});
