import { expect, test } from "bun:test";
import type { Interface } from "takosumi-contract/interfaces";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
} from "../../../../core/domains/interfaces/mod.ts";
import { createInMemoryResourceShapeStores } from "../../../../core/domains/resource-shape/mod.ts";

const NOW = "2026-07-14T00:00:00.000Z";

test("Interface projection repair keyset-pages more than 100 canonical rows without gaps or duplicates", async () => {
  const stores = createInMemoryInterfaceStores();
  for (let index = 204; index >= 0; index -= 1) {
    expect(await stores.interfaces.create(interfaceRecord(index))).toBe(true);
  }
  const projected: string[] = [];
  const service = new InterfaceService({
    stores,
    projectionSink: {
      project(snapshot) {
        projected.push(snapshot.interface.metadata.id);
        return Promise.resolve();
      },
    },
  });

  const pageSizes: number[] = [];
  let cursor: string | undefined;
  do {
    const result = await service.repairProjections({
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    pageSizes.push(result.scanned);
    cursor = result.nextCursor;
  } while (cursor);

  expect(pageSizes).toEqual([100, 100, 5]);
  expect(projected).toHaveLength(205);
  expect(new Set(projected).size).toBe(205);
  expect(projected).toEqual([...projected].sort());
});

test("Interface transitions project immediately and a failed host sink is repairable", async () => {
  const stores = createInMemoryInterfaceStores();
  const phases: string[] = [];
  let failResolvedOnce = true;
  let id = 0;
  const service = new InterfaceService({
    stores,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++id}`,
    projectionSink: {
      project(snapshot) {
        phases.push(snapshot.interface.status.phase);
        if (
          snapshot.interface.status.phase === "Resolved" &&
          failResolvedOnce
        ) {
          failResolvedOnce = false;
          return Promise.reject(new Error("simulated projection outage"));
        }
        return Promise.resolve();
      },
    },
  });

  const created = await service.create({
    workspaceId: "workspace_1",
    name: "runtime",
    ownerRef: { kind: "Workspace", id: "workspace_1" },
    spec: {
      type: "test.runtime",
      version: "v1",
      document: {},
      inputs: {
        endpoint: { source: "literal", value: "https://app.example.test" },
      },
      access: { visibility: "public", resourceUriInput: "endpoint" },
    },
  });
  expect(created.status.phase).toBe("Resolved");
  expect(await service.get(created.metadata.id)).toMatchObject({
    status: { phase: "Resolved" },
  });
  expect(phases).toEqual(["Pending", "Resolved"]);

  const repaired = await service.repairProjections({ limit: 10 });
  expect(repaired).toMatchObject({ scanned: 1, projected: 1, failed: 0 });

  const updated = await service.update(
    created.metadata.id,
    {
      spec: {
        ...created.spec,
        document: { revision: 2 },
      },
    },
    created.metadata.generation,
  );
  await service.retire(updated.metadata.id, updated.metadata.generation);
  expect(phases.slice(-3)).toEqual(["Pending", "Resolved", "Retired"]);
});

test("bootstrap attaches coherent Ready Resource generation and NativeResource evidence", async () => {
  const resourceId = "tkrn:space_1:EdgeWorker:app";
  const resourceStores = createInMemoryResourceShapeStores();
  expect(
    await resourceStores.resources.create({
      id: resourceId,
      spaceId: "space_1",
      kind: "EdgeWorker",
      name: "app",
      managedBy: "opentofu",
      spec: {},
      phase: "Ready",
      generation: 3,
      observedGeneration: 3,
      outputs: { endpoint: "https://app.example.test" },
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ).toMatchObject({ status: "created" });
  await resourceStores.locks.put({
    resourceId,
    selectedImplementation: "cloud.edge-worker.v1",
    target: "cloud/default",
    locked: true,
    reason: ["test"],
    nativeResources: [
      { type: "cloudflare_workers_script", id: "native-app-v3" },
    ],
    lockedAt: NOW,
    updatedAt: NOW,
  });
  const snapshots: import("takosumi-contract/interfaces").InterfaceProjectionSnapshot[] =
    [];
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    resourceShapeStores: resourceStores,
    resolveResourceInterfaceWorkspace: ({ resourceSpaceId }) =>
      Promise.resolve(
        resourceSpaceId === "space_1" ? "workspace_1" : undefined,
      ),
    interfaceProjectionSink: {
      project(snapshot) {
        snapshots.push(structuredClone(snapshot));
        return Promise.resolve();
      },
    },
  });

  const iface = await operations.interfaces.create({
    workspaceId: "workspace_1",
    name: "runtime-route",
    ownerRef: { kind: "Resource", id: resourceId },
    spec: {
      type: "http.route",
      version: "v1alpha1",
      document: {},
      inputs: {
        endpoint: {
          source: "resource_output",
          resourceId,
          outputName: "endpoint",
        },
      },
      access: { visibility: "public", resourceUriInput: "endpoint" },
    },
  });

  expect(iface.status).toMatchObject({
    phase: "Resolved",
    provenance: {
      endpoint: { source: "resource_output", resourceGeneration: 3 },
    },
  });
  expect(snapshots.at(-1)?.ownerResource).toEqual({
    id: resourceId,
    generation: 3,
    nativeResources: [
      { type: "cloudflare_workers_script", id: "native-app-v3" },
    ],
  });
});

function interfaceRecord(index: number): Interface {
  const suffix = index.toString().padStart(4, "0");
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: `if_${suffix}`,
      workspaceId: `workspace_${index % 3}`,
      name: `runtime-${suffix}`,
      ownerRef: {
        kind: "Resource",
        id: `tkrn:workspace_${index % 3}:EdgeWorker:worker-${suffix}`,
      },
      generation: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    spec: {
      type: "test.runtime",
      version: "v1",
      document: {},
      access: { visibility: "public" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
    },
  };
}
