import { expect, test } from "bun:test";

import type {
  ProviderConnection,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { ResolvedCapsuleProviderBinding } from "../../../../core/domains/connections/mod.ts";
import type { RunCredentials } from "../../../../core/domains/deploy-control/mod.ts";
import {
  type CapsuleRunIdentityIssuer,
  RUN_ENV_REDACTION_PROFILE_ID,
  RunEnvironmentResolutionError,
  RunEnvResolver,
} from "../../../../core/domains/deploy-control/run_env_resolver.ts";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";
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
  readonly capsuleRunIdentity?: CapsuleRunIdentityIssuer;
  readonly calls?: Array<{
    phase: string;
    auditRunId: string;
    context: "opentofu" | "release_command";
  }>;
}): RunEnvResolver {
  return new RunEnvResolver({
    credentials: {
      mintRunCredentials: async (_planRun, phase, auditRunId) => {
        input.calls?.push({ phase, auditRunId, context: "opentofu" });
        return input.credentials();
      },
      mintReleaseCommandCredentials: async (_planRun, phase, auditRunId) => {
        input.calls?.push({ phase, auditRunId, context: "release_command" });
        return input.releaseCredentials?.() ?? input.credentials();
      },
    },
    resolveRunProviderBindings: async () => input.resolved,
    ...(input.capsuleRunIdentity
      ? { capsuleRunIdentity: input.capsuleRunIdentity }
      : {}),
  });
}

test("RunEnvResolver injects least-privilege Capsule run identity only for OpenTofu runs", async () => {
  const minted: Array<{
    workspaceId: string;
    capsuleId: string;
    runId: string;
    mutable: boolean;
  }> = [];
  const subject = resolver({
    resolved: [],
    credentials: () => undefined,
    capsuleRunIdentity: {
      endpoint: "https://operator.example/api",
      mintRunToken: async (input) => {
        minted.push(input);
        return `token-${input.runId}`;
      },
    },
  });

  const planned = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_1",
  });
  const applied = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "apply",
    auditRunId: "apply_1",
  });
  const release = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "apply",
    auditRunId: "release_1",
    credentialContext: "release_command",
  });

  expect(minted).toEqual([
    {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      runId: "plan_1",
      mutable: false,
    },
    {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      runId: "apply_1",
      mutable: true,
    },
  ]);
  expect(planned.credentials?.env).toEqual({
    TAKOSUMI_ENDPOINT: "https://operator.example/api",
    TAKOSUMI_TOKEN: "token-plan_1",
    TAKOSUMI_WORKSPACE_ID: "workspace_1",
    TAKOSUMI_CAPSULE_ID: "capsule_1",
  });
  expect(applied.credentials?.env.TAKOSUMI_TOKEN).toBe("token-apply_1");
  expect(release.credentials).toBeUndefined();
});

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
    credentialContext: "release_command",
  });

  expect(calls).toEqual([
    {
      phase: "apply",
      auditRunId: "release_apply_1",
      context: "release_command",
    },
  ]);
  expect(result.credentials?.env).toEqual({
    CLOUDFLARE_API_TOKEN: "fixture-provider-token",
  });
  expect(result.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
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
