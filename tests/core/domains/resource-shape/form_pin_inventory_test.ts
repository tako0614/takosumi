import { expect, test } from "bun:test";
import type { InstalledFormReference } from "takosumi-contract";
import type { Workspace } from "takosumi-contract/workspaces";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  createInMemoryResourceShapeStores,
  formatResourceShapeId,
  ResourceFormPinInventoryService,
  type ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/mod.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  packageDigest: `sha256:${"b".repeat(64)}`,
};

function workspace(id: string, createdAt: string): Workspace {
  return {
    id,
    handle: id.replace(/^ws_/u, ""),
    displayName: id,
    type: "organization",
    ownerUserId: "acct_owner",
    createdAt,
    updatedAt: createdAt,
  };
}

function resource(
  spaceId: SpaceId,
  kind: string,
  name: string,
  form?: InstalledFormReference,
): ResourceShapeRecord {
  return {
    id: formatResourceShapeId(spaceId, kind, name),
    spaceId,
    kind,
    name,
    managedBy: "opentofu",
    spec: { password: `DO-NOT-LEAK-SPEC-${name}` },
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    outputs: { password: `DO-NOT-LEAK-OUTPUT-${name}` },
    ...(form ? { form } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("authoritative inventory cannot omit empty Workspaces or compatible Resources", async () => {
  const workspaces = new InMemoryOpenTofuControlStore();
  await workspaces.putWorkspace(workspace("ws_alpha", "2026-01-01T00:00:00Z"));
  await workspaces.putWorkspace(workspace("ws_empty", "2026-01-02T00:00:00Z"));
  const stores = createInMemoryResourceShapeStores();
  const alpha = "space_alpha" as SpaceId;
  const empty = "space_empty" as SpaceId;
  const pinned = resource(alpha, "ObjectBucket", "archive", FORM);
  const unpinned = resource(alpha, "EdgeWorker", "frontend");
  await stores.resources.upsert(pinned);
  await stores.resources.upsert(unpinned);
  await stores.resources.upsert(resource(alpha, "OperatorCustom", "ignored"));
  await stores.resources.upsert(
    resource("space_operator_only" as SpaceId, "Queue", "not-a-workspace"),
  );

  const service = new ResourceFormPinInventoryService({
    workspaces,
    resources: stores.resources,
    resolveSpace: (workspaceId) =>
      new Map([
        ["ws_alpha", alpha],
        ["ws_empty", empty],
      ]).get(workspaceId),
    now: () => NOW,
  });
  const receipt = await service.capture();

  expect(receipt).toMatchObject({
    kind: "takosumi.resource-form-pin-inventory@v1",
    complete: true,
    capturedAt: NOW,
    counts: {
      workspaces: 2,
      scopes: 20,
      resources: 2,
      pinned: 1,
      unpinned: 1,
    },
  });
  expect(receipt.rows.map((row) => row.resourceId)).toEqual([
    unpinned.id,
    pinned.id,
  ]);
  expect(receipt.rows[0]?.form).toBeNull();
  expect(receipt.rows[1]?.form).toEqual(FORM);
  expect(
    receipt.matrix.find(
      (entry) =>
        entry.workspaceId === "ws_empty" && entry.kind === "ObjectBucket",
    ),
  ).toEqual({
    workspaceId: "ws_empty",
    space: empty,
    kind: "ObjectBucket",
    resources: 0,
    pinned: 0,
    unpinned: 0,
  });
  expect(JSON.stringify(receipt)).not.toContain("DO-NOT-LEAK");
  expect(receipt.matrixDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect((await service.capture()).matrixDigest).toBe(receipt.matrixDigest);
});

test("inventory fails closed when the semantic Resource set changes between scans", async () => {
  const workspaces = new InMemoryOpenTofuControlStore();
  await workspaces.putWorkspace(workspace("ws_alpha", NOW));
  const stores = createInMemoryResourceShapeStores();
  const space = "space_alpha" as SpaceId;
  await stores.resources.upsert(resource(space, "ObjectBucket", "first"));
  let calls = 0;
  const service = new ResourceFormPinInventoryService({
    workspaces,
    resources: {
      listByKindsPage: async (kinds, params) => {
        calls += 1;
        if (calls === 2) {
          await stores.resources.upsert(resource(space, "Queue", "late"));
        }
        return await stores.resources.listByKindsPage(kinds, params);
      },
    },
    resolveSpace: () => space,
  });

  await expect(service.capture()).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "resource_form_pin_inventory_changed" },
  });
});

test("inventory rejects missing and ambiguous Workspace scope mappings", async () => {
  const workspaces = new InMemoryOpenTofuControlStore();
  await workspaces.putWorkspace(workspace("ws_alpha", "2026-01-01T00:00:00Z"));
  await workspaces.putWorkspace(workspace("ws_beta", "2026-01-02T00:00:00Z"));
  const stores = createInMemoryResourceShapeStores();

  await expect(
    new ResourceFormPinInventoryService({
      workspaces,
      resources: stores.resources,
      resolveSpace: (id) => (id === "ws_alpha" ? "space_alpha" : undefined),
    }).capture(),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "resource_form_pin_inventory_scope_missing" },
  });

  await expect(
    new ResourceFormPinInventoryService({
      workspaces,
      resources: stores.resources,
      resolveSpace: () => "space_shared",
    }).capture(),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "resource_form_pin_inventory_duplicate" },
  });
});

