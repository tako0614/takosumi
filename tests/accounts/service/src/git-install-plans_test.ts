import { expect, test } from "bun:test";

import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleAuthenticatedControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { defaultCapsuleInstallConfig } from "../../../../core/domains/capsules/default_install_config.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import {
  InMemoryOpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { InMemoryGitInstallPlanStore } from "../../../../core/domains/install-plans/store.ts";
import type { CapsuleCompatibilityReport } from "../../../../contract/capsules.ts";
import type {
  ProviderBindingSet,
  ProviderConnection,
} from "../../../../contract/connections.ts";
import type { Run } from "../../../../contract/runs.ts";
import type {
  RepositoryModuleRootProviderRequirement,
  Source,
  SourceSnapshot,
  SourceSyncRun,
} from "../../../../contract/sources.ts";
import type {
  Capsule,
  InstallConfig,
} from "../../../../contract/install-configs.ts";
import type { GitInstallPlanProviderBindingRequest } from "../../../../contract/install-plans.ts";

const ADMIN_SUBJECT = "tsub_admin";
const VIEWER_SUBJECT = "tsub_viewer";

const WORKSPACE = {
  id: "ws_install",
  handle: "install",
  displayName: "Install",
  type: "personal" as const,
  ownerUserId: "tsub_installer",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

test("Accounts Git install plan explicitly reconciles to one reviewable canonical Run", async () => {
  const fixture = installFixture();
  const first = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings: [] }),
    { "idempotency-key": "install-exactly-once" },
  );
  expect(first.status).toBe(201);
  const created = await first.json();
  expect(created).toMatchObject({
    installPlan: { phase: "syncing_source", generation: 0 },
    nextAction: "reconcile",
    links: { reconcile: expect.stringContaining("/reconcile") },
  });
  const planId = created.installPlan.id as string;
  expect(JSON.stringify(created)).not.toContain("install-exactly-once");
  expect((await fixture.planStore.get(planId))?.idempotencyKeyHash).not.toBe(
    "install-exactly-once",
  );

  const replay = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings: [] }),
    { "idempotency-key": "install-exactly-once" },
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).installPlan.id).toBe(planId);
  expect((await fixture.planStore.get(planId))?.options).toEqual({
    providerBindings: [],
  });

  const conflict = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ capsuleName: "different" }),
    { "idempotency-key": "install-exactly-once" },
  );
  expect(conflict.status).toBe(409);

  let response = await fixture.reconcile(planId); // create Source
  expect((await response.clone().json()).installPlan.sourceId).toBe("src_one");
  response = await fixture.reconcile(planId); // create pending Source sync
  const pending = await response.json();
  expect(pending.installPlan).toMatchObject({
    phase: "syncing_source",
    sourceSyncRunId: "ssr_one",
  });

  const mutationsBeforeGet = fixture.mutationCount();
  const generationBeforeGet = pending.installPlan.generation;
  const readOnly = await fixture.request(`/api/v1/install-plans/${planId}`);
  expect(readOnly.status).toBe(200);
  expect((await readOnly.json()).installPlan.generation).toBe(
    generationBeforeGet,
  );
  expect(fixture.mutationCount()).toBe(mutationsBeforeGet);

  fixture.succeedSourceSync();
  for (let step = 0; step < 5; step += 1) {
    response = await fixture.reconcile(planId);
  }
  const reviewable = await response.json();
  expect(reviewable).toMatchObject({
    installPlan: {
      phase: "reviewable",
      sourceId: "src_one",
      sourceSyncRunId: "ssr_one",
      sourceSnapshotId: "snap_one",
      installConfigId: expect.stringMatching(/^icfg_[0-9a-f]{16}$/u),
      capsuleId: expect.stringMatching(/^cap_[A-Za-z0-9]{16}$/u),
      planRunId: expect.stringMatching(/^plan_[A-Za-z0-9]{16}$/u),
    },
    nextAction: "review_run",
    links: {
      self: `/api/v1/install-plans/${planId}`,
      run: expect.stringMatching(/^\/api\/v1\/runs\/plan_/u),
    },
  });
  expect(reviewable.installPlan.installModulePath).toBe(".");
  expect(reviewable.links.reconcile).toBeUndefined();
  expect(reviewable.links.apply).toBeUndefined();
  expect(fixture.counts).toEqual({ source: 1, sync: 1, capsule: 1, plan: 1 });
  expect(fixture.approvalCalls).toBe(0);
  expect(fixture.applyCalls).toBe(0);

  const denied = await fixture.request(
    `/api/v1/install-plans/${planId}`,
    "GET",
    undefined,
    {},
    "tsub_foreign",
  );
  expect(denied.status).toBe(403);
});

test("reviewed preflight creates exact initial authority atomically and only returns a review Run", async () => {
  const fixture = installFixture();
  const preflight = fixture.seedPreflight({
    variableDeclarations: [
      {
        name: "region",
        type: "string",
        sensitive: false,
        hasDefault: false,
      },
    ],
  });
  const body = {
    ...createBody({ modulePath: ".", providerBindings: [] }),
    preflight,
    variables: { region: "top-secret-reviewed-value" },
    initialConfiguration: {
      runnerProfileId: "opentofu-default",
      outputAllowlist: {
        endpoint: { from: "endpoint", type: "url", required: true },
      },
    },
  };
  const first = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "reviewed-preflight-atomic" },
  );
  expect(first.status).toBe(201);
  const firstPayload = await first.clone().json();
  expect(firstPayload.installPlan).toMatchObject({
    phase: "creating_capsule",
    sourceId: preflight.sourceId,
    sourceSnapshotId: preflight.sourceSnapshotId,
    compatibilityCheckRunId: preflight.compatibilityCheckRunId,
    compatibilityReportId: preflight.compatibilityReportId,
  });
  expect(firstPayload.installPlan.preflightInstallConfigDigest).toBeUndefined();
  expect(JSON.stringify(firstPayload)).not.toContain("top-secret-reviewed-value");
  const planId = firstPayload.installPlan.id as string;
  expect(
    (await fixture.planStore.get(planId))?.preflightInstallConfigDigest,
  ).toMatch(/^sha256:[0-9a-f]{64}$/u);
  // The public request digest covers variable names, never their values.
  expect(firstPayload.installPlan.requestDigest).toBe(
    await stableJsonDigest({
      source: { name: "example", url: "https://github.com/takos/example", ref: "main", path: "." },
      capsule: { name: "example", environment: "production" },
      options: { modulePath: ".", providerBindings: [] },
      preflight,
      initialConfiguration: body.initialConfiguration,
      variableNames: ["region"],
    }),
  );

  const createdAuthority = await fixture.reconcile(planId);
  expect(createdAuthority.status).toBe(200);
  const planning = await createdAuthority.clone().json();
  expect(planning.installPlan.phase).toBe("planning");
  expect(JSON.stringify(await fixture.planStore.get(planId))).not.toContain(
    "top-secret-reviewed-value",
  );
  expect(fixture.counts).toEqual({ source: 0, sync: 0, capsule: 1, plan: 0 });
  expect(fixture.compatibilityMutationCount).toBe(0);
  expect(fixture.installConfigMutationCount).toBe(1);
  const config = fixture.getInstallConfig(planning.installPlan.installConfigId);
  expect(config).toMatchObject({
    workspaceId: WORKSPACE.id,
    modulePath: ".",
    variableMapping: { region: "top-secret-reviewed-value" },
    runnerId: "opentofu-default",
    outputAllowlist: {
      endpoint: { from: "endpoint", type: "url", required: true },
    },
    internal: {
      genericOpenTofuSourceSnapshotId: preflight.sourceSnapshotId,
    },
  });

  const reviewable = await fixture.reconcile(planId);
  const reviewPayload = await reviewable.clone().json();
  expect(reviewPayload.installPlan).toMatchObject({
    phase: "reviewable",
    planRunId: expect.stringMatching(/^plan_[A-Za-z0-9]{16}$/u),
  });
  expect(reviewPayload.nextAction).toBe("review_run");
  expect(fixture.counts).toEqual({ source: 0, sync: 0, capsule: 1, plan: 1 });
  expect(JSON.stringify(reviewPayload)).not.toContain("top-secret-reviewed-value");

  const replay = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "reviewed-preflight-atomic" },
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).installPlan.id).toBe(planId);
  expect(fixture.counts).toEqual({ source: 0, sync: 0, capsule: 1, plan: 1 });
});

test("reviewed preflight fails closed when its pinned host authority changes before atomic creation", async () => {
  const fixture = installFixture();
  const preflight = fixture.seedPreflight({
    variableDeclarations: [
      {
        name: "region",
        type: "string",
        sensitive: false,
        hasDefault: false,
      },
    ],
  });
  const body = {
    ...createBody({ modulePath: ".", providerBindings: [] }),
    preflight,
    variables: { region: "ap-northeast-1" },
  };
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "reviewed-preflight-drift" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;

  fixture.replaceInstallConfig("cfg-default-opentofu-capsule", {
    variableMapping: { operatorChanged: true },
  });
  const reconciled = await fixture.reconcile(planId);
  expect(reconciled.status).toBe(200);
  expect((await reconciled.json()).installPlan).toMatchObject({
    phase: "failed",
    diagnostic: {
      code: "install_preflight_config_identity_changed",
    },
  });
  expect(fixture.counts).toEqual({ source: 0, sync: 0, capsule: 0, plan: 0 });
  expect(fixture.installConfigMutationCount).toBe(0);
  // A terminal record never keeps reviewed values.
  expect((await fixture.planStore.get(planId))?.initialVariables).toBeUndefined();
  expect(JSON.stringify(await fixture.planStore.get(planId))).not.toContain(
    "ap-northeast-1",
  );

  const replay = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "reviewed-preflight-drift" },
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).installPlan).toMatchObject({
    id: planId,
    phase: "failed",
  });
  expect(fixture.counts.capsule).toBe(0);
});

test("Git install POST rejects preparation captured before drain and resume", async () => {
  const fixture = installFixture({ pausePreparation: true });
  const preflight = fixture.seedPreflight({
    variableDeclarations: [
      {
        name: "region",
        type: "string",
        sensitive: false,
        hasDefault: false,
      },
    ],
  });
  const body = {
    ...createBody({ modulePath: ".", providerBindings: [] }),
    preflight,
    variables: { region: "ap-northeast-1" },
  };

  const pending = fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "install-stale-management-epoch" },
  );
  await fixture.preparationStarted;
  await fixture.drainAndResume();
  fixture.releasePreparation();

  const response = await pending;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "workspace_management_admission_conflict" },
    },
  });
  expect(
    await fixture.planStore.getByScope({
      workspaceId: WORKSPACE.id,
      actorSubject: WORKSPACE.ownerUserId,
      idempotencyKeyHash: await stableJsonDigest(
        "install-stale-management-epoch",
      ),
    }),
  ).toBeUndefined();
});

test("Git install POST replays an exact idempotency key while draining", async () => {
  const fixture = installFixture();
  const body = createBody({ providerBindings: [] });
  const first = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "install-draining-replay" },
  );
  expect(first.status).toBe(201);
  const planId = (await first.json()).installPlan.id as string;

  await fixture.beginDrain();
  const replay = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "install-draining-replay" },
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).installPlan.id).toBe(planId);
});

test("Git install reconciliation uses the original private management authority", async () => {
  const fixture = installFixture();
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings: [] }),
    { "idempotency-key": "install-persisted-management-authority" },
  );
  expect(created.status).toBe(201);
  const payload = await created.json();
  const planId = payload.installPlan.id as string;
  expect(JSON.stringify(payload)).not.toContain("workspaceManagementAuthority");
  expect((await fixture.planStore.get(planId))?.workspaceManagementAuthority).toEqual({
    workspaceId: WORKSPACE.id,
    managementState: "active",
    managementEpoch: 1,
  });

  await fixture.drainAndResume();
  const rejected = await fixture.reconcile(planId);
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "workspace_management_admission_conflict" },
    },
  });
  expect((await fixture.planStore.get(planId))?.generation).toBe(0);
  expect(fixture.counts).toEqual({ source: 0, sync: 0, capsule: 0, plan: 0 });
});

