import { test, expect } from "bun:test";

import type {
  ActorContext,
  ObjectStoreSpec,
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
  DeployControlActorContext,
  PlanRunInternalContext,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  planObjectStore,
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

// --- fixtures ----------------------------------------------------------------

const actor: ActorContext = {
  actorAccountId: "acct_1",
  roles: ["owner"],
  requestId: "req_1",
};

const spec: ObjectStoreSpec = {
  name: "assets",
  interfaces: ["s3_api", "signed_url"],
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

function applyInput(
  plan: ResourceShapePlan,
  target: TargetPoolEntry,
  overrides: Partial<AdapterApplyInput> = {},
): AdapterApplyInput {
  return {
    resourceId: "tkrn:demo:ObjectStore:assets",
    plan,
    target,
    credentialRef: "conn_cf_1",
    actor,
    ...overrides,
  };
}

// --- provider mapping --------------------------------------------------------

test("provider mapping covers cloudflare/aws/gcp and falls through", () => {
  expect(providerLocalNameForTargetType("cloudflare")).toBe("cloudflare");
  expect(providerLocalNameForTargetType("aws")).toBe("aws");
  expect(providerLocalNameForTargetType("gcp")).toBe("google");
  expect(providerLocalNameForTargetType("kubernetes")).toBe("kubernetes");

  expect(providerSourceForLocalName("cloudflare")).toBe("cloudflare/cloudflare");
  expect(providerSourceForLocalName("aws")).toBe("hashicorp/aws");
  expect(providerSourceForLocalName("google")).toBe("hashicorp/google");
});

// --- input augmentation ------------------------------------------------------

test("augmentInputsForTarget fills cloudflare accountId from target.ref when absent", () => {
  const inputs = augmentInputsForTarget({ bucketName: "assets" }, cloudflareTarget);
  expect(inputs).toEqual({ bucketName: "assets", accountId: "cf-account-123" });
});

test("augmentInputsForTarget does not overwrite a present accountId", () => {
  const inputs = augmentInputsForTarget(
    { bucketName: "assets", accountId: "already-set" },
    cloudflareTarget,
  );
  expect(inputs.accountId).toBe("already-set");
});

test("augmentInputsForTarget fills aws region from target.region when absent", () => {
  const inputs = augmentInputsForTarget({ bucketName: "assets" }, awsTarget);
  expect(inputs).toEqual({ bucketName: "assets", region: "us-east-1" });
});

test("augmentInputsForTarget does not overwrite a present aws region", () => {
  const inputs = augmentInputsForTarget(
    { bucketName: "assets", region: "eu-west-1" },
    awsTarget,
  );
  expect(inputs.region).toBe("eu-west-1");
});

// --- adapter over FakeOpentofuRunPort ---------------------------------------

test("apply maps cloudflare target to provider+inputs and threads moduleFiles/templateId", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = planObjectStore("cloudflare_r2", spec, cloudflareTarget);

  const result = await adapter.apply(applyInput(plan, cloudflareTarget));

  // One run request reached the port; nothing else.
  expect(port.applyRequests.length).toBe(1);
  expect(port.planRequests.length).toBe(0);
  const req = port.applyRequests[0]!;

  // Target type -> OpenTofu provider + bound ProviderConnection.
  expect(req.providerBinding.provider).toBe("cloudflare");
  expect(req.providerBinding.providerSource).toBe("cloudflare/cloudflare");
  expect(req.providerBinding.connectionId).toBe("conn_cf_1");

  // Inputs carry the planner values + augmented accountId from the Target ref.
  expect(req.inputs.bucketName).toBe("assets");
  expect(req.inputs.accountId).toBe("cf-account-123");
  expect(req.inputs.location).toBe("weur");

  // moduleFiles + templateId are threaded verbatim from the plan.
  expect(req.templateId).toBe("cloudflare-r2-storage");
  expect(req.moduleFiles).toBe(plan.moduleFiles);
  expect(req.publicOutputs).toEqual(["bucket_name", "location"]);

  // Results map back to the adapter contract.
  expect(result.nativeResources).toEqual([
    { type: "cloudflare_r2_bucket", id: "assets" },
  ]);
  expect(result.outputs).toEqual({
    bucket_name: "fake://tkrn:demo:ObjectStore:assets/bucket_name",
    location: "fake://tkrn:demo:ObjectStore:assets/location",
  });
  expect(result.runId).toBeDefined();
});

test("apply augments accountId even when the planner omitted it", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  // Simulate a planner that did NOT emit accountId (final-plan note): the
  // adapter must still inject it from the Target ref before dispatch.
  const plan: ResourceShapePlan = {
    templateId: "cloudflare-r2-storage",
    moduleFiles: [{ path: "main.tf", text: 'resource "cloudflare_r2_bucket" "b" {}' }],
    inputs: { bucketName: "assets" },
    publicOutputs: ["bucket_name", "location"],
  };

  await adapter.apply(applyInput(plan, cloudflareTarget));
  expect(port.applyRequests[0]!.inputs.accountId).toBe("cf-account-123");
});

