import { expect, test } from "bun:test";
import type { OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  createDefaultRunnerProfiles,
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import type {
  Connection,
  CreatePlanRunRequest,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  InMemoryServiceBindingStore,
  InMemoryServiceExportStore,
  InMemoryServiceGraphGrantStore,
  ServiceGraphService,
} from "../../../../core/domains/service-graph/mod.ts";
import {
  fakeProviderVault,
  seedInstallationModel,
} from "../../../helpers/deploy-control/model_fixture.ts";

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

/**
 * Installation-first model setup (spec §5). Seeds Space + Source + Snapshot +
 * InstallConfig + Installation into a freshly constructed store and returns it
 * alongside an `update` plan-run request bound to the seeded Installation. The
 * Installation is seeded WITH a current deployment so the apply-expected guard is
 * well-formed (an `update` PlanRun carries `installationCurrentDeploymentId`; a
 * fresh installation has no prior deployment to guard against). The store is
 * passed back so the caller can wire it into the controller it constructs.
 */
async function seedUpdatableInstallation(
  options: {
    readonly store?: InMemoryOpenTofuDeploymentStore;
    readonly spaceId?: string;
    readonly installationId?: string;
    readonly source?: CreatePlanRunRequest["source"];
    readonly runnerProfileId?: string;
    readonly requiredProviders?: readonly string[];
  } = {},
): Promise<{
  readonly store: InMemoryOpenTofuDeploymentStore;
  readonly installationId: string;
  readonly currentDeploymentId: string;
  readonly request: CreatePlanRunRequest;
}> {
  const store = options.store ?? new InMemoryOpenTofuDeploymentStore();
  const installationId = options.installationId ?? "inst_fixture";
  const { installation } = await seedInstallationModel(store, {
    spaceId: options.spaceId,
    installationId,
  });
  const requiredProviders = options.requiredProviders ?? [
    "registry.opentofu.org/cloudflare/cloudflare",
  ];
  await seedProviderConnections(store, installation, requiredProviders);
  const currentDeploymentId = `dep_seed_${installationId}`;
  await store.putInstallation({
    ...installation,
    currentDeploymentId,
    status: "active",
  });
  const request: CreatePlanRunRequest = {
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: options.source ?? SOURCE,
    requiredProviders,
    ...(options.runnerProfileId
      ? { runnerProfileId: options.runnerProfileId }
      : {}),
  };
  return { store, installationId, currentDeploymentId, request };
}

async function seedProviderConnections(
  store: InMemoryOpenTofuDeploymentStore,
  installation: {
    readonly id: string;
    readonly spaceId: string;
    readonly environment: string;
  },
  requiredProviders: readonly string[],
): Promise<void> {
  if (requiredProviders.length === 0) return;
  const now = "2026-06-06T00:00:00.000Z";
  const bindings = requiredProviders.map((provider) => {
    const shortName = providerShortName(provider);
    const connectionId = `conn_seed_${shortName}`;
    const connection: Connection = {
      id: connectionId,
      spaceId: installation.spaceId,
      provider: shortName,
      scope: "space",
      authMethod: "static_secret",
      status: "verified",
      envNames: providerEnvNames(shortName),
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    return {
      providerSource: provider,
      connection,
      binding: {
        provider: shortName,
        alias: "main",
        envId: connectionId,
      },
    };
  });
  for (const { connection, providerSource } of bindings) {
    await store.putConnection(connection);
    await store.putProviderEnv({
      id: connection.id,
      spaceId: installation.spaceId,
      providerSource,
      displayName: connection.provider,
      materialization: "secret",
      status: "ready",
      requiredEnvNames: connection.envNames ?? [],
      secretRef: connection.id,
      createdAt: now,
      updatedAt: now,
    });
  }
  await store.putInstallationProviderEnvBindingSet({
    id: `ipcset_seed_${installation.id}`,
    spaceId: installation.spaceId,
    installationId: installation.id,
    environment: installation.environment,
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

test("plan run stays queued when no OpenTofu runner is injected", async () => {
  const { store, request } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
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
  const { store, request } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
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
  expect(sidecar?.generatedRoot?.files["main.tf"]).toContain('module "app"');
  expect(sidecar?.generatedRoot?.files["main.tf"]).toContain(
    'source = "./template-module"',
  );
});

test("plan/apply records Installation, Deployment, and non-sensitive well-known outputs", async () => {
  const { store, request, installationId } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
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

  // A successful apply patches the pre-existing Installation to `active` with the
  // new current deployment + bumped state generation (§21), and records a
  // Deployment whose public outputs project only the non-sensitive well-known
  // value (`launch_url`); the sensitive output never lands on the run.
  expect(applied.applyRun.status).toEqual("succeeded");
  expect(applied.installation?.id).toEqual(installationId);
  expect(applied.installation?.status).toEqual("active");
  expect(applied.installation?.currentDeploymentId).toEqual(
    applied.deployment!.id,
  );
  expect(applied.installation?.currentStateGeneration).toEqual(1);
  expect(applied.deployment?.status).toEqual("active");
  expect(applied.deployment?.installationId).toEqual(installationId);
  expect(applied.deployment?.stateGeneration).toEqual(1);
  expect(applied.deployment?.outputsPublic).toEqual({
    launch_url: "https://app.example.test",
  });
  expect(applied.applyRun.stateBackend.kind).toEqual("operator-managed");
  expect(applied.applyRun.stateLock.status).toEqual("recorded");
  expect(applied.applyRun.stateLock.backendRef).toEqual(
    "state://takosumi/cloudflare-default",
  );
  expect(applied.applyRun.outputs).toEqual([
    {
      name: "launch_url",
      kind: "url",
      value: "https://app.example.test",
      sensitive: false,
    },
  ]);
  expect(
    applied.applyRun.outputs?.some((output) => output.name === "secret_value"),
  ).toEqual(false);
  expect(applied.applyRun.auditEvents.map((event) => event.type)).toContain(
    "apply.completed",
  );

  const deployments = await controller.listDeployments(
    applied.installation!.id,
  );
  expect(deployments.deployments.map((deployment) => deployment.id)).toEqual([
    applied.deployment!.id,
  ]);
});

test("apply projects allowlisted service_exports into the Service Graph", async () => {
  const { store, request } = await seedUpdatableInstallation();
  const installConfig = await store.getInstallConfig("cfg_fixture");
  await store.putInstallConfig({
    ...installConfig!,
    outputAllowlist: {
      ...installConfig!.outputAllowlist,
      service_exports: { from: "service_exports", type: "json" },
    },
  });
  const serviceGraphService = new ServiceGraphService({
    stores: {
      exports: new InMemoryServiceExportStore(),
      bindings: new InMemoryServiceBindingStore(),
      grants: new InMemoryServiceGraphGrantStore(),
    },
  });
  const controller = new OpenTofuDeploymentController({
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
        value: [
          {
            name: "tools",
            capabilities: ["protocol.mcp.server"],
            endpoints: [{ name: "mcp", url: "https://tools.example.test/mcp" }],
            visibility: "space",
          },
        ],
      },
    }),
    serviceGraphService,
  });

  const { planRun } = await controller.createPlanRun(request);
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const serviceExports = await serviceGraphService.listExportsByWorkspace(
    applied.installation!.spaceId,
  );

  expect(serviceExports).toHaveLength(1);
  expect(serviceExports[0]?.name).toBe("tools");
  expect(serviceExports[0]?.capabilities).toEqual(["protocol.mcp.server"]);
  expect(serviceExports[0]?.producerCapsuleId).toBe(applied.installation!.id);
  expect(serviceExports[0]?.applyRunId).toBe(applied.deployment!.applyRunId);
  expect(serviceExports[0]?.outputId).toBe(
    applied.deployment!.outputSnapshotId,
  );
});

test("PlanRun rejects installation operations outside the requested space", async () => {
  const { store, installationId } = await seedUpdatableInstallation({
    spaceId: "space_a",
  });
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(20),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  await expect(
    controller.createPlanRun({
      spaceId: "space_b",
      installationId,
      operation: "update",
      source: SOURCE,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/belongs to space space_a/);
});

test("PlanRun requires an existing Installation regardless of operation", async () => {
  // Installation-first model (spec §5): every plan / destroy plan targets an
  // existing Installation row. A raw createPlanRun with no installationId is a
  // failed_precondition for any operation; the create-on-apply legacy path is
  // removed.
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    now: sequenceNow(30),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
      operation: "update",
      source: SOURCE,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/plan requires an existing installationId/);

  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
      operation: "destroy",
      source: SOURCE,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/plan requires an existing installationId/);

  // A missing installationId target is a typed not_found (the id is consulted
  // before any operation-specific handling).
  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
      installationId: "inst_missing",
      operation: "update",
      source: SOURCE,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toMatchObject({
    name: "OpenTofuControllerError",
    code: "not_found",
  });
});

test("update and destroy PlanRuns stay bound to the targeted Installation", async () => {
  // The Space-direct Installation no longer carries a `source` identity or a
  // `runnerProfileId` (those are resolved through the InstallConfig / Source), so
  // the binding the run preserves is the Installation + its current Deployment
  // cursor: an update / destroy plan records the installationId, the operation,
  // and the Installation's current Deployment as the apply guard.
  const { store, installationId, currentDeploymentId } =
    await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(60),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  const { planRun: updatePlan } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    operation: "update",
    source: { ...SOURCE, ref: "release-2" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  expect(updatePlan.status).toEqual("succeeded");
  expect(updatePlan.installationId).toEqual(installationId);
  expect(updatePlan.operation).toEqual("update");
  expect(updatePlan.installationCurrentDeploymentId).toEqual(
    currentDeploymentId,
  );

  const { planRun: destroyPlan } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    operation: "destroy",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  expect(destroyPlan.status).toEqual("waiting_approval");
  expect(destroyPlan.installationId).toEqual(installationId);
  expect(destroyPlan.operation).toEqual("destroy");
  expect(destroyPlan.installationCurrentDeploymentId).toEqual(
    currentDeploymentId,
  );
});

test("apply rejects a stale update PlanRun after the current Deployment changes", async () => {
  const { store, installationId } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(80),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  // Two update plans are created against the SAME current Deployment.
  const { planRun: staleUpdate } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    operation: "update",
    source: { ...SOURCE, ref: "release-2" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  const { planRun: freshUpdate } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
    operation: "update",
    source: { ...SOURCE, ref: "release-3" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  // Applying the fresh plan moves the Installation's current Deployment forward.
  await controller.createApplyRun({
    planRunId: freshUpdate.id,
    expected: applyExpectedGuardFromPlanRun(freshUpdate),
  });

  // The stale plan was created against the prior current Deployment; its apply
  // must be rejected.
  await expect(
    controller.createApplyRun({
      planRunId: staleUpdate.id,
      expected: applyExpectedGuardFromPlanRun(staleUpdate),
    }),
  ).rejects.toThrow(/current Deployment changed/);
});

test("prepared source digest must be a canonical sha256 digest", async () => {
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    now: sequenceNow(90),
    newId: deterministicIds(),
  });

  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
      source: {
        kind: "prepared",
        url: "https://example.test/module.tar.gz",
        digest: "sha256:not-a-real-digest",
      },
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    }),
  ).rejects.toThrow(/prepared source digest/);
});

