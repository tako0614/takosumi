import { test, expect } from "bun:test";

import type {
  ActorContext,
  TargetImplementationDescriptor,
  TargetPoolEntry,
} from "takosumi-contract";
import type {
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  PlanRunResponse,
  PublicPlanRun,
} from "@takosumi/internal/deploy-control-api";
import type {
  ApplyRunInternalContext,
  DeployControlActorContext,
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuRunner,
  PlanRunInternalContext,
} from "../../../../core/domains/deploy-control/mod.ts";
import { OpenTofuController } from "../../../../core/domains/deploy-control/mod.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { resourceImportPolicyReasons } from "../../../../core/domains/deploy-control/run-engine/run_engine.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import {
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  parseResourceSpec as parseCoreResourceSpec,
  planResourceShape,
  type ResourceShapePlan,
} from "../../../../core/domains/resource-shape/planner.ts";
import {
  type AdapterApplyInput,
  type AdapterDeleteInput,
} from "../../../../core/domains/resource-shape/adapter.ts";
import {
  ControllerOpentofuRunPort,
  type DeployControlRunDriver,
  FakeOpentofuRunPort,
  OpentofuResourceShapeAdapter,
  providerLocalNameForSource,
} from "../../../../core/domains/resource-shape/opentofu_adapter.ts";
import { TEST_RESOURCE_SHAPE_MODULE_REGISTRY } from "../../../helpers/resource-shape/operator-module-registry.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const parseResourceSpec: typeof parseCoreResourceSpec = (
  kind,
  spec,
  registry = LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
) => parseCoreResourceSpec(kind, spec, registry);

const actor: ActorContext = {
  actorAccountId: "acct_1",
  roles: ["owner"],
  requestId: "req_1",
};

const cloudflareTarget: TargetPoolEntry = {
  name: "cf-main",
  type: "cloudflare",
  ref: "cf-account-123",
  region: "weur",
  priority: 10,
};

const customProviderBaseUrl = "https://operator.example.test/compat/example/v1";

const edgeDescriptor: TargetImplementationDescriptor = {
  shape: "EdgeWorker",
  implementation: "cloudflare_workers",
  nativeResourceType: "cloudflare.workers_script",
  interfaces: { worker_fetch: "native", workers_bindings: "native" },
  providerSource: "registry.opentofu.org/cloudflare/cloudflare",
  moduleTemplate: "cloudflare-worker-service",
  moduleImportAddress: "cloudflare_workers_script.this",
  moduleInputMappings: {
    appName: { source: "spec", path: "/name", required: true },
    accountId: { source: "target", path: "/ref", required: true },
    artifactPath: { source: "spec", path: "/source/artifactPath" },
    connections: { source: "spec", path: "/connections", default: {} },
  },
  moduleOutputs: [
    { name: "worker_name", type: "string" },
    { name: "url", type: "url" },
    { name: "connections", type: "json" },
  ],
};

const pluginDescriptor: TargetImplementationDescriptor = {
  shape: "EdgeWorker",
  implementation: "operator_edge_plugin",
  interfaces: { worker_fetch: "native" },
  plugin: "takosumi-container-plugin",
};