test("Git install Source sync forwarding rejects a post-claim management epoch race", async () => {
  const fixture = installFixture({
    raceAfterClaimBeforeSourceSync: true,
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings: [] }),
    { "idempotency-key": "install-post-claim-source-sync-race" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;

  const source = await fixture.reconcile(planId);
  expect(source.status).toBe(200);
  const raced = await fixture.reconcile(planId);
  expect(raced.status).toBe(202);
  expect(await raced.json()).toMatchObject({
    installPlan: {
      phase: "syncing_source",
      generation: 2,
      diagnostic: { code: "install_plan_reconcile_retryable" },
    },
  });
  expect(fixture.counts).toEqual({ source: 1, sync: 0, capsule: 0, plan: 0 });
});

test("Git install plan rejects variable values and secret-shaped Git URLs", async () => {
  const fixture = installFixture();
  for (const rejected of [
    { ...createBody(), vars: { password: "do-not-store" } },
    { ...createBody(), variables: { region: "ap-northeast-1" } },
    { ...createBody(), options: { variables: { token: "not-accepted" } } },
    {
      ...createBody(),
      capsule: { ...createBody().capsule, projectId: "prj_not_supported" },
    },
    {
      ...createBody(),
      source: {
        ...createBody().source,
        authConnectionId: "raw-super-secret",
      },
    },
    {
      ...createBody(),
      options: {
        providerBindings: [
          {
            provider: "terraform.io/builtin/terraform",
            moduleLocalName: "terraform",
            connectionId: "conn_aaaaaaaa",
          },
        ],
      },
    },
    {
      ...createBody(),
      options: {
        providerBindings: [
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            connectionId: "raw-super-secret",
          },
        ],
      },
    },
    {
      ...createBody(),
      options: {
        providerBindings: [
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            connectionId: "conn_aaaaaaaa",
          },
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            connectionId: "conn_aaaaaaaa",
          },
        ],
      },
    },
    {
      ...createBody(),
      options: {
        providerBindings: [
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            alias: "legacy",
            connectionId: "conn_aaaaaaaa",
          },
        ],
      },
    },
    createBody({ sourceUrl: "https://github.com/takos/example?token=secret" }),
  ]) {
    const response = await fixture.request(
      "/api/v1/workspaces/ws_install/install-plans",
      "POST",
      rejected,
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(response.status).toBe(400);
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("Variable values are not accepted");
    expect(payload).not.toContain("do-not-store");
    expect(payload).not.toContain("ap-northeast-1");
    expect(payload).not.toContain("not-accepted");
    expect(payload).not.toContain("raw-super-secret");
  }
  expect(await fixture.planStore.get("missing")).toBeUndefined();
});

test("Git install plan keeps Source subtree and exact module selection distinct", async () => {
  const rootProviderRequirements: readonly RepositoryModuleRootProviderRequirement[] = [
    {
      source: "registry.opentofu.org/hashicorp/aws",
      moduleLocalName: "aws",
    },
  ];
  const fixture = installFixture({
    repositoryModules: {
      status: "ready",
      scopePath: "infra",
      modules: [
        {
          path: "deploy/selected",
          providerPackages: [
            { source: "registry.opentofu.org/hashicorp/aws" },
          ],
          rootProviderRequirements,
        },
        { path: "deploy/other", providerPackages: [], rootProviderRequirements: [] },
      ],
    },
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ sourcePath: "infra", modulePath: "deploy/selected" }),
    { "idempotency-key": "nested-module-selection" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;
  expect((await fixture.planStore.get(planId))?.options).toEqual({
    modulePath: "deploy/selected",
  });

  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  await fixture.reconcile(planId); // snapshot -> compiling
  await fixture.reconcile(planId); // materialized selected module config
  await fixture.reconcile(planId); // Capsule created
  await fixture.reconcile(planId); // Capsule -> planning
  const reviewable = await fixture.reconcile(planId); // canonical Plan Run
  expect((await reviewable.json()).installPlan).toMatchObject({
    phase: "reviewable",
    installModulePath: "deploy/selected",
  });
  const persisted = await fixture.planStore.get(planId);
  expect(persisted?.source.path).toBe("infra");
  expect(
    fixture.getInstallConfig(persisted?.installConfigId ?? "")?.modulePath,
  ).toBe("deploy/selected");
});

test("Git install plan requires an explicit module for multiple scanned roots", async () => {
  const fixture = installFixture({
    repositoryModules: {
      status: "ready",
      scopePath: "infra",
      modules: [
        {
          path: "deploy/selected",
          providerPackages: [],
          rootProviderRequirements: [],
        },
        {
          path: "deploy/other",
          providerPackages: [],
          rootProviderRequirements: [],
        },
      ],
    },
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ sourcePath: "infra" }),
    { "idempotency-key": "nested-module-selection-required" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;
  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  await fixture.reconcile(planId); // snapshot -> compiling
  const failed = await fixture.reconcile(planId); // module resolution
  expect((await failed.json()).installPlan).toMatchObject({
    phase: "failed",
    diagnostic: {
      code: "repository_install_module_selection_required",
    },
  });
});

test("Git install plan rejects non-canonical and undiscovered module hints", async () => {
  const malformedFixture = installFixture({
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [
        {
          path: "deploy/selected",
          providerPackages: [],
          rootProviderRequirements: [],
        },
      ],
    },
  });
  const malformed = await malformedFixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ modulePath: "./deploy/selected" }),
    { "idempotency-key": "malformed-module-selection" },
  );
  expect(malformed.status).toBe(400);
  expect(malformedFixture.mutationCount()).toBe(0);

  const unknownFixture = installFixture({
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [
        {
          path: "deploy/selected",
          providerPackages: [],
          rootProviderRequirements: [],
        },
      ],
    },
  });
  const unknown = await unknownFixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ modulePath: "deploy/missing" }),
    { "idempotency-key": "unknown-module-selection" },
  );
  expect(unknown.status).toBe(201);
  const unknownPlanId = (await unknown.json()).installPlan.id as string;
  await unknownFixture.reconcile(unknownPlanId); // Source
  await unknownFixture.reconcile(unknownPlanId); // Source sync
  unknownFixture.succeedSourceSync();
  await unknownFixture.reconcile(unknownPlanId); // snapshot -> compiling
  const failed = await unknownFixture.reconcile(unknownPlanId);
  expect((await failed.json()).installPlan).toMatchObject({
    phase: "failed",
    diagnostic: { code: "repository_install_ux_module_missing" },
  });
});

test("Git install plan continues with a scanner-selected module when optional manifest is invalid", async () => {
  const fixture = installFixture({
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
      diagnostic: "never expose parser details",
    },
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
    },
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "invalid-optional-manifest" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;
  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  for (let step = 0; step < 5; step += 1) {
    await fixture.reconcile(planId);
  }
  const reviewable = await fixture.planStore.get(planId);
  expect(reviewable?.phase).toBe("reviewable");
  expect(reviewable?.diagnostic).toBeUndefined();
  expect(reviewable?.installModulePath).toBe(".");
});

test("generic Git install materializes exact runner variable provenance", async () => {
  const fixture = installFixture({
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
    },
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "generic-variable-provenance" },
  );
  const planId = (await created.json()).installPlan.id as string;
  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  for (let step = 0; step < 5; step += 1) {
    await fixture.reconcile(planId);
  }
  const plan = await fixture.planStore.get(planId);
  expect(plan?.phase).toBe("reviewable");
  const installConfig = fixture.getInstallConfig(plan?.installConfigId!);
  expect(installConfig?.internal).toMatchObject({
    reason: "per_install_overrides",
    genericOpenTofuSourceSnapshotId: "snap_one",
  });
  expect(
    installConfig?.internal?.genericOpenTofuVariableContractDigest,
  ).toBe(
    await stableJsonDigest({
      contract: "takosumi.generic-opentofu-variable-contract/v1",
      modulePath: ".",
      declarations: [],
    }),
  );
});

test("generic Git install fails before configuration when compatibility analysis fails", async () => {
  const fixture = installFixture({
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
    },
    compatibilityRunStatus: "failed",
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "generic-failed-compatibility" },
  );
  const planId = (await created.json()).installPlan.id as string;
  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  await fixture.reconcile(planId); // snapshot -> compiling
  const failed = await fixture.reconcile(planId);

  expect((await failed.json()).installPlan).toMatchObject({
    phase: "failed",
    diagnostic: {
      code: "generic_opentofu_compatibility_analysis_failed",
    },
  });
  expect(fixture.compatibilityMutationCount).toBe(1);
  expect(fixture.installConfigMutationCount).toBe(0);
  expect(fixture.counts.capsule).toBe(0);
  expect(fixture.counts.plan).toBe(0);
});

test.each([
  {
    level: "unsupported" as const,
    declarations: [],
    key: "generic-unsupported-compatibility",
  },
  {
    level: "needs_patch" as const,
    declarations: [
      { name: "region", type: "string" as const, hasDefault: false },
    ],
    key: "generic-needs-patch-compatibility",
  },
])(
  "generic Git install fails before configuration for a $level compatibility report",
  async ({ level, declarations, key }) => {
    const fixture = installFixture({
      repositoryManifest: {
        status: "invalid",
        reason: "invalid_document",
      },
      compatibilityReportLevel: level,
      compatibilityRootModuleVariableDeclarations: declarations,
    });
    const created = await fixture.request(
      "/api/v1/workspaces/ws_install/install-plans",
      "POST",
      createBody(),
      { "idempotency-key": key },
    );
    const planId = (await created.json()).installPlan.id as string;
    await fixture.reconcile(planId); // Source
    await fixture.reconcile(planId); // Source sync
    fixture.succeedSourceSync();
    await fixture.reconcile(planId); // snapshot -> compiling
    const failed = await fixture.reconcile(planId);

    expect((await failed.json()).installPlan).toMatchObject({
      phase: "failed",
      diagnostic: {
        code: "generic_opentofu_compatibility_not_ready",
      },
    });
    expect(fixture.compatibilityMutationCount).toBe(1);
    expect(fixture.installConfigMutationCount).toBe(0);
    expect(fixture.counts).toEqual({ source: 1, sync: 1, capsule: 0, plan: 0 });
  },
);

test("generic Git install fails before configuration on non-canonical variable declarations", async () => {
  const fixture = installFixture({
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
    },
    compatibilityRootModuleVariableDeclarations: [
      { name: "duplicate", type: "string", hasDefault: false },
      { name: "duplicate", type: "string", hasDefault: true },
    ],
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "generic-invalid-declarations" },
  );
  const planId = (await created.json()).installPlan.id as string;
  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  await fixture.reconcile(planId); // snapshot -> compiling
  const failed = await fixture.reconcile(planId);

  expect((await failed.json()).installPlan).toMatchObject({
    phase: "failed",
    diagnostic: {
      code: "generic_opentofu_variable_declarations_invalid",
    },
  });
  expect(fixture.compatibilityMutationCount).toBe(1);
  expect(fixture.installConfigMutationCount).toBe(0);
  expect(fixture.counts.capsule).toBe(0);
  expect(fixture.counts.plan).toBe(0);
});

test("generic Git install fails before configuration when variable declarations are missing", async () => {
  const fixture = installFixture({
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
    },
    omitCompatibilityRootModuleVariableDeclarations: true,
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "generic-missing-declarations" },
  );
  const planId = (await created.json()).installPlan.id as string;
  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  await fixture.reconcile(planId); // snapshot -> compiling
  const failed = await fixture.reconcile(planId);

  expect((await failed.json()).installPlan).toMatchObject({
    phase: "failed",
    diagnostic: {
      code: "generic_opentofu_variable_declarations_missing",
    },
  });
  expect(fixture.compatibilityMutationCount).toBe(1);
  expect(fixture.installConfigMutationCount).toBe(0);
  expect(fixture.counts.capsule).toBe(0);
  expect(fixture.counts.plan).toBe(0);
});

test("Git install plan fails closed when host policy requires an invalid manifest", async () => {
  const fixture = installFixture({
    installConfigs: [
      {
        ...defaultCapsuleInstallConfig(),
        policy: {
          repositoryInstallUx: {
            requiredManifestApiVersion: "takosumi.com/v2.2",
          },
        },
      },
    ],
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
    },
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
    },
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "required-invalid-manifest" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;
  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  await fixture.reconcile(planId); // snapshot -> compiling
  const failed = await fixture.reconcile(planId);
  expect((await failed.json()).installPlan).toMatchObject({
    phase: "failed",
    diagnostic: {
      code: "repository_install_ux_manifest_api_version_required",
    },
  });
});

