import { expect, test } from "bun:test";
import type {
  OpenTofuRestoreJob,
  OpenTofuRestoreResult,
  OpenTofuRunner,
  OpenTofuRestoreSourceState,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  createDefaultRunnerProfiles,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuControllerError,
  OpenTofuController,
  providerInstallationAuditEvents,
  snapshotModuleSource,
} from "../../../../core/domains/deploy-control/mod.ts";
import type {
  ProviderConnection,
  CreatePlanRunRequest,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import {
  RUN_EXECUTION_EVIDENCE_CONTRACT,
  type RunExecutionEvidence,
} from "takosumi-contract/runs";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  fakeProviderVault,
  fixtureStateCommit,
  providerRequirementsForFixture,
  seedCapsuleModel,
} from "../../../helpers/deploy-control/model_fixture.ts";

const ACTIVE_TEST_RUNNER_PROFILE = {
  executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  lifecycle: { state: "active" },
  availability: { state: "available" },
} as const;

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;
const CLOUDFLARE_PROVIDER =
  "registry.opentofu.org/cloudflare/cloudflare";
const CLOUDFLARE_REQUIREMENTS =
  providerRequirementsForFixture([CLOUDFLARE_PROVIDER]);

/**
 * Capsule-first model setup (spec §5). Seeds Workspace + Source + Snapshot +
 * InstallConfig + Capsule into a freshly constructed store and returns it
 * alongside an `update` plan-run request bound to the seeded Capsule. The
 * Capsule is seeded WITH a current StateVersion so the apply-expected guard is
 * well-formed (an `update` PlanRun carries `capsuleCurrentStateVersionId`; a
 * fresh Capsule has no prior StateVersion to guard against). The store is
 * passed back so the caller can wire it into the controller it constructs.
 */
async function seedUpdatableCapsule(
  options: {
    readonly store?: InMemoryOpenTofuControlStore;
    readonly workspaceId?: string;
    readonly capsuleId?: string;
    readonly source?: CreatePlanRunRequest["source"];
    readonly runnerProfileId?: string;
    readonly requiredProviders?: readonly string[];
    readonly credentialRequired?: boolean;
    readonly seedProviderConnections?: boolean;
  } = {},
): Promise<{
  readonly store: InMemoryOpenTofuControlStore;
  readonly capsuleId: string;
  readonly currentStateVersionId: string;
  readonly request: CreatePlanRunRequest;
}> {
  const store = options.store ?? new InMemoryOpenTofuControlStore();
  const capsuleId = options.capsuleId ?? "cap_fixture";
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: options.workspaceId,
    capsuleId,
  });
  const requiredProviders = options.requiredProviders ?? [
    "registry.opentofu.org/cloudflare/cloudflare",
  ];
  if (options.seedProviderConnections !== false) {
    await seedProviderConnections(store, capsule, requiredProviders);
  }
  const currentStateVersionId = `dep_seed_${capsuleId}`;
  await store.putCapsule({
    ...capsule,
    currentStateVersionId,
    status: "active",
  });
  const request: CreatePlanRunRequest = {
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "update",
    source: options.source ?? SOURCE,
    requiredProviderRequirements:
      options.credentialRequired === undefined
        ? providerRequirementsForFixture(requiredProviders)
        : providerRequirementsForFixture(requiredProviders, {
            credentialRequired: options.credentialRequired,
          }),
    requiredProviders,
    ...(options.runnerProfileId
      ? { runnerProfileId: options.runnerProfileId }
      : {}),
  };
  return { store, capsuleId, currentStateVersionId, request };
}

async function seedProviderConnections(
  store: InMemoryOpenTofuControlStore,
  capsule: {
    readonly id: string;
    readonly workspaceId: string;
    readonly environment: string;
  },
  requiredProviders: readonly string[],
): Promise<void> {
  if (requiredProviders.length === 0) return;
  const now = "2026-06-06T00:00:00.000Z";
  const bindings = requiredProviders.map((provider) => {
    const shortName = providerShortName(provider);
    const connectionId = `conn_seed_${shortName}`;
    const connection: ProviderConnection = {
      id: connectionId,
      workspaceId: capsule.workspaceId,
      provider,
      providerSource: provider,
      credentialRecipe: {
        id: "generic-env",
        authMode: "env",
        secretPartition: "provider-credentials",
      },
      secretPartition: "provider-credentials",
      scope: "workspace",
      status: "verified",
      materialization: "secret",
      envNames: providerEnvNames(shortName),
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    return {
      providerSource: provider,
      connection,
      binding: {
        provider,
        moduleLocalName: shortName,
        rootAlias: "main",
        connectionId,
      },
    };
  });
  for (const { connection } of bindings) {
    await store.putConnection(connection);
  }
  await store.putProviderBindingSet({
    id: `ipcset_seed_${capsule.id}`,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    bindings: bindings.map((entry) => entry.binding),
    createdAt: now,
    updatedAt: now,
  });
}

function providerShortName(provider: string): string {
  if (provider.includes("/cloudflare/")) return "cloudflare";
  if (provider.includes("/hashicorp/aws")) return "aws";
  if (provider.includes("/hashicorp/google")) return "google";
  if (provider.includes("/integrations/github")) return "github";
  if (provider.includes("/hashicorp/kubernetes")) return "kubernetes";
  return provider;
}

function providerEnvNames(provider: string): readonly string[] {
  switch (provider) {
    case "cloudflare":
      return ["CLOUDFLARE_API_TOKEN"];
    case "aws":
      return ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"];
    case "google":
      return ["GOOGLE_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"];
    case "github":
      return ["GITHUB_TOKEN"];
    case "kubernetes":
      return ["KUBE_CONFIG_PATH"];
    default:
      return ["PROVIDER_TOKEN"];
  }
}

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const TEST_EXECUTION_EVIDENCE_AUTHORITY = {
  controllerArtifact: { digest: `sha256:${"a".repeat(64)}`, immutable: true },
  runnerArtifact: { digest: `sha256:${"b".repeat(64)}`, immutable: true },
  executorArtifact: { digest: `sha256:${"c".repeat(64)}`, immutable: true },
} as const;

function restoreAck(
  job: OpenTofuRestoreJob,
  digest = PLAN_DIGEST,
): OpenTofuRestoreResult {
  return {
    state: {
      generation: job.stateScope.generation,
      stateRef: `runner-local://restore/${job.runId}`,
      logicalTargetStateRef: job.stateScope.stateRef,
      digest,
      runId: job.runId,
      ciphertextLength: 0,
      restoreAuthority: {
        kind: "takosumi.runner-restore-ack@v1",
        version: 1,
        fence: 1,
        operationId: `test-restore:${job.runId}`,
        stateEtag: digest,
      },
    },
  };
}
const CLOUDFLARE_MIRROR_EVIDENCE = {
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
  installedDigest: `sha256:${"e".repeat(64)}`,
} as const;
const AWS_MIRROR_EVIDENCE = {
  provider: "registry.opentofu.org/hashicorp/aws",
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/hashicorp/aws",
  installedDigest: `sha256:${"e".repeat(64)}`,
} as const;

test("apply and destroy audit construction rejects live builtin provider installation evidence", () => {
  const builtinEvidence = [
    {
      provider: "terraform.io/builtin/terraform",
      mirrored: false,
      installationMethod: "unknown" as const,
    },
  ];

  for (const phase of ["apply", "destroy"] as const) {
    expect(() =>
      providerInstallationAuditEvents(
        `${phase}_builtin_evidence`,
        phase,
        1,
        builtinEvidence,
        { requireMirror: false },
      )
    ).toThrow(
      /live provider installation evidence cannot target OpenTofu builtin runtime capability terraform\.io\/builtin\/terraform/,
    );
  }
});

async function seedRestoreFixture(
  store: InMemoryOpenTofuControlStore,
  suffix: string,
) {
  const capsuleId = `inst_restore_${suffix}`;
  const { capsule } = await seedCapsuleModel(store, {
    capsuleId,
  });
  const stateId = `state_restore_${suffix}`;
  const backupId = `bkp_restore_${suffix}`;
  await store.putStateVersion({
    id: stateId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: `states/${suffix}/1.tfstate.enc`,
    digest: LOCK_DIGEST,
    createdByRunId: `apply_restore_${suffix}`,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: backupId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    ref: `workspaces/${capsule.workspaceId}/backups/${backupId}/control.json.zst.enc`,
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    ...capsule,
    status: "destroyed",
    currentStateGeneration: 2,
    updatedAt: "2026-06-06T00:00:01.000Z",
  });
  return { capsule, backupId };
}

test("plan run stays queued when no OpenTofu runner is injected", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: () => 1,
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.id).toEqual("plan_0001");
  expect(planRun.status).toEqual("queued");
  expect(planRun.policy.status).toEqual("passed");
});

