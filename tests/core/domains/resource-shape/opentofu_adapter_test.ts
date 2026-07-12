import { test, expect } from "bun:test";

import type { ActorContext, TargetPoolEntry } from "takosumi-contract";
import type {
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  PlanRunResponse,
  PublicPlanRun,
} from "@takosumi/internal/deploy-control-api";
import type {
  DeployControlActorContext,
  PlanRunInternalContext,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  planEdgeWorker,
  type ResourceShapePlan,
} from "../../../../core/domains/resource-shape/planner.ts";
import {
  type AdapterApplyInput,
  type AdapterDeleteInput,
} from "../../../../core/domains/resource-shape/adapter.ts";
import {
  augmentInputsForTarget,
  ControllerOpentofuRunPort,
  type DeployControlRunDriver,
  FakeOpentofuRunPort,
  OpentofuResourceShapeAdapter,
  providerLocalNameForTargetType,
  providerSourceForLocalName,
} from "../../../../core/domains/resource-shape/opentofu_adapter.ts";

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

const awsTarget: TargetPoolEntry = {
  name: "aws-main",
  type: "aws",
  region: "us-east-1",
  priority: 5,
};

const providerCompatBaseUrl =
  "https://app.takosumi.com/compat/cloudflare/client/v4";

function edgeWorkerPlan(): ResourceShapePlan {
  return planEdgeWorker(
    "cloudflare_workers",
    {
      name: "api",
      source: { artifactPath: "/work/dist/worker.js" },
    },
    cloudflareTarget,
  );
}

function applyInput(
  plan: ResourceShapePlan,
  target: TargetPoolEntry,
  overrides: Partial<AdapterApplyInput> = {},
): AdapterApplyInput {
  return {
    resourceId: "tkrn:demo:EdgeWorker:api",
    plan,
    target,
    credentialRef: "conn_cf_1",
    actor,
    ...overrides,
  };
}

test("provider mapping covers cloudflare/aws/gcp and falls through", () => {
  expect(providerLocalNameForTargetType("cloudflare")).toBe("cloudflare");
  expect(providerLocalNameForTargetType("aws")).toBe("aws");
  expect(providerLocalNameForTargetType("gcp")).toBe("google");
  expect(providerLocalNameForTargetType("kubernetes")).toBe("kubernetes");

  expect(providerSourceForLocalName("cloudflare")).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );
  expect(providerSourceForLocalName("aws")).toBe(
    "registry.opentofu.org/hashicorp/aws",
  );
  expect(providerSourceForLocalName("google")).toBe(
    "registry.opentofu.org/hashicorp/google",
  );
});

test("augmentInputsForTarget fills cloudflare accountId from target.ref when absent", () => {
  const inputs = augmentInputsForTarget({ appName: "api" }, cloudflareTarget);
  expect(inputs).toEqual({ appName: "api", accountId: "cf-account-123" });
});

test("augmentInputsForTarget does not overwrite a present accountId", () => {
  const inputs = augmentInputsForTarget(
    { appName: "api", accountId: "already-set" },
    cloudflareTarget,
  );
  expect(inputs.accountId).toBe("already-set");
});

test("augmentInputsForTarget fills aws region from target.region when absent", () => {
  const inputs = augmentInputsForTarget({ name: "ai" }, awsTarget);
  expect(inputs).toEqual({ name: "ai", region: "us-east-1" });
});

