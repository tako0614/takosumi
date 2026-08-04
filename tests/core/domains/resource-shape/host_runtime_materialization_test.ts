import { expect, test } from "bun:test";

import {
  HOST_RUNTIME_MATERIALIZATION_CONTRACT,
  type Capsule,
  type InstallConfig,
} from "takosumi-contract";
import type { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import type {
  AdapterApplyInput,
  AdapterDeleteInput,
  ResourceAdapter,
} from "../../../../core/domains/resource-shape/adapter.ts";
import {
  createDbOwnedHostRuntimeMaterializationResolver,
  formHostRuntimeMaterializationRequest,
  scheduleHostRuntimeReconcileTarget,
  withDbOwnedHostRuntimeMaterialization,
  type HostRuntimeResourceLifecycle,
} from "../../../../core/domains/resource-shape/host_runtime_materialization.ts";

const capsule: Capsule = {
  id: "capsule_1",
  workspaceId: "workspace_1",
  projectId: "project_1",
  name: "app",
  slug: "app",
  sourceId: "source_1",
  installConfigId: "config_1",
  installingPrincipalId: "principal_1",
  environment: "production",
  currentStateGeneration: 1,
  status: "active",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

const config: InstallConfig = {
  id: "config_1",
  workspaceId: "workspace_1",
  name: "app-config",
  variableMapping: {},
  outputAllowlist: {},
  policy: {},
  hostRuntimeMaterialization: {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    requirements: [
      {
        kind: "generated_secret",
        binding: "APP_SECRET",
        secretRef: "secret:app/main",
        bytes: 32,
        encoding: "base64url",
      },
    ],
    backgroundActivations: [
      {
        id: "retention",
        sourceResourceKind: "Schedule",
        sourceConnectionAlias: "WORKER",
        entrypoint: "yurucommu.retention",
        retry: {
          maxAttempts: 1,
          retryDelaySeconds: 0,
          onExhausted: "fail",
        },
      },
    ],
  },
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

const capsules: Pick<CapsulesService, "getCapsule" | "getInstallConfig"> = {
  getCapsule: () => Promise.resolve(capsule),
  getInstallConfig: () => Promise.resolve(config),
};

function adapterInput(): AdapterApplyInput {
  return {
    resourceId: "tkrn:workspace_1:EdgeWorker:app",
    owner: {
      kind: "Capsule",
      id: "capsule_1",
      workspaceId: "workspace_1",
      installingPrincipalId: "principal_1",
    },
    resourceGeneration: 1,
    resourceRevisionId: "run_1",
    environment: "production",
    stateGeneration: 0,
    plan: {
      shape: "EdgeWorker",
      validatedSpec: {},
      executionId: "plugin:test",
      inputs: {},
      publicOutputs: [],
      requiresAdapterPlugin: true,
    },
    target: {
      name: "managed",
      type: "managed",
      priority: 1,
      implementations: [],
    },
    implementation: {
      shape: "EdgeWorker",
      implementation: "managed-http",
      plugin: "managed-http",
      interfaces: {},
    },
    actor: {
      actorAccountId: "principal_1",
      roles: [],
      requestId: "request_1",
    },
  };
}

function deleteAdapterInput(): AdapterDeleteInput {
  return {
    ...adapterInput(),
    hostRuntimeMaterialization: {
      contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
      installConfigId: "caller-controlled",
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      installingPrincipalId: "principal_1",
      requirements: [],
    },
  };
}

test("DB-owned requirements are attached to the adapter with exact Capsule provenance", async () => {
  const inputs: AdapterApplyInput[] = [];
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    async apply(input) {
      inputs.push(input);
      return { nativeResources: [], outputs: {} };
    },
    importResource: () =>
      Promise.resolve({
        summary: "import",
        nativeResources: [],
        outputs: {},
      }),
    observe: () => Promise.resolve({ status: "current", summary: "current" }),
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    delete: () => Promise.resolve(),
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    createDbOwnedHostRuntimeMaterializationResolver(capsules),
  );

  await decorated.apply(adapterInput());

  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.hostRuntimeMaterialization).toEqual({
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    installConfigId: "config_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    installingPrincipalId: "principal_1",
    requirements: config.hostRuntimeMaterialization?.requirements,
    backgroundActivations:
      config.hostRuntimeMaterialization?.backgroundActivations,
  });
});

test("Capsule-owned EdgeWorker merges exact Form connections into DB-owned runtime requirements", async () => {
  const request = await createDbOwnedHostRuntimeMaterializationResolver(
    capsules,
  )({
    owner: {
      kind: "Capsule",
      id: capsule.id,
      workspaceId: capsule.workspaceId,
      installingPrincipalId: capsule.installingPrincipalId,
    },
    resourceId: "tkrn:workspace_1:EdgeWorker:app",
    validatedSpec: {
      connections: {
        MEDIA: {
          resource: "ObjectBucket/media",
          projection: "object.binding.v1",
          permissions: ["read", "write"],
        },
        DB: {
          resource: "RelationalDatabase/main",
          projection: "sql.binding.v1",
          permissions: ["connect", "read", "write"],
        },
      },
    },
  });

  expect(request).toMatchObject({
    installConfigId: config.id,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    installingPrincipalId: capsule.installingPrincipalId,
    requirements: [
      config.hostRuntimeMaterialization!.requirements[0],
      {
        kind: "resource_binding",
        binding: "DB",
        connectionAlias: "DB",
        requiredPermission: "takosumi.resource.bind",
      },
      {
        kind: "resource_binding",
        binding: "MEDIA",
        connectionAlias: "MEDIA",
        requiredPermission: "takosumi.resource.bind",
      },
    ],
  });
});

test("owner mismatch fails before the selected adapter", async () => {
  let called = false;
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => {
      called = true;
      return Promise.resolve({ nativeResources: [], outputs: {} });
    },
    importResource: () =>
      Promise.resolve({
        summary: "import",
        nativeResources: [],
        outputs: {},
      }),
    observe: () => Promise.resolve({ status: "current", summary: "current" }),
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    delete: () => Promise.resolve(),
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    createDbOwnedHostRuntimeMaterializationResolver(capsules),
  );
  const input = adapterInput();
  await expect(
    decorated.apply({
      ...input,
      owner: {
        kind: "Capsule",
        id: "capsule_1",
        workspaceId: "workspace_1",
        installingPrincipalId: "another_principal",
      },
    }),
  ).rejects.toThrow("does not match");
  expect(called).toBe(false);
});

