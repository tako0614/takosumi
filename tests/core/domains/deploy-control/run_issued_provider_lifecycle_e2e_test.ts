import { expect, test } from "bun:test";

import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  StaticSecretConnectionVault,
} from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type {
  CredentialRecipe,
} from "takosumi-contract/credential-recipes";
import {
  credentialRecipeDriverKey,
  type CredentialRecipeRuntimeDriver,
} from "takosumi-contract/credential-recipe-host";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import {
  createRunCredentialToken,
  verifyRunCredentialToken,
} from "../../../../core/shared/run_credential_tokens.ts";
import {
  FIXTURE_STATE_DIGEST,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";

const WORKSPACE_ID = "workspace_run_issued_e2e";
const CAPSULE_ID = "capsule_run_issued_e2e";
const INSTALLER_ID = "principal_run_issued_installer";
const CONNECTION_ID = "conn_runissued_e2e";
const PROVIDER = "registry.opentofu.org/example/runtime";
const TOKEN_ENV = "GENERIC_RUN_CREDENTIAL";
const AUDIENCE = "extension.example.v1";
const TOKEN_SECRET = "0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-08-09T00:00:00.000Z");
const PLAN_DIGEST = `sha256:${"1".repeat(64)}`;
const LOCK_DIGEST = `sha256:${"2".repeat(64)}`;
const RUN_CREDENTIAL_SETTINGS = {
  reservationId: "res_hosted_e2e",
  resourceName: "bucket-main",
} as const;

const RUN_ISSUED_RECIPE = {
  id: "operator-run-credential",
  displayName: "Operator Run credential",
  terraformSource: "*",
  envNames: [TOKEN_ENV],
  authModes: {
    broker: {
      preRun: { type: "issue_run_credential" },
      runIssuance: {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: AUDIENCE,
        scopes: ["extension:invoke"],
      },
    },
  },
} as const satisfies CredentialRecipe;

/**
 * Cross-layer proof for the generic path:
 * ProviderBinding -> Run resolver -> Vault -> narrow issuer -> runner-only env.
 * It deliberately uses no provider profile, endpoint, or provider-specific
 * token convention.
 */