test("PlanRun stores variable digest without retaining variable values", async () => {
  let runnerVariables: Readonly<Record<string, unknown>> | undefined;
  const { store, request } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(2),
    newId: deterministicIds(),
    runner: {
      plan: (job) => {
        runnerVariables = job.variables;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("variables"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun({
    ...request,
    variables: {
      account_id: "acct_123",
      token: "super-secret-plan-token",
    },
  });
  const persisted = await controller.getPlanRun(planRun.id);
  const payload = JSON.stringify({
    create: planRun,
    get: persisted.planRun,
  });

  expect(runnerVariables).toEqual({
    account_id: "acct_123",
    token: "super-secret-plan-token",
  });
  expect(planRun.variablesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect("variables" in planRun).toEqual(false);
  expect("variables" in persisted.planRun).toEqual(false);
  expect(payload).not.toContain("super-secret-plan-token");
  expect(payload).not.toContain("acct_123");
  const sidecar = await store.getPlanRunInputs(planRun.id);
  expect(sidecar?.generatedRoot?.files["main.tf"]).toContain('module "child"');
  expect(sidecar?.generatedRoot?.files["main.tf"]).toContain(
    'source = "./module"',
  );
});

test("RunEngine translates rootgen validation at its runtime boundary", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const [connection] = await store.listConnections(request.workspaceId!);
  if (!connection) throw new Error("seeded Provider Connection missing");
  // Persist a historical/bypassed row whose non-secret provider configuration
  // collides with rootgen's owned alias field. The runtime boundary must retain
  // the controller's public invalid_argument semantics if such a row survives.
  await store.putConnection({
    ...connection,
    scopeHints: { providerConfig: { alias: "forbidden" } },
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: () => 1,
    newId: deterministicIds(),
  });

  let thrown: unknown;
  try {
    await controller.createPlanRun(request);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(OpenTofuControllerError);
  expect(thrown).toMatchObject({
    code: "invalid_argument",
    details: { reason: "rootgen_provider_configuration_alias_override" },
  });
});

test("legacy stored builtin ProviderBinding cannot become a new Capsule Plan requirement", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store);
  const builtinProvider = "terraform.io/builtin/terraform";
  const now = "2026-06-06T00:00:00.000Z";
  await store.putConnection({
    id: "conn_legacy_builtin",
    workspaceId: capsule.workspaceId,
    provider: builtinProvider,
    providerSource: builtinProvider,
    credentialRecipe: {
      id: "legacy-builtin-env",
      authMode: "env",
      secretPartition: "provider-credentials",
    },
    secretPartition: "provider-credentials",
    kind: "generic",
    scope: "workspace",
    status: "verified",
    materialization: "secret",
    envNames: ["BUILTIN_CREDENTIAL_MUST_NOT_BE_EXPOSED"],
    createdAt: now,
    updatedAt: now,
  });
  const bindingSet = {
    id: "ipcset_legacy_builtin",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    bindings: [
      {
        provider: builtinProvider,
        connectionId: "conn_legacy_builtin",
      },
    ],
    createdAt: now,
    updatedAt: now,
  } as const;
  await store.putProviderBindingSet(bindingSet);
  let credentialMintCalls = 0;
  let runnerPlanCalls = 0;
  const providerVault = fakeProviderVault({
    provider: builtinProvider,
    connectionId: "conn_legacy_builtin",
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    store,
    vault: {
      ...providerVault,
      mintForCapsuleProviderBindings: (...args) => {
        credentialMintCalls += 1;
        return providerVault.mintForCapsuleProviderBindings(...args);
      },
    } as never,
    now: () => 1,
    newId: deterministicIds(),
    runner: {
      plan: () => {
        runnerPlanCalls += 1;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("legacy-builtin"),
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  await expect(controller.createCapsulePlan(capsule.id)).rejects.toThrow(
    /stored ProviderBinding cannot target OpenTofu builtin runtime capability/,
  );
  expect(credentialMintCalls).toBe(0);
  expect(runnerPlanCalls).toBe(0);
  expect(
    await store.getProviderBindingSetByCapsule(
      capsule.id,
      capsule.environment,
    ),
  ).toEqual(bindingSet);
});

test("plan/apply records Capsule, StateVersion, and explicitly allowlisted Output", async () => {
  const { store, request, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(10),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: fakeRunner(),
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.planDigest).toEqual(PLAN_DIGEST);

  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const stateVersion = await store.getStateVersion(
    applied.applyRun.stateVersionId!,
  );
  const output = await store.getOutput(applied.applyRun.outputId!);

  // A successful apply advances the Capsule cursor and records canonical
  // StateVersion + Output rows. Sensitive values never enter publicOutputs.
  expect(applied.applyRun.status).toEqual("succeeded");
  expect(applied.capsule?.id).toEqual(capsuleId);
  expect(applied.capsule?.status).toEqual("active");
  expect(applied.capsule?.currentStateVersionId).toEqual(stateVersion!.id);
  expect(applied.capsule?.currentStateGeneration).toEqual(1);
  expect(stateVersion?.capsuleId).toEqual(capsuleId);
  expect(stateVersion?.generation).toEqual(1);
  expect(output?.capsuleId).toEqual(capsuleId);
  expect(output?.stateGeneration).toEqual(1);
  expect(output?.publicOutputs).toEqual({
    launch_url: "https://app.example.test",
  });
  expect(applied.applyRun.stateBackend.kind).toEqual("operator-managed");
  expect(applied.applyRun.stateLock.status).toEqual("recorded");
  expect(applied.applyRun.stateLock.backendRef).toEqual(
    "state://takosumi/opentofu-default",
  );
  expect(output?.workspaceOutputs.secret_value).toBeUndefined();
  expect(applied.applyRun.auditEvents.map((event) => event.type)).toContain(
    "apply.completed",
  );

  const stateVersions = await controller.listStateVersions(applied.capsule!.id);
  expect(stateVersions.stateVersions.map((version) => version.id)).toContain(
    stateVersion!.id,
  );
});

test("a new successful apply without execution evidence fails closed before ledger commit", async () => {
  const { store, request, capsuleId, currentStateVersionId } =
    await seedUpdatableCapsule();
  const baseRunner = fakeRunner();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(10),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: {
      ...baseRunner,
      apply: (job) =>
        Promise.resolve(
          fixtureStateCommit({
            rawOutputRef: job.rawOutputRef,
            // Deliberately omit executionEvidence: a newly terminal success
            // cannot be claimed without the runner's durable receipt.
          }),
        ),
    },
  });

  const { planRun } = await controller.createPlanRun(request);
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const capsule = await store.getCapsule(capsuleId);

  expect(applied.applyRun.status).toBe("failed");
  expect(applied.applyRun.diagnostics?.[0]?.code).toBe(
    "execution_evidence_missing",
  );
  expect(capsule?.currentStateVersionId).toBe(currentStateVersionId);
  expect(capsule?.currentStateGeneration).toBe(0);
  expect(applied.applyRun.stateVersionId).toBeUndefined();
  expect(applied.applyRun.outputId).toBeUndefined();
});

test("apply rejects live builtin provider installation evidence before audit or state persistence", async () => {
  const { store, request, capsuleId, currentStateVersionId } =
    await seedUpdatableCapsule();
  const baseRunner = fakeRunner();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(10),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: {
      ...baseRunner,
      apply: (job) =>
        Promise.resolve(
          fixtureStateCommit({
            rawOutputRef: job.rawOutputRef,
            executionEvidence: executionEvidenceForJob(job, "apply"),
            providerInstallation: [
              {
                provider: "terraform.io/builtin/terraform",
                mirrored: false,
                installationMethod: "unknown" as const,
              },
            ],
          }),
        ),
    },
  });

  const { planRun } = await controller.createPlanRun(request);
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const capsule = await store.getCapsule(capsuleId);

  expect(applied.applyRun.status).toBe("failed");
  expect(applied.applyRun.diagnostics?.[0]?.message).toContain(
    "live provider installation evidence cannot target OpenTofu builtin runtime capability",
  );
  expect(applied.applyRun.auditEvents.map((event) => event.type)).not.toContain(
    "apply.provider_installation_evaluated",
  );
  expect(capsule?.currentStateVersionId).toBe(currentStateVersionId);
  expect(capsule?.status).toBe("active");
});

test("apply treats former runtime declaration names as ordinary allowlisted Outputs", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const installConfig = await store.getInstallConfig("cfg_fixture");
  await store.putInstallConfig({
    ...installConfig!,
    outputAllowlist: {
      ...installConfig!.outputAllowlist,
      service_exports: { from: "service_exports", type: "json" },
      service_bindings: { from: "service_bindings", type: "json" },
    },
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(40),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: fakeRunner({
      launch_url: {
        sensitive: false,
        value: "https://app.example.test",
      },
      service_exports: {
        sensitive: false,
        value: { opaque: "exports" },
      },
      service_bindings: {
        sensitive: false,
        value: { opaque: "bindings" },
      },
    }),
  });

  const { planRun } = await controller.createPlanRun(request);
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const output = await store.getOutput(applied.applyRun.outputId!);
  expect(output?.publicOutputs).toEqual({
    launch_url: "https://app.example.test",
    service_bindings: { opaque: "bindings" },
    service_exports: { opaque: "exports" },
  });
});

test("apply treats app_deployment as an ordinary allowlisted Output", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const installConfig = await store.getInstallConfig("cfg_fixture");
  await store.putInstallConfig({
    ...installConfig!,
    outputAllowlist: {
      ...installConfig!.outputAllowlist,
      app_deployment: { from: "app_deployment", type: "json" },
    },
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(50),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: fakeRunner({
      launch_url: {
        sensitive: false,
        value: "https://app.example.test",
      },
      app_deployment: {
        sensitive: false,
        value: {
          name: "yurucommu",
          version: "2.0.0",
          compute: {
            web: {
              kind: "worker",
              consume: [
                {
                  publication: "identity.oidc",
                  inject: {
                    env: {
                      issuerUrl: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
                      clientId: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
                    },
                  },
                },
              ],
            },
          },
          publish: [
            {
              name: "launcher",
              publisher: "web",
              type: "UiSurface",
              outputs: { url: { kind: "url", routeRef: "root" } },
              display: { title: "Yurucommu" },
              spec: { launcher: true },
            },
          ],
        },
      },
    }),
  });

  const { planRun } = await controller.createPlanRun(request);
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const output = await store.getOutput(applied.applyRun.outputId!);
  expect(output?.publicOutputs).toEqual({
    app_deployment: {
      name: "yurucommu",
      version: "2.0.0",
      compute: {
        web: {
          kind: "worker",
          consume: [
            {
              publication: "identity.oidc",
              inject: {
                env: {
                  issuerUrl: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
                  clientId: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
                },
              },
            },
          ],
        },
      },
      publish: [
        {
          name: "launcher",
          publisher: "web",
          type: "UiSurface",
          outputs: { url: { kind: "url", routeRef: "root" } },
          display: { title: "Yurucommu" },
          spec: { launcher: true },
        },
      ],
    },
    launch_url: "https://app.example.test",
  });
});

