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
    "cloudflare/cloudflare",
  );
  expect(providerSourceForLocalName("aws")).toBe("hashicorp/aws");
  expect(providerSourceForLocalName("google")).toBe("hashicorp/google");
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
  expect(req.providerBinding.providerSource).toBe("cloudflare/cloudflare");
  expect(req.providerBinding.connectionId).toBe("conn_cf_1");
  expect(req.inputs.appName).toBe("api");
  expect(req.inputs.accountId).toBe("cf-account-123");
  expect(req.inputs.artifactPath).toBe("/work/dist/worker.js");
  expect(req.templateId).toBe("cloudflare-worker-service");
  expect(req.moduleFiles).toBe(plan.moduleFiles);
  expect(req.publicOutputs).toEqual(["worker_name"]);

  expect(result.nativeResources).toEqual([
    { type: "cloudflare_workers_script", id: "api" },
  ]);
  expect(result.outputs).toEqual({
    worker_name: "fake://tkrn:demo:EdgeWorker:api/worker_name",
  });
  expect(result.runId).toBeDefined();
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

  await adapter.delete(deleteInput());

  expect(port.destroyRequests.length).toBe(1);
  const req = port.destroyRequests[0]!;
  expect(req.providerBinding.provider).toBe("cloudflare");
  expect(req.providerBinding.connectionId).toBe("conn_cf_1");
  expect(req.nativeResources).toEqual([
    { type: "cloudflare_workers_script", id: "api" },
  ]);
  expect(req.deletePolicy).toBe("delete");
});

test("delete with a retain or block policy never destroys", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);

  await adapter.delete(deleteInput({ deletePolicy: "retain" }));
  await adapter.delete(deleteInput({ deletePolicy: "block" }));
  expect(port.destroyRequests.length).toBe(0);
});

interface RecordedPlanCall {
  readonly request: CreatePlanRunRequest;
  readonly internal?: PlanRunInternalContext;
}

class FakeDeployControlDriver implements DeployControlRunDriver {
  readonly planCalls: RecordedPlanCall[] = [];
  readonly applyCalls: CreateApplyRunRequest[] = [];
  readonly #plans = new Map<string, PublicPlanRun>();
  #seq = 0;

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
      runnerProfileId: request.runnerProfileId ?? "cloudflare-default",
      variablesDigest: "sha256:vars",
      requiredProviders: request.requiredProviders ?? [],
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
    const planRun = this.#plans.get(runId)!;
    const completed = {
      ...planRun,
      status: "succeeded",
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
    this.#plans.set(runId, completed);
    return Promise.resolve(completed);
  }

  getPlanRun(id: string): Promise<PlanRunResponse> {
    return Promise.resolve({ planRun: this.#plans.get(id)! });
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
      runnerProfileId: "cloudflare-default",
      status: "queued",
      expected: request.expected,
      stateBackend: { kind: "operator-managed" },
      stateLock: { status: "not_required", backendRef: "" },
      auditEvents: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ApplyRunResponse["applyRun"];
    return Promise.resolve({ applyRun });
  }

  runQueuedApply(runId: string): Promise<ApplyRunResponse> {
    const applyRun = {
      id: runId,
      planRunId: "plan_x",
      workspaceId: "",
      operation: "create",
      runnerProfileId: "cloudflare-default",
      status: "succeeded",
      stateBackend: { kind: "operator-managed" },
      stateLock: { status: "recorded", backendRef: "ref" },
      outputs: [
        {
          name: "worker_name",
          kind: "service_url",
          value: "api",
          sensitive: false,
        },
      ],
      auditEvents: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ApplyRunResponse["applyRun"];
    return Promise.resolve({ applyRun });
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
  expect(request.requiredProviders).toEqual(["cloudflare/cloudflare"]);
  expect(request.variables?.accountId).toBe("cf-account-123");
  expect(request.variables?.appName).toBe("api");

  const dispatch = internal?.genericRootDispatch?.generatedRoot;
  expect(dispatch).toBeDefined();
  expect(dispatch!.moduleFiles?.map((f) => f.path)).toEqual(
    plan.moduleFiles.map((f) => f.path),
  );
  expect(dispatch!.files["main.tf"]).toContain('module "app"');
  expect(dispatch!.files["main.tf"]).toContain('appName = "api"');
  expect(dispatch!.files["main.tf"]).toContain('accountId = "cf-account-123"');
  expect(dispatch!.files["outputs.tf"]).toContain('output "worker_name"');

  expect(preview.nativeResources).toEqual([
    {
      type: "cloudflare_workers_script",
      id: "module.app.cloudflare_workers_script.this",
    },
  ]);
  expect(preview.runId).toBe("plan_1");
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

  expect(result.outputs).toEqual({ worker_name: "api" });
  expect(result.nativeResources).toEqual([
    {
      type: "cloudflare_workers_script",
      id: "module.app.cloudflare_workers_script.this",
    },
  ]);
  expect(result.runId).toBeDefined();
});