test("generic run-issued credentials reach plan, apply, and destroy runner dispatch only", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    environment: "preview",
  });
  await store.putCapsule({
    ...seeded.capsule,
    installingPrincipalId: INSTALLER_ID,
  });

  const issuedByRun = new Map<string, string>();
  const issuedRequests: Array<{
    readonly phase: "plan" | "apply" | "destroy";
    readonly runId: string;
    readonly scopes: readonly string[];
  }> = [];
  const driver: CredentialRecipeRuntimeDriver = {
    evidenceIssuer: "generic_run_credential_e2e",
    verify: async ({ values, files, run, issueRunCredential }) => {
      expect(values).toEqual({});
      expect(files).toEqual([]);
      expect(run).toBeUndefined();
      expect(issueRunCredential).toBeUndefined();
      return { ok: true };
    },
    mint: async (context) => {
      if (!context.run || !context.issueRunCredential) {
        throw new Error("canonical Run issuer callback is required");
      }
      expect(context.runCredentialSettings).toEqual(RUN_CREDENTIAL_SETTINGS);
      const issued = await context.issueRunCredential({ ttlSeconds: 600 });
      return {
        env: { [TOKEN_ENV]: issued.token },
        evidence: {
          connectionId: context.connection.id,
          provider: context.connection.provider,
          temporary: true,
          ttlEnforced: true,
          expiresAt: issued.expiresAt,
          ttlSeconds: issued.ttlSeconds,
          issuer: "generic_run_credential_e2e",
          secretValueStored: false,
        },
      };
    },
  };
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "run-issued-e2e-passphrase-0123456789-abcdef",
    }),
    now: () => new Date(NOW_MS),
    newId: () => CONNECTION_ID,
    credentialRecipeResolver: (id) =>
      id === RUN_ISSUED_RECIPE.id ? RUN_ISSUED_RECIPE : undefined,
    credentialDrivers: {
      [credentialRecipeDriverKey({
        id: RUN_ISSUED_RECIPE.id,
        authMode: "broker",
      })]: driver,
    },
    runCredentialIssuer: async ({ connection, run, request }) => {
      issuedRequests.push({
        phase: run.phase,
        runId: run.runId,
        scopes: [...request.scopes],
      });
      const issued = await createRunCredentialToken({
        secret: TOKEN_SECRET,
        audience: request.audience,
        subject: run.installingPrincipalId,
        workspaceId: run.workspaceId,
        capsuleId: run.capsuleId,
        runId: run.runId,
        installingPrincipalId: run.installingPrincipalId,
        connectionId: connection.id,
        provider: connection.provider,
        phase: run.phase,
        scopes: request.scopes,
        ttlSeconds: request.ttlSeconds,
        now: () => NOW_MS,
        jti: `${run.runId}:${run.phase}`,
      });
      issuedByRun.set(run.runId, issued.token);
      return issued;
    },
  });

  const pending = await vault.register({
    provider: PROVIDER,
    scope: "operator",
    credentialRecipe: {
      id: RUN_ISSUED_RECIPE.id,
      authMode: "broker",
    },
    values: {},
  });
  expect(pending.status).toBe("pending");
  expect(await store.getSecretBlob(CONNECTION_ID)).toBeUndefined();
  expect(await vault.test(CONNECTION_ID)).toEqual({ status: "verified" });
  await store.putProviderBindingSet({
    id: "provider_bindings_run_issued_e2e",
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    environment: "preview",
    bindings: [
      {
        provider: PROVIDER,
        connectionId: CONNECTION_ID,
        runCredentialSettings: RUN_CREDENTIAL_SETTINGS,
      },
    ],
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
  });

  const runner = recordingRunner();
  let nextId = 0;
  let now = NOW_MS;
  const controller = new OpenTofuController({
    store,
    runner,
    runnerProfiles: [runnerProfile()],
    defaultRunnerProfileId: runnerProfile().id,
    allowOperatorScopedProviderConnections: true,
    vault,
    credentialRecipes: [RUN_ISSUED_RECIPE],
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    newId: (prefix) => `${prefix}_e2e_${++nextId}`,
    now: () => now++,
  });

  const createPlan = await controller.createCapsulePlan(CAPSULE_ID);
  expect(createPlan.planRun.status).toBe("succeeded");
  const createApply = await controller.createApplyRun({
    planRunId: createPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(createPlan.planRun),
  });
  expect(createApply.applyRun.status).toBe("succeeded");

  const destroyPlan = await controller.createCapsuleDestroyPlan(CAPSULE_ID);
  expect(destroyPlan.planRun.status).toBe("waiting_approval");
  await controller.approveRun(destroyPlan.planRun.id);
  const destroyApply = await controller.createApplyRun({
    planRunId: destroyPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroyPlan.planRun),
  });
  expect(destroyApply.applyRun.status).toBe("succeeded");

  expect(runner.planJobs).toHaveLength(2);
  expect(runner.applyJobs).toHaveLength(1);
  expect(runner.destroyJobs).toHaveLength(1);
  const dispatched = [
    { job: runner.planJobs[0]!, phase: "plan" as const },
    { job: runner.applyJobs[0]!, phase: "apply" as const },
    { job: runner.planJobs[1]!, phase: "plan" as const },
    { job: runner.destroyJobs[0]!, phase: "destroy" as const },
  ];
  for (const { job, phase } of dispatched) {
    const runId = phase === "plan"
      ? job.planRun.id
      : (job as OpenTofuApplyJob | OpenTofuDestroyJob).applyRun.id;
    const token = job.credentials?.env[TOKEN_ENV];
    expect(token).toBe(issuedByRun.get(runId));
    expect(
      await verifyRunCredentialToken(token!, {
        secret: TOKEN_SECRET,
        expectedAudience: AUDIENCE,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedCapsuleId: CAPSULE_ID,
        expectedRunId: runId,
        expectedInstallingPrincipalId: INSTALLER_ID,
        expectedConnectionId: CONNECTION_ID,
        expectedProvider: PROVIDER,
        expectedPhase: phase,
        expectedSubject: INSTALLER_ID,
        requiredScopes: ["extension:invoke"],
        now: () => NOW_MS + 1_000,
      }),
    ).toMatchObject({ ok: true });
  }
  expect(issuedRequests.map(({ phase, scopes }) => ({ phase, scopes }))).toEqual([
    { phase: "plan", scopes: ["extension:invoke"] },
    { phase: "apply", scopes: ["extension:invoke"] },
    { phase: "plan", scopes: ["extension:invoke"] },
    { phase: "destroy", scopes: ["extension:invoke"] },
  ]);

  for (const token of issuedByRun.values()) {
    expect(
      JSON.stringify([
        await store.getPlanRun(createPlan.planRun.id),
        await store.getApplyRun(createApply.applyRun.id),
        await store.getPlanRun(destroyPlan.planRun.id),
        await store.getApplyRun(destroyApply.applyRun.id),
        await store.getConnection(CONNECTION_ID),
      ]),
    ).not.toContain(token);
  }
  expect(await store.getSecretBlob(CONNECTION_ID)).toBeUndefined();
  expect((await store.getCapsule(CAPSULE_ID))?.status).toBe("destroyed");
});

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
  readonly destroyJobs: OpenTofuDestroyJob[];
}

function recordingRunner(): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  const destroyJobs: OpenTofuDestroyJob[] = [];
  const providerInstallation = [{
    provider: PROVIDER,
    mirrored: true,
    installationMethod: "filesystem_mirror" as const,
    attested: true,
    attestationMethod: "forced_filesystem_mirror_init" as const,
    mirrorPath: `/opt/opentofu/provider-mirror/${PROVIDER}`,
  }];
  return {
    planJobs,
    applyJobs,
    destroyJobs,
    plan: async (job): Promise<OpenTofuPlanResult> => {
      planJobs.push(job);
      return {
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: `runner-local://plan/${job.planRun.id}`,
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [PROVIDER],
        providerInstallation,
      };
    },
    apply: async (job) => {
      applyJobs.push(job);
      return {
        outputs: {
          launch_url: {
            sensitive: false,
            value: "https://generic-run-issued.example.test",
          },
        },
        stateDigest: FIXTURE_STATE_DIGEST,
        providerInstallation,
        rawOutputRef: job.rawOutputRef,
      };
    },
    destroy: async (job) => {
      destroyJobs.push(job);
      return { stateDigest: FIXTURE_STATE_DIGEST, providerInstallation };
    },
  };
}

function runnerProfile(): RunnerProfile {
  return {
    id: "generic-run-issued-e2e",
    name: "Generic Run-issued E2E",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: [PROVIDER],
    requireProviderBindings: true,
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    stateLock: { kind: "native" },
    networkPolicy: { mode: "operator-managed" },
    secretExposure: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
    createdAt: NOW_MS,
  };
}