test("PlanRun rejects capsule operations outside the requested space", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule({
    workspaceId: "workspace_a",
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(20),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_b",
      capsuleId,
      operation: "update",
      source: SOURCE,
      requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/capsule is not available to this workspace/);
});

test("PlanRun requires an existing Capsule regardless of operation", async () => {
  // Capsule-first model (spec §5): every plan / destroy plan targets an
  // existing Capsule row. A raw createPlanRun with no capsuleId is a
  // failed_precondition for any operation; the create-on-apply legacy path is
  // removed.
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    now: sequenceNow(30),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      operation: "update",
      source: SOURCE,
      requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/plan requires an existing capsuleId/);

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      operation: "destroy",
      source: SOURCE,
      requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/plan requires an existing capsuleId/);

  // A missing capsuleId target is a typed not_found (the id is consulted
  // before any operation-specific handling).
  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      capsuleId: "inst_missing",
      operation: "update",
      source: SOURCE,
      requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toMatchObject({
    name: "OpenTofuControllerError",
    code: "not_found",
  });
});

test("update and destroy PlanRuns stay bound to the targeted Capsule", async () => {
  // The Workspace-direct Capsule no longer carries a `source` identity or a
  // `runnerProfileId` (those are resolved through the InstallConfig / Source), so
  // the binding the run preserves is the Capsule + its current StateVersion
  // cursor: an update / destroy plan records the capsuleId, the operation,
  // and the Capsule's current StateVersion as the apply guard.
  const { store, capsuleId, currentStateVersionId } =
    await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(60),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  const { planRun: updatePlan } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    operation: "update",
    source: { ...SOURCE, ref: "release-2" },
    requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  expect(updatePlan.status).toEqual("succeeded");
  expect(updatePlan.capsuleId).toEqual(capsuleId);
  expect(updatePlan.operation).toEqual("update");
  expect(updatePlan.capsuleCurrentStateVersionId).toEqual(
    currentStateVersionId,
  );

  const { planRun: destroyPlan } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    operation: "destroy",
    source: SOURCE,
    requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  expect(destroyPlan.status).toEqual("waiting_approval");
  expect(destroyPlan.capsuleId).toEqual(capsuleId);
  expect(destroyPlan.operation).toEqual("destroy");
  expect(destroyPlan.capsuleCurrentStateVersionId).toEqual(
    currentStateVersionId,
  );
});

test("apply rejects a stale update PlanRun after the current StateVersion changes", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(80),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: fakeRunner(),
  });
  // Two update plans are created against the same current StateVersion.
  const { planRun: staleUpdate } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    operation: "update",
    source: { ...SOURCE, ref: "release-2" },
    requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const { planRun: freshUpdate } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    operation: "update",
    source: { ...SOURCE, ref: "release-3" },
    requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  // Applying the fresh plan moves the Capsule's StateVersion cursor forward.
  await controller.createApplyRun({
    planRunId: freshUpdate.id,
    expected: applyExpectedGuardFromPlanRun(freshUpdate),
  });

  // The stale plan was created against the prior current StateVersion; its apply
  // must be rejected.
  await expect(
    controller.createApplyRun({
      planRunId: staleUpdate.id,
      expected: applyExpectedGuardFromPlanRun(staleUpdate),
    }),
  ).rejects.toThrow(/current StateVersion changed/);
});

test("git source is restricted to safe HTTPS source URLs", async () => {
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    now: sequenceNow(91),
    newId: deterministicIds(),
  });
  const requiredProviders = ["registry.opentofu.org/cloudflare/cloudflare"];

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      source: {
        kind: "git",
        url: "file:///etc/passwd",
        ref: "main",
      },
      requiredProviderRequirements:
        providerRequirementsForFixture(requiredProviders),
      requiredProviders,
    }),
  ).rejects.toThrow(/git source url must use https/);

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      source: {
        kind: "git",
        url: "https://token@example.com/private.git",
        ref: "main",
      },
      requiredProviderRequirements:
        providerRequirementsForFixture(requiredProviders),
      requiredProviders,
    }),
  ).rejects.toThrow(/must not embed credentials/);

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      source: {
        kind: "git",
        url: "https://127.0.0.1/private.git",
        ref: "main",
      },
      requiredProviderRequirements:
        providerRequirementsForFixture(requiredProviders),
      requiredProviders,
    }),
  ).rejects.toThrow(/git source url host is not allowed/);

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      source: {
        kind: "git",
        url: "https://github.com/example/app.git",
        ref: "--upload-pack=/bin/sh",
      },
      requiredProviderRequirements:
        providerRequirementsForFixture(requiredProviders),
      requiredProviders,
    }),
  ).rejects.toThrow(/source\.ref must not start/);

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      source: {
        kind: "git",
        url: "https://github.com/example/app.git",
        commit: "main",
      },
      requiredProviderRequirements:
        providerRequirementsForFixture(requiredProviders),
      requiredProviders,
    }),
  ).rejects.toThrow(/source\.commit must be a full git object id/);

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      source: {
        kind: "git",
        url: "https://github.com/example/app.git",
        modulePath: "../other",
      },
      requiredProviderRequirements:
        providerRequirementsForFixture(requiredProviders),
      requiredProviders,
    }),
  ).rejects.toThrow(/source\.modulePath must stay inside/);
});