function edgeWorkerPlan(): ResourceShapePlan {
  const parsed = parseResourceSpec("EdgeWorker", {
    name: "api",
    source: { artifactPath: "/work/dist/worker.js" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return planResourceShape(
    edgeDescriptor,
    parsed.parsed,
    cloudflareTarget,
    TEST_RESOURCE_SHAPE_MODULE_REGISTRY,
  );
}

function applyInput(
  plan: ResourceShapePlan,
  target: TargetPoolEntry,
  overrides: Partial<AdapterApplyInput> = {},
): AdapterApplyInput {
  const input: AdapterApplyInput = {
    resourceId: "tkrn:demo:EdgeWorker:api",
    resourceGeneration: 3,
    environment: "production",
    stateGeneration: 3,
    plan,
    target,
    implementation: edgeDescriptor,
    credentialRef: "conn_cf_1",
    actor,
    ...overrides,
  };
  if (
    input.stateGeneration === 0 ||
    input.stateAdoption ||
    input.priorState
  ) {
    return input;
  }
  return {
    ...input,
    priorState: resourcePriorState(input.stateGeneration),
  };
}

function resourcePriorState(generation: number) {
  return {
    generation,
    stateRef: `workspaces/demo/resources/tkrn_demo_EdgeWorker_api/environments/production/state-versions/${String(generation).padStart(8, "0")}.tfstate.enc`,
    digest: `sha256:state-${generation}`,
    createdByRunId: `apply_${generation}`,
  };
}

test("provider local name comes only from the explicit provider source", () => {
  expect(
    providerLocalNameForSource("registry.opentofu.org/cloudflare/cloudflare"),
  ).toBe("cloudflare");
  expect(providerLocalNameForSource("registry.example.test/acme/custom")).toBe(
    "custom",
  );
});

test("Resource import policy permits one no-op import and rejects native mutation", () => {
  const importRun = { resourceImport: true } as never;
  expect(
    resourceImportPolicyReasons(importRun, {
      planResourceChanges: [
        {
          address: "module.child.cloudflare_workers_script.this",
          type: "cloudflare_workers_script",
          actions: ["no-op"],
          importing: true,
        },
      ],
    }),
  ).toEqual([]);
  expect(
    resourceImportPolicyReasons(importRun, {
      planResourceChanges: [
        {
          address: "module.child.cloudflare_workers_script.this",
          type: "cloudflare_workers_script",
          actions: ["update"],
          importing: true,
        },
      ],
    }),
  ).toContain(
    "resource import plan contains 1 native mutation action(s); align the requested spec with the existing backend resource before import",
  );
});

test("apply maps target inputs and threads the explicit operator module", async () => {
  const port = new FakeOpentofuRunPort({
    nativeResources: {
      "tkrn:demo:EdgeWorker:api": [
        { type: "cloudflare_workers_script", id: "api" },
      ],
    },
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const result = await adapter.apply(applyInput(plan, cloudflareTarget));

  expect(port.applyRequests.length).toBe(1);
  expect(port.planRequests.length).toBe(0);
  const req = port.applyRequests[0]!;

  expect(req.providerBinding.provider).toBe("cloudflare");
  expect(req.providerBinding.providerSource).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );
  expect(req.providerBinding.connectionId).toBe("conn_cf_1");
  expect(req.providerBinding.configuration).toBeUndefined();
  expect(req.inputs.appName).toBe("api");
  expect(req.inputs.accountId).toBe("cf-account-123");
  expect(req.inputs.artifactPath).toBe("/work/dist/worker.js");
  expect(req.moduleTemplate).toBe("cloudflare-worker-service");
  expect(req.operatorModule).toBe(plan.operatorModule);
  expect(req.publicOutputs).toEqual([
    { name: "worker_name", type: "string" },
    { name: "url", type: "url" },
    { name: "connections", type: "json" },
  ]);

  expect(result.nativeResources).toEqual([
    { type: "cloudflare_workers_script", id: "api" },
  ]);
  expect(result.outputs).toEqual({
    worker_name: "fake://tkrn:demo:EdgeWorker:api/worker_name",
    url: "fake://tkrn:demo:EdgeWorker:api/url",
    connections: {},
  });
  expect(result.runId).toBeDefined();
});

test("import threads an explicit native id through the OpenTofu import port", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);

  const result = await adapter.importResource({
    ...applyInput(edgeWorkerPlan(), cloudflareTarget, { stateGeneration: 0 }),
    nativeId: "existing-worker-id",
  });

  expect(port.importRequests).toHaveLength(1);
  expect(port.importRequests[0]).toMatchObject({
    nativeId: "existing-worker-id",
    importAddress: "cloudflare_workers_script.this",
    stateGeneration: 0,
  });
  expect(result).toMatchObject({
    summary: "import cloudflare_workers_script.this",
    nativeResources: [
      { type: "cloudflare_workers_script", id: "existing-worker-id" },
    ],
  });
});

test("apply threads managed provider base_url from implementation options", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.apply(
    applyInput(plan, cloudflareTarget, {
      implementation: {
        ...edgeDescriptor,
        providerConfig: { base_url: customProviderBaseUrl },
      },
    }),
  );

  expect(port.applyRequests[0]?.providerBinding.configuration?.base_url).toBe(
    customProviderBaseUrl,
  );
});

test("preview returns summary + nativeResources + runId from a simulated plan", async () => {
  const port = new FakeOpentofuRunPort({
    nativeResources: {
      "tkrn:demo:EdgeWorker:api": [
        { type: "cloudflare_workers_script", id: "api" },
      ],
    },
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const preview = await adapter.preview(applyInput(plan, cloudflareTarget));

  expect(port.planRequests.length).toBe(1);
  expect(port.applyRequests.length).toBe(0);
  expect(preview.summary).toContain("cloudflare-worker-service");
  expect(preview.nativeResources).toEqual([
    { type: "cloudflare_workers_script", id: "api" },
  ]);
  expect(preview.runId).toBeDefined();
});

test("observe uses the read-only OpenTofu port", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const observed = await adapter.observe(applyInput(plan, cloudflareTarget));

  expect(observed.status).toBe("current");
  expect(port.observeRequests).toHaveLength(1);
  expect(port.applyRequests).toHaveLength(0);
  expect(port.destroyRequests).toHaveLength(0);
});

test("refresh uses the state-publishing OpenTofu port without a normal apply request", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const refreshed = await adapter.refresh(
    applyInput(plan, cloudflareTarget, {
      nativeResources: [{ type: "cloudflare_workers_script", id: "api" }],
    }),
  );

  expect(refreshed.summary).toContain("refresh");
  expect(port.refreshRequests).toHaveLength(1);
  expect(port.refreshRequests[0]?.nativeResources).toEqual([
    { type: "cloudflare_workers_script", id: "api" },
  ]);
  expect(port.applyRequests).toHaveLength(0);
  expect(port.destroyRequests).toHaveLength(0);
});

test("built-in opentofu adapter rejects operator plugin implementations instead of ignoring them", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await expect(
    adapter.preview(
      applyInput(plan, cloudflareTarget, {
        implementation: pluginDescriptor,
      }),
    ),
  ).rejects.toThrow("plugin-aware Resource Shape adapter");
  await expect(
    adapter.observe(
      applyInput(plan, cloudflareTarget, {
        implementation: pluginDescriptor,
      }),
    ),
  ).rejects.toThrow("plugin-aware Resource Shape adapter");
  await expect(
    adapter.apply(
      applyInput(plan, cloudflareTarget, {
        implementation: pluginDescriptor,
      }),
    ),
  ).rejects.toThrow("plugin-aware Resource Shape adapter");
  await expect(
    adapter.refresh(
      applyInput(plan, cloudflareTarget, {
        implementation: pluginDescriptor,
      }),
    ),
  ).rejects.toThrow("plugin-aware Resource Shape adapter");

  expect(port.planRequests.length).toBe(0);
  expect(port.applyRequests.length).toBe(0);
  expect(port.refreshRequests.length).toBe(0);
});

test("apply without a credentialRef leaves the ProviderBinding connectionId unset", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.apply(
    applyInput(plan, cloudflareTarget, { credentialRef: undefined }),
  );
  expect(port.applyRequests[0]!.providerBinding.connectionId).toBeUndefined();
});

function deleteInput(
  overrides: Partial<AdapterDeleteInput> = {},
): AdapterDeleteInput {
  const input: AdapterDeleteInput = {
    resourceId: "tkrn:demo:EdgeWorker:api",
    resourceGeneration: 3,
    environment: "production",
    stateGeneration: 3,
    nativeResources: [{ type: "cloudflare_workers_script", id: "api" }],
    target: cloudflareTarget,
    implementation: edgeDescriptor,
    credentialRef: "conn_cf_1",
    deletePolicy: "delete",
    actor,
    ...overrides,
  };
  if (
    input.stateGeneration === 0 ||
    input.stateAdoption ||
    input.priorState
  ) {
    return input;
  }
  return {
    ...input,
    priorState: resourcePriorState(input.stateGeneration),
  };
}

