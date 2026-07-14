import { expect, test } from "bun:test";

import { formatResourceShapeId } from "../../../../core/domains/resource-shape/records.ts";
import type { ResourceShapeRecord } from "../../../../core/domains/resource-shape/records.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";
import {
  resourceObservationSweep,
  type ResourceObservationOperations,
} from "../../../../worker/src/scheduled/resource_observation.ts";

function readyResource(index: number): ResourceShapeRecord {
  const spaceId = `space_${index % 2}` as SpaceId;
  const name = `scheduled-${index}`;
  return {
    id: formatResourceShapeId(spaceId, "EdgeWorker", name),
    spaceId,
    kind: "EdgeWorker",
    name,
    managedBy: "api",
    spec: {},
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

test("scheduled Resource observation is bounded, concurrent, and failure-isolated", async () => {
  const pending = [readyResource(0), readyResource(1), readyResource(2)];
  const claims: Array<{
    leaseId: string;
    claimedAt: string;
    dueBefore: string;
    staleClaimBefore: string;
  }> = [];
  const actors: Array<{
    actorAccountId: string;
    principalKind?: string;
    roles: readonly string[];
    requestId: string;
    workspaceId?: string;
  }> = [];
  const finishes: Array<{
    resourceId: string;
    leaseId: string;
    attemptedAt: string;
  }> = [];
  let active = 0;
  let maxActive = 0;

  const operations: ResourceObservationOperations = {
    claimCandidate: (input) => {
      claims.push(input);
      return Promise.resolve(pending.shift());
    },
    observe: async (resource, actor) => {
      actors.push(actor);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (resource.name === "scheduled-1") return false;
      if (resource.name === "scheduled-2") throw new Error("backend failed");
      return true;
    },
    finishClaim: (resourceId, leaseId, attemptedAt) => {
      finishes.push({ resourceId, leaseId, attemptedAt });
      return Promise.resolve(!resourceId.endsWith("scheduled-2"));
    },
  };
  let leaseSequence = 0;
  const result = await resourceObservationSweep(operations, {
    limit: 3,
    concurrency: 2,
    intervalMs: 60 * 60 * 1000,
    leaseMs: 15 * 60 * 1000,
    now: () => new Date("2026-07-02T12:00:00.000Z"),
    createLeaseId: () => `lease-${leaseSequence++}`,
  });

  expect(result).toEqual({
    claimed: 3,
    observed: 1,
    failed: 2,
    leaseLost: 1,
    claimErrors: 0,
  });
  expect(maxActive).toBe(2);
  expect(claims).toHaveLength(3);
  expect(claims[0]).toEqual({
    leaseId: "lease-0",
    claimedAt: "2026-07-02T12:00:00.000Z",
    dueBefore: "2026-07-02T11:00:00.000Z",
    staleClaimBefore: "2026-07-02T11:45:00.000Z",
  });
  expect(finishes).toHaveLength(3);
  expect(actors).toHaveLength(3);
  for (const actor of actors) {
    expect(actor.actorAccountId).toBe("takosumi-resource-observer");
    expect(actor.principalKind).toBe("system");
    expect(actor.roles).toEqual(["system"]);
    expect(actor.requestId).toStartWith("lease-");
    expect(actor.workspaceId).toBeUndefined();
  }
});

test("scheduled Resource observation contains claim-store failures", async () => {
  let observes = 0;
  const result = await resourceObservationSweep(
    {
      claimCandidate: () => Promise.reject(new Error("database unavailable")),
      observe: () => {
        observes += 1;
        return Promise.resolve(true);
      },
      finishClaim: () => Promise.resolve(true),
    },
    { limit: 4, concurrency: 2 },
  );
  expect(result).toEqual({
    claimed: 0,
    observed: 0,
    failed: 0,
    leaseLost: 0,
    claimErrors: 2,
  });
  expect(observes).toBe(0);
});

test("scheduled Resource observation does no work for a non-positive limit", async () => {
  let claims = 0;
  const result = await resourceObservationSweep(
    {
      claimCandidate: () => {
        claims += 1;
        return Promise.resolve(undefined);
      },
      observe: () => Promise.resolve(true),
      finishClaim: () => Promise.resolve(true),
    },
    { limit: 0 },
  );
  expect(result).toEqual({
    claimed: 0,
    observed: 0,
    failed: 0,
    leaseLost: 0,
    claimErrors: 0,
  });
  expect(claims).toBe(0);
});
