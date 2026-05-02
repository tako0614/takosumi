// Phase 18.3 — M6 (multi-generation GroupHead rollback) tests.

import assert from "node:assert/strict";
import {
  DeploymentService,
  InMemoryDeploymentStore,
} from "./deployment_service.ts";
import {
  InMemoryGroupHeadHistoryStore,
  resolveRollbackTarget,
} from "./group_head_history.ts";
import type { PublicDeployManifest } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixedClock(start: string): () => Date {
  let cursor = new Date(start).getTime();
  return () => {
    const d = new Date(cursor);
    cursor += 1000;
    return d;
  };
}

// ---------------------------------------------------------------------------
// M6: multi-generation rollback via group_head_history
// ---------------------------------------------------------------------------

function sampleManifest(version = "1.0.0"): PublicDeployManifest {
  return {
    name: "demo-app",
    version,
    compute: {
      api: { type: "js-worker" },
    },
  };
}

async function applyN(
  service: DeploymentService,
  n: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const d = await service.resolveDeployment({
      spaceId: "space_m6",
      manifest: sampleManifest(`${i}.0.0`),
    });
    await service.applyDeployment({
      deploymentId: d.id,
      appliedAt: `2026-04-30T00:0${i}:00.000Z`,
    });
    ids.push(d.id);
  }
  return ids;
}

Deno.test("M6: GroupHead history retains every applied generation", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `m6_apply_${++counter}`,
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });
  const ids = await applyN(service, 4);
  const history = await store.getGroupHeadHistory().list({
    spaceId: "space_m6",
    groupId: "demo-app",
  });
  // newest-first
  assert.equal(history.length, 4);
  assert.deepEqual(
    history.map((entry) => entry.deploymentId),
    [...ids].reverse(),
  );
  assert.deepEqual(
    history.map((entry) => entry.sequence),
    [4, 3, 2, 1],
  );
});

Deno.test("M6: rollbackGroup --steps walks N generations back", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `m6_steps_${++counter}`,
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });
  const ids = await applyN(service, 4);

  // Roll back THREE generations: from D4 (current) to D1.
  const head = await service.rollbackGroup({
    spaceId: "space_m6",
    groupId: "demo-app",
    steps: 3,
    advancedAt: "2026-04-30T01:00:00.000Z",
  });
  assert.equal(head.current_deployment_id, ids[0]);
  // GroupHead generation increments by one (the rollback is itself an advance).
  assert.equal(head.generation, 5);
  assert.equal(head.previous_deployment_id, ids[3]);

  // The previously current Deployment (D4) must be marked rolled-back.
  const d4 = await service.getDeployment(ids[3]);
  assert.equal(d4?.status, "rolled-back");
});

Deno.test("M6: rollbackGroup --target validates against retained history", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `m6_target_${++counter}`,
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });
  const ids = await applyN(service, 3);

  // Roll back to an older retained head (D1, two generations back).
  const head = await service.rollbackGroup({
    spaceId: "space_m6",
    groupId: "demo-app",
    targetDeploymentId: ids[0],
  });
  assert.equal(head.current_deployment_id, ids[0]);
});

Deno.test("M6: rollbackGroup rejects target that was never the head", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `m6_neverhead_${++counter}`,
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });
  await applyN(service, 2);

  // Resolve a third Deployment in the same space/group but never apply it.
  const stranger = await service.resolveDeployment({
    spaceId: "space_m6",
    manifest: sampleManifest("never-applied"),
  });
  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_m6",
        groupId: "demo-app",
        targetDeploymentId: stranger.id,
      }),
    /was never the head/,
  );
});

Deno.test("M6: rollbackGroup --target and --steps cross-check agree", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `m6_cross_${++counter}`,
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });
  const ids = await applyN(service, 3);

  // steps=2 means "two generations back from the current head (D3)" → D1.
  // Specifying targetDeploymentId=ids[0] alongside MUST agree.
  const head = await service.rollbackGroup({
    spaceId: "space_m6",
    groupId: "demo-app",
    steps: 2,
    targetDeploymentId: ids[0],
  });
  assert.equal(head.current_deployment_id, ids[0]);
});