test("delete with the delete policy drives destroy on the port", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.delete(deleteInput({ plan }));

  expect(port.destroyRequests.length).toBe(1);
  const req = port.destroyRequests[0]!;
  expect(req.providerBinding.provider).toBe("cloudflare");
  expect(req.providerBinding.connectionId).toBe("conn_cf_1");
  expect(req.moduleTemplate).toBe(plan.moduleTemplate);
  expect(req.operatorModule?.files.map((file) => file.path)).toEqual(
    plan.operatorModule?.files.map((file) => file.path),
  );
  expect(req.inputs?.accountId).toBe("cf-account-123");
  expect(req.publicOutputs).toEqual(plan.publicOutputs);
  expect(req.nativeResources).toEqual([
    { type: "cloudflare_workers_script", id: "api" },
  ]);
  expect(req.deletePolicy).toBe("delete");
});

test("delete threads managed provider base_url from implementation options", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.delete(
    deleteInput({
      plan,
      implementation: {
        ...edgeDescriptor,
        providerConfig: { base_url: customProviderBaseUrl },
      },
    }),
  );

  expect(port.destroyRequests[0]?.providerBinding.configuration?.base_url).toBe(
    customProviderBaseUrl,
  );
});

test("delete with a retain or block policy never destroys", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);

  await adapter.delete(deleteInput({ deletePolicy: "retain" }));
  await adapter.delete(deleteInput({ deletePolicy: "block" }));
  expect(port.destroyRequests.length).toBe(0);
});

test("built-in opentofu adapter rejects plugin-backed destroy unless deletion is retained", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);

  await expect(
    adapter.delete(deleteInput({ implementation: pluginDescriptor })),
  ).rejects.toThrow("plugin-aware Resource Shape adapter");
  await adapter.delete(
    deleteInput({
      implementation: pluginDescriptor,
      deletePolicy: "retain",
    }),
  );

  expect(port.destroyRequests.length).toBe(0);
});

interface RecordedPlanCall {
  readonly request: CreatePlanRunRequest;
  readonly internal?: PlanRunInternalContext;
}

class FakeDeployControlDriver implements DeployControlRunDriver {
  readonly planCalls: RecordedPlanCall[] = [];
  readonly applyCalls: CreateApplyRunRequest[] = [];
  readonly checkpointedApplyRuns: string[] = [];
  readonly runQueuedPlanCalls: string[] = [];
  readonly runQueuedApplyCalls: string[] = [];
  readonly approveCalls: {
    readonly id: string;
    readonly input?: { readonly approvedBy?: string; readonly reason?: string };
  }[] = [];
  readonly #plans = new Map<string, PublicPlanRun>();
  readonly #applies = new Map<string, ApplyRunResponse["applyRun"]>();
  readonly #options: {
    readonly completePlanOnGet?: boolean;
    readonly completeApplyOnGet?: boolean;
  };
  #seq = 0;
  #failApplyPutOnce = false;

  constructor(
    options: {
      readonly completePlanOnGet?: boolean;
      readonly completeApplyOnGet?: boolean;
    } = {},
  ) {
    this.#options = options;
  }

  createPlanRun(
    request: CreatePlanRunRequest,
    _context?: DeployControlActorContext,
    internal?: PlanRunInternalContext,
  ): Promise<PlanRunResponse> {
    this.planCalls.push({ request, ...(internal ? { internal } : {}) });
    const id = `plan_${++this.#seq}`;
    const planRun = {
      id,
      workspaceId: request.workspaceId ?? "",
      capsuleId: request.capsuleId,
      capsuleCurrentStateVersionId: null,
      source: request.source,
      sourceDigest: "sha256:src",
      operation: request.operation ?? "create",
      runnerProfileId: request.runnerProfileId ?? "opentofu-default",
      variablesDigest: "sha256:vars",
      requiredProviders: request.requiredProviders ?? [],
      ...(internal?.resourceContext
        ? { resourceContext: internal.resourceContext }
        : {}),
      ...(internal?.resourceImport ? { resourceImport: true } : {}),
      status: "queued",
      policy: { status: "passed", reasons: [], checkedAt: 0 },
      policyDecisionDigest: "sha256:policy",
      auditEvents: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as PublicPlanRun;
    this.#plans.set(id, planRun);
    return Promise.resolve({ planRun });
  }

  runQueuedPlan(runId: string): Promise<unknown> {
    this.runQueuedPlanCalls.push(runId);
    const planRun = this.#plans.get(runId)!;
    const completed = this.#completedPlan(planRun);
    this.#plans.set(runId, completed);
    return Promise.resolve(completed);
  }

  getPlanRun(id: string): Promise<PlanRunResponse> {
    let planRun = this.#plans.get(id)!;
    if (
      this.#options.completePlanOnGet &&
      (planRun.status === "queued" || planRun.status === "running")
    ) {
      planRun = this.#completedPlan(planRun);
      this.#plans.set(id, planRun);
    }
    return Promise.resolve({ planRun });
  }

  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<unknown> {
    this.approveCalls.push({ id, ...(input ? { input } : {}) });
    const planRun = this.#plans.get(id)!;
    this.#plans.set(id, {
      ...planRun,
      status: "succeeded",
      approval: {
        ...(input?.approvedBy ? { approvedBy: input.approvedBy } : {}),
        ...(input?.reason ? { reason: input.reason } : {}),
        approvedAt: 1,
      },
    } as unknown as PublicPlanRun);
    return Promise.resolve({});
  }

  async createApplyRun(
    request: CreateApplyRunRequest,
    _context?: DeployControlActorContext,
    internal?: ApplyRunInternalContext,
  ): Promise<ApplyRunResponse> {
    this.applyCalls.push(request);
    const planRun = this.#plans.get(request.planRunId)!;
    const applyRun = {
      id: internal?.applyRunId ?? `apply_${++this.#seq}`,
      planRunId: request.planRunId,
      workspaceId: planRun.workspaceId,
      operation: planRun.operation,
      runnerProfileId: "opentofu-default",
      status: "queued",
      expected: request.expected,
      stateBackend: { kind: "operator-managed" },
      stateLock: { status: "not_required", backendRef: "" },
      auditEvents: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ApplyRunResponse["applyRun"];
    if (internal?.onPrepared) {
      await internal.onPrepared(applyRun);
      this.checkpointedApplyRuns.push(applyRun.id);
    }
    if (this.#failApplyPutOnce) {
      this.#failApplyPutOnce = false;
      throw new Error("simulated ApplyRun durable put failure");
    }
    this.#applies.set(applyRun.id, applyRun);
    return { applyRun };
  }

  runQueuedApply(runId: string): Promise<ApplyRunResponse> {
    this.runQueuedApplyCalls.push(runId);
    const applyRun = this.#completedApply(this.#applies.get(runId)!);
    this.#applies.set(runId, applyRun);
    return Promise.resolve({ applyRun });
  }

  getApplyRun(id: string): Promise<ApplyRunResponse> {
    let applyRun = this.#applies.get(id);
    if (!applyRun) {
      throw new OpenTofuControllerError("not_found", `ApplyRun ${id} not found`);
    }
    if (
      this.#options.completeApplyOnGet &&
      (applyRun.status === "queued" || applyRun.status === "running")
    ) {
      applyRun = this.#completedApply(applyRun);
      this.#applies.set(id, applyRun);
    }
    return Promise.resolve({ applyRun });
  }

  failNextApplyPut(): void {
    this.#failApplyPutOnce = true;
  }

  #completedPlan(planRun: PublicPlanRun): PublicPlanRun {
    const completedStatus =
      planRun.operation === "destroy" ? "waiting_approval" : "succeeded";
    return {
      ...planRun,
      status: completedStatus,
      planDigest: "sha256:plan",
      planArtifact: {
        kind: "object-storage",
        ref: "r2://plan",
        digest: "sha256:art",
      },
      planResourceChanges: [
        planRun.resourceImport
          ? {
              address: "module.child.cloudflare_workers_script.this",
              type: "cloudflare_workers_script",
              actions: ["no-op"],
              importing: true,
            }
          : {
              address: "module.child.cloudflare_workers_script.this",
              type: "cloudflare_workers_script",
              actions: ["create"],
            },
        {
          address: "module.child.data.cloudflare_account.acc",
          type: "cloudflare_account",
          actions: ["no-op"],
        },
      ],
    } as unknown as PublicPlanRun;
  }

  #completedApply(
    applyRun: ApplyRunResponse["applyRun"],
  ): ApplyRunResponse["applyRun"] {
    return {
      ...applyRun,
      status: "succeeded",
      stateLock: { status: "recorded", backendRef: "ref" },
      resourceResult: {
        resourceId: "tkrn:demo:EdgeWorker:api",
        stateGeneration: 4,
        stateRef:
          "workspaces/demo/resources/tkrn_demo_EdgeWorker_api/environments/production/state-versions/00000004.tfstate.enc",
        stateDigest: "sha256:state",
        rawOutputRef: "outputs/encrypted.json",
        outputs: {
          worker_name: "api",
          url: "https://api.example.test",
        },
      },
      finishedAt: 1,
    } as unknown as ApplyRunResponse["applyRun"];
  }
}