test("preview returns summary + nativeResources + runId from a simulated plan", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = planObjectStore("cloudflare_r2", spec, cloudflareTarget);

  const preview = await adapter.preview(applyInput(plan, cloudflareTarget));

  expect(port.planRequests.length).toBe(1);
  expect(port.applyRequests.length).toBe(0);
  expect(preview.summary).toContain("cloudflare-r2-storage");
  expect(preview.nativeResources).toEqual([
    { type: "cloudflare_r2_bucket", id: "assets" },
  ]);
  expect(preview.runId).toBeDefined();
});

test("apply maps aws target to provider+region and aws_s3_bucket native resource", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = planObjectStore("aws_s3", spec, awsTarget);

  const result = await adapter.apply(
    applyInput(plan, awsTarget, { credentialRef: "conn_aws_1" }),
  );

  const req = port.applyRequests[0]!;
  expect(req.providerBinding.provider).toBe("aws");
  expect(req.providerBinding.providerSource).toBe("hashicorp/aws");
  expect(req.providerBinding.connectionId).toBe("conn_aws_1");
  expect(req.inputs.bucketName).toBe("assets");
  expect(req.inputs.region).toBe("us-east-1");
  expect(req.templateId).toBe("aws-s3-storage");
  expect(result.nativeResources).toEqual([
    { type: "aws_s3_bucket", id: "assets" },
  ]);
});

test("apply without a credentialRef leaves the ProviderBinding connectionId unset", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = planObjectStore("cloudflare_r2", spec, cloudflareTarget);

  await adapter.apply(applyInput(plan, cloudflareTarget, { credentialRef: undefined }));
  expect(port.applyRequests[0]!.providerBinding.connectionId).toBeUndefined();
});

// --- delete / destroy --------------------------------------------------------

function deleteInput(
  overrides: Partial<AdapterDeleteInput> = {},
): AdapterDeleteInput {
  return {
    resourceId: "tkrn:demo:ObjectStore:assets",
    nativeResources: [{ type: "cloudflare_r2_bucket", id: "assets" }],
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
    { type: "cloudflare_r2_bucket", id: "assets" },
  ]);
  expect(req.deletePolicy).toBe("delete");
});

test("delete with a retain policy never destroys", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);

  await adapter.delete(deleteInput({ deletePolicy: "retain" }));
  expect(port.destroyRequests.length).toBe(0);
});

test("delete with a block policy never destroys", async () => {
  const port = new FakeOpentofuRunPort();
  const adapter = new OpentofuResourceShapeAdapter(port);

  await adapter.delete(deleteInput({ deletePolicy: "block" }));
  expect(port.destroyRequests.length).toBe(0);
});

// --- REAL ControllerOpentofuRunPort against a fake deploy-control driver ------

interface RecordedPlanCall {
  readonly request: CreatePlanRunRequest;
  readonly internal?: PlanRunInternalContext;
}

