import { expect, test } from "bun:test";

import type {
  Connection,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { ResolvedInstallationProviderEnvBinding } from "../../../../core/domains/connections/mod.ts";
import type { RunCredentials } from "../../../../core/domains/deploy-control/mod.ts";
import {
  RUN_ENV_REDACTION_PROFILE_ID,
  RunEnvironmentResolutionError,
  RunEnvResolver,
} from "../../../../core/domains/deploy-control/run_env_resolver.ts";

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";
const NULL_PROVIDER = "registry.opentofu.org/hashicorp/null";

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
    providerSource: CLOUDFLARE_PROVIDER,
    kind: "cloudflare_api_token",
    materialization: "secret",
    scope: "space",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...over,
  };
}

function resolver(input: {
  readonly resolved:
    readonly ResolvedInstallationProviderEnvBinding[] | undefined;
  readonly credentials: () => RunCredentials | undefined;
  readonly releaseCredentials?: () => RunCredentials | undefined;
  readonly calls?: Array<{
    phase: string;
    auditRunId: string;
    context: "opentofu" | "release_command";
  }>;
  readonly serviceGrant?: {
    mintServiceGrantEnv(
      planRun: PlanRun,
      phase: "plan" | "apply" | "destroy",
      auditRunId: string,
      consumerOutputs?: Readonly<
        Record<string, import("takosumi-contract").JsonValue>
      >,
    ): Promise<Record<string, string> | undefined>;
  };
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
    resolveRunInstallationProviderEnvBindings: async () => input.resolved,
    ...(input.serviceGrant ? { serviceGrant: input.serviceGrant } : {}),
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
        provider: "cloudflare",
        materialization: "secret",
        connection: conn,
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
    { phase: "plan", auditRunId: "plan_1", context: "opentofu" },
    { phase: "plan", auditRunId: "plan_1", context: "opentofu" },
  ]);
  expect(first.credentials?.CLOUDFLARE_API_TOKEN).toBe("first-secret");
  expect(second.credentials?.CLOUDFLARE_API_TOKEN).toBe("second-secret");
  expect(first.runEnvironmentEvidenceDigest).toBe(
    second.runEnvironmentEvidenceDigest,
  );
  expect(first.providerResolutions[0]).toMatchObject({
    status: "resolved_provider_env",
    envId: conn.id,
    materialization: "secret",
    evidence: {
      kind: "provider_env",
      envId: conn.id,
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

test("RunEnvResolver enriches a discovery plan without re-minting provider credentials", async () => {
  let providerMintCount = 0;
  const subject = resolver({
    resolved: [
      {
        provider: "cloudflare",
        materialization: "secret",
        connection: connection(),
      },
    ],
    credentials: () => {
      providerMintCount += 1;
      return { CLOUDFLARE_API_TOKEN: "provider-value" };
    },
    serviceGrant: {
      mintServiceGrantEnv: async (_run, phase, _audit, outputs) =>
        phase === "plan" && outputs?.app_deployment
          ? {
              TF_VAR_object_storage_access_token: "service-value",
              TF_VAR_object_storage_api_url: "https://storage.example/o",
            }
          : undefined,
    },
  });

  const base = await subject.resolveRunEnvironment({
    planRun: planRun(),
    phase: "plan",
    auditRunId: "plan_1",
  });
  const enriched = await subject.enrichRunEnvironmentWithPlannedServiceGrants({
    planRun: planRun(),
    auditRunId: "plan_1",
    plannedWorkspaceOutputs: {
      app_deployment: { name: "office" },
    },
    base,
  });

  expect(providerMintCount).toBe(1);
  expect(enriched.credentials).toEqual({
    CLOUDFLARE_API_TOKEN: "provider-value",
    TF_VAR_object_storage_access_token: "service-value",
    TF_VAR_object_storage_api_url: "https://storage.example/o",
  });
  expect(enriched.serviceGrantEnvNames).toEqual([
    "TF_VAR_object_storage_access_token",
    "TF_VAR_object_storage_api_url",
  ]);
  expect(enriched.runEnvironmentEvidenceDigest).not.toBe(
    base.runEnvironmentEvidenceDigest,
  );
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
        provider: "cloudflare",
        materialization: "secret",
        connection: connection(),
      },
    ],
    credentials: () => ({
      TF_VAR_cloudflare_main_api_token: "fixture-provider-token",
    }),
    releaseCredentials: () => ({
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
  expect(result.credentials).toEqual({
    CLOUDFLARE_API_TOKEN: "fixture-provider-token",
  });
  expect(result.runEnvironmentEvidenceDigest).toMatch(/^sha256:/);
});

test("RunEnvResolver blocks Cloud-only gateway materialization in OSS", async () => {
  const subject = resolver({
    resolved: [
      {
        provider: "cloudflare",
        connection: connection({ id: "conn_gateway" }),
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

test("RunEnvResolver treats unresolved installation providers as no-credential providers after policy resolution", async () => {
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
      runnerProfileId: "generic-opentofu-provider",
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