test("git source is restricted to safe HTTPS source URLs", async () => {
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    now: sequenceNow(91),
    newId: deterministicIds(),
  });
  const requiredProviders = ["registry.opentofu.org/cloudflare/cloudflare"];

  await expect(
    controller.createPlanRun({
      spaceId: "space_test",
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
      spaceId: "space_test",
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
      spaceId: "space_test",
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
      spaceId: "space_test",
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
      spaceId: "space_test",
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
      spaceId: "space_test",
      source: {
        kind: "git",
        url: "https://github.com/example/app.git",
        modulePath: "../other",
      },
      requiredProviders,
    }),
  ).rejects.toThrow(/source\.modulePath must stay inside/);
});

test("local source requires runner profile opt-in", async () => {
  const denying = await seedUpdatableInstallation({
    source: { kind: "local", path: "/workspace/module" },
  });
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store: denying.store,
    now: sequenceNow(40),
    newId: deterministicIds(),
  });

  await expect(controller.createPlanRun(denying.request)).rejects.toThrow(
    /does not allow local source paths/,
  );

  const localProfile: RunnerProfile = {
    ...createDefaultRunnerProfiles(40)[0],
    id: "local-dev",
    name: "Local dev",
    sourcePolicy: { allowLocalSource: true },
  };
  const allowing = await seedUpdatableInstallation({
    installationId: "inst_local",
    source: { kind: "local", path: "/workspace/module" },
    runnerProfileId: "local-dev",
  });
  const localController = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store: allowing.store,
    now: sequenceNow(50),
    newId: deterministicIds(),
    runnerProfiles: [localProfile],
    defaultRunnerProfileId: "local-dev",
  });
  const { planRun } = await localController.createPlanRun(allowing.request);
  expect(planRun.status).toEqual("queued");
});