test("ControllerOpentofuRunPort.plan builds a real generated-root dispatch and maps plan changes", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const preview = await adapter.preview(applyInput(plan, cloudflareTarget));

  expect(driver.planCalls.length).toBe(1);
  const { request, internal } = driver.planCalls[0]!;
  expect(request.workspaceId).toBe("demo");
  expect(request.capsuleId).toBeUndefined();
  expect(request.source.kind).toBe("operator_module");
  expect(request.operation).toBe("update");
  expect(internal?.resourceContext).toEqual({
    workspaceId: "demo",
    resourceId: "tkrn:demo:EdgeWorker:api",
    environment: "production",
    providerBinding: {
      provider: "cloudflare",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare",
      connectionId: "conn_cf_1",
    },
  });
  expect(internal?.baseStateGeneration).toBe(3);
  expect(internal?.genericRootDispatch?.priorState).toEqual(
    resourcePriorState(3),
  );
  expect(request.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);
  expect(request.variables?.accountId).toBe("cf-account-123");
  expect(request.variables?.appName).toBe("api");

  const dispatch = internal?.genericRootDispatch?.generatedRoot;
  expect(dispatch).toBeDefined();
  expect(
    internal?.genericRootDispatch?.operatorModule?.files.map((f) => f.path),
  ).toEqual(plan.operatorModule?.files.map((f) => f.path));
  expect(dispatch!.files["main.tf"]).toContain('module "child"');
  expect(dispatch!.files["main.tf"]).toContain('appName = "api"');
  expect(dispatch!.files["main.tf"]).toContain('accountId = "cf-account-123"');
  expect(dispatch!.files["outputs.tf"]).toContain('output "worker_name"');
  expect(dispatch!.files["outputs.tf"]).toContain('output "url"');
  expect(internal?.genericRootDispatch?.outputAllowlist.connections).toEqual({
    from: "connections",
    type: "json",
  });

  expect(preview.nativeResources).toEqual([
    {
      type: "cloudflare_workers_script",
      id: "module.child.cloudflare_workers_script.this",
    },
  ]);
  expect(preview.runId).toBe("plan_1");
});

test("ControllerOpentofuRunPort carries an explicit exact-ref transition for a legacy Resource digest", async () => {
  const driver = new FakeDeployControlDriver();
  const adapter = new OpentofuResourceShapeAdapter(
    new ControllerOpentofuRunPort({ driver }),
  );
  const plan = edgeWorkerPlan();
  const input = applyInput(plan, cloudflareTarget);
  const prior = resourcePriorState(3);
  const { digest: _omittedDigest, ...exactLegacyPrior } = prior;
  const legacyPrior = {
    ...exactLegacyPrior,
    legacyDigestMissing: true as const,
  };

  await adapter.preview({ ...input, priorState: legacyPrior });
  expect(
    driver.planCalls[0]?.internal?.genericRootDispatch?.priorState,
  ).toEqual(legacyPrior);

  const { priorState: _omitted, ...malformed } = input;
  await expect(adapter.preview(malformed)).rejects.toThrow(
    "has no exact canonical prior state descriptor",
  );
  expect(driver.planCalls).toHaveLength(1);
  expect(driver.applyCalls).toHaveLength(0);
});

