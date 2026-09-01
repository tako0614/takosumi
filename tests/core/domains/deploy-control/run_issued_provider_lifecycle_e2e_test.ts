import { expect, test } from "bun:test";

import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  CapsuleModuleVariableMaterializer,
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
  CREDENTIAL_RECIPE_HTTP_ENDPOINT_PUBLIC_INPUT_CAPABILITY,
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
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  createPublicInputReservationLifecycle,
  publicInputClientIdempotencyKey,
  type PublicInputReservationReceipt,
} from "../../../../core/domains/deploy-control/public_input_reservation.ts";

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
const REPOSITORY_INSTALL_UX_DIGEST = `sha256:${"9".repeat(64)}`;
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
    installConfig: {
      workspaceId: WORKSPACE_ID,
      internal: {
        reason: "per_install_overrides",
        sourceSnapshotId: "snap_fixture",
        repositoryInstallUxDigest: REPOSITORY_INSTALL_UX_DIGEST,
        repositoryManifestApiVersion: "takosumi.com/v2.4",
        repositoryHttpEndpointUrlVariable: "app_url",
        repositoryHttpEndpointSubdomainVariable: "project_name",
      },
      variableMapping: { project_name: "young-tree" },
      installExperience: {
        repositoryInstallUx: { status: "accepted" },
        projections: [
          {
            kind: "public_endpoint",
            variables: { url: "app_url", subdomain: "project_name" },
          },
          {
            kind: "oidc_client",
            variables: {
              accountsUrl: "takosumi_accounts_url",
              issuerUrl: "takosumi_accounts_issuer_url",
              clientId: "takosumi_accounts_client_id",
              redirectUri: "takosumi_accounts_redirect_uri",
            },
            callbackPath: "/auth/oidc/callback",
            scopes: ["openid", "profile"],
          },
        ],
      },
    },
  });
  await store.putCapsule({
    ...seeded.capsule,
    installingPrincipalId: INSTALLER_ID,
  });
  await store.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: REPOSITORY_INSTALL_UX_DIGEST,
      document: {
        apiVersion: "takosumi.com/v2.4",
        kind: "Repository",
        install: {
          modules: {
            ".": {
              // Real Yuru contract: app_url exists in HCL but is absent from
              // manifest inputs, so neither the installer nor variableMapping
              // can supply it. Only the reviewed semantic delivery names it.
              inputs: [{
                name: "project_name",
                role: "service_name",
                source: { kind: "capsule_name" },
                type: "string",
                label: { ja: "プロジェクト名", en: "Project name" },
              }],
              requires: [
                {
                  kind: "http.endpoint",
                  deliver: {
                    variables: {
                      url: "app_url",
                      subdomain: "project_name",
                    },
                  },
                },
                {
                  kind: "identity.oidc",
                  callbackPath: "/auth/oidc/callback",
                  scopes: ["openid", "profile"],
                  deliver: {
                    variables: {
                      accountsUrl: "takosumi_accounts_url",
                      issuerUrl: "takosumi_accounts_issuer_url",
                      clientId: "takosumi_accounts_client_id",
                      redirectUri: "takosumi_accounts_redirect_uri",
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  });

  const issuedByRun = new Map<string, string>();
  const issuedRequests: Array<{
    readonly phase: "plan" | "apply" | "destroy";
    readonly lifecycleIntent: "provision" | "destroy";
    readonly runId: string;
    readonly scopes: readonly string[];
  }> = [];
  const lifecycleOrder: string[] = [];
  const publicInputRequests: unknown[] = [];
  const releasedReservationRefs: string[] = [];
  const endpointUrl = "https://echo-a1b2.takoserver.net";
  const reservationRef = "takoserver/reservations/opaque-e2e-ref";
  let failNextRelease = true;
  const driver: CredentialRecipeRuntimeDriver = {
    evidenceIssuer: "generic_run_credential_e2e",
    publicInputCapabilities: [
      CREDENTIAL_RECIPE_HTTP_ENDPOINT_PUBLIC_INPUT_CAPABILITY,
    ],
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
    resolvePublicInputs: async (context) => {
      lifecycleOrder.push(
        context.publicInputRequest.httpEndpointUrl.reservationRef
          ? "reservation:reread"
          : "reservation:reserve",
      );
      expect(context.workspaceId).toBe(WORKSPACE_ID);
      expect(context.connection.workspaceId).toBeUndefined();
      expect(["young-tree", "capacity-b"]).toContain(
        context.publicInputRequest.httpEndpointUrl.requestedSubdomain,
      );
      publicInputRequests.push(context.publicInputRequest);
      return { httpEndpointUrl: endpointUrl, reservationRef };
    },
    releasePublicInputs: async (context) => {
      lifecycleOrder.push("reservation:release");
      expect(context.workspaceId).toBe(WORKSPACE_ID);
      expect(context.publicInputRequest.httpEndpointUrl.reservationRef).toBe(
        reservationRef,
      );
      if (failNextRelease) {
        failNextRelease = false;
        throw new Error("fixture provider release temporarily unavailable");
      }
      releasedReservationRefs.push(reservationRef);
      return { status: "released", reservationRef };
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
        lifecycleIntent: run.lifecycleIntent,
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
        moduleLocalName: "runtime",
        connectionId: CONNECTION_ID,
        runCredentialSettings: RUN_CREDENTIAL_SETTINGS,
      },
    ],
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
  });

  const oidcVariables = {
    takosumi_accounts_url: "https://app.takosumi.com",
    takosumi_accounts_issuer_url: "https://app.takosumi.com",
    takosumi_accounts_client_id: "tko_public_client",
    takosumi_accounts_redirect_uri:
      `${endpointUrl}/auth/oidc/callback`,
  } as const;
  const oidcDigest = await stableJsonDigest({
    contract: "fixture.repository-accounts-oidc-variables/v1",
    variables: oidcVariables,
  });
  const moduleVariableMaterializer: CapsuleModuleVariableMaterializer = {
    async materialize(input) {
      lifecycleOrder.push(`oidc:${input.phase}`);
      expect(input.variables).toEqual({ app_url: endpointUrl });
      if (input.phase !== "plan") {
        expect(input.expectedDigest).toBe(oidcDigest);
        expect(input.plannedVariables).toEqual(oidcVariables);
      }
      return { digest: oidcDigest, variables: oidcVariables };
    },
    async retire() {
      lifecycleOrder.push("oidc:retire");
    },
  };
  const runner = recordingRunner(lifecycleOrder);
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
    moduleVariableMaterializer,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    newId: (prefix) => `${prefix}_e2e_${++nextId}`,
    now: () => now++,
  });

  const createPlan = await controller.createCapsulePlan(CAPSULE_ID);
  expect(createPlan.planRun.status).toBe("succeeded");
  const expectedPlanVariables = {
    project_name: "young-tree",
    app_url: endpointUrl,
    ...oidcVariables,
  };
  expect(createPlan.planRun.variablesDigest).toBe(
    await stableJsonDigest(expectedPlanVariables),
  );
  expect(runner.planJobs[0]?.variables).toEqual(expectedPlanVariables);
  expect(runner.planJobs[0]?.generatedRoot?.files["main.tf"]).toContain(
    `  app_url = "${endpointUrl}"`,
  );
  expect(runner.planJobs[0]?.credentials?.env).not.toHaveProperty(
    "TF_VAR_app_url",
  );
  const createInputs = await store.getPlanRunInputs(createPlan.planRun.id);
  const plannedReservation =
    createInputs?.publicInputReservationDecision?.receipt;
  expect(plannedReservation?.clientIdempotencyKey).toMatch(
    /^endpoint_request_[a-f0-9]{64}$/,
  );
  expect(plannedReservation?.targetVariable).toBe("app_url");
  expect(plannedReservation?.subdomainVariable).toBe(
    "project_name",
  );
  expect(plannedReservation?.requestedSubdomain).toBe(
    "young-tree",
  );
  expect(plannedReservation?.reservationRef).toBe(
    reservationRef,
  );
  expect(plannedReservation?.httpEndpointUrl).toBe(endpointUrl);
  expect(plannedReservation?.digest).toMatch(
    /^sha256:[a-f0-9]{64}$/,
  );
  expect(createInputs?.variables).toEqual(expectedPlanVariables);
  expect(createInputs?.moduleVariableMaterializationDigest).toBe(oidcDigest);
  expect(JSON.stringify(createInputs)).not.toContain(
    issuedByRun.get(createPlan.planRun.id)!,
  );
  expect(JSON.stringify(createInputs)).not.toContain(TOKEN_SECRET);
  const reserveIndex = lifecycleOrder.indexOf("reservation:reserve");
  const oidcPlanIndex = lifecycleOrder.indexOf("oidc:plan");
  const runnerPlanIndex = lifecycleOrder.indexOf("runner:plan");
  expect(reserveIndex).toBeGreaterThanOrEqual(0);
  expect(oidcPlanIndex).toBeGreaterThan(reserveIndex);
  expect(runnerPlanIndex).toBeGreaterThan(oidcPlanIndex);
  const createApply = await controller.createApplyRun({
    planRunId: createPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(createPlan.planRun),
  });
  expect(createApply.applyRun.status).toBe("succeeded");
  expect(runner.applyJobs[0]?.generatedRoot?.files["main.tf"]).toContain(
    `  app_url = "${endpointUrl}"`,
  );
  const appliedLifecycle =
    await store.getCapsulePublicInputReservationRecord(CAPSULE_ID);
  expect(appliedLifecycle).toMatchObject({
    applied: { reservationRef, httpEndpointUrl: endpointUrl },
    retiring: [],
  });
  expect(appliedLifecycle?.candidate).toBeUndefined();

  // The applied lifecycle receipt, not mutable current InstallConfig UX, owns
  // teardown of the old endpoint. Simulate a source/config adoption that no
  // longer advertises http.endpoint and drop the private Plan sidecar; Destroy
  // must still re-read and overlay the exact applied receipt.
  await store.putInstallConfig({
    ...seeded.installConfig,
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: "snap_fixture",
      repositoryInstallUxDigest: REPOSITORY_INSTALL_UX_DIGEST,
      repositoryManifestApiVersion: "takosumi.com/v2.4",
    },
    installExperience: undefined,
  });
  await store.deletePlanRunInputs(createPlan.planRun.id);
  const destroyPlan = await controller.createCapsuleDestroyPlan(CAPSULE_ID);
  expect(destroyPlan.planRun.status).toBe("waiting_approval");
  expect(runner.planJobs[1]?.variables.app_url).toBe(endpointUrl);
  await controller.approveRun(destroyPlan.planRun.id);
  const destroyApply = await controller.createApplyRun({
    planRunId: destroyPlan.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroyPlan.planRun),
  });
  expect(destroyApply.applyRun.status).toBe("succeeded");
  const retiringLifecycle =
    await store.getCapsulePublicInputReservationRecord(CAPSULE_ID);
  expect(retiringLifecycle?.applied).toBeUndefined();
  expect(retiringLifecycle).toMatchObject({
    retiring: [{
      cleanupRunId: destroyApply.applyRun.id,
      receipt: { reservationRef, httpEndpointUrl: endpointUrl },
    }],
  });
  expect(releasedReservationRefs).toEqual([]);

  // The Capsule is already terminal. Queue redelivery retries only the durable
  // lifecycle retirement, accepts typed provider success, then exact-CAS
  // deletes the empty envelope without dispatching destroy a second time.
  const replayedDestroy = await controller.runQueuedApply(
    destroyApply.applyRun.id,
  );
  expect(replayedDestroy.applyRun.status).toBe("succeeded");
  expect(
    await store.getCapsulePublicInputReservationRecord(CAPSULE_ID),
  ).toBeUndefined();
  expect(releasedReservationRefs).toEqual([reservationRef]);

  const clientKeys = publicInputRequests.map((entry) =>
    (entry as {
      httpEndpointUrl: { clientIdempotencyKey: string };
    }).httpEndpointUrl.clientIdempotencyKey
  );
  expect(new Set(clientKeys).size).toBe(1);
  expect(JSON.stringify(publicInputRequests)).not.toMatch(
    /workspace|account|session|capsule|runId|workerName|endpointName|space/u,
  );

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
  expect(
    issuedRequests.map(({ phase, lifecycleIntent, scopes }) => ({
      phase,
      lifecycleIntent,
      scopes,
    })),
  ).toEqual([
    {
      phase: "plan",
      lifecycleIntent: "provision",
      scopes: ["extension:invoke"],
    },
    {
      phase: "apply",
      lifecycleIntent: "provision",
      scopes: ["extension:invoke"],
    },
    {
      phase: "plan",
      lifecycleIntent: "destroy",
      scopes: ["extension:invoke"],
    },
    {
      phase: "destroy",
      lifecycleIntent: "destroy",
      scopes: ["extension:invoke"],
    },
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

  // Capacity boundary proof at the real RunEngine seam. A second Capsule gets
  // an applied A receipt, then 64 durable old retirements and a staged B Plan.
  // Apply must fail before credential mint/provider read/runner dispatch; the
  // provider mutation can therefore never precede an impossible 65th enqueue.
  const capacityCapsuleId = "capsule_run_issued_capacity";
  const capacitySeed = await seedCapsuleModel(store, {
    workspaceId: WORKSPACE_ID,
    capsuleId: capacityCapsuleId,
    sourceId: "source_run_issued_capacity",
    snapshotId: "snapshot_run_issued_capacity",
    installConfigId: "config_run_issued_capacity",
    environment: "preview",
    name: "capacity-app",
    installConfig: {
      workspaceId: WORKSPACE_ID,
      internal: {
        reason: "per_install_overrides",
        sourceSnapshotId: "snapshot_run_issued_capacity",
        repositoryInstallUxDigest: REPOSITORY_INSTALL_UX_DIGEST,
        repositoryManifestApiVersion: "takosumi.com/v2.4",
        repositoryHttpEndpointUrlVariable: "app_url",
        repositoryHttpEndpointSubdomainVariable: "project_name",
      },
      variableMapping: { project_name: "young-tree" },
      installExperience: {
        repositoryInstallUx: { status: "accepted" },
        projections: [{
          kind: "public_endpoint",
          variables: { url: "app_url", subdomain: "project_name" },
        }],
      },
    },
  });
  await store.putCapsule({
    ...capacitySeed.capsule,
    installingPrincipalId: INSTALLER_ID,
  });
  const sourceWithManifest = await store.getSourceSnapshot(seeded.snapshot.id);
  await store.putSourceSnapshot({
    ...capacitySeed.snapshot,
    repositoryManifest: sourceWithManifest?.repositoryManifest,
  });
  await store.putProviderBindingSet({
    id: "provider_bindings_run_issued_capacity",
    workspaceId: WORKSPACE_ID,
    capsuleId: capacityCapsuleId,
    environment: "preview",
    bindings: [{
      provider: PROVIDER,
      moduleLocalName: "runtime",
      connectionId: CONNECTION_ID,
      runCredentialSettings: RUN_CREDENTIAL_SETTINGS,
    }],
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
  });
  const capacityPlanA = await controller.createCapsulePlan(capacityCapsuleId);
  expect(capacityPlanA.planRun.status).toBe("succeeded");
  const capacityApplyA = await controller.createApplyRun({
    planRunId: capacityPlanA.planRun.id,
    expected: applyExpectedGuardFromPlanRun(capacityPlanA.planRun),
  });
  expect(capacityApplyA.applyRun.status).toBe("succeeded");
  const capacityApplied =
    await store.getCapsulePublicInputReservationRecord(capacityCapsuleId);
  const oldRetirements = await Promise.all(
    Array.from({ length: 64 }, (_, index) =>
      capacityRetiredReceipt(capacityApplied!.applied!, index)
    ),
  );
  const capacityFull = await createPublicInputReservationLifecycle({
    applied: capacityApplied!.applied,
    retiring: oldRetirements.map((receipt, index) => ({
      cleanupRunId: `apply_capacity_old_${index}`,
      enqueuedAt: NOW_MS + 10_000 + index,
      receipt,
    })),
  });
  expect(await store.settleCapsulePublicInputReservationLifecycle({
    capsuleId: capacityCapsuleId,
    expectedRecordDigest: capacityApplied!.digest,
    record: capacityFull,
  })).toBe(true);
  await store.putInstallConfig({
    ...capacitySeed.installConfig,
    variableMapping: { project_name: "capacity-b" },
  });
  const capacityPlanB = await controller.createCapsulePlan(capacityCapsuleId);
  expect(capacityPlanB.planRun.status).toBe("succeeded");
  const applyDispatchesBeforeCapacityFence = runner.applyJobs.length;
  const issuedBeforeCapacityFence = issuedRequests.length;
  const publicReadsBeforeCapacityFence = publicInputRequests.length;
  const capacityApplyB = await controller.createApplyRun({
    planRunId: capacityPlanB.planRun.id,
    expected: applyExpectedGuardFromPlanRun(capacityPlanB.planRun),
  });
  expect(capacityApplyB.applyRun.status).toBe("failed");
  expect(capacityApplyB.applyRun.diagnostics?.[0]?.message).toContain(
    "retirement queue is full",
  );
  expect(runner.applyJobs).toHaveLength(applyDispatchesBeforeCapacityFence);
  expect(issuedRequests).toHaveLength(issuedBeforeCapacityFence);
  expect(publicInputRequests).toHaveLength(publicReadsBeforeCapacityFence);
});

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
  readonly destroyJobs: OpenTofuDestroyJob[];
}

