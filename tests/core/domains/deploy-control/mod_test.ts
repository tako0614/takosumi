import { expect, test } from "bun:test";
import type { OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  createDefaultRunnerProfiles,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuControllerError,
  OpenTofuController,
} from "../../../../core/domains/deploy-control/mod.ts";
import type {
  ProviderConnection,
  CreatePlanRunRequest,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  fakeProviderVault,
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
        alias: "main",
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
const CLOUDFLARE_MIRROR_EVIDENCE = {
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
} as const;
const AWS_MIRROR_EVIDENCE = {
  provider: "registry.opentofu.org/hashicorp/aws",
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/hashicorp/aws",
} as const;

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

test("plan/apply records Capsule, StateVersion, and explicitly allowlisted Output", async () => {
  const { store, request, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(10),
    newId: deterministicIds(),
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
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/plan requires an existing capsuleId/);

  await expect(
    controller.createPlanRun({
      workspaceId: "workspace_test",
      operation: "destroy",
      source: SOURCE,
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
    runner: fakeRunner(),
  });
  // Two update plans are created against the same current StateVersion.
  const { planRun: staleUpdate } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    operation: "update",
    source: { ...SOURCE, ref: "release-2" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const { planRun: freshUpdate } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    operation: "update",
    source: { ...SOURCE, ref: "release-3" },
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
      requiredProviders,
    }),
  ).rejects.toThrow(/source\.modulePath must stay inside/);
});

test("runner diagnostics are redacted before PlanRun and ApplyRun persistence", async () => {
  const { store, request } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(15),
    newId: deterministicIds(),
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
      apply: () =>
        Promise.resolve({
          diagnostics: [
            {
              severity: "warning",
              message: "apply used Authorization: Bearer cf-apply-secret",
              detail: "client_secret=cf-apply-token",
            },
          ],
        }),
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

test("default runner records providers discovered during OpenTofu init", async () => {
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

  expect(planRun.status).toEqual("succeeded");
  expect(runnerCalled).toEqual(true);
  expect(planRun.requiredProviders).toEqual([
    "registry.opentofu.org/hashicorp/aws",
  ]);
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
        alias: "main",
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
    stateLock: { kind: "native" },
    networkPolicy: {
      mode: "egress-allowlist",
      allowedHosts: ["registry.opentofu.org", "api.vercel.com"],
    },
    secretExposure: {
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
        alias: "main",
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
    stateLock: { kind: "native" },
    networkPolicy: {
      mode: "egress-allowlist",
      allowedHosts: ["registry.opentofu.org", "api.vercel.com"],
    },
    secretExposure: {
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
    runner: fakeRunner(),
  });

  const { planRun: destroyPlan } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    source: SOURCE,
    operation: "destroy",
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

test("destroy apply is rejected until the plan is approved (always two-stage, spec §10.6)", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(40),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  const { planRun: destroyPlan } = await controller.createPlanRun({
    workspaceId: "workspace_test",
    capsuleId,
    source: SOURCE,
    operation: "destroy",
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

test("restore marks the Capsule stale because it restores state, not live resources", async () => {
  const { store, capsuleId } = await seedUpdatableCapsule();
  const controller = new OpenTofuController({
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(70),
    newId: deterministicIds(),
    runner: {
      restore: ({ stateScope }) =>
        Promise.resolve({
          state: {
            stateRef: stateScope.stateRef,
            digest: PLAN_DIGEST,
          },
        }),
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

  const restored = await store.getCapsule(capsuleId);
  const restoreRun = await store.getBackupRun(restore.id);
  expect(restoreRun?.status).toBe("succeeded");
  expect(restored?.currentStateGeneration).toBe(3);
  expect(restored?.status).toBe("stale");
  expect(lifecycle).toEqual([
    "started:running:running",
    "succeeded:succeeded:succeeded",
  ]);
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
      restore: ({ stateScope }) =>
        Promise.resolve({
          state: {
            stateRef: stateScope.stateRef,
            digest: PLAN_DIGEST,
          },
        }),
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
      restore: async ({ stateScope }) => {
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
        return {
          state: {
            stateRef: stateScope.stateRef,
            digest: PLAN_DIGEST,
          },
        };
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
      restore: async ({ stateScope }) => {
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
        return {
          state: {
            stateRef: stateScope.stateRef,
            digest: PLAN_DIGEST,
          },
        };
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
      restore: (job) => {
        return Promise.resolve({
          state: {
            generation: job.stateScope.generation,
            stateRef: job.stateScope.stateRef,
            digest: PLAN_DIGEST,
          },
        });
      },
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
    apply: () =>
      Promise.resolve({
        outputs,
      }),
    destroy: () => Promise.resolve({}),
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