test("snapshotModuleSource preserves archive-relative module paths", () => {
  const source = {
    id: "source_module_path",
    workspaceId: "workspace_test",
    name: "module path",
    url: "https://github.com/example/app.git",
    defaultRef: "main",
    defaultPath: "infra",
    status: "active",
    autoSync: false,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  } as const;
  const snapshot = (path: string): SourceSnapshot => ({
    id: `snapshot_${path.replaceAll("/", "_") || "root"}`,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "A".repeat(40),
    path,
    archiveRef: "source-archive",
    archiveDigest: `sha256:${"a".repeat(64)}`,
    archiveSizeBytes: 1,
    fetchedByRunId: "sync_1",
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  expect(snapshotModuleSource(source, snapshot("infra"), "infra").modulePath).toBe(
    "infra",
  );
  expect(
    snapshotModuleSource(source, snapshot("infra"), "infra/prod").modulePath,
  ).toBe("infra/prod");
  // A path that merely shares the snapshot prefix is still a distinct archive
  // coordinate and must not be rewritten.
  expect(
    snapshotModuleSource(source, snapshot("infra"), "infrastructure").modulePath,
  ).toBe("infrastructure");
  expect(snapshotModuleSource(source, snapshot("infra"), ".")).not.toHaveProperty(
    "modulePath",
  );
});

test("runner diagnostics are redacted before PlanRun and ApplyRun persistence", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(15),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("diagnostics"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
          diagnostics: [
            {
              severity: "warning",
              message: "provider returned Authorization: Bearer cf-plan-secret",
              detail: "token=cf-plan-token",
            },
          ],
        }),
      apply: (job) =>
        Promise.resolve(fixtureStateCommit({
          rawOutputRef: job.rawOutputRef,
          executionEvidence: executionEvidenceForJob(job, "apply"),
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
          diagnostics: [
            {
              severity: "warning",
              message: "apply used Authorization: Bearer cf-apply-secret",
              detail: "client_secret=cf-apply-token",
            },
          ],
        })),
    },
  });

  const { planRun } = await controller.createPlanRun(request);
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const persistedPlan = await controller.getPlanRun(planRun.id);
  const persistedApply = await controller.getApplyRun(applied.applyRun.id);
  const payload = JSON.stringify({
    plan: persistedPlan.diagnostics,
    apply: persistedApply.applyRun.diagnostics,
  });
  expect(payload).not.toContain("cf-plan-secret");
  expect(payload).not.toContain("cf-plan-token");
  expect(payload).not.toContain("cf-apply-secret");
  expect(payload).not.toContain("cf-apply-token");
  expect(payload).toContain("[REDACTED]");
});

test("apply expected guard compares against the succeeded PlanRun", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(20),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const { planRun } = await controller.createPlanRun(request);

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: {
        ...applyExpectedGuardFromPlanRun(planRun),
        planDigest: "sha256:bad",
      },
    }),
  ).rejects.toMatchObject({
    name: "OpenTofuControllerError",
    code: "failed_precondition",
  });
});

test("apply requires the full reviewed PlanRun guard", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(25),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const { planRun } = await controller.createPlanRun(request);

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: {
        ...applyExpectedGuardFromPlanRun(planRun),
        variablesDigest:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    }),
  ).rejects.toMatchObject({
    name: "OpenTofuControllerError",
    code: "failed_precondition",
  });
});