function recordingRunner(lifecycleOrder: string[] = []): RecordingRunner {
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
      lifecycleOrder.push("runner:plan");
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
      lifecycleOrder.push("runner:apply");
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
      lifecycleOrder.push("runner:destroy");
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

async function capacityRetiredReceipt(
  base: PublicInputReservationReceipt,
  sequence: number,
): Promise<PublicInputReservationReceipt> {
  const reservationLifecycleNonce =
    `00000000-0000-4000-8000-${String(2_000 + sequence).padStart(12, "0")}`;
  const requestedSubdomain = `capacity-old-${sequence}`;
  const { digest: _digest, ...baseCore } = base;
  void _digest;
  const core = {
    ...baseCore,
    reservationLifecycleNonce,
    clientIdempotencyKey: await publicInputClientIdempotencyKey({
      capsuleId: base.capsuleId,
      targetVariable: base.targetVariable,
      subdomainVariable: base.subdomainVariable,
      requestedSubdomain,
      reservationLifecycleNonce,
    }),
    requestedSubdomain,
    reservationRef: `provider/capacity/old/${sequence}`,
    httpEndpointUrl: `https://capacity-old-${sequence}.example.test`,
  } as const;
  return {
    ...core,
    digest: await stableJsonDigest(core),
  };
}