test("Git install plan runs complete provider semantic preflight before initial authority", async () => {
  const fixture = installFixture({
    providerValidationError: new OpenTofuControllerError(
      "failed_precondition",
      "provider semantic preflight rejected the proposed binding set",
      { reason: "provider_connection_setup_required" },
    ),
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "provider-preflight-before-authority" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;

  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  await fixture.reconcile(planId); // snapshot -> compilation
  await fixture.reconcile(planId); // compilation -> Capsule creation
  const rejected = await fixture.reconcile(planId);
  expect(rejected.status).toBe(200);
  expect((await rejected.json()).installPlan).toMatchObject({
    phase: "failed",
    diagnostic: {
      code: "provider_binding_invalid",
      reason: "provider_connection_setup_required",
    },
  });
  expect(fixture.counts).toEqual({ source: 1, sync: 1, capsule: 0, plan: 0 });
  expect(fixture.installConfigMutationCount).toBe(0);
  expect(fixture.authorityRows()).toEqual({
    capsules: 0,
    bindingSets: 0,
    epochs: 0,
  });
});

test("Git install plan preserves exact provider local and alias tuples through reconcile", async () => {
  const provider = "registry.opentofu.org/hashicorp/aws";
  const providerBindings: readonly GitInstallPlanProviderBindingRequest[] = [
    {
      provider,
      moduleLocalName: "aws",
      childAlias: "secondary",
      connectionId: "conn_secondary01",
    },
    {
      provider,
      moduleLocalName: "alternate",
      childAlias: "secondary",
      connectionId: "conn_alternate01",
    },
    {
      provider,
      moduleLocalName: "aws",
      connectionId: "conn_default01",
    },
  ];
  const fixture = installFixture({
    providerConnections: [
      providerConnection(provider, "conn_default01"),
      providerConnection(provider, "conn_secondary01"),
      providerConnection(provider, "conn_alternate01"),
    ],
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings }),
    { "idempotency-key": "provider-binding-tuples" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;
  expect((await fixture.planStore.get(planId))?.options).toEqual({
    providerBindings: [
      {
        provider,
        moduleLocalName: "alternate",
        childAlias: "secondary",
        connectionId: "conn_alternate01",
      },
      {
        provider,
        moduleLocalName: "aws",
        connectionId: "conn_default01",
      },
      {
        provider,
        moduleLocalName: "aws",
        childAlias: "secondary",
        connectionId: "conn_secondary01",
      },
    ],
  });

  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  for (let step = 0; step < 6; step += 1) {
    await fixture.reconcile(planId);
  }
  const reviewable = await fixture.planStore.get(planId);
  expect(reviewable?.phase).toBe("reviewable");
  expect(
    fixture.getProviderBindingSet(reviewable!.capsuleId!, "production")?.bindings,
  ).toEqual([
    {
      provider,
      moduleLocalName: "alternate",
      childAlias: "secondary",
      rootAlias: "secondary",
      connectionId: "conn_alternate01",
    },
    {
      provider,
      moduleLocalName: "aws",
      connectionId: "conn_default01",
    },
    {
      provider,
      moduleLocalName: "aws",
      childAlias: "secondary",
      rootAlias: "secondary",
      connectionId: "conn_secondary01",
    },
  ]);

  // Canonical request ordering makes an order-only retry the same immutable
  // request, while a changed alias is a distinct request identity.
  const reordered = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings: [...providerBindings].reverse() }),
    { "idempotency-key": "provider-binding-tuples" },
  );
  expect(reordered.status).toBe(200);
  expect((await reordered.json()).installPlan.id).toBe(planId);
  const changedAlias = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({
      providerBindings: providerBindings.map((binding) =>
        binding.childAlias === "secondary"
          ? { ...binding, childAlias: "tertiary" }
          : binding,
      ),
    }),
    { "idempotency-key": "provider-binding-tuples-alias-change" },
  );
  expect(changedAlias.status).toBe(201);
  expect((await changedAlias.json()).installPlan.requestDigest).not.toBe(
    reviewable?.requestDigest,
  );
});

test("Git install plan accepts hyphenated provider local and alias identities", async () => {
  const provider = "registry.opentofu.org/cloudflare/cloudflare-v02";
  const providerBinding: GitInstallPlanProviderBindingRequest = {
    provider,
    moduleLocalName: "aws-edge",
    childAlias: "cloudflare-v02",
    connectionId: "conn_edge0101",
  };
  const fixture = installFixture({
    providerConnections: [providerConnection(provider, "conn_edge0101")],
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings: [providerBinding] }),
    { "idempotency-key": "provider-binding-hyphens" },
  );
  expect(created.status).toBe(201);
  const planId = (await created.json()).installPlan.id as string;
  expect((await fixture.planStore.get(planId))?.options).toEqual({
    providerBindings: [providerBinding],
  });

  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  for (let step = 0; step < 6; step += 1) {
    await fixture.reconcile(planId);
  }

  const reviewable = await fixture.planStore.get(planId);
  expect(reviewable?.phase).toBe("reviewable");
  expect(
    fixture.getProviderBindingSet(reviewable!.capsuleId!, "production")?.bindings,
  ).toEqual([
    {
      ...providerBinding,
      rootAlias: "cloudflare-v02",
    },
  ]);
});

test("lost acknowledgements recover exact Source, sync, Capsule, and Plan Run without duplicates", async () => {
  const fixture = installFixture({
    loseAckOnce: ["source", "sync", "capsule", "plan"],
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "lost-acks" },
  );
  const planId = (await created.json()).installPlan.id as string;

  let response = await fixture.reconcile(planId);
  expect(response.status).toBe(202);
  const lostSource = await response.clone().json();
  expect(lostSource.installPlan.diagnostic).toMatchObject({
    code: "install_plan_reconcile_retryable",
    planCreationStage: "source",
  });
  expect(JSON.stringify(lostSource)).not.toContain(
    "super-secret-mutation-value",
  );
  response = await fixture.reconcile(planId); // recover Source
  expect(fixture.counts.source).toBe(1);

  response = await fixture.reconcile(planId); // sync commits, ack lost
  expect(response.status).toBe(202);
  expect(fixture.counts.sync).toBe(1);
  response = await fixture.reconcile(planId); // recover pending sync
  fixture.succeedSourceSync();
  response = await fixture.reconcile(planId); // snapshot -> compiling
  response = await fixture.reconcile(planId); // config -> creating Capsule

  response = await fixture.reconcile(planId); // Capsule commits, ack lost
  expect(response.status).toBe(202);
  expect((await response.clone().json()).installPlan.diagnostic).toMatchObject({
    planCreationStage: "preparation",
  });
  expect(fixture.counts.capsule).toBe(1);
  response = await fixture.reconcile(planId); // recover Capsule and enter planning

  response = await fixture.reconcile(planId); // Plan commits, ack lost
  expect(response.status).toBe(202);
  expect((await response.clone().json()).installPlan.diagnostic).toMatchObject({
    planCreationStage: "create",
  });
  expect(fixture.counts.plan).toBe(1);
  response = await fixture.reconcile(planId); // exact deterministic Run recovery
  expect((await response.json()).installPlan.phase).toBe("reviewable");
  expect(fixture.counts).toEqual({ source: 1, sync: 1, capsule: 1, plan: 1 });
});

test("retryable Plan creation records only bounded structured controller diagnostics", async () => {
  const fixture = installFixture({ retryablePlanErrorOnce: true });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "structured-plan-diagnostic" },
  );
  const planId = (await created.json()).installPlan.id as string;

  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // Source sync
  fixture.succeedSourceSync();
  let response: Response | undefined;
  for (let step = 0; step < 4; step += 1) {
    response = await fixture.reconcile(planId);
  }
  expect(response?.status).toBe(202);
  const retryable = await response!.json();
  expect(retryable.installPlan).toMatchObject({
    phase: "planning",
    diagnostic: {
      code: "install_plan_reconcile_retryable",
      planCreationStage: "create",
      controllerCode: "failed_precondition",
      reason: "module_variable_materialization_failed",
    },
  });
  expect(JSON.stringify(retryable)).not.toContain(
    "never-serialize-controller-exception-prose",
  );

  response = await fixture.reconcile(planId);
  expect((await response.json()).installPlan.phase).toBe("reviewable");
  expect(fixture.counts.plan).toBe(1);
});

test("lost compatibility acknowledgement adopts the exact persisted Run and report once", async () => {
  const fixture = installFixture({
    repositoryManifest: repositoryManifest(["."]),
    loseAckOnce: ["compatibility"],
  });
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody(),
    { "idempotency-key": "lost-compatibility-ack" },
  );
  const planId = (await created.json()).installPlan.id as string;

  await fixture.reconcile(planId); // Source
  await fixture.reconcile(planId); // sync
  fixture.succeedSourceSync();
  await fixture.reconcile(planId); // snapshot -> compiling
  const prepared = await fixture.reconcile(planId); // persist exact evidence refs
  expect((await prepared.json()).installPlan).toMatchObject({
    phase: "analyzing_compatibility",
    installConfigBaseId: "cfg-default-opentofu-capsule",
    installModulePath: ".",
    compatibilityCheckRunId: expect.stringMatching(/^ccr_[A-Za-z0-9]{16}$/u),
    compatibilityReportId: expect.stringMatching(
      /^caprep_[A-Za-z0-9]{16}$/u,
    ),
  });
  expect(fixture.compatibilityMutationCount).toBe(0);

  const lost = await fixture.reconcile(planId);
  expect(lost.status).toBe(202);
  expect(fixture.compatibilityMutationCount).toBe(1);
  const evidenceAfterLoss = fixture.compatibilityEvidence();
  expect(evidenceAfterLoss).toHaveLength(1);

  const recovered = await fixture.reconcile(planId);
  const recoveredPlan = (await recovered.json()).installPlan;
  expect(recoveredPlan).toMatchObject({
    phase: "creating_capsule",
    compatibilityCheckRunId: evidenceAfterLoss[0]!.run.id,
    compatibilityReportId: evidenceAfterLoss[0]!.report.id,
    installConfigId: expect.stringMatching(/^icfg_[0-9a-f]{16}$/u),
  });
  expect(fixture.compatibilityMutationCount).toBe(1);
  expect(fixture.compatibilityEvidence()).toEqual(evidenceAfterLoss);
  expect(fixture.installConfigMutationCount).toBe(0);

  await fixture.reconcile(planId); // one atomic config/Capsule/binding transition
  expect(fixture.installConfigMutationCount).toBe(1);
});

test("Git install plans reject source-specific deployment profile selectors", async () => {
  const fixture = installFixture();
  const response = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    {
      ...createBody(),
      options: { deploymentProfileKey: "byoc-v1" },
    },
    { "idempotency-key": "profile-selector-rejected" },
  );
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload).toMatchObject({
    error: {
      code: "invalid_request",
    },
  });
  expect(fixture.mutationCount()).toBe(0);
});

type LostAckMutation =
  | "source"
  | "sync"
  | "compatibility"
  | "capsule"
  | "plan";

const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
const SECRET_VALUE = "super-secret-attempt-value";

function attemptBody(
  input: {
    readonly capsuleName?: string;
    readonly modulePath?: string;
  } = {},
) {
  return {
    mode: "attempt",
    source: { url: "https://github.com/takos/example.git", ref: "main" },
    ...(input.capsuleName ? { capsule: { name: input.capsuleName } } : {}),
    ...(input.modulePath ? { options: { modulePath: input.modulePath } } : {}),
  };
}

function attemptFixture(
  options: Parameters<typeof installFixture>[0] = {},
) {
  return installFixture({
    compatibilityRootProviderRequirements: [
      {
        source: CLOUDFLARE,
        moduleLocalName: "cloudflare",
        credentialRequired: true,
      },
    ],
    compatibilityResources: [
      { type: "cloudflare_workers_script", count: 1, allowed: true },
    ],
    compatibilityRootModuleVariableDeclarations: [
      { name: "region", type: "string", hasDefault: false },
    ],
    providerConnections: [providerConnection(CLOUDFLARE, "conn_cloudflare01")],
    ...options,
  });
}