test("inventory preserves a durable legacy space_ Workspace for migration", async () => {
  const workspaces = new InMemoryOpenTofuControlStore();
  await workspaces.putWorkspace(workspace("space_legacy", NOW));
  const stores = createInMemoryResourceShapeStores();
  const legacySpace = "space_resources_legacy" as SpaceId;
  const legacyResource = resource(
    legacySpace,
    "ObjectBucket",
    "legacy-archive",
  );
  await stores.resources.upsert(legacyResource);

  const receipt = await new ResourceFormPinInventoryService({
    workspaces,
    resources: stores.resources,
    resolveSpace: (id) => (id === "space_legacy" ? legacySpace : undefined),
  }).capture();
  expect(receipt.counts).toMatchObject({ workspaces: 1, resources: 1 });
  expect(receipt.rows).toEqual([
    {
      workspaceId: "space_legacy",
      space: legacySpace,
      resourceId: legacyResource.id,
      name: "legacy-archive",
      kind: "ObjectBucket",
      form: null,
    },
  ]);
});

test("inventory paginates more than 200 Workspaces without a bulk id lookup", async () => {
  const store = new InMemoryOpenTofuControlStore();
  for (let index = 0; index < 205; index += 1) {
    const id = `ws_${index.toString().padStart(3, "0")}`;
    await store.putWorkspace(workspace(id, NOW));
  }
  const pageLimits: number[] = [];
  const stores = createInMemoryResourceShapeStores();
  const service = new ResourceFormPinInventoryService({
    workspaces: {
      listWorkspacesPage: async (params) => {
        pageLimits.push(params.limit);
        return await store.listWorkspacesPage(params);
      },
    },
    resources: stores.resources,
    resolveSpace: (id) => `space_${id}`,
  });

  const receipt = await service.capture();
  expect(receipt.counts).toMatchObject({
    workspaces: 205,
    scopes: 2_050,
    resources: 0,
  });
  expect(pageLimits.length).toBeGreaterThanOrEqual(6);
  expect(pageLimits.every((limit) => limit === 100)).toBeTrue();
});

test("inventory rejects incomplete cursor chains and hard-limit overflow", async () => {
  const stores = createInMemoryResourceShapeStores();
  const repeatedCursor = {
    listWorkspacesPage: async () => ({
      items: [workspace("ws_alpha", NOW)],
      nextCursor: "same-cursor",
    }),
  };
  await expect(
    new ResourceFormPinInventoryService({
      workspaces: repeatedCursor,
      resources: stores.resources,
      resolveSpace: () => "space_alpha",
    }).capture(),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "resource_form_pin_inventory_cursor_cycle" },
  });

  const workspaces = new InMemoryOpenTofuControlStore();
  await workspaces.putWorkspace(workspace("ws_alpha", NOW));
  await workspaces.putWorkspace(workspace("ws_beta", NOW));
  await expect(
    new ResourceFormPinInventoryService({
      workspaces,
      resources: stores.resources,
      resolveSpace: (id) => `space_${id}`,
      bounds: { maxWorkspaces: 1 },
    }).capture(),
  ).rejects.toMatchObject({
    code: "resource_exhausted",
    details: { reason: "resource_form_pin_inventory_limit" },
  });
});