test("observe, refresh, and delete ignore invalid stored configs and caller runtime envelopes", async () => {
  const invalidConfig = {
    ...config,
    hostRuntimeMaterialization: {
      ...config.hostRuntimeMaterialization!,
      requirements: [
        {
          kind: "managed_connection",
          binding: "LEGACY",
          connectionRef: "connection:legacy",
        },
      ],
    },
  } as unknown as InstallConfig;
  const invalidCapsules: Pick<
    CapsulesService,
    "getCapsule" | "getInstallConfig"
  > = {
    getCapsule: () => Promise.resolve(capsule),
    getInstallConfig: () => Promise.resolve(invalidConfig),
  };
  const observed: AdapterApplyInput[] = [];
  const refreshed: AdapterApplyInput[] = [];
  const deleted: AdapterDeleteInput[] = [];
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => Promise.resolve({ nativeResources: [], outputs: {} }),
    importResource: () =>
      Promise.resolve({ summary: "import", nativeResources: [], outputs: {} }),
    async observe(input) {
      observed.push(input);
      return { status: "current", summary: "current" };
    },
    async refresh(input) {
      refreshed.push(input);
      return { summary: "refresh", nativeResources: [], outputs: {} };
    },
    async delete(input) {
      deleted.push(input);
    },
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    createDbOwnedHostRuntimeMaterializationResolver(invalidCapsules),
  );

  await decorated.observe({
    ...adapterInput(),
    hostRuntimeMaterialization: deleteAdapterInput().hostRuntimeMaterialization,
  });
  await decorated.refresh({
    ...adapterInput(),
    hostRuntimeMaterialization: deleteAdapterInput().hostRuntimeMaterialization,
  });
  await decorated.delete(deleteAdapterInput());

  expect(observed).toHaveLength(1);
  expect(refreshed).toHaveLength(1);
  expect(deleted).toHaveLength(1);
  expect(observed[0]).not.toHaveProperty("hostRuntimeMaterialization");
  expect(refreshed[0]).not.toHaveProperty("hostRuntimeMaterialization");
  expect(deleted[0]).not.toHaveProperty("hostRuntimeMaterialization");
});

