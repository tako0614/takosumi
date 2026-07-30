import { expect, test } from "bun:test";

import {
  HOST_RUNTIME_MATERIALIZATION_CONTRACT,
  type Capsule,
  type InstallConfig,
} from "takosumi-contract";
import type { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import type {
  AdapterApplyInput,
  ResourceAdapter,
} from "../../../../core/domains/resource-shape/adapter.ts";
import {
  createDbOwnedHostRuntimeMaterializationResolver,
  scheduleHostRuntimeReconcileTarget,
  withDbOwnedHostRuntimeMaterialization,
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