test("ControllerOpentofuRunPort translates rootgen validation at its runtime boundary", async () => {
  const capture = new FakeOpentofuRunPort();
  await new OpentofuResourceShapeAdapter(capture).preview(
    applyInput(edgeWorkerPlan(), cloudflareTarget),
  );
  const validRequest = capture.planRequests[0]!;
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({ driver });

  let thrown: unknown;
  try {
    await port.plan({
      ...validRequest,
      inputs: { "invalid-name": true },
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(OpenTofuControllerError);
  expect(thrown).toMatchObject({
    code: "invalid_argument",
    details: { reason: "rootgen_invalid_identifier" },
  });
  expect(driver.planCalls).toHaveLength(0);
});

test("ControllerOpentofuRunPort.observe creates a non-applyable Resource drift_check", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({ driver });
  const adapter = new OpentofuResourceShapeAdapter(port);

  const observed = await adapter.observe(
    applyInput(edgeWorkerPlan(), cloudflareTarget),
  );

  expect(observed).toEqual({
    runId: "plan_1",
    status: "drifted",
    summary: "drift detected: 1 add, 0 change, 0 destroy",
  });
  expect(driver.planCalls[0]?.request.operation).toBe("update");
  expect(driver.planCalls[0]?.internal?.driftCheck).toBe(true);
  expect(driver.planCalls[0]?.internal?.resourceContext?.resourceId).toBe(
    "tkrn:demo:EdgeWorker:api",
  );
  expect(driver.applyCalls).toHaveLength(0);
});

test("ControllerOpentofuRunPort.refresh applies a refresh-only saved plan and publishes Resource state", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({ driver });
  const adapter = new OpentofuResourceShapeAdapter(port);

  const refreshed = await adapter.refresh(
    applyInput(edgeWorkerPlan(), cloudflareTarget, {
      nativeResources: [{ type: "cloudflare_workers_script", id: "api" }],
    }),
  );

  expect(driver.planCalls).toHaveLength(1);
  expect(driver.planCalls[0]?.request.operation).toBe("update");
  expect(driver.planCalls[0]?.internal?.refreshOnly).toBe(true);
  expect(driver.planCalls[0]?.internal?.driftCheck).toBeUndefined();
  expect(driver.applyCalls).toHaveLength(1);
  expect(refreshed).toMatchObject({
    runId: "apply_2",
    summary: "refreshed 1 native resource(s) for tkrn:demo:EdgeWorker:api",
    outputs: {
      worker_name: "api",
      url: "https://api.example.test",
    },
    execution: {
      stateGeneration: 4,
      stateRef: expect.any(String),
    },
  });
});

test("ControllerOpentofuRunPort imports exactly one configured child resource through a saved plan", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({ driver });
  const adapter = new OpentofuResourceShapeAdapter(port);

  const imported = await adapter.importResource({
    ...applyInput(edgeWorkerPlan(), cloudflareTarget, { stateGeneration: 0 }),
    nativeId: "existing-worker-id",
  });

  expect(driver.planCalls).toHaveLength(1);
  expect(driver.planCalls[0]?.request.operation).toBe("create");
  expect(driver.planCalls[0]?.internal?.resourceImport).toBe(true);
  expect(
    driver.planCalls[0]?.internal?.genericRootDispatch?.generatedRoot.files[
      "imports.tf"
    ],
  ).toBe(
    'import {\n  to = module.child.cloudflare_workers_script.this\n  id = "existing-worker-id"\n}\n',
  );
  expect(driver.applyCalls).toHaveLength(1);
  expect(imported).toMatchObject({
    runId: "apply_2",
    summary: "imported 1 native resource(s) for tkrn:demo:EdgeWorker:api",
    nativeResources: [
      { type: "cloudflare_workers_script", id: "existing-worker-id" },
    ],
    outputs: { worker_name: "api" },
    execution: { stateGeneration: 4 },
  });
});