test("missing direct-plugin EdgeWorker remains drifted until exact retained runtime is retired", async () => {
  const checked: Array<{
    resourceId: string;
    resourceGeneration: number;
    resourceRevisionId: string;
  }> = [];
  let retirementRequired = true;
  const lifecycle: HostRuntimeResourceLifecycle = {
    activate: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    retire: () => Promise.resolve(),
    async retirementRequired(input) {
      checked.push(input);
      return retirementRequired;
    },
  };
  const observed: AdapterApplyInput[] = [];
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => Promise.resolve({ nativeResources: [], outputs: {} }),
    importResource: () =>
      Promise.resolve({ summary: "import", nativeResources: [], outputs: {} }),
    async observe(input) {
      observed.push(input);
      return {
        status: "missing",
        summary: "provider resource is missing",
        backendOperationId: "backend-observe-1",
      };
    },
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    delete: () => Promise.resolve(),
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    async () => {
      throw new Error("InstallConfig resolver must not run during observe");
    },
    lifecycle,
  );

  const retained = await decorated.observe({
    ...adapterInput(),
    hostRuntimeMaterialization: deleteAdapterInput().hostRuntimeMaterialization,
  });
  expect(retained).toEqual({
    status: "drifted",
    summary:
      "provider resource is missing but retained host runtime requires retirement",
    backendOperationId: "backend-observe-1",
  });
  expect(checked).toEqual([
    {
      resourceId: "tkrn:workspace_1:EdgeWorker:app",
      resourceGeneration: 1,
      resourceRevisionId: "run_1",
    },
  ]);
  expect(observed[0]).not.toHaveProperty("hostRuntimeMaterialization");

  retirementRequired = false;
  expect(await decorated.observe(adapterInput())).toEqual({
    status: "missing",
    summary: "provider resource is missing",
    backendOperationId: "backend-observe-1",
  });
});

test("module-backed EdgeWorker missing observation does not consult retained runtime", async () => {
  let checked = false;
  const lifecycle: HostRuntimeResourceLifecycle = {
    activate: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    retire: () => Promise.resolve(),
    retirementRequired: () => {
      checked = true;
      return Promise.resolve(true);
    },
  };
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => Promise.resolve({ nativeResources: [], outputs: {} }),
    importResource: () =>
      Promise.resolve({ summary: "import", nativeResources: [], outputs: {} }),
    observe: () =>
      Promise.resolve({ status: "missing", summary: "provider missing" }),
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    delete: () => Promise.resolve(),
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    async () => undefined,
    lifecycle,
  );
  const direct = adapterInput();
  const { requiresAdapterPlugin: _plugin, ...modulePlan } = direct.plan;

  expect(
    await decorated.observe({
      ...direct,
      plan: {
        ...modulePlan,
        executionId: "cloudflare-worker-service",
        moduleTemplate: "cloudflare-worker-service",
      },
    }),
  ).toEqual({ status: "missing", summary: "provider missing" });
  expect(checked).toBe(false);
});