test("default runner admits arbitrary valid provider sources", async () => {
  let runnerCalled = false;
  const awsProvider = "registry.opentofu.org/hashicorp/aws";
  const { store, request } = await seedUpdatableCapsule({
    requiredProviders: [awsProvider],
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: () => 30,
    newId: deterministicIds(),
    runner: {
      plan: () => {
        runnerCalled = true;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("arbitrary-provider"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [awsProvider],
          providerInstallation: [
            {
              provider: awsProvider,
              mirrored: false,
              installationMethod: "direct",
              attested: false,
            },
          ],
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
  expect(planRun.runnerProfileId).toEqual("opentofu-default");
  expect(runnerCalled).toEqual(true);
});

test("runner discovery cannot promote an explicit empty exact requirement set", async () => {
  let runnerCalled = false;
  const { store, request } = await seedUpdatableCapsule({
    requiredProviders: [],
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(31),
    newId: deterministicIds(),
    runner: {
      plan: () => {
        runnerCalled = true;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("observed-provider"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("failed");
  expect(runnerCalled).toEqual(true);
  expect(planRun.requiredProviders).toEqual([]);
  expect(planRun.requiredProviderRequirements).toEqual([]);
  expect(planRun.diagnostics?.[0]?.message).toContain(
    "runner requiredProviders do not match the compatibility-reviewed provider packages",
  );
});

test("runner profile policy blocks denied providers", async () => {
  const profile: RunnerProfile = {
    ...ACTIVE_TEST_RUNNER_PROFILE,
    id: "strict-cloudflare",
    name: "Strict Cloudflare",
    substrate: "cloudflare-containers",
    stateBackend: {
      kind: "operator-managed",
      ref: "state://strict",
      lock: { kind: "operator", ref: "lock://strict" },
    },
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    deniedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    requireProviderBindings: true,
    createdAt: 1,
  };
  const { store, request } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: () => 35,
    newId: deterministicIds(),
    runner: fakeRunner(),
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun({
    ...request,
    runnerProfileId: profile.id,
  });

  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.reasons.join("\n")).toContain("denied");
});

test("runner profile requires explicit Provider Bindings", async () => {
  const profile: RunnerProfile = {
    ...ACTIVE_TEST_RUNNER_PROFILE,
    id: "credential-required",
    name: "Credential required",
    substrate: "cloudflare-containers",
    stateBackend: {
      kind: "operator-managed",
      ref: "state://credential-required",
    },
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    requireProviderBindings: true,
    createdAt: 1,
  };
  const { store, request } = await seedUpdatableCapsule({
    seedProviderConnections: false,
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: () => 36,
    newId: deterministicIds(),
    runner: fakeRunner(),
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  await expect(
    controller.createPlanRun({
      ...request,
      runnerProfileId: profile.id,
    }),
  ).rejects.toThrow(/provider connection is required/);
});

test("generic runner allows optional provider declarations without Provider Connections", async () => {
  let runnerCalled = false;
  const genericProfile = createDefaultRunnerProfiles().find(
    (profile) => profile.id === "opentofu-default",
  );
  if (!genericProfile) throw new Error("generic profile fixture missing");
  const { store, request } = await seedUpdatableCapsule({
    runnerProfileId: genericProfile.id,
    credentialRequired: false,
    seedProviderConnections: false,
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(37),
    newId: deterministicIds(),
    runnerProfiles: [genericProfile],
    defaultRunnerProfileId: genericProfile.id,
    runner: {
      plan: () => {
        runnerCalled = true;
        return Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("generic-optional-provider"),
          sourceCommit: "abc123",
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
          summary: { add: 0, change: 0, destroy: 0 },
        });
      },
      apply: () => Promise.resolve({ outputs: {} }),
      destroy: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun(request);

  if (planRun.status !== "succeeded") {
    throw new Error(
      `expected generic optional-provider plan to succeed: ${JSON.stringify({
        status: planRun.status,
        policy: planRun.policy,
        diagnostics: planRun.diagnostics,
        errorCode: planRun.errorCode,
      })}`,
    );
  }
  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
  expect(planRun.runnerProfileId).toEqual(genericProfile.id);
  expect(planRun.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);
  expect(runnerCalled).toBe(true);
});

test("InstallConfig provider allowlist blocks after RunnerProfile admits provider", async () => {
  const profile: RunnerProfile = {
    ...ACTIVE_TEST_RUNNER_PROFILE,
    id: "aws-admitting",
    name: "AWS admitting",
    substrate: "cloudflare-containers",
    stateBackend: {
      kind: "operator-managed",
      ref: "state://aws-admitting",
    },
    allowedProviders: ["registry.opentofu.org/hashicorp/aws"],
    createdAt: 1,
  };
  const { store, request } = await seedUpdatableCapsule({
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
    runnerProfileId: profile.id,
  });
  const seeded = await store.getCapsule(request.capsuleId!);
  const installConfig = await store.getInstallConfig(seeded!.installConfigId);
  await store.putInstallConfig({
    ...installConfig!,
    policy: {
      ...installConfig!.policy,
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    },
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault({
      provider: "registry.opentofu.org/hashicorp/aws",
      connectionId: "conn_seed_aws",
    }) as never,
    store,
    now: sequenceNow(37),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("install-config-provider"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
          providerInstallation: [AWS_MIRROR_EVIDENCE],
        }),
      apply: () => Promise.resolve({}),
    },
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "registry.opentofu.org/hashicorp/aws is not allowed by policy",
  );
});

test("plan policy blocks strict Cloudflare scope when plan metadata is missing", async () => {
  const { store, request } = await seedUpdatableCapsule({
    store: new InMemoryOpenTofuControlStore(),
  });
  const seeded = await store.getCapsule(request.capsuleId!);
  const installConfig = await store.getInstallConfig(seeded!.installConfigId);
  await store.putInstallConfig({
    ...installConfig!,
    policy: {
      ...installConfig!.policy,
      allowedResourceTypes: ["cloudflare_r2_bucket"],
      scopeBoundary: {
        mode: "strict",
        rules: [
          {
            resourceTypePattern: "cloudflare_*",
            dimensions: {
              account_id: {
                selector: "/account_id",
                allowedValues: ["acct_allowed"],
              },
            },
          },
        ],
      },
    },
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(41),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("strict-scope"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
          planResourceChanges: [
            {
              address: "cloudflare_r2_bucket.files",
              type: "cloudflare_r2_bucket",
              actions: ["create"],
            },
          ],
        }),
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.status).toEqual("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "missing scope dimension account_id",
  );
});

test("plan policy admits matching scope metadata and blocks quota overflow", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const seeded = await store.getCapsule(request.capsuleId!);
  const installConfig = await store.getInstallConfig(seeded!.installConfigId);
  await store.putInstallConfig({
    ...installConfig!,
    policy: {
      ...installConfig!.policy,
      allowedResourceTypes: ["cloudflare_r2_bucket"],
      scopeBoundary: {
        mode: "strict",
        rules: [
          {
            resourceTypePattern: "cloudflare_*",
            dimensions: {
              account_id: {
                selector: "/account_id",
                allowedValues: ["acct_allowed"],
              },
            },
          },
        ],
      },
      quota: { "resources.total": 1 },
    },
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(42),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("quota"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
          planResourceChanges: [
            {
              address: "cloudflare_r2_bucket.files_a",
              type: "cloudflare_r2_bucket",
              actions: ["create"],
              scope: { facts: { account_id: "acct_allowed" } },
            },
            {
              address: "cloudflare_r2_bucket.files_b",
              type: "cloudflare_r2_bucket",
              actions: ["create"],
              scope: { facts: { account_id: "acct_allowed" } },
            },
          ],
        }),
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.reasons.join("\n")).not.toContain("out of scope");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "resources.total count 2 exceeds 1",
  );
});

test("plan policy composes Workspace policy ceiling with InstallConfig policy", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const space = await store.getWorkspace(request.workspaceId);
  await store.putWorkspace({
    ...space!,
    policy: {
      allowedResourceTypes: ["cloudflare_r2_bucket"],
      quota: { "resources.total": 1 },
    },
  });
  const seeded = await store.getCapsule(request.capsuleId!);
  const installConfig = await store.getInstallConfig(seeded!.installConfigId);
  await store.putInstallConfig({
    ...installConfig!,
    policy: {
      ...installConfig!.policy,
      allowedResourceTypes: [
        "cloudflare_r2_bucket",
        "cloudflare_workers_script",
      ],
      quota: { "resources.total": 5 },
    },
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(43),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("space-policy"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
          planResourceChanges: [
            {
              address: "cloudflare_r2_bucket.files",
              type: "cloudflare_r2_bucket",
              actions: ["create"],
            },
            {
              address: "cloudflare_workers_script.app",
              type: "cloudflare_workers_script",
              actions: ["create"],
            },
          ],
        }),
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "cloudflare_workers_script is not allowed",
  );
  expect(planRun.policy.reasons.join("\n")).toContain(
    "resources.total count 2 exceeds 1",
  );
});

test("default OpenTofu runner is provider-neutral and has no Cloud hosting metadata", () => {
  const profile = createDefaultRunnerProfiles(123).find(
    (profile) => profile.id === "opentofu-default",
  );

  expect(profile?.substrate).toEqual("operator-managed");
  expect(profile?.resourceLimits).toEqual({
    maxRunSeconds: 900,
    maxSourceArchiveBytes: 104857600,
    maxSourceDecompressedBytes: 1048576000,
    cpu: "1",
    memoryMb: 1024,
  });
  expect(profile?.cloudflareWorkersForPlatforms).toBeUndefined();
  expect(profile?.executorId).toEqual(DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID);
  expect(profile?.lifecycle).toEqual({ state: "active" });
  expect(profile?.availability).toEqual({ state: "available" });
  expect(profile?.labels).toBeUndefined();
  expect(profile?.allowedProviders).toEqual(["*"]);
  expect(profile?.requireProviderBindings).toEqual(false);
  expect(profile?.secretExposurePolicy).toEqual({
    providerCredentials: "runner-only",
    tenantWorkerOperatorSecrets: "forbidden",
    redactLogs: true,
    blockSensitiveOutputs: true,
  });
});

test("default runner seed is one generic OpenTofu execution profile", () => {
  const profiles = createDefaultRunnerProfiles(123);
  expect(profiles.map((profile) => profile.id)).toEqual(["opentofu-default"]);
  expect(profiles[0]?.allowedProviders).toEqual(["*"]);
  expect(profiles[0]?.networkPolicy).toEqual({ mode: "operator-managed" });
  expect(profiles[0]?.executorId).toBe(DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID);
});

test("runner profile discovery exposes configured profiles, not retired persisted rows", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putRunnerProfile({
    ...createDefaultRunnerProfiles(123)[0]!,
    id: "cloudflare-default",
    name: "Retired profile",
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    store,
    now: () => 124,
  });

  const listed = await controller.listRunnerProfiles();

  expect(listed.runnerProfiles.map((profile) => profile.id)).toEqual([
    "opentofu-default",
  ]);
});

test("operator-defined capability runner profiles remain explicitly selectable", async () => {
  const profile: RunnerProfile = {
    ...createDefaultRunnerProfiles(123)[0]!,
    id: "private-network",
    name: "Private network",
    labels: { purpose: "private-network" },
  };
  const { store, request } = await seedUpdatableCapsule({
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
    runnerProfileId: profile.id,
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault({
      provider: "registry.opentofu.org/hashicorp/aws",
      connectionId: "conn_seed_aws",
    }) as never,
    store,
    now: sequenceNow(39),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("enabled-template"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
          providerInstallation: [AWS_MIRROR_EVIDENCE],
        }),
      apply: () => Promise.resolve({}),
    },
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
  expect(planRun.runnerProfileId).toEqual("private-network");
});

test("generic-env providers run on an ordinary runner profile when the provider is allowed", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const { store, request, capsuleId } = await seedUpdatableCapsule({
    requiredProviders: [provider],
    runnerProfileId: "vercel-template",
  });
  await store.putConnection({
    id: "conn_vercel",
    workspaceId: "workspace_test",
    provider,
    providerSource: provider,
    kind: "generic_env_provider",
    scope: "space",
    materialization: "secret",
    displayName: "Vercel generic env",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    verifiedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putProviderBindingSet({
    id: "profile_vercel",
    workspaceId: "workspace_test",
    capsuleId,
    environment: "production",
    bindings: [
      {
        provider,
        moduleLocalName: "vercel",
        rootAlias: "main",
        connectionId: "conn_vercel",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile: RunnerProfile = {
    ...ACTIVE_TEST_RUNNER_PROFILE,
    id: "vercel-template",
    name: "Vercel template",
    substrate: "cloudflare-containers",
    allowedProviders: [provider],
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    networkPolicy: {
      mode: "egress-allowlist",
      allowedHosts: ["registry.opentofu.org", "api.vercel.com"],
    },
    secretExposurePolicy: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
  };
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(41),
    newId: deterministicIds(),
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest: PLAN_DIGEST,
          planArtifact: testPlanArtifact("vercel-template"),
          providerLockDigest: LOCK_DIGEST,
          requiredProviders: [provider],
          providerInstallation: [
            {
              provider,
              mirrored: true,
              installationMethod: "filesystem_mirror",
              attested: true,
              attestationMethod: "forced_filesystem_mirror_init",
              mirrorPath:
                "/opt/opentofu/provider-mirror/registry.opentofu.org/vercel/vercel",
            },
          ],
        }),
      apply: () => Promise.resolve({}),
    },
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
});

test("generic-env provider policy uses the profile's explicitly registered executor", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const { store, request, capsuleId } = await seedUpdatableCapsule({
    requiredProviders: [provider],
    runnerProfileId: "vercel-custom",
  });
  await store.putConnection({
    id: "conn_vercel",
    workspaceId: "workspace_test",
    provider,
    providerSource: provider,
    kind: "generic_env_provider",
    scope: "space",
    materialization: "secret",
    displayName: "Vercel generic env",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    verifiedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putProviderBindingSet({
    id: "profile_vercel",
    workspaceId: "workspace_test",
    capsuleId,
    environment: "production",
    bindings: [
      {
        provider,
        moduleLocalName: "vercel",
        rootAlias: "main",
        connectionId: "conn_vercel",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile: RunnerProfile = {
    ...ACTIVE_TEST_RUNNER_PROFILE,
    id: "vercel-custom",
    name: "Vercel custom",
    substrate: "cloudflare-containers",
    allowedProviders: [provider],
    executorId: "test.vercel",
    labels: { purpose: "custom-network" },
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    networkPolicy: {
      mode: "egress-allowlist",
      allowedHosts: ["registry.opentofu.org", "api.vercel.com"],
    },
    secretExposurePolicy: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
  };
  const customRunner: OpenTofuRunner = {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: testPlanArtifact("vercel-custom"),
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [provider],
        providerInstallation: [
          {
            provider,
            mirrored: true,
            installationMethod: "filesystem_mirror",
            attested: true,
            attestationMethod: "forced_filesystem_mirror_init",
            mirrorPath:
              "/opt/opentofu/provider-mirror/registry.opentofu.org/vercel/vercel",
          },
        ],
      }),
    apply: () => Promise.resolve({}),
  };
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault({
      provider,
      connectionId: "conn_vercel",
    }) as never,
    store,
    now: sequenceNow(42),
    newId: deterministicIds(),
    runner: fakeRunner(),
    runnerExecutors: new Map([["test.vercel", customRunner]]),
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
});

test("a RunnerProfile with an unregistered executor fails closed at dispatch", async () => {
  const provider = "registry.opentofu.org/hashicorp/aws";
  const profile: RunnerProfile = {
    ...createDefaultRunnerProfiles(1)[0]!,
    id: "unregistered-executor",
    executorId: "operator.missing",
    allowedProviders: [provider],
  };
  const { store, request } = await seedUpdatableCapsule({
    requiredProviders: [provider],
    runnerProfileId: profile.id,
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault({
      provider,
      connectionId: "conn_seed_aws",
    }) as never,
    store,
    now: sequenceNow(43),
    newId: deterministicIds(),
    runner: fakeRunner(),
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toBe("queued");
  await expect(controller.runQueuedPlan(planRun.id)).rejects.toThrow(
    "references unregistered executor operator.missing",
  );
});

test("destroy is recorded as an ApplyRun when the runner succeeds", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(40),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: fakeRunner(),
  });

  const { planRun: destroyPlan } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    source: SOURCE,
    operation: "destroy",
    requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  // A destroy is always two-stage (spec §10.6): it must be approved before apply.
  await controller.approveRun(destroyPlan.id, { approvedBy: "ops" });
  const destroyed = await controller.createApplyRun({
    planRunId: destroyPlan.id,
    expected: applyExpectedGuardFromPlanRun(destroyPlan),
  });

  expect(destroyed.applyRun.operation).toEqual("destroy");
  expect(destroyed.applyRun.status).toEqual("succeeded");
  expect(destroyed.capsule?.status).toEqual("destroyed");
  expect(destroyed.capsule?.currentStateVersionId).toEqual(
    destroyed.applyRun.stateVersionId,
  );
  expect(destroyed.applyRun.auditEvents.map((event) => event.type)).toContain(
    "destroy.completed",
  );
});

test("destroy rejects live builtin provider installation evidence before audit or teardown persistence", async () => {
  const { store, capsuleId, currentStateVersionId } =
    await seedUpdatableCapsule();
  const baseRunner = fakeRunner();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(40),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: {
      ...baseRunner,
      destroy: (job) =>
        Promise.resolve(
          fixtureStateCommit({
            executionEvidence: executionEvidenceForJob(job, "destroy"),
            providerInstallation: [
              {
                provider: "terraform.io/builtin/terraform",
                mirrored: false,
                installationMethod: "unknown" as const,
              },
            ],
          }),
        ),
    },
  });

  const { planRun } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    source: SOURCE,
    operation: "destroy",
    requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
    requiredProviders: [CLOUDFLARE_PROVIDER],
  });
  await controller.approveRun(planRun.id, { approvedBy: "ops" });
  const destroyed = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const capsule = await store.getCapsule(capsuleId);

  expect(destroyed.applyRun.status).toBe("failed");
  expect(destroyed.applyRun.diagnostics?.[0]?.message).toContain(
    "live provider installation evidence cannot target OpenTofu builtin runtime capability",
  );
  expect(
    destroyed.applyRun.auditEvents.map((event) => event.type),
  ).not.toContain("destroy.provider_installation_evaluated");
  expect(capsule?.currentStateVersionId).toBe(currentStateVersionId);
  expect(capsule?.status).toBe("active");
});

test("destroy apply is rejected until the plan is approved (always two-stage, spec §10.6)", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(40),
    newId: deterministicIds(),
    executionEvidenceAuthority: TEST_EXECUTION_EVIDENCE_AUTHORITY,
    runner: fakeRunner(),
  });

  const { planRun: destroyPlan } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    source: SOURCE,
    operation: "destroy",
    requiredProviderRequirements: CLOUDFLARE_REQUIREMENTS,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  expect(destroyPlan.status).toEqual("waiting_approval");

  // Without a recorded approval the destroy apply is refused — the destroy plan
  // is parked in the persisted `waiting_approval` status, so the apply
  // precondition (which requires a `succeeded` plan) fails closed. The approval
  // is enforced at apply, not merely displayed.
  await expect(
    controller.createApplyRun({
      planRunId: destroyPlan.id,
      expected: applyExpectedGuardFromPlanRun(destroyPlan),
    }),
  ).rejects.toThrow(/waiting_approval|awaiting approval/);

  // After approval the same destroy applies.
  await controller.approveRun(destroyPlan.id, { approvedBy: "ops" });
  const destroyed = await controller.createApplyRun({
    planRunId: destroyPlan.id,
    expected: applyExpectedGuardFromPlanRun(destroyPlan),
  });
  expect(destroyed.applyRun.status).toEqual("succeeded");
});

test("restore rebases StateVersion and Output cursors and marks the Capsule stale", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  let restoreJob: OpenTofuRestoreJob | undefined;
  let sourceAuthorityReads = 0;
  let authoritativeSource: OpenTofuRestoreSourceState | undefined;
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(70),
    newId: deterministicIds(),
    runner: {
      restore: async (job, control) => {
        restoreJob = job;
        authoritativeSource = await control?.sourceAuthority?.readExact();
        sourceAuthorityReads += 1;
        return Promise.resolve(restoreAck(job));
      },
    },
  });
  const lifecycle: string[] = [];
  controller.setRestoreRunObserver(async ({ phase, run }) => {
    lifecycle.push(
      `${phase}:${run.status}:${(await store.getBackupRun(run.id))?.status}`,
    );
  });
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  await store.putStateVersion({
    id: "state_restore_source",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    generation: 1,
    stateRef: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  const sourceOutput = {
    id: "out_restore_source",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    stateGeneration: 1,
    rawArtifactRef: "outputs/1.json.enc",
    publicOutputs: { url: "https://restored.example.test" },
    workspaceOutputs: {
      url: "https://restored.example.test",
      bucket_name: "restored-assets",
    },
    outputDigest: "sha256:restore-source-output",
    createdAt: "2026-06-06T00:00:00.000Z",
  } as const;
  const latestSourceOutput = {
    ...sourceOutput,
    id: "out_restore_source_latest",
    rawArtifactRef: "outputs/1-latest.json.enc",
    publicOutputs: { url: "https://restored-latest.example.test" },
    workspaceOutputs: {
      url: "https://restored-latest.example.test",
      bucket_name: "restored-latest-assets",
    },
    outputDigest: "sha256:restore-source-output-latest",
    createdAt: "2026-06-06T00:00:00.500Z",
  } as const;
  const previousOutput = {
    ...sourceOutput,
    id: "out_restore_previous",
    stateGeneration: 2,
    rawArtifactRef: "outputs/2.json.enc",
    publicOutputs: { url: "https://previous.example.test" },
    workspaceOutputs: {
      url: "https://previous.example.test",
      bucket_name: "previous-assets",
    },
    outputDigest: "sha256:restore-previous-output",
    createdAt: "2026-06-06T00:00:01.000Z",
  } as const;
  await store.putOutput(sourceOutput);
  await store.putOutput(latestSourceOutput);
  await store.putOutput(previousOutput);
  await store.putBackupRecord({
    id: "bkp_restore",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    ref: "workspaces/space_test/backups/bkp_restore/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    ...capsule!,
    status: "destroyed",
    currentStateGeneration: 2,
    currentOutputId: previousOutput.id,
    updatedAt: "2026-06-06T00:00:01.000Z",
  });

  const restore = await controller.createRestoreRun(
    capsule!.workspaceId,
    "bkp_restore",
    {
      capsuleId,
      environment: capsule!.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "ops" });
  await controller.runQueuedRestore(restore.id);

  expect(restoreJob?.sourceState).toEqual({
    stateVersionId: "state_restore_source",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    generation: 1,
    stateRef: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
  });
  expect(sourceAuthorityReads).toBe(1);
  expect(authoritativeSource).toEqual(restoreJob?.sourceState);

  const restored = await store.getCapsule(capsuleId);
  const restoreRun = await store.getBackupRun(restore.id);
  const restoredState = restoreRun?.restoredStateVersionId
    ? await store.getStateVersion(restoreRun.restoredStateVersionId)
    : undefined;
  const restoredOutput = restored?.currentOutputId
    ? await store.getOutput(restored.currentOutputId)
    : undefined;
  expect(restoreRun?.status).toBe("succeeded");
  expect(restored?.currentStateVersionId).toBe(
    restoreRun?.restoredStateVersionId,
  );
  expect(restored?.currentStateGeneration).toBe(3);
  expect(restoredState?.generation).toBe(3);
  expect(restoredState?.stateRef).toBe(`runner-local://restore/${restore.id}`);
  expect(restoredOutput?.id).not.toBe(sourceOutput.id);
  expect(restoredOutput?.id).not.toBe(latestSourceOutput.id);
  expect(restoredOutput?.id).not.toBe(previousOutput.id);
  expect(restoredOutput?.stateGeneration).toBe(3);
  expect(restoredOutput?.rawArtifactRef).toBe(
    latestSourceOutput.rawArtifactRef,
  );
  expect(restoredOutput?.publicOutputs).toEqual(
    latestSourceOutput.publicOutputs,
  );
  expect(restoredOutput?.workspaceOutputs).toEqual(
    latestSourceOutput.workspaceOutputs,
  );
  expect(restoredOutput?.outputDigest).toBe(latestSourceOutput.outputDigest);
  expect(restored?.status).toBe("stale");
  expect(lifecycle).toEqual([
    "started:running:running",
    "succeeded:succeeded:succeeded",
  ]);
});

test("restore fails closed when the configured runner has no restore capability", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule, backupId } = await seedRestoreFixture(
    store,
    "missing_runner_restore",
  );
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(70),
    newId: deterministicIds(),
    // The ordinary fake runner intentionally has plan/apply/destroy only.
    // Restore must not be synthesized from the source StateVersion.
    runner: fakeRunner(),
    enqueueRun: () => Promise.resolve(),
  });
  const restore = await controller.createRestoreRun(
    capsule.workspaceId,
    backupId,
    {
      capsuleId: capsule.id,
      environment: capsule.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "ops" });

  let restoreError: unknown;
  try {
    await controller.runQueuedRestore(restore.id);
  } catch (error) {
    restoreError = error;
  }
  expect(restoreError).toBeInstanceOf(Error);
  expect((restoreError as Error).message).toContain(
    "restore requires a restore-capable runner",
  );

  const after = await store.getCapsule(capsule.id);
  expect(after?.currentStateGeneration).toBe(2);
  expect(after?.currentStateVersionId).toBe(capsule.currentStateVersionId);
  expect(
    (await store.listStateVersions(capsule.id, capsule.environment)).filter(
      (snapshot) => snapshot.generation >= 3,
    ),
  ).toEqual([]);
  expect((await store.getBackupRun(restore.id))?.status).toBe("failed");
});