async function startAttempt(
  fixture: ReturnType<typeof installFixture>,
  body: unknown = attemptBody(),
  key = "attempt-one",
  subject = WORKSPACE.ownerUserId,
): Promise<string> {
  const created = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": key },
    subject,
  );
  expect(created.status).toBe(201);
  return (await created.json()).installPlan.id as string;
}

async function reconcileUntilIdle(
  fixture: ReturnType<typeof installFixture>,
  planId: string,
  subject = WORKSPACE.ownerUserId,
) {
  // deno-lint-ignore no-explicit-any
  let payload: any;
  for (let step = 0; step < 8; step += 1) {
    const response = await fixture.request(
      `/api/v1/install-plans/${planId}/reconcile`,
      "POST",
      undefined,
      {},
      subject,
    );
    payload = await response.json();
    if (payload.installPlan.sourceSyncRunId) fixture.succeedSourceSync();
    if (payload.nextAction !== "reconcile") break;
  }
  return payload;
}

async function readPlan(
  fixture: ReturnType<typeof installFixture>,
  planId: string,
  subject = WORKSPACE.ownerUserId,
) {
  const response = await fixture.request(
    `/api/v1/install-plans/${planId}`,
    "GET",
    undefined,
    {},
    subject,
  );
  expect(response.status).toBe(200);
  return await response.json();
}

function answer(
  fixture: ReturnType<typeof installFixture>,
  planId: string,
  body: unknown,
  subject = WORKSPACE.ownerUserId,
) {
  return fixture.request(
    `/api/v1/install-plans/${planId}`,
    "PATCH",
    body,
    {},
    subject,
  );
}

function discard(
  fixture: ReturnType<typeof installFixture>,
  planId: string,
  expectedGeneration: number | undefined,
  subject = WORKSPACE.ownerUserId,
) {
  return fixture.request(
    `/api/v1/install-plans/${planId}`,
    "DELETE",
    expectedGeneration === undefined ? undefined : { expectedGeneration },
    {},
    subject,
  );
}

test("install attempt pauses once for the whole sheet, auto-selects the only connection, and continues with transient values", async () => {
  const fixture = attemptFixture();
  const planId = await startAttempt(fixture);
  const started = await readPlan(fixture, planId);
  expect(started).toMatchObject({
    installPlan: {
      mode: "attempt",
      phase: "syncing_source",
      capsule: { name: "example", environment: "production" },
      source: { name: "example", ref: "main", path: "." },
    },
    nextAction: "reconcile",
    userAction: { kind: "wait", phase: "syncing_source" },
  });
  expect(Date.parse(started.installPlan.expiresAt)).toBeGreaterThan(Date.now());

  const paused = await reconcileUntilIdle(fixture, planId);
  expect(paused.installPlan).toMatchObject({
    phase: "awaiting_input",
    awaitingInput: "inputs",
    sourceCreatedByAttempt: true,
    installModulePath: ".",
  });
  expect(paused.installPlan.attemptFacts).toBeUndefined();
  expect(paused.nextAction).toBe("none");
  expect(paused.links.reconcile).toBeUndefined();
  expect(paused.userAction).toEqual({
    kind: "provide_inputs",
    modulePath: ".",
    resources: [{ type: "cloudflare_workers_script", count: 1, allowed: true }],
    connections: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "cloudflare",
        candidates: [
          {
            id: "conn_cloudflare01",
            displayName: "conn_cloudflare01",
            status: "verified",
            scope: "workspace",
          },
        ],
        selectedConnectionId: "conn_cloudflare01",
        autoSelected: true,
      },
    ],
    variables: [
      { name: "region", type: "string", required: true, sensitive: true },
    ],
    name: { current: "example", proposed: "example", conflict: false },
    missing: [],
  });
  // Nothing was created in the cloud ledger yet.
  expect(fixture.counts).toEqual({ source: 1, sync: 1, capsule: 0, plan: 0 });
  // The idle pause holds no lease and does not block Workspace management.
  expect(await fixture.planStore.hasWorkspaceManagementBlockers(WORKSPACE.id)).toBe(false);

  const renamed = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    capsuleName: "my-example",
  });
  expect(renamed.status).toBe(200);
  const renamedPayload = await renamed.json();
  expect(renamedPayload.installPlan).toMatchObject({
    phase: "awaiting_input",
    capsule: { name: "my-example" },
    source: { name: "example" },
    generation: paused.installPlan.generation + 1,
  });

  const stale = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    continue: true,
    variables: { region: SECRET_VALUE },
  });
  expect(stale.status).toBe(409);
  expect((await stale.json()).error.code).toBe("install_plan_generation_conflict");

  const valuesWithoutContinue = await answer(fixture, planId, {
    expectedGeneration: renamedPayload.installPlan.generation,
    variables: { region: SECRET_VALUE },
  });
  expect(valuesWithoutContinue.status).toBe(400);

  const missingRequired = await answer(fixture, planId, {
    expectedGeneration: renamedPayload.installPlan.generation,
    continue: true,
  });
  expect(missingRequired.status).toBe(400);
  expect((await missingRequired.json()).error.details.reason).toBe("install_variable_required");
  expect(fixture.counts.capsule).toBe(0);

  const confirmed = await answer(fixture, planId, {
    expectedGeneration: renamedPayload.installPlan.generation,
    continue: true,
    variables: { region: SECRET_VALUE },
  });
  expect(confirmed.status).toBe(200);
  const confirmedText = await confirmed.text();
  expect(confirmedText).not.toContain(SECRET_VALUE);
  const planning = JSON.parse(confirmedText);
  expect(planning.installPlan.capsuleId).toBe(fixture.capsules[0]!.id);
  expect(planning.installPlan).toMatchObject({
    phase: "planning",
    options: {
      providerBindings: [
        {
          provider: CLOUDFLARE,
          moduleLocalName: "cloudflare",
          connectionId: "conn_cloudflare01",
        },
      ],
    },
  });
  // Once the Capsule exists the attempt can no longer expire.
  expect(planning.installPlan.expiresAt).toBeUndefined();
  const stored = await fixture.planStore.get(planId);
  expect(JSON.stringify(stored)).not.toContain(SECRET_VALUE);
  expect(stored?.transientVariableNames).toBeUndefined();
  expect(fixture.getInstallConfig(planning.installPlan.installConfigId)).toMatchObject({
    variableMapping: { region: SECRET_VALUE },
  });
  expect(fixture.capsules[0]).toMatchObject({ name: "my-example", status: "pending" });
  expect(fixture.getProviderBindingSet(fixture.capsules[0]!.id, "production")?.bindings)
    .toEqual([
      expect.objectContaining({ connectionId: "conn_cloudflare01" }),
    ]);

  // The coordinator enables polling for the Source it registered itself.
  expect(fixture.sources[0]?.autoSync).toBe(false);
  const reviewable = await reconcileUntilIdle(fixture, planId);
  expect(reviewable).toMatchObject({
    installPlan: { phase: "reviewable" },
    nextAction: "review_run",
    userAction: {
      kind: "review_run",
      planRunId: reviewable.installPlan.planRunId,
      capsuleId: reviewable.installPlan.capsuleId,
    },
  });
  expect(fixture.sources[0]?.autoSync).toBe(true);
  expect(fixture.sourcePatches).toEqual([{ id: "src_one", autoSync: true }]);
  expect(JSON.stringify(reviewable)).not.toContain(SECRET_VALUE);
  expect(JSON.stringify(await fixture.planStore.get(planId))).not.toContain(SECRET_VALUE);
  expect(fixture.approvalCalls).toBe(0);
  expect(fixture.applyCalls).toBe(0);
});

test("install attempt asks for connections when no single candidate exists and validates answers", async () => {
  const fixture = attemptFixture({
    providerConnections: [
      providerConnection(CLOUDFLARE, "conn_cloudflare01"),
      providerConnection(CLOUDFLARE, "conn_cloudflare02"),
    ],
  });
  const planId = await startAttempt(fixture);
  const paused = await reconcileUntilIdle(fixture, planId);
  expect(paused.userAction).toMatchObject({
    kind: "provide_inputs",
    connections: [
      {
        provider: CLOUDFLARE,
        autoSelected: false,
        candidates: [{ id: "conn_cloudflare01" }, { id: "conn_cloudflare02" }],
      },
    ],
    missing: ["connections"],
  });
  expect(paused.userAction.connections[0].selectedConnectionId).toBeUndefined();

  const notReady = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    continue: true,
    variables: { region: SECRET_VALUE },
  });
  expect(notReady.status).toBe(409);
  expect((await notReady.json()).error.details.reason).toBe("provider_connection_required");

  const wrongTuple = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    providerBindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "other",
        connectionId: "conn_cloudflare02",
      },
    ],
  });
  expect(wrongTuple.status).toBe(400);

  const chosen = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    providerBindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "cloudflare",
        connectionId: "conn_cloudflare02",
      },
    ],
  });
  expect(chosen.status).toBe(200);
  const chosenPayload = await chosen.json();
  expect(chosenPayload.userAction).toMatchObject({
    connections: [{ selectedConnectionId: "conn_cloudflare02", autoSelected: false }],
    missing: [],
  });

  // Another app already uses the proposed name: the sheet reports it.
  fixture.addCapsule({
    id: "cap_existing00000001",
    workspaceId: WORKSPACE.id,
    projectId: "prj_default_ws_install",
    name: "example",
    slug: "example",
    environment: "production",
    sourceId: "src_other",
    installConfigId: "cfg-default-opentofu-capsule",
    installingPrincipalId: WORKSPACE.ownerUserId,
    currentStateGeneration: 1,
    status: "active",
    createdAt: WORKSPACE.createdAt,
    updatedAt: WORKSPACE.createdAt,
  });
  const conflicted = await readPlan(fixture, planId);
  expect(conflicted.userAction).toMatchObject({
    name: { current: "example", proposed: "example-2", conflict: true },
    missing: ["name"],
  });
  const refused = await answer(fixture, planId, {
    expectedGeneration: chosenPayload.installPlan.generation,
    continue: true,
    variables: { region: "eu" },
  });
  expect(refused.status).toBe(409);
  expect((await refused.json()).error.details.reason).toBe("capsule_name_conflict");
  expect(fixture.counts.capsule).toBe(0);
});

test("install attempt asks to choose among scanned modules and restarts analysis for the choice", async () => {
  const fixture = attemptFixture({
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [
        {
          path: "apps/a",
          providerPackages: [{ source: CLOUDFLARE }],
          rootProviderRequirements: [],
        },
        {
          path: "apps/b",
          providerPackages: [],
          rootProviderRequirements: [],
        },
      ],
    },
  });
  const planId = await startAttempt(fixture);
  const paused = await reconcileUntilIdle(fixture, planId);
  expect(paused.installPlan).toMatchObject({
    phase: "awaiting_input",
    awaitingInput: "module",
  });
  expect(paused.userAction).toEqual({
    kind: "choose_module",
    modules: [
      { path: "apps/a", providers: [CLOUDFLARE] },
      { path: "apps/b", providers: [] },
    ],
  });
  expect(fixture.compatibilityMutationCount).toBe(0);

  const continueEarly = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    continue: true,
  });
  expect(continueEarly.status).toBe(409);

  const missing = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    modulePath: "apps/missing",
  });
  expect(missing.status).toBe(400);
  expect((await missing.json()).error.code).toBe("install_module_unavailable");

  const chosen = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    modulePath: "apps/b",
  });
  expect(chosen.status).toBe(200);
  const chosenPayload = await chosen.json();
  expect(chosenPayload).toMatchObject({
    installPlan: { phase: "compiling_install", options: { modulePath: "apps/b" } },
    nextAction: "reconcile",
    userAction: { kind: "wait" },
  });
  const analyzed = await reconcileUntilIdle(fixture, planId);
  expect(analyzed.installPlan).toMatchObject({
    phase: "awaiting_input",
    awaitingInput: "inputs",
    installModulePath: "apps/b",
  });
  expect(analyzed.userAction).toMatchObject({ kind: "provide_inputs", modulePath: "apps/b" });
});