test("real OpenTofuController applies a Resource without creating Capsule ledger rows", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace({
    id: "demo",
    handle: "demo",
    displayName: "Demo",
    type: "personal",
    ownerUserId: actor.actorAccountId,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  });
  const captured: {
    plan?: OpenTofuPlanJob;
    apply?: OpenTofuApplyJob;
    destroy?: OpenTofuDestroyJob;
  } = {};
  let ratedPlanCalls = 0;
  const runner: OpenTofuRunner = {
    plan: (job) => {
      captured.plan = job;
      return Promise.resolve({
        planDigest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://resource/tfplan",
          digest:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        providerLockDigest:
          "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        providerInstallation: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            mirrored: false,
            installationMethod: "direct",
          },
        ],
        planResourceChanges: [
          job.planRun.resourceImport
            ? {
                address: "module.child.cloudflare_workers_script.this",
                type: "cloudflare_workers_script",
                actions: ["no-op"],
                importing: true,
              }
            : {
                address: "module.child.cloudflare_workers_script.this",
                type: "cloudflare_workers_script",
                actions: ["create"],
              },
        ],
      });
    },
    apply: (job) => {
      captured.apply = job;
      return Promise.resolve({
        outputs: {
          worker_name: { sensitive: false, value: "api" },
          url: { sensitive: false, value: "https://api.example.test" },
          ignored: { sensitive: false, value: "not-projected" },
        },
        stateDigest:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        rawOutputRef: job.rawOutputRef,
        providerInstallation: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            mirrored: false,
            installationMethod: "direct",
          },
        ],
      });
    },
    destroy: (job) => {
      captured.destroy = job;
      return Promise.resolve({
        stateDigest:
          "sha256:destroyed0123456789abcdef0123456789abcdef0123456789abcdef01234567",
        providerInstallation: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            mirrored: false,
            installationMethod: "direct",
          },
        ],
      });
    },
  };
  const controller = new OpenTofuController({
    store,
    runner,
    defaultBillingSettings: { mode: "showback" },
    showbackRater: {
      ratePlan() {
        ratedPlanCalls += 1;
        return Promise.resolve({ ratingStatus: "rated", usdMicros: 125_000 });
      },
      rateUsage() {
        return Promise.resolve({ ratingStatus: "rated", usdMicros: 1_000 });
      },
    },
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: (() => {
      let value = 1_000;
      return () => value++;
    })(),
    newId: (() => {
      let value = 0;
      return (prefix) => `${prefix}_resource_${++value}`;
    })(),
  });
  const adapter = new OpentofuResourceShapeAdapter(
    new ControllerOpentofuRunPort({ driver: controller }),
  );

  const result = await adapter.apply(
    applyInput(edgeWorkerPlan(), cloudflareTarget, {
      stateGeneration: 0,
      credentialRef: undefined,
    }),
  );

  expect(result.outputs).toEqual({
    worker_name: "api",
    url: "https://api.example.test",
  });
  expect(result.execution?.stateGeneration).toBe(1);
  expect(result.execution?.stateRef).toBe(
    "workspaces/demo/resources/tkrn_demo_EdgeWorker_api/environments/production/state-versions/00000001.tfstate.enc",
  );
  expect(captured.plan?.planRun.resourceContext?.resourceId).toBe(
    "tkrn:demo:EdgeWorker:api",
  );
  expect(captured.plan?.planRun.capsuleId).toBeUndefined();
  expect(captured.plan?.stateScope?.subject).toEqual({
    kind: "resource",
    id: "tkrn:demo:EdgeWorker:api",
  });
  expect(captured.plan?.sourceArchive).toBeUndefined();
  expect(captured.apply?.stateScope?.subject).toEqual({
    kind: "resource",
    id: "tkrn:demo:EdgeWorker:api",
  });
  expect(await store.listCapsules("demo")).toEqual([]);
  expect(
    await store.listStateVersions("tkrn:demo:EdgeWorker:api", "production"),
  ).toEqual([]);
  expect(await store.listOutputs("tkrn:demo:EdgeWorker:api")).toEqual([]);

  const persistedPlan = await store.getPlanRun(captured.plan!.planRun.id);
  expect(persistedPlan?.source.kind).toBe("operator_module");
  expect(persistedPlan?.sourceSnapshotId).toBeUndefined();
  expect(persistedPlan?.installationContext).toBeUndefined();
  const persistedApply = await store.getApplyRun(result.runId!);
  expect(persistedApply?.resourceResult?.resourceId).toBe(
    "tkrn:demo:EdgeWorker:api",
  );
  expect(persistedApply?.stateVersionId).toBeUndefined();
  expect(persistedApply?.outputId).toBeUndefined();
  expect(ratedPlanCalls).toBe(1);

  const refreshed = await adapter.refresh(
    applyInput(edgeWorkerPlan(), cloudflareTarget, {
      stateGeneration: 1,
      credentialRef: undefined,
      nativeResources: result.nativeResources,
    }),
  );
  expect(refreshed.execution?.stateGeneration).toBe(2);
  expect(captured.plan?.planRun.refreshOnly).toBe(true);
  expect(captured.plan?.planRun.operation).toBe("update");
  expect(captured.apply?.planRun.refreshOnly).toBe(true);
  expect((await store.getPlanRun(captured.plan!.planRun.id))?.refreshOnly).toBe(
    true,
  );
  expect(
    (await store.getApplyRun(refreshed.runId!))?.auditEvents.some(
      (event) => event.type === "resource.refresh.completed",
    ),
  ).toBe(true);
  expect(ratedPlanCalls).toBe(1);

  const imported = await adapter.importResource({
    ...applyInput(edgeWorkerPlan(), cloudflareTarget, {
      resourceId: "tkrn:demo:EdgeWorker:imported-api",
      stateGeneration: 0,
      credentialRef: undefined,
    }),
    nativeId: "existing-worker-id",
  });
  expect(imported.execution?.stateGeneration).toBe(1);
  expect(imported.nativeResources).toEqual([
    { type: "cloudflare_workers_script", id: "existing-worker-id" },
  ]);
  expect(captured.plan?.planRun.resourceImport).toBe(true);
  expect(captured.plan?.planRun.operation).toBe("create");
  expect(captured.plan?.generatedRoot?.files["imports.tf"]).toContain(
    "to = module.child.cloudflare_workers_script.this",
  );
  expect(captured.apply?.planRun.resourceImport).toBe(true);
  expect(
    (await store.getApplyRun(imported.runId!))?.auditEvents.some(
      (event) => event.type === "resource.import.completed",
    ),
  ).toBe(true);
  expect(ratedPlanCalls).toBe(1);

  await adapter.delete(
    deleteInput({
      plan: edgeWorkerPlan(),
      stateGeneration: 2,
      credentialRef: undefined,
    }),
  );
  expect(captured.destroy?.stateScope?.subject).toEqual({
    kind: "resource",
    id: "tkrn:demo:EdgeWorker:api",
  });
  expect(captured.destroy?.installation).toBeUndefined();
  expect(await store.listCapsules("demo")).toEqual([]);
  expect(
    await store.listStateVersions("tkrn:demo:EdgeWorker:api", "production"),
  ).toEqual([]);
  expect(await store.listOutputs("tkrn:demo:EdgeWorker:api")).toEqual([]);
});

test("Resource apply and destroy requeue the same ApplyRun after a D1 ledger-tail failure", async () => {
  const inner = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());
  await inner.putWorkspace({
    id: "demo",
    handle: "demo",
    displayName: "Demo",
    type: "personal",
    ownerUserId: actor.actorAccountId,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  });
  let failNextLedgerTail = true;
  let injectedFailures = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "commitResourceRun") {
        return (
          input: Parameters<OpenTofuControlStore["commitResourceRun"]>[0],
        ) => {
          if (failNextLedgerTail) {
            failNextLedgerTail = false;
            injectedFailures += 1;
            return Promise.reject(
              new Error("injected: Resource ledger commit response was lost"),
            );
          }
          return target.commitResourceRun(input);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as OpenTofuControlStore;
  const applyRunIds: string[] = [];
  const destroyRunIds: string[] = [];
  const runner: OpenTofuRunner = {
    plan: (job) => {
      return Promise.resolve({
        planDigest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        planArtifact: {
          kind: "runner-local",
          ref: `runner-local://${job.planRun.id}/tfplan`,
          digest:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        providerLockDigest:
          "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        providerInstallation: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            mirrored: false,
            installationMethod: "direct",
          },
        ],
        planResourceChanges: [
          {
            address: "module.child.cloudflare_workers_script.this",
            type: "cloudflare_workers_script",
            actions:
              job.planRun.operation === "destroy" ? ["delete"] : ["create"],
          },
        ],
      });
    },
    apply: (job) => {
      applyRunIds.push(job.applyRun.id);
      return Promise.resolve({
        outputs: {
          worker_name: { sensitive: false, value: "api" },
          url: { sensitive: false, value: "https://api.example.test" },
        },
        stateDigest:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        rawOutputRef: job.rawOutputRef,
        providerInstallation: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            mirrored: false,
            installationMethod: "direct",
          },
        ],
      });
    },
    destroy: (job) => {
      destroyRunIds.push(job.applyRun.id);
      return Promise.resolve({
        stateDigest:
          "sha256:destroyed0123456789abcdef0123456789abcdef0123456789abcdef01234567",
        providerInstallation: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            mirrored: false,
            installationMethod: "direct",
          },
        ],
      });
    },
  };
  const controller = new OpenTofuController({
    store,
    runner,
    defaultBillingSettings: { mode: "showback" },
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: (() => {
      let value = 1_000;
      return () => value++;
    })(),
    newId: (() => {
      let value = 0;
      return (prefix) => `${prefix}_resource_retry_${++value}`;
    })(),
  });
  const adapter = new OpentofuResourceShapeAdapter(
    new ControllerOpentofuRunPort({
      driver: controller,
      pollIntervalMs: 1,
      waitTimeoutMs: 200,
    }),
  );

  const applied = await adapter.apply(
    applyInput(edgeWorkerPlan(), cloudflareTarget, {
      stateGeneration: 0,
      credentialRef: undefined,
    }),
  );

  expect(applyRunIds).toHaveLength(2);
  expect(new Set(applyRunIds)).toEqual(new Set([applied.runId!]));
  expect((await inner.getApplyRun(applied.runId!))?.status).toBe("succeeded");

  failNextLedgerTail = true;
  await adapter.delete(
    deleteInput({
      plan: edgeWorkerPlan(),
      stateGeneration: applied.execution!.stateGeneration,
      priorState: {
        generation: applied.execution!.stateGeneration,
        stateRef: applied.execution!.stateRef,
        digest: applied.execution!.stateDigest!,
        createdByRunId: applied.runId!,
      },
      nativeResources: applied.nativeResources,
      credentialRef: undefined,
    }),
  );

  expect(destroyRunIds).toHaveLength(2);
  expect(new Set(destroyRunIds).size).toBe(1);
  expect(injectedFailures).toBe(2);
  expect((await inner.getApplyRun(destroyRunIds[0]!))?.status).toBe(
    "succeeded",
  );
});