test("restore clears the current Output cursor when the source generation has no Output", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule, backupId } = await seedRestoreFixture(
    store,
    "missing_output",
  );
  const previousOutput = {
    id: "out_restore_missing_output_previous",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateGeneration: 2,
    rawArtifactRef: "outputs/missing-output-previous.json.enc",
    publicOutputs: { url: "https://previous.example.test" },
    workspaceOutputs: { url: "https://previous.example.test" },
    outputDigest: "sha256:restore-missing-output-previous",
    createdAt: "2026-06-06T00:00:01.000Z",
  } as const;
  await store.putOutput(previousOutput);
  const current = await store.getCapsule(capsule.id);
  await store.putCapsule({
    ...current!,
    currentOutputId: previousOutput.id,
  });
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(71),
    newId: deterministicIds(),
    runner: {
      restore: (job) => Promise.resolve(restoreAck(job)),
    },
  });

  const restore = await controller.createRestoreRun(
    capsule.workspaceId,
    backupId,
    {
      capsuleId: capsule.id,
      environment: capsule.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "ops" });
  await controller.runQueuedRestore(restore.id);

  const restored = await store.getCapsule(capsule.id);
  const restoreRun = await store.getBackupRun(restore.id);
  expect(restoreRun?.status).toBe("succeeded");
  expect(restored?.currentStateVersionId).toBe(
    restoreRun?.restoredStateVersionId,
  );
  expect(restored?.currentStateGeneration).toBe(3);
  expect(restored?.currentOutputId).toBeUndefined();
  expect(await store.getOutput(previousOutput.id)).toEqual(previousOutput);
  expect(
    (await store.listOutputs(capsule.id)).filter(
      (output) => output.stateGeneration === 3,
    ),
  ).toEqual([]);
});