test("runner diagnostics are redacted before PlanRun and ApplyRun persistence", async () => {
  const { store, request } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
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
  const { store, request } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
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
  const { store, request } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
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

test("runner profile policy blocks unsupported providers before execution", async () => {
  const { store, request } = await seedUpdatableInstallation({
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
  });
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: () => 30,
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  const { planRun } = await controller.createPlanRun(request);
  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.status).toEqual("blocked");
  expect(planRun.policy.reasons[0]).toContain("not allowed");
});

test("runner profile policy requires declared providers before execution", async () => {
  let runnerCalled = false;
  const { store, request } = await seedUpdatableInstallation({
    requiredProviders: [],
  });
  const controller = new OpenTofuDeploymentController({
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
          requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
        });
      },
      apply: () => Promise.resolve({}),
    },
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("failed");
  expect(runnerCalled).toEqual(false);
  expect(planRun.requiredProviders).toEqual([]);
  expect(planRun.policy.reasons.join("\n")).toContain(
    "requires requiredProviders",
  );
  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: {
        planRunId: planRun.id,
        runnerProfileId: planRun.runnerProfileId,
        sourceDigest: planRun.sourceDigest,
        variablesDigest: planRun.variablesDigest,
        policyDecisionDigest: planRun.policyDecisionDigest,
        planDigest: PLAN_DIGEST,
        planArtifactDigest: PLAN_DIGEST,
      },
    }),
  ).rejects.toMatchObject({
    name: "OpenTofuControllerError",
    code: "failed_precondition",
  });
});