test("ControllerOpentofuRunPort renders base_url for operator-configured provider endpoints", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.preview(
    applyInput(plan, cloudflareTarget, {
      implementation: {
        ...edgeDescriptor,
        providerConfig: { base_url: customProviderBaseUrl },
      },
    }),
  );

  const mainTf =
    driver.planCalls[0]?.internal?.genericRootDispatch?.generatedRoot.files[
      "main.tf"
    ];
  expect(mainTf).toBeDefined();
  if (!mainTf) return;
  expect(mainTf).toContain('provider "cloudflare"');
  expect(mainTf).toContain(`base_url = "${customProviderBaseUrl}"`);
  expect(mainTf).not.toContain("api_token = var.");
  expect(mainTf).not.toContain('variable "cloudflare_api_token"');
});

test("ControllerOpentofuRunPort.apply drives plan->apply and maps outputs+nativeResources", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const result = await adapter.apply(applyInput(plan, cloudflareTarget));

  expect(driver.applyCalls.length).toBe(1);
  const guard = driver.applyCalls[0]!.expected;
  expect(guard.planRunId).toBe("plan_1");
  expect(guard.planDigest).toBe("sha256:plan");
  expect(guard.planArtifactDigest).toBe("sha256:art");
  expect(guard.capsuleId).toBeUndefined();

  expect(result.outputs).toEqual({
    worker_name: "api",
    url: "https://api.example.test",
  });
  expect(result.nativeResources).toEqual([
    {
      type: "cloudflare_workers_script",
      id: "module.child.cloudflare_workers_script.this",
    },
  ]);
  expect(result.runId).toBeDefined();
  expect(result.execution).toEqual({
    runId: result.runId,
    stateGeneration: 4,
    stateRef:
      "workspaces/demo/resources/tkrn_demo_EdgeWorker_api/environments/production/state-versions/00000004.tfstate.enc",
    stateDigest: "sha256:state",
    rawOutputRef: "outputs/encrypted.json",
    updatedAt: "1970-01-01T00:00:00.001Z",
  });
});

test("ControllerOpentofuRunPort resumes the checkpointed apply without creating plan or ApplyRun B", async () => {
  const driver = new FakeDeployControlDriver();
  const adapter = new OpentofuResourceShapeAdapter(
    new ControllerOpentofuRunPort({ driver }),
  );
  let checkpointedApplyRunId: string | undefined;
  let checkpointedPlanRunId: string | undefined;
  const input = applyInput(edgeWorkerPlan(), cloudflareTarget);

  const first = await adapter.apply({
    ...input,
    opentofuApplyRun: {
      checkpointApplyRun: (applyRunId, planRunId) => {
        checkpointedApplyRunId = applyRunId;
        checkpointedPlanRunId = planRunId;
        return Promise.resolve();
      },
    },
  });
  expect(checkpointedApplyRunId).toBe(first.runId);
  expect(driver.checkpointedApplyRuns).toEqual([first.runId]);

  const recovered = await adapter.apply({
    ...input,
    opentofuApplyRun: {
      applyRunId: checkpointedApplyRunId,
      applyPlanRunId: checkpointedPlanRunId,
    },
  });
  expect(recovered).toEqual(first);
  expect(driver.planCalls).toHaveLength(1);
  expect(driver.applyCalls).toHaveLength(1);
  expect(driver.runQueuedApplyCalls).toEqual([first.runId]);
});

test("ControllerOpentofuRunPort recreates a missing checkpointed ApplyRun with the exact id and PlanRun", async () => {
  const driver = new FakeDeployControlDriver();
  const adapter = new OpentofuResourceShapeAdapter(
    new ControllerOpentofuRunPort({ driver }),
  );
  const input = applyInput(edgeWorkerPlan(), cloudflareTarget);
  let checkpoint:
    | { readonly applyRunId: string; readonly planRunId: string }
    | undefined;
  driver.failNextApplyPut();
  await expect(
    adapter.apply({
      ...input,
      opentofuApplyRun: {
        checkpointApplyRun: (applyRunId, planRunId) => {
          checkpoint = { applyRunId, planRunId };
          return Promise.resolve();
        },
      },
    }),
  ).rejects.toThrow("simulated ApplyRun durable put failure");
  expect(checkpoint).toBeDefined();

  const recovered = await adapter.apply({
    ...input,
    opentofuApplyRun: {
      applyRunId: checkpoint!.applyRunId,
      applyPlanRunId: checkpoint!.planRunId,
      checkpointApplyRun: (applyRunId, planRunId) => {
        expect({ applyRunId, planRunId }).toEqual(checkpoint!);
        return Promise.resolve();
      },
    },
  });

  expect(recovered.runId).toBe(checkpoint!.applyRunId);
  expect(driver.planCalls).toHaveLength(1);
  expect(driver.applyCalls).toHaveLength(2);
  expect(driver.runQueuedApplyCalls).toEqual([checkpoint!.applyRunId]);
});