test("restore failure is observed after the failed terminal row is durable", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule, backupId } = await seedRestoreFixture(store, "failed");
  const lifecycle: string[] = [];
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(75),
    newId: deterministicIds(),
    runner: {
      restore: () => Promise.reject(new Error("restore backend failed")),
    },
    enqueueRun: () => Promise.resolve(),
  });
  controller.setRestoreRunObserver(async ({ phase, run }) => {
    lifecycle.push(
      `${phase}:${run.status}:${(await store.getBackupRun(run.id))?.status}`,
    );
  });
  const restore = await controller.createRestoreRun(
    capsule.workspaceId,
    backupId,
    {
      capsuleId: capsule.id,
      environment: capsule.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "ops" });

  await expect(controller.runQueuedRestore(restore.id)).rejects.toThrow(
    "restore backend failed",
  );

  expect((await store.getBackupRun(restore.id))?.status).toBe("failed");
  expect(lifecycle).toEqual([
    "started:running:running",
    "failed:failed:failed",
  ]);
});

test("restore DLQ failure is observed after its terminal transition", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule, backupId } = await seedRestoreFixture(store, "dlq");
  const lifecycle: string[] = [];
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(80),
    newId: deterministicIds(),
    runner: {
      restore: (job) => Promise.resolve(restoreAck(job)),
    },
    enqueueRun: () => Promise.resolve(),
  });
  controller.setRestoreRunObserver(async ({ phase, run }) => {
    lifecycle.push(
      `${phase}:${run.status}:${(await store.getBackupRun(run.id))?.status}`,
    );
  });
  const restore = await controller.createRestoreRun(
    capsule.workspaceId,
    backupId,
    {
      capsuleId: capsule.id,
      environment: capsule.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "ops" });

  expect(
    await controller.markRunFailed("restore", restore.id, "retries-exhausted"),
  ).toBe(true);
  expect((await store.getBackupRun(restore.id))?.status).toBe("failed");
  expect(lifecycle).toEqual(["failed:failed:failed"]);
});

test("restore does not publish state after losing its run lease", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  await store.putStateVersion({
    id: "state_restore_lost_source",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    generation: 1,
    stateRef: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_lost",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    ref: "workspaces/space_test/backups/bkp_restore_lost/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    ...capsule!,
    status: "destroyed",
    currentStateGeneration: 2,
    updatedAt: "2026-06-06T00:00:01.000Z",
  });
  let restoreRunId = "";
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(700),
    newId: deterministicIds(),
    runner: {
      restore: async (job) => {
        const { stateScope } = job;
        const current = await store.getBackupRun(restoreRunId);
        expect(current?.status).toBe("running");
        const takeover = await store.transitionRun({
          id: restoreRunId,
          kind: "restore",
          expectFrom: ["running"],
          expectHeartbeatAt: current?.heartbeatAt ?? null,
          run: {
            ...(current as NonNullable<typeof current>),
            status: "running",
            heartbeatAt: 999_000,
          },
          setLeaseToken: "lease_other_restore_owner",
          heartbeatAt: 999_000,
        });
        expect(takeover.won).toBe(true);
        return restoreAck(job);
      },
    },
  });
  const restore = await controller.createRestoreRun(
    capsule!.workspaceId,
    "bkp_restore_lost",
    {
      capsuleId,
      environment: capsule!.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  restoreRunId = restore.id;
  await controller.approveRun(restore.id, { approvedBy: "ops" });
  await controller.runQueuedRestore(restore.id);

  const restored = await store.getCapsule(capsuleId);
  const restoreRun = await store.getBackupRun(restore.id);
  expect(restoreRun?.status).toBe("running");
  expect(restoreRun?.heartbeatAt).toBe(999_000);
  expect(restored?.currentStateGeneration).toBe(2);
  expect(
    (await store.listStateVersions(capsuleId, capsule!.environment)).find(
      (snapshot) => snapshot.generation === 3,
    ),
  ).toBeUndefined();
});

