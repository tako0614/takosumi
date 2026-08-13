import { expect, test } from "bun:test";
import type {
  ApplyRun,
  PlanResourceChange,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { StateVersion } from "takosumi-contract/state-versions";
import {
  getCurrentResourceInventory,
  CURRENT_RESOURCE_INVENTORY_LINEAGE_MISMATCH_REASON,
  CURRENT_RESOURCE_INVENTORY_UNKNOWN_ACTION_REASON,
} from "../../../../core/domains/deploy-control/current_resource_inventory.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

const workspace = {
  id: "ws_inventory",
  handle: "inventory",
  displayName: "Inventory",
  type: "personal" as const,
  ownerUserId: "user_inventory",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

function capsule(overrides: Partial<Capsule> = {}): Capsule {
  return {
    id: "cap_inventory",
    workspaceId: workspace.id,
    projectId: "prj_inventory",
    name: "inventory",
    slug: "inventory",
    sourceId: "src_inventory",
    installConfigId: "cfg_inventory",
    environment: "production",
    currentStateGeneration: 3,
    currentStateVersionId: "state_inventory",
    status: "active",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    ...overrides,
  };
}

function stateVersion(overrides: Partial<StateVersion> = {}): StateVersion {
  return {
    id: "state_inventory",
    workspaceId: workspace.id,
    capsuleId: "cap_inventory",
    environment: "production",
    generation: 3,
    stateRef: "opaque-state-ref",
    digest: "sha256:state",
    createdByRunId: "apply_inventory",
    createdAt: "2026-08-13T00:01:00.000Z",
    ...overrides,
  };
}

function planRun(overrides: Partial<PlanRun> = {}): PlanRun {
  return {
    id: "plan_inventory",
    workspaceId: workspace.id,
    capsuleId: "cap_inventory",
    capsuleCurrentStateVersionId: "state_previous",
    capsuleContext: {
      workspaceId: workspace.id,
      capsuleId: "cap_inventory",
      environment: "production",
    },
    source: { kind: "git", url: "https://example.test/inventory.git" },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    appliedApplyRunId: "apply_inventory",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 2,
    planResourceChanges: [],
    ...overrides,
  };
}

function applyRun(overrides: Partial<ApplyRun> = {}): ApplyRun {
  return {
    id: "apply_inventory",
    planRunId: "plan_inventory",
    workspaceId: workspace.id,
    capsuleId: "cap_inventory",
    stateVersionId: "state_inventory",
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId: "plan_inventory",
      capsuleId: "cap_inventory",
      currentStateVersionId: "state_previous",
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "managed", ref: "state" },
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function lineage(planChanges?: readonly PlanResourceChange[]) {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace(workspace);
  await store.putCapsule(capsule());
  await store.putStateVersion(stateVersion());
  await store.putPlanRun(
    planRun({ planResourceChanges: planChanges }),
  );
  await store.putApplyRun(applyRun());
  return store;
}

test("projects only surviving value-free resources in stable order", async () => {
  const store = await lineage([
    {
      address: "data.cloudflare_zone.this",
      type: "cloudflare_zone",
      actions: ["no-op"],
    },
    {
      address: "module.network.data.cloudflare_zone.this",
      type: "cloudflare_zone",
      actions: ["no-op"],
    },
    { address: "data.example.read", type: "example_data", actions: ["read"] },
    {
      address: "read_only",
      type: "example_read",
      providerSource: "registry.opentofu.org/example/provider",
      actions: ["read"],
    },
    {
      address: "z.update",
      type: "example_update",
      providerSource: "registry.opentofu.org/example/provider",
      actions: ["update"],
    },
    { address: "b.delete", type: "example_delete", actions: ["delete"] },
    { address: "a.noop", type: "example_noop", actions: ["no-op"] },
    { address: "c.create", type: "example_create", actions: ["create"] },
    {
      address: "d.replace",
      type: "example_replace",
      actions: ["delete", "create"],
    },
    {
      address: "e.import",
      type: "example_import",
      actions: ["no-op"],
      importing: true,
    },
  ]);

  const response = await getCurrentResourceInventory(store, "cap_inventory");
  expect(response.inventory.availability).toBe("recorded");
  if (response.inventory.availability !== "recorded") throw new Error("unreachable");
  expect(response.inventory.kind).toBe(
    "takosumi.capsule-current-resource-inventory@v1",
  );
  expect(response.inventory.resources).toEqual([
    { address: "a.noop", type: "example_noop" },
    { address: "c.create", type: "example_create" },
    { address: "d.replace", type: "example_replace" },
    { address: "e.import", type: "example_import" },
    {
      address: "read_only",
      type: "example_read",
      providerSource: "registry.opentofu.org/example/provider",
    },
    {
      address: "z.update",
      type: "example_update",
      providerSource: "registry.opentofu.org/example/provider",
    },
  ]);
  expect(JSON.stringify(response)).not.toContain("scope");
  expect(JSON.stringify(response)).not.toContain("value");
});

test("distinguishes recorded empty from a legacy plan without the projection", async () => {
  const empty = await getCurrentResourceInventory(
    await lineage([]),
    "cap_inventory",
  );
  expect(empty.inventory.availability).toBe("recorded");
  if (empty.inventory.availability === "recorded") {
    expect(empty.inventory.resources).toEqual([]);
  }

  const legacy = await getCurrentResourceInventory(
    await lineage(undefined),
    "cap_inventory",
  );
  expect(legacy.inventory.availability).toBe("legacy_unavailable");
  expect("resources" in legacy.inventory).toBe(false);
});

test("fails closed for unknown actions and broken lineage", async () => {
  await expect(
    getCurrentResourceInventory(
      await lineage([
        { address: "unknown", type: "example", actions: ["forget"] },
      ]),
      "cap_inventory",
    ),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: CURRENT_RESOURCE_INVENTORY_UNKNOWN_ACTION_REASON },
  });

  const store = await lineage([]);
  await store.putApplyRun(
    applyRun({ stateVersionId: "state_other" }),
  );
  await expect(
    getCurrentResourceInventory(store, "cap_inventory"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: CURRENT_RESOURCE_INVENTORY_LINEAGE_MISMATCH_REASON },
  });
});
