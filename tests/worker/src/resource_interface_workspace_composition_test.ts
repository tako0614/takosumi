import { expect, test } from "bun:test";
import type { InterfaceProjectionSnapshot } from "takosumi-contract/interfaces";
import { createD1ResourceShapeStores } from "../../../core/domains/resource-shape/d1_stores.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import {
  createWorkerServiceApp,
  resourceInterfaceWorkspaceResolverFromEnv,
} from "../../../worker/src/worker_service.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-07-14T00:00:00.000Z";
const WORKSPACE_ID = "workspace_cloud_1";
const RESOURCE_ID = `tkrn:${WORKSPACE_ID}:EdgeWorker:app`;

test("shipped Worker projects Resource Interfaces and repairs their lifecycle through the host bridge", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const resources = createD1ResourceShapeStores(db);
  await seedReadyResource(resources);

  const snapshots: InterfaceProjectionSnapshot[] = [];
  const { operations } = await createWorkerServiceApp(
    {
      TAKOSUMI_CONTROL_DB: db,
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "test-deploy-control-token",
      TAKOSUMI_RESOURCE_INTERFACE_WORKSPACE_RESOLVER: async ({
        resourceSpaceId,
      }) => resourceSpaceId,
      TAKOSUMI_INTERFACE_PROJECTION_SINK: {
        async project(snapshot) {
          snapshots.push(structuredClone(snapshot));
        },
      },
    } as unknown as CloudflareWorkerEnv,
    "takosumi-api",
    { operatorInstallConfigs: [] },
  );

  const iface = await operations.interfaces.create({
    workspaceId: WORKSPACE_ID,
    name: "runtime-route",
    ownerRef: { kind: "Resource", id: RESOURCE_ID },
    spec: {
      type: "http.route",
      version: "v1alpha1",
      document: {},
      inputs: {
        endpoint: {
          source: "resource_output",
          resourceId: RESOURCE_ID,
          outputName: "endpoint",
        },
      },
      access: { visibility: "public", resourceUriInput: "endpoint" },
    },
  });
  const binding = await operations.interfaces.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "principal_cloud_1" },
    permissions: ["edge.request"],
    delivery: { type: "none" },
  });

  expect(iface.status).toMatchObject({
    phase: "Resolved",
    provenance: {
      endpoint: { source: "resource_output", resourceGeneration: 1 },
    },
  });
  expect(binding.status.phase).toBe("Ready");
  expect(
    snapshots.find((snapshot) => snapshot.interface.status.phase === "Resolved")
      ?.ownerResource,
  ).toEqual({
    id: RESOURCE_ID,
    generation: 1,
    nativeResources: [
      { type: "cloudflare_workers_script", id: "native-app-v1" },
    ],
  });

  const ready = await resources.resources.get(RESOURCE_ID);
  expect(ready).toBeDefined();
  await resources.resources.upsert({
    ...ready!,
    phase: "Deleting",
    updatedAt: "2026-07-14T00:01:00.000Z",
  });

  // Runtime discovery is the durable lifecycle repair boundary. It must use
  // the same host bridge as creation/projection and stop a missed observer
  // transition before returning the old Ready Binding.
  expect(
    await operations.interfaces.listAuthorizedForPrincipal(
      { workspaceId: WORKSPACE_ID },
      "principal_cloud_1",
      "edge.request",
    ),
  ).toEqual([]);
  expect(
    (await operations.interfaces.get(iface.metadata.id)).status.phase,
  ).toBe("NotReady");
  expect(
    (
      await operations.interfaces.getBinding(
        iface.metadata.id,
        binding.metadata.id,
      )
    ).status.phase,
  ).toBe("NotReady");
  expect(
    snapshots.some(
      (snapshot) => snapshot.interface.status.phase === "Terminating",
    ),
  ).toBe(true);
  expect(snapshots.at(-1)).toMatchObject({
    interface: { status: { phase: "NotReady" } },
  });
  expect(snapshots.at(-1)?.ownerResource).toBeUndefined();
});

test("shipped Worker keeps Resource Interface ownership fail-closed without a host bridge", async () => {
  expect(
    resourceInterfaceWorkspaceResolverFromEnv({
      TAKOSUMI_RESOURCE_INTERFACE_WORKSPACE_RESOLVER: undefined,
    } as unknown as CloudflareWorkerEnv),
  ).toBeUndefined();
  expect(() =>
    resourceInterfaceWorkspaceResolverFromEnv({
      TAKOSUMI_RESOURCE_INTERFACE_WORKSPACE_RESOLVER: "workspace_1",
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("must be a host-code resolver function");

  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await seedReadyResource(createD1ResourceShapeStores(db));
  const { operations } = await createWorkerServiceApp(
    {
      TAKOSUMI_CONTROL_DB: db,
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "test-deploy-control-token",
    } as unknown as CloudflareWorkerEnv,
    "takosumi-api",
    { operatorInstallConfigs: [] },
  );
  await expect(
    operations.interfaces.create({
      workspaceId: WORKSPACE_ID,
      name: "unmapped-runtime-route",
      ownerRef: { kind: "Resource", id: RESOURCE_ID },
      spec: {
        type: "http.route",
        version: "v1alpha1",
        document: {},
        access: { visibility: "public" },
      },
    }),
  ).rejects.toThrow("Interface owner does not exist in the Workspace");
});

async function seedReadyResource(
  stores: ReturnType<typeof createD1ResourceShapeStores>,
): Promise<void> {
  await stores.resources.upsert({
    id: RESOURCE_ID,
    spaceId: WORKSPACE_ID,
    kind: "EdgeWorker",
    name: "app",
    managedBy: "opentofu",
    spec: {},
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    outputs: { endpoint: "https://app.example.test" },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await stores.locks.put({
    resourceId: RESOURCE_ID,
    selectedImplementation: "cloud.edge-worker.v1",
    target: "cloud/default",
    locked: true,
    reason: ["test"],
    nativeResources: [
      { type: "cloudflare_workers_script", id: "native-app-v1" },
    ],
    lockedAt: NOW,
    updatedAt: NOW,
  });
}