/**
 * A minimal stand-in for OpenTofuDeploymentController that drives the run
 * lifecycle in memory: createPlanRun -> runQueuedPlan (completes the plan) ->
 * createApplyRun -> runQueuedApply (captures outputs). No runner, no cloud.
 */
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
    // Complete the plan the way a runner would: status + plan JSON projection +
    // immutable plan artifact (required for the apply TOCTOU guard).
    const completed = {
      ...planRun,
      status: "succeeded",
      planDigest: "sha256:plan",
      planArtifact: { kind: "object-storage", ref: "r2://plan", digest: "sha256:art" },
      planResourceChanges: [
        {
          address: "module.app.cloudflare_r2_bucket.this",
          type: "cloudflare_r2_bucket",
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
        { name: "bucket_name", kind: "service_url", value: "assets", sensitive: false },
        {
          name: "location",
          kind: "service_url",
          value: "weur",
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
  source: { kind: "local", path: "/resource-shape/cloudflare-r2-storage" },
} as const;

test("ControllerOpentofuRunPort.plan builds a real generated-root dispatch and maps plan changes", async () => {
  const driver = new FakeDeployControlDriver();
  const port = new ControllerOpentofuRunPort({
    driver,
    resolveCapsuleBinding: () => capsuleBinding,
  });
  const adapter = new OpentofuResourceShapeAdapter(port);
  const plan = planObjectStore("cloudflare_r2", spec, cloudflareTarget);

  const preview = await adapter.preview(applyInput(plan, cloudflareTarget));

  // The plan request targets the backing Capsule + workspace and derives the
  // provider from the Target (no requiredProviders ambiguity).
  expect(driver.planCalls.length).toBe(1);
  const { request, internal } = driver.planCalls[0]!;
  expect(request.workspaceId).toBe("ws_1");
  expect(request.capsuleId).toBe("cap_1");
  expect(request.requiredProviders).toEqual(["cloudflare/cloudflare"]);
  // Augmented inputs flow through as the run variables.
  expect(request.variables?.accountId).toBe("cf-account-123");
  expect(request.variables?.bucketName).toBe("assets");

  // The genericRootDispatch carries the first-party module files verbatim and a
  // real rootgen-generated root (versions/main/outputs).
  const dispatch = internal?.genericRootDispatch?.generatedRoot;
  expect(dispatch).toBeDefined();
  expect(dispatch!.moduleFiles?.map((f) => f.path)).toEqual(
    plan.moduleFiles.map((f) => f.path),
  );
  expect(dispatch!.files["main.tf"]).toContain("module \"app\"");
  expect(dispatch!.files["main.tf"]).toContain('bucketName = "assets"');
  expect(dispatch!.files["main.tf"]).toContain('accountId = "cf-account-123"');
  expect(dispatch!.files["outputs.tf"]).toContain("output \"bucket_name\"");

  // no-op resource changes are dropped; the created bucket is reported.
  expect(preview.nativeResources).toEqual([
    {
      type: "cloudflare_r2_bucket",
      id: "module.app.cloudflare_r2_bucket.this",
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
  const plan = planObjectStore("cloudflare_r2", spec, cloudflareTarget);

  const result = await adapter.apply(applyInput(plan, cloudflareTarget));

  // The apply request carried a TOCTOU guard derived from the completed plan.
  expect(driver.applyCalls.length).toBe(1);
  const guard = driver.applyCalls[0]!.expected;
  expect(guard.planRunId).toBe("plan_1");
  expect(guard.planDigest).toBe("sha256:plan");
  expect(guard.planArtifactDigest).toBe("sha256:art");
  expect(guard.capsuleId).toBe("cap_1");

  // Outputs come from the apply run; native resources from the plan.
  expect(result.outputs).toEqual({ bucket_name: "assets", location: "weur" });
  expect(result.nativeResources).toEqual([
    {
      type: "cloudflare_r2_bucket",
      id: "module.app.cloudflare_r2_bucket.this",
    },
  ]);
  expect(result.runId).toBeDefined();
});