test("install attempt with a repository manifest pauses after manifest analysis and creates from the reviewed preview", async () => {
  const fixture = attemptFixture({
    repositoryManifest: repositoryManifest(["."]),
    providerConnections: [],
    compatibilityRootProviderRequirements: [],
  });
  const planId = await startAttempt(fixture);
  const paused = await reconcileUntilIdle(fixture, planId);
  expect(paused.installPlan).toMatchObject({
    phase: "awaiting_input",
    awaitingInput: "inputs",
    installModulePath: ".",
    compatibilityReportId: expect.any(String),
  });
  expect(paused.userAction).toMatchObject({
    kind: "provide_inputs",
    connections: [],
    variables: [],
    missing: [],
  });
  const unknown = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    continue: true,
    variables: { undeclared: "value" },
  });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error.details.reason).toBe("install_variable_unknown");
  const confirmed = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    continue: true,
  });
  expect(confirmed.status).toBe(200);
  expect((await confirmed.json()).installPlan.phase).toBe("planning");
  const reviewable = await reconcileUntilIdle(fixture, planId);
  expect(reviewable.installPlan.phase).toBe("reviewable");
  expect(fixture.counts).toEqual({ source: 1, sync: 1, capsule: 1, plan: 1 });
});

async function expireStoredAttempt(
  fixture: ReturnType<typeof installFixture>,
  planId: string,
): Promise<number> {
  const stored = (await fixture.planStore.get(planId))!;
  const expired = await fixture.planStore.transitionUnleased({
    id: planId,
    expectedGeneration: stored.generation,
    expectedPhase: stored.phase,
    plan: {
      ...stored,
      generation: stored.generation + 1,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    },
    at: new Date().toISOString(),
  });
  expect(expired.status).toBe("updated");
  return stored.generation + 1;
}

async function reachReviewable(
  fixture: ReturnType<typeof installFixture>,
  planId: string,
) {
  const paused = await reconcileUntilIdle(fixture, planId);
  const confirmed = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    continue: true,
    variables: { region: "eu" },
  });
  expect(confirmed.status).toBe(200);
  const reviewable = await reconcileUntilIdle(fixture, planId);
  expect(reviewable.installPlan.phase).toBe("reviewable");
  return reviewable;
}

test("discarding an attempt abandons its never-applied Capsule and keeps the Source with polling off", async () => {
  const fixture = attemptFixture();
  const planId = await startAttempt(fixture);
  const reviewable = await reachReviewable(fixture, planId);
  expect(fixture.sources[0]?.autoSync).toBe(true);

  expect((await discard(fixture, planId, undefined)).status).toBe(400);
  const stale = await discard(fixture, planId, reviewable.installPlan.generation - 1);
  expect(stale.status).toBe(409);
  expect((await stale.json()).error.code).toBe("install_plan_generation_conflict");
  // A Workspace admin who did not start the attempt cannot answer or discard it.
  expect((await discard(fixture, planId, reviewable.installPlan.generation, ADMIN_SUBJECT)).status)
    .toBe(403);
  expect(
    (await answer(fixture, planId, { expectedGeneration: 0 }, ADMIN_SUBJECT)).status,
  ).toBe(403);
  expect((await readPlan(fixture, planId, ADMIN_SUBJECT)).installPlan.id).toBe(planId);
  expect((await fixture.planStore.get(planId))?.generation).toBe(
    reviewable.installPlan.generation,
  );

  const discarded = await discard(fixture, planId, reviewable.installPlan.generation);
  expect(discarded.status).toBe(200);
  expect(await discarded.json()).toMatchObject({
    installPlan: {
      phase: "discarded",
      generation: reviewable.installPlan.generation + 1,
      diagnostic: { code: "install_attempt_discarded" },
    },
    nextAction: "none",
    userAction: { kind: "none" },
  });
  expect(fixture.abandonedCapsules).toEqual([reviewable.installPlan.capsuleId]);
  expect(fixture.capsules[0]?.status).toBe("destroyed");
  // The Source is never deleted; polling this attempt enabled is turned off.
  expect(fixture.deletedSources).toEqual([]);
  expect(fixture.sources.map((source) => source.id)).toEqual(["src_one"]);
  expect(fixture.sources[0]?.autoSync).toBe(false);
  expect(fixture.sourcePatches).toEqual([
    { id: "src_one", autoSync: true },
    { id: "src_one", autoSync: false },
  ]);
  expect(await fixture.planStore.hasWorkspaceManagementBlockers(WORKSPACE.id)).toBe(false);

  // Discard is idempotent once terminal.
  const again = await discard(fixture, planId, 0);
  expect(again.status).toBe(200);
  expect((await again.json()).installPlan.phase).toBe("discarded");
});

test("refused discards write nothing, legacy plans cannot be discarded here, and applied attempts leave the open list", async () => {
  const fixture = attemptFixture();
  const planId = await startAttempt(fixture);
  const reviewable = await reachReviewable(fixture, planId);
  fixture.applyCapsule(reviewable.installPlan.capsuleId);
  const refused = await discard(fixture, planId, reviewable.installPlan.generation);
  expect(refused.status).toBe(409);
  expect((await refused.json()).error.code).toBe("install_attempt_applied");
  const afterRefusal = (await fixture.planStore.get(planId))!;
  expect(afterRefusal.phase).toBe("reviewable");
  expect(afterRefusal.generation).toBe(reviewable.installPlan.generation);
  expect(await fixture.planStore.hasWorkspaceManagementBlockers(WORKSPACE.id)).toBe(false);
  expect(fixture.abandonedCapsules).toEqual([]);
  const listed = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans?open=1",
  );
  expect((await listed.json()).installPlans).toEqual([]);

  const legacy = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings: [] }),
    { "idempotency-key": "legacy-not-discardable" },
  );
  const legacyPlan = (await legacy.json()).installPlan;
  const legacyDiscard = await discard(fixture, legacyPlan.id, legacyPlan.generation);
  expect(legacyDiscard.status).toBe(409);
  expect((await legacyDiscard.json()).error.code).toBe("install_plan_not_attempt");
  const legacyAnswer = await answer(fixture, legacyPlan.id, {
    expectedGeneration: legacyPlan.generation,
    capsuleName: "renamed",
  });
  expect(legacyAnswer.status).toBe(409);
  expect((await legacyAnswer.json()).error.code).toBe("install_plan_not_attempt");
});

test("discarding an attempt never removes a Source that a legacy install plan reuses", async () => {
  const fixture = attemptFixture();
  const planId = await startAttempt(fixture);
  const paused = await reconcileUntilIdle(fixture, planId);
  expect(paused.installPlan).toMatchObject({
    sourceId: "src_one",
    sourceCreatedByAttempt: true,
  });
  // A legacy plan with the same Git address reuses the attempt's Source.
  const legacy = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    createBody({ providerBindings: [], capsuleName: "legacy-app" }),
    { "idempotency-key": "legacy-shares-source" },
  );
  const legacyId = (await legacy.json()).installPlan.id as string;
  const matched = await fixture.reconcile(legacyId);
  expect((await matched.json()).installPlan.sourceId).toBe("src_one");

  const discarded = await discard(fixture, planId, paused.installPlan.generation);
  expect(discarded.status).toBe(200);
  expect(fixture.deletedSources).toEqual([]);
  expect(fixture.sources.map((source) => source.id)).toEqual(["src_one"]);
  expect(fixture.sourcePatches).toEqual([]);

  const legacyReviewable = await reconcileUntilIdle(fixture, legacyId);
  expect(legacyReviewable.installPlan).toMatchObject({
    phase: "reviewable",
    sourceId: "src_one",
  });
});

test("reads never settle an expired or epoch-changed attempt; only the creator's write discards it", async () => {
  const fixture = attemptFixture();
  const planId = await startAttempt(fixture);
  const adminPlanId = await startAttempt(
    fixture,
    attemptBody({ capsuleName: "admin-app" }),
    "attempt-admin",
    ADMIN_SUBJECT,
  );
  const paused = await reconcileUntilIdle(fixture, planId);
  expect(paused.installPlan.phase).toBe("awaiting_input");
  const generation = await expireStoredAttempt(fixture, planId);
  const mutationsBefore = fixture.mutationCount();
  const effectsBefore = JSON.stringify([
    fixture.abandonedCapsules,
    fixture.deletedSources,
    fixture.sourcePatches,
  ]);

  for (const subject of [VIEWER_SUBJECT, ADMIN_SUBJECT, WORKSPACE.ownerUserId]) {
    const read = await readPlan(fixture, planId, subject);
    expect(read).toMatchObject({
      installPlan: { phase: "awaiting_input", generation },
      invalidated: "install_attempt_expired",
      nextAction: "none",
      userAction: { kind: "retry", code: "install_attempt_expired", restart: true },
    });
    expect(read.links.reconcile).toBeUndefined();
  }
  const ownerList = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans?open=1",
  );
  const ownerItems = (await ownerList.json()).installPlans;
  expect(ownerItems.map((item: { installPlan: { id: string } }) => item.installPlan.id))
    .toEqual([planId]);
  expect(ownerItems[0].invalidated).toBe("install_attempt_expired");
  const adminList = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans?open=1",
    "GET",
    undefined,
    {},
    ADMIN_SUBJECT,
  );
  expect((await adminList.json()).installPlans.map(
    (item: { installPlan: { id: string } }) => item.installPlan.id,
  )).toEqual([adminPlanId]);
  const reconciled = await fixture.reconcile(planId);
  expect((await reconciled.json()).invalidated).toBe("install_attempt_expired");
  expect((await fixture.planStore.get(planId))?.generation).toBe(generation);
  expect(fixture.mutationCount()).toBe(mutationsBefore);
  expect(JSON.stringify([
    fixture.abandonedCapsules,
    fixture.deletedSources,
    fixture.sourcePatches,
  ])).toBe(effectsBefore);

  // Only the creator's own write cleans up.
  const answered = await answer(fixture, planId, {
    expectedGeneration: generation,
    capsuleName: "too-late",
  });
  expect(answered.status).toBe(409);
  expect((await answered.json()).error).toMatchObject({
    code: "install_attempt_invalid",
    details: { reason: "install_attempt_expired" },
  });
  expect(await readPlan(fixture, planId, VIEWER_SUBJECT)).toMatchObject({
    installPlan: {
      phase: "discarded",
      diagnostic: { code: "install_attempt_expired" },
      capsule: { name: "example" },
    },
    userAction: { kind: "none" },
  });
  expect(fixture.deletedSources).toEqual([]);
});

test("an attempt with a Capsule never expires", async () => {
  const fixture = attemptFixture();
  const planId = await startAttempt(fixture);
  const reviewable = await reachReviewable(fixture, planId);
  expect(reviewable.installPlan.expiresAt).toBeUndefined();
  const generation = await expireStoredAttempt(fixture, planId);
  for (const subject of [VIEWER_SUBJECT, WORKSPACE.ownerUserId]) {
    const read = await readPlan(fixture, planId, subject);
    expect(read.invalidated).toBeUndefined();
    expect(read.userAction).toMatchObject({ kind: "review_run" });
  }
  const listed = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans?open=1",
  );
  expect((await listed.json()).installPlans.map(
    (item: { installPlan: { id: string } }) => item.installPlan.id,
  )).toEqual([planId]);
  expect((await fixture.planStore.get(planId))?.generation).toBe(generation);
  expect(fixture.abandonedCapsules).toEqual([]);
});

test("an idle attempt does not block Workspace management; after a drain reads only report it and the creator's answer discards it", async () => {
  const fixture = attemptFixture();
  const planId = await startAttempt(fixture);
  // An attempt with coordinator work pending is still a blocker.
  expect(await fixture.planStore.hasWorkspaceManagementBlockers(WORKSPACE.id)).toBe(true);
  const paused = await reconcileUntilIdle(fixture, planId);
  expect(paused.installPlan.phase).toBe("awaiting_input");
  expect(await fixture.planStore.hasWorkspaceManagementBlockers(WORKSPACE.id)).toBe(false);

  await fixture.beginDrain();
  const viewed = await readPlan(fixture, planId, VIEWER_SUBJECT);
  expect(viewed).toMatchObject({
    installPlan: { phase: "awaiting_input", generation: paused.installPlan.generation },
    invalidated: "workspace_management_changed",
    userAction: { kind: "retry", code: "workspace_management_changed", restart: true },
  });
  expect((await fixture.planStore.get(planId))?.generation).toBe(
    paused.installPlan.generation,
  );
  const refused = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    capsuleName: "renamed",
  });
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toMatchObject({
    code: "install_attempt_invalid",
    details: { reason: "workspace_management_changed" },
  });
  expect((await readPlan(fixture, planId)).installPlan).toMatchObject({
    phase: "discarded",
    diagnostic: { code: "workspace_management_changed" },
    capsule: { name: "example" },
  });
  expect(fixture.counts.capsule).toBe(0);
});

