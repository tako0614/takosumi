import { expect, test } from "bun:test";

import type { ResourceObject } from "takosumi-contract";
import {
  resolveUniqueIncomingHostRuntimeSchedule,
  type PlatformCanonicalReadyResourceInventory,
  type PlatformCanonicalReadyResourceInventoryItem,
} from "../../../deploy/platform/worker.ts";

const owner = {
  kind: "Capsule" as const,
  id: "capsule_1",
  workspaceId: "workspace_1",
  installingPrincipalId: "principal_1",
};

function schedule(
  name: string,
  revision: string,
  target = "tkrn:workspace_1:EdgeWorker:app",
): PlatformCanonicalReadyResourceInventoryItem {
  const resourceId = `tkrn:workspace_1:Schedule:${name}`;
  return {
    resourceId,
    resource: {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "Schedule",
      metadata: {
        name,
        space: "workspace_1",
        owner,
        managedBy: "opentofu",
      },
      spec: {
        name,
        cron: "0 * * * *",
        timezone: "UTC",
        connections: {
          WORKER: {
            resource: target,
            permissions: ["invoke"],
            projection: "schedule.trigger.v1",
          },
        },
      },
      status: {
        phase: "Ready",
        observedGeneration: 2,
      },
    } as ResourceObject,
    resourceGeneration: 2,
    resourceRevisionId: revision,
    nativeResources: [{ type: "schedule", id: `native-${name}` }],
  };
}

function inventory(
  items: readonly PlatformCanonicalReadyResourceInventoryItem[],
): PlatformCanonicalReadyResourceInventory {
  return {
    get: () => Promise.resolve(undefined),
    list: (input) => {
      expect(input).toMatchObject({
        kind: "Schedule",
        space: "workspace_1",
        limit: 100,
      });
      return Promise.resolve({ items });
    },
  };
}

const input = {
  workspaceId: "workspace_1",
  capsuleId: "capsule_1",
  installingPrincipalId: "principal_1",
  targetResourceId: "tkrn:workspace_1:EdgeWorker:app",
  connectionAlias: "WORKER",
};

test("incoming Schedule resolution pins the exact current revision without a native-provider selector", async () => {
  const resolved = await resolveUniqueIncomingHostRuntimeSchedule({
    ...input,
    inventory: inventory([schedule("app-retention", "run_schedule_2")]),
  });

  expect(resolved).toMatchObject({
    resourceId: "tkrn:workspace_1:Schedule:app-retention",
    resourceGeneration: 2,
    resourceRevisionId: "run_schedule_2",
    nativeType: "schedule",
    nativeId: "native-app-retention",
  });
});

test("an absent or replaced Schedule fails closed and an ambiguous edge is rejected", async () => {
  expect(
    await resolveUniqueIncomingHostRuntimeSchedule({
      ...input,
      inventory: inventory([]),
    }),
  ).toBeUndefined();

  expect(
    await resolveUniqueIncomingHostRuntimeSchedule({
      ...input,
      inventory: inventory([
        schedule(
          "app-retention",
          "run_schedule_3",
          "tkrn:workspace_1:EdgeWorker:another",
        ),
      ]),
    }),
  ).toBeUndefined();

  await expect(
    resolveUniqueIncomingHostRuntimeSchedule({
      ...input,
      inventory: inventory([
        schedule("first-retention", "run_schedule_4"),
        schedule("second-retention", "run_schedule_5"),
      ]),
    }),
  ).rejects.toThrow("ambiguous");
});