test("restore renews the run heartbeat while the runner blocks", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  await store.putStateVersion({
    id: "state_restore_heartbeat_source",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    generation: 1,
    stateRef: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_heartbeat",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    ref: "workspaces/space_test/backups/bkp_restore_heartbeat/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  let clock = 800;
  let restoreRunId = "";
  let claimHeartbeat = 0;
  let midFlightHeartbeat = 0;
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: () => (clock += 1),
    newId: deterministicIds(),
    runRenewalIntervalMs: 5,
    runner: {
      restore: async (job) => {
        const { stateScope } = job;
        claimHeartbeat =
          (await store.getBackupRun(restoreRunId))?.heartbeatAt ?? 0;
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          const current =
            (await store.getBackupRun(restoreRunId))?.heartbeatAt ?? 0;
          if (current > claimHeartbeat) {
            midFlightHeartbeat = current;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return restoreAck(job);
      },
    },
  });
  const restore = await controller.createRestoreRun(
    capsule!.workspaceId,
    "bkp_restore_heartbeat",
    {
      capsuleId,
      environment: capsule!.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  restoreRunId = restore.id;
  await controller.approveRun(restore.id, { approvedBy: "ops" });
  await controller.runQueuedRestore(restore.id);

  expect(midFlightHeartbeat).toBeGreaterThan(claimHeartbeat);
  expect((await store.getBackupRun(restore.id))?.status).toBe("succeeded");
});

test("restore dispatches service-data artifacts only when requested and acknowledged", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const serviceData = {
    ref: "workspaces/space_test/backups/bkp_restore/service-data.tar.zst.enc",
    digest: "sha256:service-data",
    sizeBytes: 42,
    exportedCount: 3,
    unsupportedCount: 0,
    missingCount: 0,
  };
  const restoreJobs: Array<{
    readonly serviceData?: typeof serviceData;
  }> = [];
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(75),
    newId: deterministicIds(),
    runner: {
      restore: (job) => Promise.resolve(restoreAck(job)),
      restoreServiceData: (job) => {
        restoreJobs.push({ serviceData: job.serviceData });
        return Promise.resolve({
          status: "restored",
          ref: job.serviceData.ref,
          digest: job.serviceData.digest,
          sizeBytes: job.serviceData.sizeBytes,
          restoredCount: job.serviceData.exportedCount,
        });
      },
    },
  });
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  await store.putStateVersion({
    id: "state_restore_service_data_source",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    generation: 1,
    stateRef: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_service_data",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    ref: "workspaces/space_test/backups/bkp_restore_service_data/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    serviceData,
    createdAt: "2026-06-06T00:00:00.000Z",
  });

  const restore = await controller.createRestoreRun(
    capsule!.workspaceId,
    "bkp_restore_service_data",
    {
      capsuleId,
      environment: capsule!.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
      restoreServiceData: true,
    },
  );
  expect(restore.restoreServiceData).toBe(true);

  await controller.approveRun(restore.id, { approvedBy: "ops" });
  await controller.runQueuedRestore(restore.id);

  const restoreRun = await store.getBackupRun(restore.id);
  expect(restoreJobs).toHaveLength(1);
  expect(restoreJobs[0]?.serviceData).toEqual(serviceData);
  expect(restoreRun?.status).toBe("succeeded");
  expect(restoreRun?.restoredServiceData).toEqual({
    status: "restored",
    ref: serviceData.ref,
    digest: serviceData.digest,
    sizeBytes: serviceData.sizeBytes,
    restoredCount: serviceData.exportedCount,
  });
});

test("restoreServiceData fails closed when the backup has no service-data artifact", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(80),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  await store.putStateVersion({
    id: "state_restore_without_service_data_source",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    generation: 1,
    stateRef: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_without_service_data",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    ref: "workspaces/space_test/backups/bkp_restore_without_service_data/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });

  await expect(
    controller.createRestoreRun(
      capsule!.workspaceId,
      "bkp_restore_without_service_data",
      {
        capsuleId,
        environment: capsule!.environment,
        stateGeneration: 1,
        expectedBackupDigest: PLAN_DIGEST,
        restoreServiceData: true,
      },
    ),
  ).rejects.toThrow(/no service-data artifact/);
});

test("restoreServiceData fails closed when the runner lacks service-data restore capability", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(85),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const capsule = await store.getCapsule(capsuleId);
  expect(capsule).toBeDefined();
  await store.putStateVersion({
    id: "state_restore_service_data_unwired_source",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    generation: 1,
    stateRef: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_service_data_unwired",
    workspaceId: capsule!.workspaceId,
    capsuleId,
    environment: capsule!.environment,
    ref: "workspaces/space_test/backups/bkp_restore_service_data_unwired/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    serviceData: {
      ref: "workspaces/space_test/backups/bkp_restore_service_data_unwired/service-data.tar.zst.enc",
      digest: "sha256:service-data",
      sizeBytes: 42,
      exportedCount: 3,
      unsupportedCount: 0,
      missingCount: 0,
    },
    createdAt: "2026-06-06T00:00:00.000Z",
  });

  await expect(
    controller.createRestoreRun(
      capsule!.workspaceId,
      "bkp_restore_service_data_unwired",
      {
        capsuleId,
        environment: capsule!.environment,
        stateGeneration: 1,
        expectedBackupDigest: PLAN_DIGEST,
        restoreServiceData: true,
      },
    ),
  ).rejects.toThrow(/service-data restore-capable runner/);
});

test("not found surfaces the closed controller error code", async () => {
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    now: () => 50,
    newId: deterministicIds(),
  });

  await expect(controller.getPlanRun("plan_missing")).rejects.toBeInstanceOf(
    OpenTofuControllerError,
  );
});

function fakeRunner(
  outputs: Record<
    string,
    { readonly sensitive?: boolean; readonly value: unknown }
  > = {
    launch_url: {
      sensitive: false,
      value: "https://app.example.test",
    },
    ignored_value: {
      sensitive: false,
      value: "not published",
    },
    secret_value: {
      sensitive: true,
      value: "do-not-publish",
    },
  },
): OpenTofuRunner {
  return {
    plan: () =>
      Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: testPlanArtifact("fake"),
        sourceCommit: "abc123",
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        summary: { add: 1, change: 0, destroy: 0 },
      }),
    apply: (job) =>
      Promise.resolve(
        fixtureStateCommit({
          outputs,
          rawOutputRef: job.rawOutputRef,
          executionEvidence: executionEvidenceForJob(job, "apply"),
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        }),
      ),
    destroy: (job) =>
      Promise.resolve(
        fixtureStateCommit({
          executionEvidence: executionEvidenceForJob(job, "destroy"),
          providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        }),
      ),
  };
}

function executionEvidenceForJob(
  job: Parameters<NonNullable<OpenTofuRunner["apply"]>>[0],
  action: "apply" | "destroy",
): RunExecutionEvidence {
  const commit = job.executionEvidenceCommit;
  if (!commit) throw new Error("test apply job is missing evidence commit");
  return {
    format: RUN_EXECUTION_EVIDENCE_CONTRACT,
    runId: job.applyRun.id,
    planRunId: job.planRun.id,
    action,
    outcome: "committed",
    authority: {
      ...TEST_EXECUTION_EVIDENCE_AUTHORITY,
      runnerProfileId: job.runnerProfile.id,
      executorId: job.runnerProfile.executorId,
      providerArtifacts: job.planRun.requiredProviders
        .filter((provider) => !provider.includes("/builtin/"))
        .map((source) => ({
          source,
          digest: `sha256:${"e".repeat(64)}` as `sha256:${string}`,
          attested: true as const,
        })),
    },
    plan: {
      digest: job.planRun.planDigest!,
      artifactDigest: job.planArtifact.digest,
    },
    commit,
    receipt: { operationId: job.applyRun.id, version: 1, fence: 1 },
    committedAt: "2026-06-06T00:00:00.000Z",
  };
}

function testPlanArtifact(label: string) {
  return {
    kind: "runner-local",
    ref: `runner-local://plan_${label}/tfplan`,
    digest: PLAN_DIGEST,
    contentType: "application/vnd.opentofu.plan",
  } as const;
}

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}