test("EdgeWorker delete retires exact identity before provider delete without resolving InstallConfig", async () => {
  const events: string[] = [];
  const retired: Array<{
    resourceId: string;
    resourceGeneration: number;
    resourceRevisionId: string;
  }> = [];
  const lifecycle: HostRuntimeResourceLifecycle = {
    activate: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    retirementRequired: () => Promise.resolve(false),
    async retire(input) {
      retired.push(input);
      events.push("retire");
    },
  };
  const deleted: AdapterDeleteInput[] = [];
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => Promise.resolve({ nativeResources: [], outputs: {} }),
    importResource: () =>
      Promise.resolve({ summary: "import", nativeResources: [], outputs: {} }),
    observe: () => Promise.resolve({ status: "current", summary: "current" }),
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    async delete(input) {
      deleted.push(input);
      events.push("delete");
    },
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    async () => {
      throw new Error("InstallConfig resolver must not run during delete");
    },
    lifecycle,
  );

  await decorated.delete(deleteAdapterInput());

  expect(retired).toEqual([
    {
      resourceId: "tkrn:workspace_1:EdgeWorker:app",
      resourceGeneration: 1,
      resourceRevisionId: "run_1",
    },
  ]);
  expect(events).toEqual(["retire", "delete"]);
  expect(deleted[0]).not.toHaveProperty("hostRuntimeMaterialization");
});

test("EdgeWorker provider delete is blocked when host retirement fails", async () => {
  let deleteCalled = false;
  const lifecycle: HostRuntimeResourceLifecycle = {
    activate: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    retirementRequired: () => Promise.resolve(false),
    retire: () => Promise.reject(new Error("retire failed")),
  };
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => Promise.resolve({ nativeResources: [], outputs: {} }),
    importResource: () =>
      Promise.resolve({ summary: "import", nativeResources: [], outputs: {} }),
    observe: () => Promise.resolve({ status: "current", summary: "current" }),
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    delete: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    async () => {
      throw new Error("InstallConfig resolver must not run during delete");
    },
    lifecycle,
  );

  await expect(decorated.delete(deleteAdapterInput())).rejects.toThrow(
    "retire failed",
  );
  expect(deleteCalled).toBe(false);
});

test("module-backed EdgeWorker delete bypasses retained retirement", async () => {
  let retireCalled = false;
  let deleteCalled = false;
  const lifecycle: HostRuntimeResourceLifecycle = {
    activate: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    retirementRequired: () => Promise.resolve(false),
    retire: () => {
      retireCalled = true;
      return Promise.resolve();
    },
  };
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => Promise.resolve({ nativeResources: [], outputs: {} }),
    importResource: () =>
      Promise.resolve({ summary: "import", nativeResources: [], outputs: {} }),
    observe: () => Promise.resolve({ status: "current", summary: "current" }),
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    delete: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    async () => {
      throw new Error("InstallConfig resolver must not run during delete");
    },
    lifecycle,
  );
  const input = deleteAdapterInput();
  const { resourceRevisionId: _revision, plan: directPlan, ...withoutRevision } =
    input;
  const { requiresAdapterPlugin: _plugin, ...modulePlan } = directPlan;

  await decorated.delete({
    ...withoutRevision,
    plan: {
      ...modulePlan,
      executionId: "cloudflare-worker-service",
      moduleTemplate: "cloudflare-worker-service",
    },
  });

  expect(retireCalled).toBe(false);
  expect(deleteCalled).toBe(true);
});

test("direct-plugin EdgeWorker delete requires its canonical backend revision", async () => {
  let deleteCalled = false;
  const lifecycle: HostRuntimeResourceLifecycle = {
    activate: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    retirementRequired: () => Promise.resolve(false),
    retire: () => Promise.resolve(),
  };
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => Promise.resolve({ nativeResources: [], outputs: {} }),
    importResource: () =>
      Promise.resolve({ summary: "import", nativeResources: [], outputs: {} }),
    observe: () => Promise.resolve({ status: "current", summary: "current" }),
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    delete: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    async () => undefined,
    lifecycle,
  );
  const { resourceRevisionId: _revision, ...missingRevision } =
    deleteAdapterInput();

  await expect(decorated.delete(missingRevision)).rejects.toThrow(
    "no canonical backend revision",
  );
  expect(deleteCalled).toBe(false);
});