test("runner profile policy blocks denied providers and missing credential refs", async () => {
  const profile: RunnerProfile = {
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
    requireCredentialRefs: true,
    credentialRefs: [],
    createdAt: 1,
  };
  const { store, request } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
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

test("runner profile policy blocks required providers without credential refs", async () => {
  const profile: RunnerProfile = {
    id: "credential-required",
    name: "Credential required",
    substrate: "cloudflare-containers",
    stateBackend: {
      kind: "operator-managed",
      ref: "state://credential-required",
    },
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    requireCredentialRefs: true,
    credentialRefs: [],
    createdAt: 1,
  };
  const { store, request } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: () => 36,
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
  expect(planRun.policy.reasons.join("\n")).toContain("credential reference");
});

test("InstallConfig provider allowlist blocks after RunnerProfile admits provider", async () => {
  const profile: RunnerProfile = {
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
  const { store, request } = await seedUpdatableInstallation({
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
    runnerProfileId: profile.id,
  });
  const seeded = await store.getInstallation(request.installationId!);
  const installConfig = await store.getInstallConfig(seeded!.installConfigId);
  await store.putInstallConfig({
    ...installConfig!,
    policy: {
      ...installConfig!.policy,
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    },
  });
  const controller = new OpenTofuDeploymentController({
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
  const { store, request } = await seedUpdatableInstallation({
    store: new InMemoryOpenTofuDeploymentStore(),
  });
  const seeded = await store.getInstallation(request.installationId!);
  const installConfig = await store.getInstallConfig(seeded!.installConfigId);
  await store.putInstallConfig({
    ...installConfig!,
    policy: {
      ...installConfig!.policy,
      allowedResourceTypes: ["cloudflare_r2_bucket"],
      scopeBoundary: {
        mode: "strict",
        cloudflare: { accountIds: ["acct_allowed"] },
      },
    },
  });
  const controller = new OpenTofuDeploymentController({
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
    "missing Cloudflare account metadata",
  );
});

test("plan policy admits matching scope metadata and blocks quota overflow", async () => {
  const { store, request } = await seedUpdatableInstallation();
  const seeded = await store.getInstallation(request.installationId!);
  const installConfig = await store.getInstallConfig(seeded!.installConfigId);
  await store.putInstallConfig({
    ...installConfig!,
    policy: {
      ...installConfig!.policy,
      allowedResourceTypes: ["cloudflare_r2_bucket"],
      scopeBoundary: {
        mode: "strict",
        cloudflare: { accountIds: ["acct_allowed"] },
      },
      quota: { "resources.total": 1 },
    },
  });
  const controller = new OpenTofuDeploymentController({
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
              scope: { cloudflareAccountId: "acct_allowed" },
            },
            {
              address: "cloudflare_r2_bucket.files_b",
              type: "cloudflare_r2_bucket",
              actions: ["create"],
              scope: { cloudflareAccountId: "acct_allowed" },
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

test("plan policy composes Space policy ceiling with InstallConfig policy", async () => {
  const { store, request } = await seedUpdatableInstallation();
  const space = await store.getSpace(request.spaceId);
  await store.putSpace({
    ...space!,
    policy: {
      allowedResourceTypes: ["cloudflare_r2_bucket"],
      quota: { "resources.total": 1 },
    },
  });
  const seeded = await store.getInstallation(request.installationId!);
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
  const controller = new OpenTofuDeploymentController({
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

test("default Cloudflare runner is an OSS provider runner without Cloud-only hosting metadata", () => {
  const cloudflare = createDefaultRunnerProfiles(123).find(
    (profile) => profile.id === "cloudflare-default",
  );

  expect(cloudflare?.substrate).toEqual("cloudflare-containers");
  expect(cloudflare?.cloudflareContainer?.queueName).toEqual("takosumi-runs");
  expect(cloudflare?.resourceLimits).toEqual({
    maxRunSeconds: 900,
    maxSourceArchiveBytes: 104857600,
    maxSourceDecompressedBytes: 1048576000,
    cpu: "1",
    memoryMb: 1024,
  });
  expect(cloudflare?.cloudflareWorkersForPlatforms).toBeUndefined();
  expect(cloudflare?.labels?.["takosumi.com/provider-runner"]).toEqual("true");
  expect(cloudflare?.secretExposurePolicy).toEqual({
    providerCredentials: "runner-only",
    tenantWorkerOperatorSecrets: "forbidden",
    redactLogs: true,
    blockSensitiveOutputs: true,
  });
});

test("default runner profile seeds cover provider-env targets and future/custom candidates", () => {
  const profiles = createDefaultRunnerProfiles(123);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  expect(Array.from(byId.keys())).toEqual([
    "cloudflare-default",
    "aws-provider-env-candidate",
    "gcp-provider-env-candidate",
    "azure-provider-env-candidate",
    "kubernetes-provider-env-candidate",
    "github-provider-env-candidate",
    "digitalocean-provider-env-candidate",
    "docker-custom-example",
    "generic-opentofu-provider",
  ]);
  expect(byId.get("azure-provider-env-candidate")?.allowedProviders).toEqual([
    "registry.opentofu.org/hashicorp/azurerm",
  ]);
  expect(
    byId.get("kubernetes-provider-env-candidate")?.allowedProviders,
  ).toEqual([
    "registry.opentofu.org/hashicorp/kubernetes",
    "registry.opentofu.org/hashicorp/helm",
  ]);
  expect(byId.get("github-provider-env-candidate")?.allowedProviders).toEqual([
    "registry.opentofu.org/integrations/github",
  ]);
  expect(
    byId.get("digitalocean-provider-env-candidate")?.allowedProviders,
  ).toEqual(["registry.opentofu.org/digitalocean/digitalocean"]);
  expect(byId.get("docker-custom-example")?.substrate).toEqual("local");
  expect(byId.get("docker-custom-example")?.cloudflareContainer).toEqual(
    undefined,
  );
  expect(byId.get("generic-opentofu-provider")?.allowedProviders).toEqual([
    "*",
  ]);
  expect(byId.get("generic-opentofu-provider")?.networkPolicy).toEqual({
    mode: "operator-managed",
  });
  expect(byId.get("generic-opentofu-provider")?.requireCredentialRefs).toEqual(
    false,
  );
  expect(
    byId.get("generic-opentofu-provider")?.labels?.[
      "takosumi.com/provider-surface"
    ],
  ).toEqual("generic");
  expect(
    byId.get("cloudflare-default")?.labels?.["takosumi.com/profile-state"],
  ).toEqual(undefined);
  for (const id of [
    "aws-provider-env-candidate",
    "gcp-provider-env-candidate",
    "kubernetes-provider-env-candidate",
    "github-provider-env-candidate",
    "azure-provider-env-candidate",
    "digitalocean-provider-env-candidate",
    "docker-custom-example",
    "generic-opentofu-provider",
  ]) {
    expect(byId.get(id)?.labels?.["takosumi.com/profile-state"]).toEqual(
      "candidate",
    );
  }
});

test("default runner profile seeds record provider network policy patterns", () => {
  const profiles = createDefaultRunnerProfiles(123);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  expect(
    byId.get("aws-provider-env-candidate")?.networkPolicy?.allowedHostPatterns,
  ).toContain("*.amazonaws.com");
  expect(
    byId.get("gcp-provider-env-candidate")?.networkPolicy?.allowedHostPatterns,
  ).toContain("*.googleapis.com");
  expect(
    byId.get("azure-provider-env-candidate")?.networkPolicy?.allowedHosts,
  ).toContain("management.azure.com");
  expect(
    byId.get("azure-provider-env-candidate")?.networkPolicy
      ?.allowedHostPatterns,
  ).toContain("*.microsoftonline.com");
  expect(
    byId.get("kubernetes-provider-env-candidate")?.networkPolicy?.mode,
  ).toEqual("operator-managed");
  expect(
    byId.get("digitalocean-provider-env-candidate")?.networkPolicy
      ?.allowedHosts,
  ).toContain("api.digitalocean.com");
});

test("candidate runner profiles are blocked until operator validation enables them", async () => {
  const { store, request } = await seedUpdatableInstallation({
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
    runnerProfileId: "aws-provider-env-candidate",
  });
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: () => 38,
    newId: deterministicIds(),
    runner: fakeRunner(),
    defaultRunnerProfileId: "aws-provider-env-candidate",
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.reasons.join("\n")).toContain("disabled candidate");
});

test("operator-enabled candidate runner profiles can pass provider policy", async () => {
  const profile = createDefaultRunnerProfiles(123).find(
    (candidate) => candidate.id === "aws-provider-env-candidate",
  )!;
  const { store, request } = await seedUpdatableInstallation({
    requiredProviders: ["registry.opentofu.org/hashicorp/aws"],
    runnerProfileId: profile.id,
  });
  const controller = new OpenTofuDeploymentController({
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
    runnerProfiles: [
      {
        ...profile,
        labels: {
          ...profile.labels,
          "takosumi.com/profile-enabled": "true",
        },
      },
    ],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
});

test("generic-env providers run on an ordinary runner profile when the provider is allowed", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const { store, request, installationId } = await seedUpdatableInstallation({
    requiredProviders: [provider],
    runnerProfileId: "vercel-template",
  });
  await store.putConnection({
    id: "conn_vercel",
    spaceId: "space_test",
    provider,
    kind: "generic_env_provider",
    scope: "space",
    authMethod: "generic_env",
    displayName: "Vercel generic env",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    verifiedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putProviderEnv({
    id: "penv_vercel",
    spaceId: "space_test",
    providerSource: provider,
    displayName: "Vercel generic env",
    materialization: "secret",
    status: "ready",
    requiredEnvNames: ["VERCEL_API_TOKEN"],
    secretRef: "conn_vercel",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_vercel",
    spaceId: "space_test",
    installationId,
    environment: "production",
    bindings: [
      {
        provider,
        alias: "main",
        envId: "penv_vercel",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile: RunnerProfile = {
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
  const controller = new OpenTofuDeploymentController({
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

test("generic-env provider policy also passes with a Space generic-env connection and custom runner class", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const { store, request, installationId } = await seedUpdatableInstallation({
    requiredProviders: [provider],
    runnerProfileId: "vercel-custom",
  });
  await store.putConnection({
    id: "conn_vercel",
    spaceId: "space_test",
    provider,
    kind: "generic_env_provider",
    scope: "space",
    authMethod: "generic_env",
    displayName: "Vercel generic env",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    verifiedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putProviderEnv({
    id: "penv_vercel",
    spaceId: "space_test",
    providerSource: provider,
    displayName: "Vercel generic env",
    materialization: "secret",
    status: "ready",
    requiredEnvNames: ["VERCEL_API_TOKEN"],
    secretRef: "conn_vercel",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_vercel",
    spaceId: "space_test",
    installationId,
    environment: "production",
    bindings: [
      {
        provider,
        alias: "main",
        envId: "penv_vercel",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile: RunnerProfile = {
    id: "vercel-custom",
    name: "Vercel custom",
    substrate: "cloudflare-containers",
    allowedProviders: [provider],
    labels: {
      "takosumi.com/runner-class": "custom",
    },
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
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault({
      provider,
      connectionId: "conn_vercel",
    }) as never,
    store,
    now: sequenceNow(42),
    newId: deterministicIds(),
    runner: fakeRunner(),
    providerEnvRunner: customRunner,
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createPlanRun(request);

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
});

test("destroy is recorded as an ApplyRun when the runner succeeds", async () => {
  const { store, installationId } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(40),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  const { planRun: destroyPlan } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
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
  expect(destroyed.installation?.status).toEqual("destroyed");
  expect(destroyed.installation?.currentDeploymentId ?? null).toEqual(null);
  expect(destroyed.applyRun.auditEvents.map((event) => event.type)).toContain(
    "destroy.completed",
  );
});

test("destroy apply is rejected until the plan is approved (always two-stage, spec §10.6)", async () => {
  const { store, installationId } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(40),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });

  const { planRun: destroyPlan } = await controller.createPlanRun({
    spaceId: "space_test",
    installationId,
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

test("restore marks the Installation stale because it restores state, not live resources", async () => {
  const { store, installationId } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(70),
    newId: deterministicIds(),
    runner: {
      restore: ({ stateScope }) =>
        Promise.resolve({
          state: {
            objectKey: `states/${stateScope.generation}.tfstate.enc`,
            digest: PLAN_DIGEST,
          },
        }),
    },
  });
  const installation = await store.getInstallation(installationId);
  expect(installation).toBeDefined();
  await store.putStateSnapshot({
    id: "state_restore_source",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    generation: 1,
    objectKey: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    objectKey: "spaces/space_test/backups/bkp_restore/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallation({
    ...installation!,
    status: "destroyed",
    currentStateGeneration: 2,
    updatedAt: "2026-06-06T00:00:01.000Z",
  });

  const restore = await controller.createRestoreRun(
    installation!.spaceId,
    "bkp_restore",
    {
      installationId,
      environment: installation!.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "ops" });
  await controller.runQueuedRestore(restore.id);

  const restored = await store.getInstallation(installationId);
  const restoreRun = await store.getBackupRun(restore.id);
  expect(restoreRun?.status).toBe("succeeded");
  expect(restored?.currentStateGeneration).toBe(3);
  expect(restored?.status).toBe("stale");
});

test("restore does not publish state after losing its run lease", async () => {
  const { store, installationId } = await seedUpdatableInstallation();
  const installation = await store.getInstallation(installationId);
  expect(installation).toBeDefined();
  await store.putStateSnapshot({
    id: "state_restore_lost_source",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    generation: 1,
    objectKey: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_lost",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    objectKey:
      "spaces/space_test/backups/bkp_restore_lost/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallation({
    ...installation!,
    status: "destroyed",
    currentStateGeneration: 2,
    updatedAt: "2026-06-06T00:00:01.000Z",
  });
  let restoreRunId = "";
  const controller = new OpenTofuDeploymentController({
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
            objectKey: `states/${stateScope.generation}.tfstate.enc`,
            digest: PLAN_DIGEST,
          },
        };
      },
    },
  });
  const restore = await controller.createRestoreRun(
    installation!.spaceId,
    "bkp_restore_lost",
    {
      installationId,
      environment: installation!.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  restoreRunId = restore.id;
  await controller.approveRun(restore.id, { approvedBy: "ops" });
  await controller.runQueuedRestore(restore.id);

  const restored = await store.getInstallation(installationId);
  const restoreRun = await store.getBackupRun(restore.id);
  expect(restoreRun?.status).toBe("running");
  expect(restoreRun?.heartbeatAt).toBe(999_000);
  expect(restored?.currentStateGeneration).toBe(2);
  expect(
    (
      await store.listStateSnapshots(installationId, installation!.environment)
    ).find((snapshot) => snapshot.generation === 3),
  ).toBeUndefined();
});

test("restore renews the run heartbeat while the runner blocks", async () => {
  const { store, installationId } = await seedUpdatableInstallation();
  const installation = await store.getInstallation(installationId);
  expect(installation).toBeDefined();
  await store.putStateSnapshot({
    id: "state_restore_heartbeat_source",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    generation: 1,
    objectKey: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_heartbeat",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    objectKey:
      "spaces/space_test/backups/bkp_restore_heartbeat/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  let clock = 800;
  let restoreRunId = "";
  let claimHeartbeat = 0;
  let midFlightHeartbeat = 0;
  const controller = new OpenTofuDeploymentController({
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
            objectKey: `states/${stateScope.generation}.tfstate.enc`,
            digest: PLAN_DIGEST,
          },
        };
      },
    },
  });
  const restore = await controller.createRestoreRun(
    installation!.spaceId,
    "bkp_restore_heartbeat",
    {
      installationId,
      environment: installation!.environment,
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
  const { store, installationId } = await seedUpdatableInstallation();
  const serviceData = {
    objectKey: "spaces/space_test/backups/bkp_restore/service-data.tar.zst.enc",
    digest: "sha256:service-data",
    sizeBytes: 42,
    exportedCount: 3,
    unsupportedCount: 0,
    missingCount: 0,
  };
  const restoreJobs: Array<{
    readonly serviceData?: typeof serviceData;
  }> = [];
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(75),
    newId: deterministicIds(),
    runner: {
      restore: (job) => {
        return Promise.resolve({
          state: {
            generation: job.stateScope.generation,
            objectKey: `states/${job.stateScope.generation}.tfstate.enc`,
            digest: PLAN_DIGEST,
          },
        });
      },
      restoreServiceData: (job) => {
        restoreJobs.push({ serviceData: job.serviceData });
        return Promise.resolve({
          status: "restored",
          objectKey: job.serviceData.objectKey,
          digest: job.serviceData.digest,
          sizeBytes: job.serviceData.sizeBytes,
          restoredCount: job.serviceData.exportedCount,
        });
      },
    },
  });
  const installation = await store.getInstallation(installationId);
  expect(installation).toBeDefined();
  await store.putStateSnapshot({
    id: "state_restore_service_data_source",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    generation: 1,
    objectKey: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_service_data",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    objectKey:
      "spaces/space_test/backups/bkp_restore_service_data/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    serviceData,
    createdAt: "2026-06-06T00:00:00.000Z",
  });

  const restore = await controller.createRestoreRun(
    installation!.spaceId,
    "bkp_restore_service_data",
    {
      installationId,
      environment: installation!.environment,
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
    objectKey: serviceData.objectKey,
    digest: serviceData.digest,
    sizeBytes: serviceData.sizeBytes,
    restoredCount: serviceData.exportedCount,
  });
});

test("restoreServiceData fails closed when the backup has no service-data artifact", async () => {
  const { store, installationId } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(80),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const installation = await store.getInstallation(installationId);
  expect(installation).toBeDefined();
  await store.putStateSnapshot({
    id: "state_restore_without_service_data_source",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    generation: 1,
    objectKey: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_without_service_data",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    objectKey:
      "spaces/space_test/backups/bkp_restore_without_service_data/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-06T00:00:00.000Z",
  });

  await expect(
    controller.createRestoreRun(
      installation!.spaceId,
      "bkp_restore_without_service_data",
      {
        installationId,
        environment: installation!.environment,
        stateGeneration: 1,
        expectedBackupDigest: PLAN_DIGEST,
        restoreServiceData: true,
      },
    ),
  ).rejects.toThrow(/no service-data artifact/);
});

test("restoreServiceData fails closed when the runner lacks service-data restore capability", async () => {
  const { store, installationId } = await seedUpdatableInstallation();
  const controller = new OpenTofuDeploymentController({
    vault: fakeProviderVault() as never,
    store,
    now: sequenceNow(85),
    newId: deterministicIds(),
    runner: fakeRunner(),
  });
  const installation = await store.getInstallation(installationId);
  expect(installation).toBeDefined();
  await store.putStateSnapshot({
    id: "state_restore_service_data_unwired_source",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    generation: 1,
    objectKey: "states/1.tfstate.enc",
    digest: LOCK_DIGEST,
    createdByRunId: "apply_seed",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putBackupRecord({
    id: "bkp_restore_service_data_unwired",
    spaceId: installation!.spaceId,
    installationId,
    environment: installation!.environment,
    objectKey:
      "spaces/space_test/backups/bkp_restore_service_data_unwired/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    serviceData: {
      objectKey:
        "spaces/space_test/backups/bkp_restore_service_data_unwired/service-data.tar.zst.enc",
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
      installation!.spaceId,
      "bkp_restore_service_data_unwired",
      {
        installationId,
        environment: installation!.environment,
        stateGeneration: 1,
        expectedBackupDigest: PLAN_DIGEST,
        restoreServiceData: true,
      },
    ),
  ).rejects.toThrow(/service-data restore-capable runner/);
});

test("not found surfaces the closed controller error code", async () => {
  const controller = new OpenTofuDeploymentController({
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
