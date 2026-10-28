import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";

test("composed install routes create owned Source, sync, and Capsule authority while claiming a recorded legacy Source", async () => {
  const deployStore = new InMemoryOpenTofuControlStore();
  // Git execution is the external boundary. Coordinator, Source, Capsule,
  // and ledger operations all use their production service implementations.
  const runner: OpenTofuRunner = {
    plan: async () => { throw new Error("Plan execution is outside this test"); },
    apply: async () => { throw new Error("Apply execution is outside this test"); },
    sourceSync: async () => ({
      resolvedCommit: "a".repeat(40),
      archiveDigest: `sha256:${"b".repeat(64)}`,
      archiveSizeBytes: 64,
      repositoryInstallMetadata: { status: "absent" },
      repositoryManifest: { status: "absent" },
      repositoryModules: {
        status: "ready",
        scopePath: ".",
        modules: [{
          path: ".",
          providerPackages: [],
          rootProviderRequirements: [],
        }],
      },
    }),
    readCapsuleSourceFiles: async () => [{
      path: "main.tf",
      text: "output \"ready\" { value = \"yes\" }\n",
    }],
  };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const workspace = await operations.workspaces.createWorkspace({
    handle: "install-composition",
    displayName: "Install composition",
    type: "personal",
    ownerUserId: "user_install_composition",
  });
  const accountStore = new InMemoryAccountsStore();
  const now = Date.now();
  accountStore.saveAccount({
    subject: "user_install_composition",
    email: "installer@example.test",
    displayName: "Installer",
    createdAt: now,
    updatedAt: now,
  });
  accountStore.saveAccountSession({
    sessionId: "sess_install_composition",
    subject: "user_install_composition",
    createdAt: now,
    expiresAt: now + 60_000,
  });

  async function route(method: string, path: string, body?: unknown, key?: string) {
    const url = new URL(`https://app.takosumi.test${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_install_composition`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accountStore,
      operations,
    });
    expect(response).toBeDefined();
    return response!;
  }

  const created = await route(
    "POST",
    `/api/v1/workspaces/${workspace.id}/install-plans`,
    {
      source: {
        name: "example",
        url: "https://github.com/takos/example.git",
        ref: "main",
        path: ".",
      },
      capsule: { name: "example", environment: "production" },
      options: { modulePath: ".", providerBindings: [] },
    },
    "composed-install",
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;

  const registered = await route("POST", `/api/v1/install-plans/${planId}/reconcile`);
  expect(registered.status).toBe(200);
  const sourceId = (await registered.json()).installPlan.sourceId as string;
  const source = await deployStore.getSource(sourceId);
  expect(source).toMatchObject({
    id: sourceId,
    workspaceId: workspace.id,
    ownerCapsuleId: `cap_${planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16)}`,
    createdByInstallPlanId: planId,
    name: "example",
    url: "https://github.com/takos/example",
    defaultRef: "main",
    defaultPath: ".",
  });

  const queued = await route("POST", `/api/v1/install-plans/${planId}/reconcile`);
  expect(queued.status).toBe(200);
  const next = (await queued.json()).installPlan;
  const syncId = next.sourceSyncRunId as string;
  expect(next).toMatchObject({
    phase: "syncing_source",
    sourceId,
  });
  expect(syncId).toMatch(/^ssr_[0-9a-f]{16}$/u);
  const sync = await deployStore.getSourceSyncRun(syncId);
  expect(sync).toMatchObject({
    workspaceId: workspace.id,
    sourceId,
    url: source?.url,
    ref: "main",
    path: ".",
    intent: "manual_plan",
    status: "succeeded",
    snapshotId: expect.stringMatching(/^snap_[0-9a-f]{16}$/u),
  });
  expect((await operations.gitInstallPlans.get(planId))?.sourceSyncRunId).toBe(sync?.id);

  let phase = next.phase as string;
  let installConfigId: string | undefined;
  let capsuleId: string | undefined;
  for (let step = 0; step < 6 && phase !== "planning"; step += 1) {
    const advanced = await route("POST", `/api/v1/install-plans/${planId}/reconcile`);
    expect(advanced.status).toBe(200);
    const plan = (await advanced.json()).installPlan;
    phase = plan.phase;
    installConfigId = plan.installConfigId;
    capsuleId = plan.capsuleId;
  }
  expect(phase).toBe("planning");
  expect(capsuleId).toBeString();
  expect(installConfigId).toBeString();
  const capsule = await deployStore.getCapsule(capsuleId!);
  expect(capsule).toMatchObject({
    id: capsuleId,
    sourceId,
    installConfigId,
    installingPrincipalId: "user_install_composition",
    status: "pending",
  });
  expect((await deployStore.getSource(sourceId))?.ownerCapsuleId).toBe(capsuleId);

  const installConfig = await operations.capsules.getInstallConfig(installConfigId!);
  const otherCreatedAt = new Date().toISOString();
  await expect(operations.capsules.createCapsuleInitialAuthority({
    capsuleId: "cap_other_install_composition",
    providerBindingSetId: "ipcset_other_install_composition",
    workspaceId: workspace.id,
    name: "other-app",
    environment: "production",
    sourceId,
    installingPrincipalId: "user_install_composition",
    installConfig: {
      ...installConfig,
      id: "icfg_other_install_composition",
      createdAt: otherCreatedAt,
      updatedAt: otherCreatedAt,
    },
    providerBindings: [],
  })).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "source_owned_by_another_app" },
  });
  expect(await deployStore.getCapsule("cap_other_install_composition"))
    .toBeUndefined();

  // A coordinator row from the prior release may have recorded an ownerless
  // Source. Resume that exact row through the same composed route. The real
  // Capsule store must atomically claim the Source for this app.
  const legacySource = await operations.createSource({
    workspaceId: workspace.id,
    name: "legacy",
    url: "https://github.com/takos/example",
    defaultRef: "main",
    defaultPath: ".",
  });
  expect((await deployStore.getSource(legacySource.source.id))?.ownerCapsuleId)
    .toBeUndefined();
  const legacyCreated = await route(
    "POST",
    `/api/v1/workspaces/${workspace.id}/install-plans`,
    {
      source: {
        name: "legacy",
        url: "https://github.com/takos/example.git",
        ref: "main",
        path: ".",
      },
      capsule: { name: "legacy", environment: "production" },
      options: { modulePath: ".", providerBindings: [] },
    },
    "composed-legacy-install",
  );
  expect(legacyCreated.status).toBe(201);
  const legacyPlanId = (await legacyCreated.json()).installPlan.id as string;
  const legacyPlan = (await operations.gitInstallPlans.get(legacyPlanId))!;
  const recorded = await operations.gitInstallPlans.transitionUnleased({
    id: legacyPlanId,
    expectedGeneration: legacyPlan.generation,
    expectedPhase: legacyPlan.phase,
    plan: {
      ...legacyPlan,
      generation: legacyPlan.generation + 1,
      sourceId: legacySource.source.id,
    },
    at: new Date().toISOString(),
  });
  expect(recorded.status).toBe("updated");
  let legacyPhase = "syncing_source";
  let legacyCapsuleId: string | undefined;
  for (let step = 0; step < 7 && legacyPhase !== "planning"; step += 1) {
    const advanced = await route("POST", `/api/v1/install-plans/${legacyPlanId}/reconcile`);
    expect(advanced.status).toBe(200);
    const plan = (await advanced.json()).installPlan;
    legacyPhase = plan.phase;
    legacyCapsuleId = plan.capsuleId;
  }
  expect(legacyPhase).toBe("planning");
  expect(legacyCapsuleId).toBeString();
  expect(await deployStore.getCapsule(legacyCapsuleId!)).toMatchObject({
    sourceId: legacySource.source.id,
    installingPrincipalId: "user_install_composition",
  });
  expect((await deployStore.getSource(legacySource.source.id))?.ownerCapsuleId)
    .toBe(legacyCapsuleId);
});