test("the store admission fence refuses answers after an epoch change even when the route read looked current", async () => {
  for (const body of [
    { capsuleName: "renamed" },
    { continue: true, variables: { region: "eu" } },
  ]) {
    const fixture = attemptFixture({ staleManagementCapture: true });
    const planId = await startAttempt(fixture);
    const paused = await reconcileUntilIdle(fixture, planId);
    expect(paused.installPlan.phase).toBe("awaiting_input");
    await fixture.beginDrain();
    // The stale capture hides the drain from the route's read-only check.
    expect((await readPlan(fixture, planId)).invalidated).toBeUndefined();
    const refused = await answer(fixture, planId, {
      expectedGeneration: paused.installPlan.generation,
      ...body,
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatchObject({
      code: "install_attempt_invalid",
      details: { reason: "workspace_management_admission_conflict" },
    });
    expect((await fixture.planStore.get(planId))).toMatchObject({
      phase: "discarded",
      diagnostic: { code: "workspace_management_changed" },
      capsule: { name: "example" },
    });
    expect(fixture.counts.capsule).toBe(0);
    expect(await fixture.planStore.hasWorkspaceManagementBlockers(WORKSPACE.id)).toBe(false);
  }
});

test("a confirming request whose creation acknowledgement is lost accepts only the same values and adopts the committed Capsule", async () => {
  const fixture = attemptFixture({ loseAckOnce: ["capsule"] });
  const planId = await startAttempt(fixture);
  const paused = await reconcileUntilIdle(fixture, planId);
  const lost = await answer(fixture, planId, {
    expectedGeneration: paused.installPlan.generation,
    continue: true,
    variables: { region: SECRET_VALUE },
  });
  expect(lost.status).toBe(200);
  const lostText = await lost.text();
  expect(lostText).not.toContain(SECRET_VALUE);
  expect(lostText).not.toContain("super-secret-mutation-value");
  const lostPayload = JSON.parse(lostText);
  expect(lostPayload.installPlan).toMatchObject({
    phase: "awaiting_input",
    awaitingInput: "inputs",
    diagnostic: { code: "install_inputs_resubmission_required" },
  });
  // A Capsule may exist, so this pause never expires.
  expect(lostPayload.installPlan.expiresAt).toBeUndefined();
  expect(lostPayload.userAction.resubmitVariables).toEqual(["region"]);
  expect(JSON.stringify(await fixture.planStore.get(planId))).not.toContain(SECRET_VALUE);
  expect(fixture.counts.capsule).toBe(1);

  // A reconcile without the values never re-creates authority.
  const reconciled = await fixture.reconcile(planId);
  expect((await reconciled.json()).installPlan.phase).toBe("awaiting_input");
  for (const change of [
    { capsuleName: "renamed" },
    { capsuleName: "renamed", continue: true, variables: { region: SECRET_VALUE } },
    {
      providerBindings: [
        { provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "conn_cloudflare01" },
      ],
    },
    { continue: true },
  ]) {
    const refused = await answer(fixture, planId, {
      expectedGeneration: lostPayload.installPlan.generation,
      ...change,
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("install_inputs_resubmission_only");
  }
  expect((await fixture.planStore.get(planId))?.generation).toBe(
    lostPayload.installPlan.generation,
  );

  const resubmitted = await answer(fixture, planId, {
    expectedGeneration: lostPayload.installPlan.generation,
    continue: true,
    variables: { region: SECRET_VALUE },
  });
  expect(resubmitted.status).toBe(200);
  expect((await resubmitted.json()).installPlan).toMatchObject({
    phase: "planning",
    capsuleId: fixture.capsules[0]!.id,
    capsule: { name: "example" },
  });
  expect(fixture.counts.capsule).toBe(1);
  expect(JSON.stringify(await fixture.planStore.get(planId))).not.toContain(SECRET_VALUE);
});

test("legacy reviewed-preflight rows keep their previous lifecycle across a lost acknowledgement", async () => {
  const fixture = installFixture({ loseAckOnce: ["capsule"] });
  const preflight = fixture.seedPreflight({
    variableDeclarations: [{ name: "region", type: "string", hasDefault: false }],
  });
  const body = {
    ...createBody({ modulePath: ".", providerBindings: [] }),
    preflight,
    variables: { region: SECRET_VALUE },
  };
  const first = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "preflight-lost-ack" },
  );
  expect(first.status).toBe(201);
  const firstPayload = await first.json();
  expect(firstPayload).toMatchObject({
    installPlan: { phase: "creating_capsule" },
    nextAction: "reconcile",
    userAction: { kind: "wait", phase: "creating_capsule" },
  });
  expect(firstPayload.installPlan.mode).toBeUndefined();
  expect(JSON.stringify(firstPayload)).not.toContain(SECRET_VALUE);
  const planId = firstPayload.installPlan.id as string;

  const lost = await fixture.reconcile(planId);
  expect(lost.status).toBe(202);
  const lostPayload = await lost.json();
  expect(lostPayload).toMatchObject({
    installPlan: {
      phase: "creating_capsule",
      diagnostic: { code: "install_plan_reconcile_retryable" },
    },
    nextAction: "reconcile",
  });
  expect(JSON.stringify(lostPayload)).not.toContain(SECRET_VALUE);
  expect((await fixture.planStore.get(planId))?.initialVariables).toEqual({
    region: SECRET_VALUE,
  });

  const recovered = await fixture.reconcile(planId);
  expect((await recovered.json()).installPlan.phase).toBe("planning");
  expect(fixture.counts.capsule).toBe(1);
  expect((await fixture.planStore.get(planId))?.initialVariables).toBeUndefined();
  expect(fixture.getInstallConfig(fixture.capsules[0]!.installConfigId)).toMatchObject({
    variableMapping: { region: SECRET_VALUE },
  });
});

test("a legacy row written with the value-bearing digest still replays and keeps its reviewed values", async () => {
  const fixture = installFixture();
  const preflight = fixture.seedPreflight({
    variableDeclarations: [{ name: "region", type: "string", hasDefault: false }],
  });
  const body = {
    ...createBody({ modulePath: ".", providerBindings: [] }),
    preflight,
    variables: { region: "legacy-region" },
  };
  // Seed the row exactly as the previous release wrote it: value-bearing
  // request digest and stored initialVariables.
  const template = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "template-only" },
  );
  const templateRecord = (await fixture.planStore.get(
    (await template.json()).installPlan.id,
  ))!;
  const legacyDigest = await stableJsonDigest({
    source: { name: "example", url: "https://github.com/takos/example", ref: "main", path: "." },
    capsule: { name: "example", environment: "production" },
    options: { modulePath: ".", providerBindings: [] },
    preflight,
    variables: { region: "legacy-region" },
  });
  expect(templateRecord.requestDigest).not.toBe(legacyDigest);
  const legacyId = "gip_legacyrow000001";
  const seeded = await fixture.planStore.create({
    ...templateRecord,
    id: legacyId,
    idempotencyKeyHash: await stableJsonDigest("legacy-replay-key"),
    requestDigest: legacyDigest,
    initialVariables: { region: "legacy-region" },
  });
  expect(seeded.status).toBe("created");

  const replay = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    body,
    { "idempotency-key": "legacy-replay-key" },
  );
  expect(replay.status).toBe(200);
  const replayPayload = await replay.json();
  expect(replayPayload.installPlan).toMatchObject({ id: legacyId, phase: "creating_capsule" });
  expect(JSON.stringify(replayPayload)).not.toContain("legacy-region");

  const created = await fixture.reconcile(legacyId);
  const planning = await created.json();
  expect(planning.installPlan.phase).toBe("planning");
  expect(fixture.getInstallConfig(planning.installPlan.installConfigId)).toMatchObject({
    variableMapping: { region: "legacy-region" },
  });
  expect((await fixture.planStore.get(legacyId))?.initialVariables).toBeUndefined();

  // Same key, different values: the digest covers names only, so it replays.
  const differentValues = await fixture.request(
    "/api/v1/workspaces/ws_install/install-plans",
    "POST",
    { ...body, variables: { region: "another-region" } },
    { "idempotency-key": "template-only" },
  );
  expect(differentValues.status).toBe(200);
  expect((await differentValues.json()).installPlan.id).toBe(templateRecord.id);
});

