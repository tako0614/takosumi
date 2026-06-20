import { expect, test } from "bun:test";

import type {
  Connection,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { ProviderEnv } from "takosumi-contract/provider-envs";
import type { ResolvedInstallationProviderEnvBinding } from "../../../../core/domains/connections/mod.ts";
import type { RunCredentials } from "../../../../core/domains/deploy-control/mod.ts";
import {
  RUN_ENV_REDACTION_PROFILE_ID,
  RunEnvironmentResolutionError,
  RunEnvResolver,
} from "../../../../core/domains/deploy-control/run_env_resolver.ts";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

function planRun(over: Partial<PlanRun> = {}): PlanRun {
  return {
    id: "plan_1",
    spaceId: "space_1",
    source: {
      kind: "git",
      url: "https://example.com/app.git",
      ref: "main",
      modulePath: "infra",
    },
    sourceDigest: "sha256:src",
    operation: "create",
    runnerProfileId: "cloudflare-default",
    installationContext: {
      spaceId: "space_1",
      installationId: "inst_1",
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

function connection(over: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    spaceId: "space_1",
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    materialization: "secret",
    credentialDriver: "cloudflare_api_token",
    scope: "space",
    authMethod: "api_token",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...over,
  };
}

function providerEnv(over: Partial<ProviderEnv> = {}): ProviderEnv {
  return {
    id: "penv_1",
    spaceId: "space_1",
    providerSource: CLOUDFLARE_PROVIDER,
    displayName: "Cloudflare",
    materialization: "secret",
    status: "ready",
    requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...over,
  };
}

function resolver(input: {
  readonly resolved:
    | readonly ResolvedInstallationProviderEnvBinding[]
    | undefined;
  readonly credentials: () => RunCredentials | undefined;
  readonly calls?: Array<{ phase: string; auditRunId: string }>;
}): RunEnvResolver {
  return new RunEnvResolver({
    credentials: {
      mintRunCredentials: async (_planRun, phase, auditRunId) => {
        input.calls?.push({ phase, auditRunId });
        return input.credentials();
      },
    },
    resolveRunInstallationProviderEnvBindings: async () => input.resolved,
  });
}

test("RunEnvResolver resolves secret Provider Envs without hashing secret values", async () => {
  let secret = "first-secret";
  const calls: Array<{ phase: string; auditRunId: string }> = [];
  const env = providerEnv();
  const subject = resolver({
    calls,
    resolved: [
      {
        provider: "cloudflare",
        env,
        materialization: "secret",
        connection: connection(),
      },
    ],
    credentials: () => ({ CLOUDFLARE_API_TOKEN: secret }),
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
    { phase: "plan", auditRunId: "plan_1" },
    { phase: "plan", auditRunId: "plan_1" },
  ]);
  expect(first.credentials?.CLOUDFLARE_API_TOKEN).toBe("first-secret");
  expect(second.credentials?.CLOUDFLARE_API_TOKEN).toBe("second-secret");
  expect(first.runEnvironmentEvidenceDigest).toBe(
    second.runEnvironmentEvidenceDigest,
  );
  expect(first.providerResolutions[0]).toMatchObject({
    status: "resolved_provider_env",
    envId: env.id,
    materialization: "secret",
    evidence: {
      kind: "provider_env",
      envId: env.id,
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

test("RunEnvResolver blocks Cloud-only gateway Provider Envs in OSS", async () => {
  const env = providerEnv({
    id: "penv_gateway",
    materialization: "gateway" as never,
    requiredEnvNames: [],
  });
  const subject = resolver({
    resolved: [
      {
        provider: "cloudflare",
        env,
        materialization: "gateway" as never,
      },
    ],
    credentials: () => ({ CLOUDFLARE_API_TOKEN: "run-token" }),
  });

  await expect(
    subject.resolveRunEnvironment({
      planRun: planRun({ operation: "destroy" }),
      phase: "destroy",
      auditRunId: "apply_1",
    }),
  ).rejects.toThrow(RunEnvironmentResolutionError);
});

test("RunEnvResolver fails closed with blocked provider resolution evidence", async () => {
  const subject = resolver({
    resolved: [],
    credentials: () => undefined,
  });

  let thrown: unknown;
  try {
    await subject.resolveRunEnvironment({
      planRun: planRun(),
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
    status: "blocked_missing_env",
    blockedReason: `provider connection is required for provider ${CLOUDFLARE_PROVIDER}`,
  });
  expect(error.runEnvironment.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});

test("RunEnvResolver fails closed for raw no-installation runs with providers", async () => {
  const subject = resolver({
    resolved: undefined,
    credentials: () => undefined,
  });

  let thrown: unknown;
  try {
    await subject.resolveRunEnvironment({
      planRun: planRun({ installationContext: undefined }),
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
    status: "blocked_missing_env",
    blockedReason: `installation provider connection evidence is required for provider ${CLOUDFLARE_PROVIDER}`,
  });
  expect(error.runEnvironment.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});
