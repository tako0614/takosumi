import { expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleCapsules } from "../../../../accounts/service/src/control/capsules.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const capsule: Capsule = {
  id: "cap_inventory0001",
  workspaceId: "ws_inventory",
  projectId: "prj_inventory",
  name: "inventory",
  slug: "inventory",
  sourceId: "src_inventory",
  installConfigId: "cfg_inventory",
  environment: "production",
  currentStateGeneration: 3,
  currentStateVersionId: "state_inventory",
  status: "active",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

const inventory = {
  inventory: {
    kind: "takosumi.capsule-current-resource-inventory@v1" as const,
    capsuleId: capsule.id,
    workspaceId: capsule.workspaceId,
    environment: capsule.environment,
    stateVersionId: "state_inventory",
    generation: 3,
    applyRunId: "apply_inventory",
    planRunId: "plan_inventory",
    recordedAt: "2026-08-13T00:01:00.000Z",
    availability: "recorded" as const,
    resources: [
      {
        address: "cloudflare_worker.api",
        type: "cloudflare_workers_script",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
      },
    ],
  },
};

function operationsFixture(
  onInventory?: () => Promise<typeof inventory>,
): ControlPlaneOperations {
  return {
    workspaces: {
      getWorkspace: async () => ({
        id: capsule.workspaceId,
        handle: "inventory",
        displayName: "Inventory",
        type: "personal",
        ownerUserId: "subject_inventory",
        createdAt: capsule.createdAt,
        updatedAt: capsule.updatedAt,
      }),
    },
    members: { listMembers: async () => [] },
    capsules: { getCapsule: async () => capsule },
    getCurrentResourceInventory: onInventory ?? (async () => inventory),
  } as unknown as ControlPlaneOperations;
}

function context(
  operations: ControlPlaneOperations,
  method = "GET",
  subject = "subject_inventory",
): ControlDispatchContext {
  const request = new Request(
    `https://app.example.test/api/v1/capsules/${capsule.id}/current-resource-inventory`,
    { method },
  );
  return {
    request,
    url: new URL(request.url),
    operations,
    store: new InMemoryAccountsStore(),
    session: { subject },
  };
}

test("session Capsule current-resource-inventory returns the OSS projection", async () => {
  const response = await handleCapsules(
    context(operationsFixture()),
    ["capsules", capsule.id, "current-resource-inventory"],
    "GET",
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(inventory);
});

test("current-resource-inventory authorizes Workspace before reading the projection", async () => {
  let reads = 0;
  const response = await handleCapsules(
    context(
      operationsFixture(async () => {
        reads += 1;
        return inventory;
      }),
      "GET",
      "subject_other",
    ),
    ["capsules", capsule.id, "current-resource-inventory"],
    "GET",
  );
  expect(response?.status).toBe(403);
  expect(reads).toBe(0);
});

test("current-resource-inventory is read-only", async () => {
  const response = await handleCapsules(
    context(operationsFixture(), "POST"),
    ["capsules", capsule.id, "current-resource-inventory"],
    "POST",
  );
  expect(response?.status).toBe(405);
  expect(response?.headers.get("allow")).toBe("GET");
});