function installFixture(
  options: {
    readonly loseAckOnce?: readonly LostAckMutation[];
    readonly retryablePlanErrorOnce?: boolean;
    readonly repositoryManifest?: SourceSnapshot["repositoryManifest"];
    readonly repositoryModules?: SourceSnapshot["repositoryModules"];
    readonly installConfigs?: readonly InstallConfig[];
    readonly providerConnections?: readonly ProviderConnection[];
    readonly compatibilityRunStatus?: "succeeded" | "failed";
    readonly compatibilityReportLevel?: CapsuleCompatibilityReport["level"];
    readonly compatibilityRootModuleVariableDeclarations?: CapsuleCompatibilityReport["rootModuleVariableDeclarations"];
    readonly compatibilityRootProviderRequirements?: CapsuleCompatibilityReport["rootProviderRequirements"];
    readonly compatibilityResources?: CapsuleCompatibilityReport["resources"];
    readonly omitCompatibilityRootModuleVariableDeclarations?: boolean;
    readonly providerValidationError?: OpenTofuControllerError;
    readonly pausePreparation?: boolean;
    readonly raceAfterClaimBeforeSourceSync?: boolean;
    /** Capture keeps returning the first epoch, so only the store fence refuses. */
    readonly staleManagementCapture?: boolean;
  } = {},
) {
  const managementStore = new InMemoryOpenTofuControlStore();
  // The in-memory store installs the Workspace synchronously before resolving.
  void managementStore.putWorkspace(WORKSPACE);
  const workspacesService = new WorkspacesService({ store: managementStore });
  let resumedManagementEpoch: number | undefined;
  const managementValidator = {
    isWorkspaceManagementAdmissionAllowed(
      workspaceId: string,
      expected?: WorkspaceManagementAuthority,
    ): boolean {
      if (resumedManagementEpoch !== undefined) {
        return workspaceId === WORKSPACE.id &&
          (expected === undefined ||
            expected.workspaceId === workspaceId &&
              expected.managementEpoch === resumedManagementEpoch);
      }
      return managementStore.isWorkspaceManagementAdmissionAllowed(
        workspaceId,
        expected,
      );
    },
  };
  const planStore = new InMemoryGitInstallPlanStore(managementValidator);
  const accountsStore = new InMemoryAccountsStore();
  const loseAck = new Set(options.loseAckOnce ?? []);
  const sources: Source[] = [];
  const syncRuns = new Map<string, SourceSyncRun>();
  const snapshots: SourceSnapshot[] = [];
  const capsules: Capsule[] = [];
  const runs = new Map<string, Run>();
  const compatibilityReports = new Map<string, CapsuleCompatibilityReport>();
  const providerBindingSets = new Map<string, ProviderBindingSet>();
  const capsuleAuthorityEpochs = new Map<string, number>();
  const installConfigs = new Map<string, InstallConfig>([
    ["cfg-default-opentofu-capsule", defaultCapsuleInstallConfig()],
    ...(options.installConfigs ?? []).map(
      (config) => [config.id, config] as const,
    ),
  ]);
  const counts = { source: 0, sync: 0, capsule: 0, plan: 0 };
  const sourcePatches: { readonly id: string; readonly autoSync?: boolean }[] = [];
  const deletedSources: string[] = [];
  const abandonedCapsules: string[] = [];
  let compatibilityMutationCount = 0;
  let installConfigMutationCount = 0;
  let approvalCalls = 0;
  let applyCalls = 0;
  let retryablePlanErrorPending = options.retryablePlanErrorOnce === true;
  let preparationPausePending = options.pausePreparation === true;
  let raceAfterClaimBeforeSourceSyncPending =
    options.raceAfterClaimBeforeSourceSync === true;
  let resolvePreparationStarted: (() => void) | undefined;
  let releasePreparationGate: (() => void) | undefined;
  const preparationStarted = new Promise<void>((resolve) => {
    resolvePreparationStarted = resolve;
  });
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparationGate = resolve;
  });

  async function raceManagementEpochAfterClaim(): Promise<void> {
    const management = await managementStore.getWorkspaceManagement(
      WORKSPACE.id,
    );
    if (!management || management.managementState !== "active") {
      throw new Error("Workspace is not active");
    }
    const result = await managementStore.beginWorkspaceDraining(WORKSPACE.id, {
      workspaceId: WORKSPACE.id,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    });
    if (result.status !== "started") {
      throw new Error("Workspace did not start draining");
    }
    // There is intentionally no public abort/resume endpoint yet. The
    // fixture's read-only validator models the documented N+2 active epoch
    // so stale child preparation cannot be blessed by a later active state.
    resumedManagementEpoch = management.managementEpoch + 2;
  }

  const operations = {
    gitInstallPlans: planStore,
    workspaces: {
      getWorkspace: async (id: string) => {
        if (id !== WORKSPACE.id) throw new Error("workspace not found");
        return WORKSPACE;
      },
      captureManagementAuthority: async (workspaceId: string) => {
        if (options.staleManagementCapture) {
          return {
            workspaceId,
            managementState: "active" as const,
            managementEpoch: 1,
          };
        }
        if (resumedManagementEpoch !== undefined) {
          return {
            workspaceId,
            managementState: "active" as const,
            managementEpoch: resumedManagementEpoch,
          };
        }
        return await workspacesService.captureManagementAuthority(workspaceId);
      },
    },
    members: {
      // One active admin who is not the Workspace owner, for actor isolation.
      getMember: async (workspaceId: string, subject: string) =>
        subject === ADMIN_SUBJECT || subject === VIEWER_SUBJECT
          ? {
              workspaceId,
              accountId: subject,
              status: "active",
              roles: [subject === ADMIN_SUBJECT ? "admin" : "viewer"],
            }
          : undefined,
      listMembers: async () => [],
    },
    connections: {
      listProviderConnections: async () => options.providerConnections ?? [],
    },
    listSources: async () => ({ sources }),
    createSource: async (input: {
      readonly workspaceId: string;
      readonly name: string;
      readonly url: string;
      readonly defaultRef?: string;
      readonly defaultPath?: string;
      readonly authConnectionId?: string;
    }) => {
      counts.source += 1;
      const source: Source = {
        id: "src_one",
        workspaceId: input.workspaceId,
        name: input.name,
        url: input.url,
        defaultRef: input.defaultRef ?? "HEAD",
        defaultPath: input.defaultPath ?? ".",
        ...(input.authConnectionId
          ? { authConnectionId: input.authConnectionId }
          : {}),
        status: "active",
        autoSync: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sources.push(source);
      lose("source");
      return { source, hookSecret: "never-record-this-hook-secret" };
    },
    getSource: async (id: string) => {
      const source = sources.find((candidate) => candidate.id === id);
      if (!source) throw new OpenTofuControllerError("not_found", "missing");
      return { source };
    },
    patchSource: async (id: string, patch: { readonly autoSync?: boolean }) => {
      const index = sources.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new OpenTofuControllerError("not_found", "missing");
      sourcePatches.push({ id, ...patch });
      sources[index] = {
        ...sources[index]!,
        ...(patch.autoSync !== undefined ? { autoSync: patch.autoSync } : {}),
      };
      return { source: sources[index]! };
    },
    deleteSource: async (
      id: string,
      _actor?: string,
      authority?: WorkspaceManagementAuthority,
    ) => {
      if (!managementValidator.isWorkspaceManagementAdmissionAllowed(WORKSPACE.id, authority)) {
        throw new OpenTofuControllerError("failed_precondition", "management");
      }
      const index = sources.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new OpenTofuControllerError("not_found", "missing");
      if (
        capsules.some((capsule) =>
          capsule.sourceId === id && capsule.status !== "destroyed"
        )
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "referenced",
          { reason: "source_referenced_by_capsule" },
        );
      }
      const [removed] = sources.splice(index, 1);
      deletedSources.push(id);
      return { source: removed! };
    },
    createSourceSync: async (
      sourceId: string,
      _request: unknown,
      expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
    ) => {
      if (raceAfterClaimBeforeSourceSyncPending) {
        raceAfterClaimBeforeSourceSyncPending = false;
        await raceManagementEpochAfterClaim();
      }
      if (
        !managementValidator.isWorkspaceManagementAdmissionAllowed(
          WORKSPACE.id,
          expectedWorkspaceManagementAuthority,
        )
      ) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "Workspace management admission conflict",
          { reason: "workspace_management_admission_conflict" },
        );
      }
      counts.sync += 1;
      const source = sources.find((candidate) => candidate.id === sourceId)!;
      const run: SourceSyncRun = {
        id: "ssr_one",
        kind: "source_sync",
        workspaceId: WORKSPACE.id,
        sourceId,
        url: source.url,
        ref: source.defaultRef,
        path: source.defaultPath,
        archiveRef: "source-archive/snap_one",
        intent: "manual_plan",
        status: "queued",
        snapshotId: "snap_one",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      syncRuns.set(run.id, run);
      lose("sync");
      return { run };
    },
    getSourceSyncRun: async (id: string) => {
      const run = syncRuns.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return run;
    },
    getSourceSnapshot: async (id: string) => {
      const snapshot = snapshots.find((candidate) => candidate.id === id);
      if (!snapshot) throw new OpenTofuControllerError("not_found", "missing");
      return snapshot;
    },
    listSourceSnapshots: async () => ({ snapshots }),
    listRuns: async () => [
      ...[...syncRuns.values()].map(projectSyncRun),
      ...runs.values(),
    ],
    createSourceCompatibilityCheck: async (
      sourceId: string,
      request: {
        readonly sourceSnapshotId?: string;
        readonly modulePath?: string;
        readonly installConfigId?: string;
        readonly installPlanIdentity?: {
          readonly runId: string;
          readonly reportId: string;
          readonly createdBy: string;
        };
      },
    ) => {
      const identity = request.installPlanIdentity;
      if (!identity) {
        throw new Error("install-plan compatibility identity missing");
      }
      const existingRun = runs.get(identity.runId);
      const existingReport = compatibilityReports.get(identity.reportId);
      if (existingRun && existingReport) {
        return { report: existingReport, run: existingRun };
      }
      if (existingRun || existingReport) {
        throw new Error("partial compatibility evidence");
      }
      compatibilityMutationCount += 1;
      const now = new Date().toISOString();
      const report: CapsuleCompatibilityReport = {
        id: identity.reportId,
        sourceId,
        sourceSnapshotId: request.sourceSnapshotId!,
        modulePath: request.modulePath ?? ".",
        level: options.compatibilityReportLevel ?? "ready",
        findings: [],
        providers: [],
        resources: options.compatibilityResources ?? [],
        rootProviderRequirements:
          options.compatibilityRootProviderRequirements ?? [],
        dataSources: [],
        provisioners: [],
        rootModuleVariables: [],
        ...(options.omitCompatibilityRootModuleVariableDeclarations
          ? {}
          : {
              rootModuleVariableDeclarations:
                options.compatibilityRootModuleVariableDeclarations ?? [],
            }),
        rootModuleOutputs: [],
        createdAt: now,
      };
      const run: Run = {
        id: identity.runId,
        workspaceId: WORKSPACE.id,
        sourceId,
        type: "compatibility_check",
        status: options.compatibilityRunStatus ?? "succeeded",
        sourceSnapshotId: request.sourceSnapshotId,
        compatibilityReportId: report.id,
        createdBy: identity.createdBy,
        createdAt: now,
        startedAt: now,
        finishedAt: now,
      };
      compatibilityReports.set(report.id, report);
      runs.set(run.id, run);
      lose("compatibility");
      return { report, run };
    },
    getCompatibilityReport: async (id: string) => {
      const report = compatibilityReports.get(id);
      if (!report) throw new OpenTofuControllerError("not_found", "missing");
      return { report };
    },
    capsules: {
      getInstallConfig: async (id: string) => {
        const config = installConfigs.get(id);
        if (!config) throw new OpenTofuControllerError("not_found", "missing");
        if (preparationPausePending && id === "cfg-default-opentofu-capsule") {
          preparationPausePending = false;
          resolvePreparationStarted?.();
          await preparationGate;
        }
        return config;
      },
      listInstallConfigsPage: async () => ({
        items: [...installConfigs.values()],
      }),
      listSharedInstallConfigsPage: async () => ({
        items: [...installConfigs.values()].filter(
          (config) => config.workspaceId === undefined,
        ),
      }),
      putInstallConfig: async (config: InstallConfig) => {
        installConfigMutationCount += 1;
        installConfigs.set(config.id, config);
        return config;
      },
      listCapsulesPage: async () => ({ items: capsules }),
      listCapsules: async () => capsules,
      abandonUnappliedCapsule: async (
        id: string,
        _reason: string,
        authority?: WorkspaceManagementAuthority,
      ) => {
        if (!managementValidator.isWorkspaceManagementAdmissionAllowed(WORKSPACE.id, authority)) {
          throw new OpenTofuControllerError("failed_precondition", "management");
        }
        const index = capsules.findIndex((candidate) => candidate.id === id);
        if (index < 0) throw new OpenTofuControllerError("not_found", "missing");
        if (capsules[index]!.currentStateGeneration > 0) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "applied state",
          );
        }
        abandonedCapsules.push(id);
        capsules[index] = { ...capsules[index]!, status: "destroyed" };
        return capsules[index]!;
      },
      getCapsule: async (id: string) => {
        const capsule = capsules.find((candidate) => candidate.id === id);
        if (!capsule) throw new OpenTofuControllerError("not_found", "missing");
        return capsule;
      },
      createCapsuleInitialAuthority: async (input: {
        readonly capsuleId: string;
        readonly workspaceId: string;
        readonly projectId?: string;
        readonly name: string;
        readonly environment: string;
        readonly sourceId: string;
        readonly installingPrincipalId: string;
        readonly autoUpdate?: boolean;
        readonly installConfig: InstallConfig;
        readonly providerBindingSetId: string;
        readonly providerBindings: ProviderBindingSet["bindings"];
      }) => {
        const existing = capsules.find(
          (candidate) => candidate.id === input.capsuleId,
        );
        if (existing) {
          const existingConfig = installConfigs.get(input.installConfig.id);
          const existingBinding = providerBindingSets.get(
            `${input.capsuleId}:${input.environment}`,
          );
          const expectedBinding: ProviderBindingSet = {
            id: input.providerBindingSetId,
            workspaceId: input.workspaceId,
            capsuleId: input.capsuleId,
            environment: input.environment,
            bindings: input.providerBindings,
            createdAt: input.installConfig.createdAt,
            updatedAt: input.installConfig.updatedAt,
          };
          if (
            !existingConfig ||
            !existingBinding ||
            (await stableJsonDigest(existingConfig)) !==
              (await stableJsonDigest(input.installConfig)) ||
            (await stableJsonDigest(existingBinding)) !==
              (await stableJsonDigest(expectedBinding))
          ) {
            throw new OpenTofuControllerError(
              "failed_precondition",
              "initial authority replay was not exact",
            );
          }
          return { capsule: existing, replayed: true };
        }
        counts.capsule += 1;
        installConfigMutationCount += 1;
        installConfigs.set(input.installConfig.id, input.installConfig);
        const capsule: Capsule = {
          id: input.capsuleId,
          workspaceId: input.workspaceId,
          projectId: input.projectId ?? "prj_default",
          name: input.name,
          slug: input.name,
          environment: input.environment,
          sourceId: input.sourceId,
          installConfigId: input.installConfig.id,
          installingPrincipalId: input.installingPrincipalId,
          currentStateGeneration: 0,
          status: "pending",
          ...(input.autoUpdate === true ? { autoUpdate: true } : {}),
          createdAt: input.installConfig.createdAt,
          updatedAt: input.installConfig.updatedAt,
        };
        capsules.push(capsule);
        const providerBindingSet: ProviderBindingSet = {
          id: input.providerBindingSetId,
          workspaceId: input.workspaceId,
          capsuleId: input.capsuleId,
          environment: input.environment,
          bindings: input.providerBindings,
          createdAt: input.installConfig.createdAt,
          updatedAt: input.installConfig.updatedAt,
        };
        providerBindingSets.set(
          `${providerBindingSet.capsuleId}:${providerBindingSet.environment}`,
          providerBindingSet,
        );
        capsuleAuthorityEpochs.set(input.capsuleId, 1);
        lose("capsule");
        return { capsule, replayed: false };
      },
      createCapsule: async (input: {
        readonly workspaceId: string;
        readonly projectId?: string;
        readonly name: string;
        readonly environment: string;
        readonly sourceId: string;
        readonly installConfigId: string;
        readonly installingPrincipalId: string;
      }) => {
        counts.capsule += 1;
        const capsule: Capsule = {
          id: "cap_one",
          workspaceId: input.workspaceId,
          projectId: input.projectId ?? "prj_default",
          name: input.name,
          environment: input.environment,
          sourceId: input.sourceId,
          installConfigId: input.installConfigId,
          installingPrincipalId: input.installingPrincipalId,
          currentStateGeneration: 0,
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        capsules.push(capsule);
        lose("capsule");
        return capsule;
      },
      getProviderBindingSetByCapsule: async (
        capsuleId: string,
        environment: string,
      ) => providerBindingSets.get(`${capsuleId}:${environment}`),
    },
    getRun: async (id: string) => {
      const run = runs.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return run;
    },
    validateCapsuleConfigurationProviderBindings: async () => {
      if (options.providerValidationError) {
        throw options.providerValidationError;
      }
    },
    createCapsulePlan: async (
      capsuleId: string,
      input: {
        readonly sourceSnapshotId?: string;
        readonly planRunId?: string;
        readonly actor?: string;
      },
    ) => {
      if (retryablePlanErrorPending) {
        retryablePlanErrorPending = false;
        throw new OpenTofuControllerError(
          "failed_precondition",
          "never-serialize-controller-exception-prose",
          { reason: "module_variable_materialization_failed" },
        );
      }
      counts.plan += 1;
      const run: Run = {
        id: input.planRunId!,
        workspaceId: WORKSPACE.id,
        capsuleId,
        environment: "production",
        type: "plan",
        status: "waiting_approval",
        sourceSnapshotId: input.sourceSnapshotId,
        createdBy: input.actor!,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      runs.set(run.id, run);
      lose("plan");
      return { planRun: run as never };
    },
    approveRun: async () => {
      approvalCalls += 1;
      throw new Error("install plan must not approve");
    },
    createApplyRun: async () => {
      applyCalls += 1;
      throw new Error("install plan must not apply");
    },
  } as unknown as ControlPlaneOperations;

  function lose(kind: LostAckMutation): void {
    if (!loseAck.delete(kind)) return;
    throw new Error(`lost ack super-secret-mutation-value ${kind}`);
  }

  return {
    planStore,
    sources,
    capsules,
    sourcePatches,
    deletedSources,
    abandonedCapsules,
    addCapsule(capsule: Capsule) {
      capsules.push(capsule);
    },
    applyCapsule(id: string) {
      const index = capsules.findIndex((candidate) => candidate.id === id);
      capsules[index] = { ...capsules[index]!, currentStateGeneration: 1, status: "active" };
    },
    preparationStarted,
    releasePreparation: () => releasePreparationGate?.(),
    async beginDrain() {
      const management = await managementStore.getWorkspaceManagement(
        WORKSPACE.id,
      );
      if (!management || management.managementState !== "active") {
        throw new Error("Workspace is not active");
      }
      return await managementStore.beginWorkspaceDraining(WORKSPACE.id, {
        workspaceId: WORKSPACE.id,
        managementState: "active",
        managementEpoch: management.managementEpoch,
      });
    },
    async drainAndResume() {
      const management = await managementStore.getWorkspaceManagement(
        WORKSPACE.id,
      );
      if (!management || management.managementState !== "active") {
        throw new Error("Workspace is not active");
      }
      const result = await managementStore.beginWorkspaceDraining(WORKSPACE.id, {
        workspaceId: WORKSPACE.id,
        managementState: "active",
        managementEpoch: management.managementEpoch,
      });
      if (result.status !== "started") {
        throw new Error("Workspace did not start draining");
      }
      // There is intentionally no public abort/resume endpoint yet. The
      // fixture's read-only validator models the documented N+2 active epoch
      // so stale preparation cannot be blessed by a later active state.
      resumedManagementEpoch = management.managementEpoch + 2;
      return result;
    },
    counts,
    get compatibilityMutationCount() {
      return compatibilityMutationCount;
    },
    get installConfigMutationCount() {
      return installConfigMutationCount;
    },
    compatibilityEvidence: () =>
      [...compatibilityReports.values()].map((report) => ({
        report,
        run: runs.get(
          [...runs.values()].find(
            (run) => run.compatibilityReportId === report.id,
          )!.id,
        )!,
      })),
    getInstallConfig: (id: string) => installConfigs.get(id),
    replaceInstallConfig(
      id: string,
      patch: Partial<InstallConfig>,
    ): void {
      const current = installConfigs.get(id);
      if (!current) throw new Error(`InstallConfig ${id} not found`);
      installConfigs.set(id, {
        ...current,
        ...patch,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
      });
    },
    getProviderBindingSet: (capsuleId: string, environment: string) =>
      providerBindingSets.get(`${capsuleId}:${environment}`),
    authorityRows: () => ({
      capsules: capsules.length,
      bindingSets: providerBindingSets.size,
      epochs: capsuleAuthorityEpochs.size,
    }),
    get approvalCalls() {
      return approvalCalls;
    },
    get applyCalls() {
      return applyCalls;
    },
    seedPreflight(input: {
      readonly variableDeclarations: NonNullable<
        CapsuleCompatibilityReport["rootModuleVariableDeclarations"]
      >;
    }) {
      const now = new Date().toISOString();
      const source: Source = {
        id: "src_preflight",
        workspaceId: WORKSPACE.id,
        name: "example",
        url: "https://github.com/takos/example",
        defaultRef: "main",
        defaultPath: ".",
        status: "active",
        autoSync: false,
        createdAt: now,
        updatedAt: now,
      };
      sources.push(source);
      const snapshot: SourceSnapshot = {
        id: "snap_preflight",
        origin: "git",
        workspaceId: WORKSPACE.id,
        sourceId: source.id,
        url: source.url,
        ref: source.defaultRef,
        resolvedCommit: "c".repeat(40),
        path: source.defaultPath,
        archiveRef: "source-archive/snap_preflight",
        archiveDigest: `sha256:${"d".repeat(64)}`,
        archiveSizeBytes: 64,
        repositoryManifest: { status: "absent" },
        repositoryModules: {
          status: "ready",
          scopePath: ".",
          modules: [
            {
              path: ".",
              providerPackages: [],
              rootProviderRequirements: [],
            },
          ],
        },
        fetchedByRunId: "ssr_preflight",
        fetchedAt: now,
      };
      snapshots.push(snapshot);
      const report: CapsuleCompatibilityReport = {
        id: "caprep_preflight",
        sourceId: source.id,
        sourceSnapshotId: snapshot.id,
        modulePath: ".",
        level: "ready",
        findings: [],
        providers: [],
        resources: [],
        dataSources: [],
        provisioners: [],
        rootModuleVariables: input.variableDeclarations.map((item) => item.name),
        rootModuleVariableDeclarations: input.variableDeclarations,
        rootModuleOutputs: [],
        createdAt: now,
      };
      compatibilityReports.set(report.id, report);
      const run: Run = {
        id: "ccr_preflight",
        workspaceId: WORKSPACE.id,
        sourceId: source.id,
        type: "compatibility_check",
        status: "succeeded",
        sourceSnapshotId: snapshot.id,
        compatibilityReportId: report.id,
        createdBy: WORKSPACE.ownerUserId,
        createdAt: now,
        startedAt: now,
        finishedAt: now,
      };
      runs.set(run.id, run);
      return {
        sourceId: source.id,
        sourceSnapshotId: snapshot.id,
        compatibilityCheckRunId: run.id,
        compatibilityReportId: report.id,
        installConfigId: "cfg-default-opentofu-capsule",
      };
    },
    mutationCount: () =>
      counts.source + counts.sync + counts.capsule + counts.plan,
    succeedSourceSync() {
      const current = syncRuns.get("ssr_one")!;
      const sourcePath = sources[0]?.defaultPath ?? ".";
      syncRuns.set("ssr_one", {
        ...current,
        status: "succeeded",
        resolvedCommit: "a".repeat(40),
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 42,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      if (snapshots.length === 0) {
        snapshots.push({
          id: "snap_one",
          origin: "git",
          workspaceId: WORKSPACE.id,
          sourceId: "src_one",
          url: "https://github.com/takos/example",
          ref: "main",
          resolvedCommit: "a".repeat(40),
          path: sourcePath,
          archiveRef: "source-archive/snap_one",
          archiveDigest: `sha256:${"b".repeat(64)}`,
          archiveSizeBytes: 42,
          repositoryManifest: options.repositoryManifest ?? {
            status: "absent",
          },
          repositoryModules: options.repositoryModules ?? {
            status: "ready",
            scopePath: sourcePath,
            modules: [
              {
                path: ".",
                providerPackages: [],
                rootProviderRequirements: [],
              },
            ],
          },
          fetchedByRunId: "ssr_one",
          fetchedAt: new Date().toISOString(),
        });
      }
    },
    reconcile: (planId: string) =>
      request(`/api/v1/install-plans/${planId}/reconcile`, "POST"),
    request,
  };

  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Readonly<Record<string, string>> = {},
    subject = WORKSPACE.ownerUserId,
  ): Promise<Response> {
    const url = new URL(`https://app.example.test${path}`);
    const response = await handleAuthenticatedControlRoute({
      request: new Request(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accountsStore,
      operations,
      subject,
    });
    if (!response) throw new Error("control route did not dispatch");
    return response;
  }
}

function projectSyncRun(run: SourceSyncRun): Run {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    sourceId: run.sourceId,
    ref: run.ref,
    type: "source_sync",
    status:
      run.status === "queued" || run.status === "running"
        ? run.status
        : run.status === "succeeded"
          ? "succeeded"
          : "failed",
    ...(run.status === "succeeded" && run.snapshotId
      ? { sourceSnapshotId: run.snapshotId }
      : {}),
    createdBy: "system",
    createdAt: run.createdAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  };
}