Deno.test("M6: rollbackGroup --target and --steps cross-check disagree → error", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `m6_disagree_${++counter}`,
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });
  const ids = await applyN(service, 3);

  await assert.rejects(
    () =>
      service.rollbackGroup({
        spaceId: "space_m6",
        groupId: "demo-app",
        steps: 1, // resolves to ids[1]
        targetDeploymentId: ids[0], // disagrees
      }),
    /disagree/,
  );
});

Deno.test("M6: rollbackGroup with neither steps nor target is rejected", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `m6_empty_${++counter}`,
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });
  await applyN(service, 2);

  await assert.rejects(
    () =>
      service.rollbackGroup(
        {
          spaceId: "space_m6",
          groupId: "demo-app",
        } as unknown as Parameters<typeof service.rollbackGroup>[0],
      ),
    /at least one of/,
  );
});

Deno.test("M6: chained rollback retains access to deeper retained generations", async () => {
  const store = new InMemoryDeploymentStore();
  let counter = 0;
  const service = new DeploymentService({
    store,
    idFactory: () => `m6_chain_${++counter}`,
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
  });
  const ids = await applyN(service, 4);

  // Roll back from D4 to D3 (one generation).
  await service.rollbackGroup({
    spaceId: "space_m6",
    groupId: "demo-app",
    steps: 1,
  });
  // Now roll back to D1 — three retained generations beneath the current
  // head's *original* sequence. The history append after the previous
  // rollback bumped the sequence, so the helper resolves --target against
  // the most recent occurrence of D1.
  const head2 = await service.rollbackGroup({
    spaceId: "space_m6",
    groupId: "demo-app",
    targetDeploymentId: ids[0],
  });
  assert.equal(head2.current_deployment_id, ids[0]);
});

Deno.test("M6: resolveRollbackTarget is unit-testable in isolation", async () => {
  const history = new InMemoryGroupHeadHistoryStore();
  const base = {
    spaceId: "space_m6",
    groupId: "demo-app",
  } as const;
  await history.append({
    ...base,
    deploymentId: "d1",
    previousDeploymentId: null,
    sequence: 1,
    advancedAt: "2026-04-30T00:01:00.000Z",
  });
  await history.append({
    ...base,
    deploymentId: "d2",
    previousDeploymentId: "d1",
    sequence: 2,
    advancedAt: "2026-04-30T00:02:00.000Z",
  });
  await history.append({
    ...base,
    deploymentId: "d3",
    previousDeploymentId: "d2",
    sequence: 3,
    advancedAt: "2026-04-30T00:03:00.000Z",
  });

  // steps=1 → d2 (most recent prior to current head d3).
  const r1 = await resolveRollbackTarget(history, {
    ...base,
    currentSequence: 3,
    steps: 1,
  });
  assert.equal(r1.entry.deploymentId, "d2");
  assert.equal(r1.resolvedBy, "steps");

  // steps=2 → d1.
  const r2 = await resolveRollbackTarget(history, {
    ...base,
    currentSequence: 3,
    steps: 2,
  });
  assert.equal(r2.entry.deploymentId, "d1");

  // target=d1 → d1.
  const r3 = await resolveRollbackTarget(history, {
    ...base,
    currentSequence: 3,
    targetDeploymentId: "d1",
  });
  assert.equal(r3.entry.deploymentId, "d1");
  assert.equal(r3.resolvedBy, "target");

  // Refusing to roll back to the current head.
  await assert.rejects(
    () =>
      resolveRollbackTarget(history, {
        ...base,
        currentSequence: 3,
        targetDeploymentId: "d3",
      }),
    /current head/,
  );

  // steps beyond retained history.
  await assert.rejects(
    () =>
      resolveRollbackTarget(history, {
        ...base,
        currentSequence: 3,
        steps: 99,
      }),
    /history does not retain/,
  );
});

Deno.test("M6: history append rejects sequence regressions", async () => {
  const history = new InMemoryGroupHeadHistoryStore();
  await history.append({
    spaceId: "s",
    groupId: "g",
    deploymentId: "d1",
    previousDeploymentId: null,
    sequence: 1,
    advancedAt: "2026-04-30T00:00:00.000Z",
  });
  await assert.rejects(
    () =>
      history.append({
        spaceId: "s",
        groupId: "g",
        deploymentId: "d2",
        previousDeploymentId: "d1",
        sequence: 1, // duplicate
        advancedAt: "2026-04-30T00:01:00.000Z",
      }),
    /regressed sequence/,
  );
});
