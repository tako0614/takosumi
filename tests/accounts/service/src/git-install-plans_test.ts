import { expect, test } from "bun:test";

import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleAuthenticatedControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { defaultCapsuleInstallConfig } from "../../../../core/domains/capsules/default_install_config.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
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
      capsuleId: "cap_one",
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
    fixture.getProviderBindingSet("cap_one", "production")?.bindings,
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
  response = await fixture.reconcile(planId); // recover Capsule id
  response = await fixture.reconcile(planId); // creating -> planning

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
  for (let step = 0; step < 5; step += 1) {
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

function installFixture(
  options: {
    readonly loseAckOnce?: readonly LostAckMutation[];
    readonly retryablePlanErrorOnce?: boolean;
    readonly repositoryManifest?: SourceSnapshot["repositoryManifest"];
    readonly repositoryModules?: SourceSnapshot["repositoryModules"];
    readonly installConfigs?: readonly InstallConfig[];
    readonly providerConnections?: readonly ProviderConnection[];
  } = {},
) {
  const planStore = new InMemoryGitInstallPlanStore();
  const accountsStore = new InMemoryAccountsStore();
  const loseAck = new Set(options.loseAckOnce ?? []);
  const sources: Source[] = [];
  const syncRuns = new Map<string, SourceSyncRun>();
  const snapshots: SourceSnapshot[] = [];
  const capsules: Capsule[] = [];
  const runs = new Map<string, Run>();
  const compatibilityReports = new Map<string, CapsuleCompatibilityReport>();
  const providerBindingSets = new Map<string, ProviderBindingSet>();
  const installConfigs = new Map<string, InstallConfig>([
    ["cfg-default-opentofu-capsule", defaultCapsuleInstallConfig()],
    ...(options.installConfigs ?? []).map(
      (config) => [config.id, config] as const,
    ),
  ]);
  const counts = { source: 0, sync: 0, capsule: 0, plan: 0 };
  let compatibilityMutationCount = 0;
  let installConfigMutationCount = 0;
  let approvalCalls = 0;
  let applyCalls = 0;
  let retryablePlanErrorPending = options.retryablePlanErrorOnce === true;

  const operations = {
    gitInstallPlans: planStore,
    workspaces: {
      getWorkspace: async (id: string) => {
        if (id !== WORKSPACE.id) throw new Error("workspace not found");
        return WORKSPACE;
      },
    },
    members: {
      getMember: async () => undefined,
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
    createSourceSync: async (sourceId: string) => {
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
        level: "ready",
        findings: [],
        providers: [],
        resources: [],
        dataSources: [],
        provisioners: [],
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
        rootModuleOutputs: [],
        createdAt: now,
      };
      const run: Run = {
        id: identity.runId,
        workspaceId: WORKSPACE.id,
        sourceId,
        type: "compatibility_check",
        status: "succeeded",
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
      getCapsule: async (id: string) => {
        const capsule = capsules.find((candidate) => candidate.id === id);
        if (!capsule) throw new OpenTofuControllerError("not_found", "missing");
        return capsule;
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
      putProviderBindingSet: async (value: unknown) => {
        const providerBindingSet = value as ProviderBindingSet;
        providerBindingSets.set(
          `${providerBindingSet.capsuleId}:${providerBindingSet.environment}`,
          providerBindingSet,
        );
        return providerBindingSet;
      },
    },
    getRun: async (id: string) => {
      const run = runs.get(id);
      if (!run) throw new OpenTofuControllerError("not_found", "missing");
      return run;
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
    getProviderBindingSet: (capsuleId: string, environment: string) =>
      providerBindingSets.get(`${capsuleId}:${environment}`),
    get approvalCalls() {
      return approvalCalls;
    },
    get applyCalls() {
      return applyCalls;
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