function createBody(
  input: {
    readonly capsuleName?: string;
    readonly sourceUrl?: string;
    readonly sourcePath?: string;
    readonly modulePath?: string;
    readonly providerBindings?: readonly GitInstallPlanProviderBindingRequest[];
  } = {},
) {
  return {
    source: {
      name: "example",
      url: input.sourceUrl ?? "https://github.com/takos/example.git",
      ref: "main",
      path: input.sourcePath ?? ".",
    },
    capsule: {
      name: input.capsuleName ?? "example",
      environment: "production",
    },
    ...(input.modulePath !== undefined || input.providerBindings !== undefined
      ? {
          options: {
            ...(input.modulePath !== undefined
              ? { modulePath: input.modulePath }
              : {}),
            ...(input.providerBindings !== undefined
              ? { providerBindings: input.providerBindings }
              : {}),
          },
        }
      : {}),
  };
}

function providerConnection(
  provider: string,
  id: string,
): ProviderConnection {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId: WORKSPACE.id,
    provider,
    providerSource: provider,
    scope: "workspace",
    status: "verified",
    materialization: "secret",
    envNames: [],
    createdAt: now,
    updatedAt: now,
  };
}

function repositoryManifest(
  modulePaths: readonly string[],
): NonNullable<SourceSnapshot["repositoryManifest"]> {
  return {
    status: "present",
    digest: `sha256:${"d".repeat(64)}`,
    document: {
      apiVersion: "takosumi.com/v2.1",
      kind: "Repository",
      install: {
        modules: Object.fromEntries(
          modulePaths.map((modulePath) => [modulePath, { inputs: [] }]),
        ),
      },
    },
  } as NonNullable<SourceSnapshot["repositoryManifest"]>;
}