test("EdgeWorker delete cannot skip retirement with a missing plan", async () => {
  let deleteCalled = false;
  const lifecycle: HostRuntimeResourceLifecycle = {
    activate: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    retirementRequired: () => Promise.resolve(false),
    retire: () => Promise.resolve(),
  };
  const adapter: ResourceAdapter = {
    id: "capture",
    preview: () => Promise.resolve({ summary: "preview", nativeResources: [] }),
    apply: () => Promise.resolve({ nativeResources: [], outputs: {} }),
    importResource: () =>
      Promise.resolve({ summary: "import", nativeResources: [], outputs: {} }),
    observe: () => Promise.resolve({ status: "current", summary: "current" }),
    refresh: () =>
      Promise.resolve({
        summary: "refresh",
        nativeResources: [],
        outputs: {},
      }),
    delete: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  };
  const decorated = withDbOwnedHostRuntimeMaterialization(
    adapter,
    async () => undefined,
    lifecycle,
  );
  const input = deleteAdapterInput();
  const { plan: _plan, ...missingPlan } = input;

  await expect(decorated.delete(missingPlan)).rejects.toThrow(
    "does not match EdgeWorker",
  );
  expect(deleteCalled).toBe(false);
});

test("form-host projections derive credentialless Resource binding requirements", () => {
  const request = formHostRuntimeMaterializationRequest({
    resourceId: "tkrn:workspace_1:EdgeWorker:worker",
    validatedSpec: {
      connections: {
        DB: {
          resource: "RelationalDatabase/main",
          projection: "sql.binding.v1",
          permissions: ["query"],
        },
        MEDIA: {
          resource: "ObjectBucket/media",
          projection: "object.binding.v1",
          permissions: ["read", "write"],
        },
        ignored: {
          resource: "EdgeWorker/other",
          projection: "schedule.trigger.v1",
          permissions: ["invoke"],
        },
      },
    },
  });

  expect(request?.requirements).toEqual([
    {
      kind: "resource_binding",
      binding: "DB",
      connectionAlias: "DB",
      requiredPermission: "takosumi.resource.bind",
    },
    {
      kind: "resource_binding",
      binding: "MEDIA",
      connectionAlias: "MEDIA",
      requiredPermission: "takosumi.resource.bind",
    },
  ]);
  expect(JSON.stringify(request)).not.toContain("capabilityRef");
});

test("Schedule background requirements resolve only the exact provider-neutral EdgeWorker edge", () => {
  const request = {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    installConfigId: config.id,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    installingPrincipalId: capsule.installingPrincipalId,
    requirements: config.hostRuntimeMaterialization!.requirements,
    backgroundActivations:
      config.hostRuntimeMaterialization!.backgroundActivations,
  };
  const source = {
    kind: "Schedule",
    owner: {
      kind: "Capsule" as const,
      id: capsule.id,
      workspaceId: capsule.workspaceId,
      installingPrincipalId: capsule.installingPrincipalId,
    },
    spec: {
      name: "app-retention",
      cron: "0 * * * *",
      timezone: "UTC",
      connections: {
        WORKER: {
          resource: "tkrn:workspace_1:EdgeWorker:app",
          permissions: ["invoke"],
          projection: "schedule.trigger.v1",
        },
      },
    },
  };

  expect(scheduleHostRuntimeReconcileTarget({ request, source })).toBe(
    "tkrn:workspace_1:EdgeWorker:app",
  );
  expect(() =>
    scheduleHostRuntimeReconcileTarget({
      request,
      source: {
        ...source,
        spec: {
          ...source.spec,
          connections: {
            WORKER: {
              ...source.spec.connections.WORKER,
              projection: "schedule_trigger",
            },
          },
        },
      },
    }),
  ).toThrow("exact schedule.trigger.v1");
  expect(
    scheduleHostRuntimeReconcileTarget({
      request,
      source: {
        ...source,
        owner: { ...source.owner, id: "another_capsule" },
      },
    }),
  ).toBeUndefined();
});