test("apply maps cloudflare target to provider+inputs and threads moduleFiles/templateId", async () => {
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
  expect(req.providerBinding.baseUrl).toBeUndefined();
  expect(req.inputs.appName).toBe("api");
  expect(req.inputs.accountId).toBe("cf-account-123");
  expect(req.inputs.artifactPath).toBe("/work/dist/worker.js");
  expect(req.templateId).toBe("cloudflare-worker-service");
  expect(req.moduleFiles).toBe(plan.moduleFiles);
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

test("apply threads managed provider base_url from implementation options", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.apply(
    applyInput(plan, cloudflareTarget, {
      implementationOptions: { providerBaseUrl: providerCompatBaseUrl },
    }),
  );

  expect(port.applyRequests[0]?.providerBinding.baseUrl).toBe(
    providerCompatBaseUrl,
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

test("built-in opentofu adapter rejects operator plugin implementations instead of ignoring them", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await expect(
    adapter.preview(
      applyInput(plan, cloudflareTarget, {
        implementationPlugin: "takosumi-container-plugin",
      }),
    ),
  ).rejects.toThrow("plugin-aware Resource Shape adapter");
  await expect(
    adapter.apply(
      applyInput(plan, cloudflareTarget, {
        implementationPlugin: "takosumi-container-plugin",
      }),
    ),
  ).rejects.toThrow("plugin-aware Resource Shape adapter");

  expect(port.planRequests.length).toBe(0);
  expect(port.applyRequests.length).toBe(0);
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
  return {
    resourceId: "tkrn:demo:EdgeWorker:api",
    nativeResources: [{ type: "cloudflare_workers_script", id: "api" }],
    target: cloudflareTarget,
    credentialRef: "conn_cf_1",
    deletePolicy: "delete",
    actor,
    ...overrides,
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
  expect(req.templateId).toBe(plan.templateId);
  expect(req.moduleFiles?.map((file) => file.path)).toEqual(
    plan.moduleFiles.map((file) => file.path),
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
      implementationOptions: { providerBaseUrl: providerCompatBaseUrl },
    }),
  );

  expect(port.destroyRequests[0]?.providerBinding.baseUrl).toBe(
    providerCompatBaseUrl,
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
    adapter.delete(
      deleteInput({ implementationPlugin: "takosumi-container-plugin" }),
    ),
  ).rejects.toThrow("plugin-aware Resource Shape adapter");
  await adapter.delete(
    deleteInput({
      implementationPlugin: "takosumi-container-plugin",
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
    const providerCredentialDelivery =
      internal?.providerCredentialDelivery ??
      internal?.genericRootDispatch?.providerCredentialDelivery;
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
      status: "queued",
      policy: { status: "passed", reasons: [], checkedAt: 0 },
      policyDecisionDigest: "sha256:policy",
      ...(providerCredentialDelivery ? { providerCredentialDelivery } : {}),
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

  createApplyRun(
    request: CreateApplyRunRequest,
    _context?: DeployControlActorContext,
  ): Promise<ApplyRunResponse> {
    this.applyCalls.push(request);
    const applyRun = {
      id: `apply_${++this.#seq}`,
      planRunId: request.planRunId,
      workspaceId: "",
      operation: "create",
      runnerProfileId: "opentofu-default",
      status: "queued",
      expected: request.expected,
      stateBackend: { kind: "operator-managed" },
      stateLock: { status: "not_required", backendRef: "" },
      auditEvents: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ApplyRunResponse["applyRun"];
    this.#applies.set(applyRun.id, applyRun);
    return Promise.resolve({ applyRun });
  }

  runQueuedApply(runId: string): Promise<ApplyRunResponse> {
    this.runQueuedApplyCalls.push(runId);
    const applyRun = this.#completedApply(this.#applies.get(runId)!);
    this.#applies.set(runId, applyRun);
    return Promise.resolve({ applyRun });
  }

  getApplyRun(id: string): Promise<ApplyRunResponse> {
    let applyRun = this.#applies.get(id)!;
    if (
      this.#options.completeApplyOnGet &&
      (applyRun.status === "queued" || applyRun.status === "running")
    ) {
      applyRun = this.#completedApply(applyRun);
      this.#applies.set(id, applyRun);
    }
    return Promise.resolve({ applyRun });
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
        {
          address: "module.app.cloudflare_workers_script.this",
          type: "cloudflare_workers_script",
          actions: ["create"],
        },
        {
          address: "module.app.data.cloudflare_account.acc",
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
      outputs: [
        {
          name: "worker_name",
          kind: "service_url",
          value: "api",
          sensitive: false,
        },
        {
          name: "url",
          kind: "service_url",
          value: "https://api.example.test",
          sensitive: false,
        },
      ],
    } as unknown as ApplyRunResponse["applyRun"];
  }
}

const capsuleBinding = {
  workspaceId: "ws_1",
  capsuleId: "cap_1",
  source: { kind: "local", path: "/resource-shape/cloudflare-worker-service" },
} as const;

test("ControllerOpentofuRunPort.plan builds a real generated-root dispatch and maps plan changes", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
    resolveCapsuleBinding: () => capsuleBinding,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const preview = await adapter.preview(applyInput(plan, cloudflareTarget));

  expect(driver.planCalls.length).toBe(1);
  const { request, internal } = driver.planCalls[0]!;
  expect(request.workspaceId).toBe("ws_1");
  expect(request.capsuleId).toBe("cap_1");
  expect(request.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);
  expect(request.variables?.accountId).toBe("cf-account-123");
  expect(request.variables?.appName).toBe("api");

  const dispatch = internal?.genericRootDispatch?.generatedRoot;
  expect(dispatch).toBeDefined();
  expect(internal?.genericRootDispatch?.providerCredentialDelivery).toBe(
    "generated_root_variable",
  );
  expect(dispatch!.moduleFiles?.map((f) => f.path)).toEqual(
    plan.moduleFiles.map((f) => f.path),
  );
  expect(dispatch!.files["main.tf"]).toContain('module "app"');
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
      id: "module.app.cloudflare_workers_script.this",
    },
  ]);
  expect(preview.runId).toBe("plan_1");
});

test("ControllerOpentofuRunPort renders provider base_url for managed compatibility targets", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
    resolveCapsuleBinding: () => capsuleBinding,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.preview(
    applyInput(plan, cloudflareTarget, {
      implementationOptions: { providerBaseUrl: providerCompatBaseUrl },
    }),
  );

  const mainTf =
    driver.planCalls[0]?.internal?.genericRootDispatch?.generatedRoot.files[
      "main.tf"
    ];
  expect(mainTf).toBeDefined();
  if (!mainTf) return;
  expect(
    driver.planCalls[0]?.internal?.genericRootDispatch
      ?.providerCredentialDelivery,
  ).toBe("provider_env");
  expect(mainTf).toContain('provider "cloudflare"');
  expect(mainTf).toContain(`base_url = "${providerCompatBaseUrl}"`);
  expect(mainTf).not.toContain("api_token = var.");
  expect(mainTf).not.toContain('variable "cloudflare_api_token"');
});

test("ControllerOpentofuRunPort.apply drives plan->apply and maps outputs+nativeResources", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
    resolveCapsuleBinding: () => capsuleBinding,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  const result = await adapter.apply(applyInput(plan, cloudflareTarget));

  expect(driver.applyCalls.length).toBe(1);
  const guard = driver.applyCalls[0]!.expected;
  expect(guard.planRunId).toBe("plan_1");
  expect(guard.planDigest).toBe("sha256:plan");
  expect(guard.planArtifactDigest).toBe("sha256:art");
  expect(guard.capsuleId).toBe("cap_1");

  expect(result.outputs).toEqual({
    worker_name: "api",
    url: "https://api.example.test",
  });
  expect(result.nativeResources).toEqual([
    {
      type: "cloudflare_workers_script",
      id: "module.app.cloudflare_workers_script.this",
    },
  ]);
  expect(result.runId).toBeDefined();
});

test("ControllerOpentofuRunPort apply guard preserves managed provider env delivery", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
    resolveCapsuleBinding: () => capsuleBinding,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = edgeWorkerPlan();

  await adapter.apply(
    applyInput(plan, cloudflareTarget, {
      implementationOptions: { providerBaseUrl: providerCompatBaseUrl },
    }),
  );

  expect(driver.applyCalls[0]?.expected.providerCredentialDelivery).toBe(
    "provider_env",
  );
});

test("ControllerOpentofuRunPort can wait for an external queue owner instead of inline-driving runs", async () => {
  const driver = new FakeDeployControlDriver({
    completePlanOnGet: true,
    completeApplyOnGet: true,
  });
  const port = new ControllerOpentofuRunPort({
    driver,
    resolveCapsuleBinding: () => capsuleBinding,
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
      id: "module.app.cloudflare_workers_script.this",
    },
  ]);
});

test("ControllerOpentofuRunPort.destroy replays generated root before apply", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
    resolveCapsuleBinding: () => capsuleBinding,
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
  ).toContain('module "app"');
  expect(
    internal?.genericRootDispatch?.generatedRoot.moduleFiles?.map(
      (file) => file.path,
    ),
  ).toEqual(plan.moduleFiles.map((file) => file.path));
  expect(driver.applyCalls.length).toBe(1);
  expect(driver.applyCalls[0]?.expected.planRunId).toBe("plan_1");
  expect(driver.applyCalls[0]?.confirmDestructive).toBe(true);
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