test("ControllerOpentofuRunPort rejects a checkpoint that belongs to another Resource authority", async () => {
  const driver = new FakeDeployControlDriver();
  const adapter = new OpentofuResourceShapeAdapter(
    new ControllerOpentofuRunPort({ driver }),
  );
  const input = applyInput(edgeWorkerPlan(), cloudflareTarget);
  const first = await adapter.apply(input);

  await expect(
    adapter.apply({
      ...input,
      resourceId: "tkrn:other:EdgeWorker:api",
      opentofuApplyRun: { applyRunId: first.runId },
    }),
  ).rejects.toThrow("is not the canonical update plan");
  expect(driver.planCalls).toHaveLength(1);
  expect(driver.applyCalls).toHaveLength(1);
});

test("ControllerOpentofuRunPort rejects a checkpoint with the wrong operation or state generation", async () => {
  const driver = new FakeDeployControlDriver();
  const adapter = new OpentofuResourceShapeAdapter(
    new ControllerOpentofuRunPort({ driver }),
  );
  const plan = edgeWorkerPlan();
  let destroyApplyRunId: string | undefined;
  await adapter.delete({
    ...deleteInput({ plan }),
    opentofuApplyRun: {
      checkpointApplyRun: (applyRunId) => {
        destroyApplyRunId = applyRunId;
        return Promise.resolve();
      },
    },
  });

  await expect(
    adapter.apply({
      ...applyInput(plan, cloudflareTarget),
      opentofuApplyRun: { applyRunId: destroyApplyRunId },
    }),
  ).rejects.toThrow("is not the canonical update plan");

  const applyResult = await adapter.apply(applyInput(plan, cloudflareTarget));
  await expect(
    adapter.apply({
      ...applyInput(plan, cloudflareTarget, { stateGeneration: 4 }),
      opentofuApplyRun: { applyRunId: applyResult.runId },
    }),
  ).rejects.toThrow("has no exact durable result");
  expect(driver.planCalls).toHaveLength(2);
  expect(driver.applyCalls).toHaveLength(2);
});

test("ControllerOpentofuRunPort apply guard does not encode credential delivery", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.apply(
    applyInput(plan, cloudflareTarget, {
      implementation: {
        ...edgeDescriptor,
        providerConfig: { base_url: customProviderBaseUrl },
      },
    }),
  );

  expect(driver.applyCalls[0]?.expected).not.toHaveProperty(
    "providerCredentialDelivery",
  );
});

test("ControllerOpentofuRunPort can wait for an external queue owner instead of inline-driving runs", async () => {
  const driver = new FakeDeployControlDriver({
    completePlanOnGet: true,
    completeApplyOnGet: true,
  });
  const port = new ControllerOpentofuRunPort({
    driver,
    driveRunsSynchronously: false,
    pollIntervalMs: 1,
    waitTimeoutMs: 1_000,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const result = await adapter.apply(applyInput(plan, cloudflareTarget));

  expect(driver.runQueuedPlanCalls).toEqual([]);
  expect(driver.runQueuedApplyCalls).toEqual([]);
  expect(driver.planCalls.length).toBe(1);
  expect(driver.applyCalls.length).toBe(1);
  expect(result.outputs).toEqual({
    worker_name: "api",
    url: "https://api.example.test",
  });
  expect(result.nativeResources).toEqual([
    {
      type: "cloudflare_workers_script",
      id: "module.child.cloudflare_workers_script.this",
    },
  ]);
});

test("ControllerOpentofuRunPort.destroy replays generated root before apply", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.delete(deleteInput({ plan }));

  expect(driver.planCalls.length).toBe(1);
  const { request, internal } = driver.planCalls[0]!;
  expect(request.operation).toBe("destroy");
  expect(request.variables?.accountId).toBe("cf-account-123");
  expect(request.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);
  expect(
    internal?.genericRootDispatch?.generatedRoot.files["main.tf"],
  ).toContain('module "child"');
  expect(
    internal?.genericRootDispatch?.operatorModule?.files.map(
      (file) => file.path,
    ),
  ).toEqual(plan.operatorModule?.files.map((file) => file.path));
  expect(internal?.genericRootDispatch?.priorState).toEqual(
    resourcePriorState(3),
  );
  expect(driver.applyCalls.length).toBe(1);
  expect(driver.applyCalls[0]?.expected.planRunId).toBe("plan_1");
  expect(driver.approveCalls).toEqual([
    {
      id: "plan_1",
      input: {
        approvedBy: actor.actorAccountId,
        reason: "resource-shape-delete",
      },
    },
  ]);
});

test("ControllerOpentofuRunPort resumes the checkpointed destroy without creating plan or ApplyRun B", async () => {
  const driver = new FakeDeployControlDriver();
  const adapter = new OpentofuResourceShapeAdapter(
    new ControllerOpentofuRunPort({ driver }),
  );
  let checkpointedApplyRunId: string | undefined;
  let checkpointedPlanRunId: string | undefined;
  const input = deleteInput({ plan: edgeWorkerPlan() });

  await adapter.delete({
    ...input,
    opentofuApplyRun: {
      checkpointApplyRun: (applyRunId, planRunId) => {
        checkpointedApplyRunId = applyRunId;
        checkpointedPlanRunId = planRunId;
        return Promise.resolve();
      },
    },
  });
  expect(checkpointedApplyRunId).toBe("apply_2");

  await adapter.delete({
    ...input,
    opentofuApplyRun: {
      applyRunId: checkpointedApplyRunId,
      applyPlanRunId: checkpointedPlanRunId,
    },
  });
  expect(driver.planCalls).toHaveLength(1);
  expect(driver.applyCalls).toHaveLength(1);
  expect(driver.runQueuedApplyCalls).toEqual(["apply_2"]);
});
