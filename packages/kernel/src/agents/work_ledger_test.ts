import assert from "node:assert/strict";
import {
  InMemoryRuntimeAgentRegistry,
  InMemoryWorkLedger,
  rehydrateLeases,
  StorageBackedWorkLedger,
  type WorkLedgerSnapshot,
} from "./mod.ts";
import { MemoryStorageDriver } from "../adapters/storage/mod.ts";

Deno.test("InMemoryWorkLedger.apply persists agent + work mutations atomically", async () => {
  const ledger = new InMemoryWorkLedger();
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
    idGenerator: sequenceIds(["w_1", "lease_1"]),
    ledger,
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: { db: "primary" },
  });
  const lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);

  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0].id, "agent_a");
  assert.equal(snapshot.works.length, 1);
  assert.equal(snapshot.works[0].id, "work_w_1");
  assert.equal(snapshot.works[0].status, "leased");
  assert.equal(snapshot.works[0].leasedByAgentId, "agent_a");
  assert.equal(snapshot.works[0].leaseId, "lease_lease_1");
});

Deno.test("InMemoryWorkLedger reflects every progress update", async () => {
  const ledger = new InMemoryWorkLedger();
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
    idGenerator: sequenceIds(["w_1", "lease_1"]),
    defaultLeaseTtlMs: 60_000,
    ledger,
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);
  await registry.reportProgress({
    agentId: "agent_a",
    leaseId: lease.id,
    progress: { stage: "rds.creating", percent: 50 },
    extendUntil: "2026-04-30T01:00:00.000Z",
    reportedAt: "2026-04-30T00:00:30.000Z",
  });
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.works.length, 1);
  assert.deepEqual(snapshot.works[0].lastProgress, {
    stage: "rds.creating",
    percent: 50,
  });
  assert.equal(snapshot.works[0].lastProgressAt, "2026-04-30T00:00:30.000Z");
  assert.equal(snapshot.works[0].leaseExpiresAt, "2026-04-30T00:15:30.000Z");
});

Deno.test("rehydrateLeases requeues stale leases past their expiry", () => {
  const raw: WorkLedgerSnapshot = {
    agents: [],
    works: [
      {
        id: "w_stale",
        kind: "provider.aws.rds.create",
        status: "leased",
        payload: {},
        provider: "aws",
        priority: 0,
        queuedAt: "2026-04-30T00:00:00.000Z",
        leasedByAgentId: "agent_a",
        leaseId: "lease_stale",
        leaseExpiresAt: "2026-04-30T00:00:30.000Z",
        attempts: 1,
        metadata: {},
      },
      {
        id: "w_fresh",
        kind: "provider.aws.rds.create",
        status: "leased",
        payload: {},
        provider: "aws",
        priority: 0,
        queuedAt: "2026-04-30T00:00:00.000Z",
        leasedByAgentId: "agent_a",
        leaseId: "lease_fresh",
        leaseExpiresAt: "2026-04-30T01:00:00.000Z",
        attempts: 1,
        metadata: {},
      },
    ],
  };
  const result = rehydrateLeases(raw, { now: "2026-04-30T00:05:00.000Z" });
  assert.deepEqual(result.requeuedWorkIds, ["w_stale"]);
  const stale = result.snapshot.works.find((w) => w.id === "w_stale");
  const fresh = result.snapshot.works.find((w) => w.id === "w_fresh");
  assert.equal(stale?.status, "queued");
  assert.equal(stale?.leasedByAgentId, undefined);
  assert.equal(stale?.leaseId, undefined);
  assert.equal(stale?.leaseExpiresAt, undefined);
  // Fresh lease must NOT be touched — the kernel will let the existing
  // agent reattach via heartbeat and complete the in-flight op.
  assert.equal(fresh?.status, "leased");
  assert.equal(fresh?.leaseExpiresAt, "2026-04-30T01:00:00.000Z");
});

Deno.test("rehydrateLeases leaves non-leased work items untouched", () => {
  const raw: WorkLedgerSnapshot = {
    agents: [],
    works: [
      {
        id: "w_queued",
        kind: "provider.aws.rds.create",
        status: "queued",
        payload: {},
        provider: "aws",
        priority: 0,
        queuedAt: "2026-04-30T00:00:00.000Z",
        attempts: 0,
        metadata: {},
      },
      {
        id: "w_completed",
        kind: "provider.aws.rds.create",
        status: "completed",
        payload: {},
        provider: "aws",
        priority: 0,
        queuedAt: "2026-04-30T00:00:00.000Z",
        completedAt: "2026-04-30T00:01:00.000Z",
        attempts: 1,
        metadata: {},
      },
    ],
  };
  const result = rehydrateLeases(raw, { now: "2026-04-30T01:00:00.000Z" });
  assert.deepEqual(result.requeuedWorkIds, []);
  assert.equal(result.snapshot.works[0].status, "queued");
  assert.equal(result.snapshot.works[1].status, "completed");
});

Deno.test("InMemoryRuntimeAgentRegistry.fromLedger replays prior agents and works", async () => {
  const ledger = new InMemoryWorkLedger();
  // Boot 1: initial registry seeds the ledger.
  {
    const registry = new InMemoryRuntimeAgentRegistry({
      clock: fixedClock("2026-04-30T00:00:00.000Z"),
      idGenerator: sequenceIds(["w_1", "w_2"]),
      ledger,
    });
    await registry.register({ agentId: "agent_a", provider: "aws" });
    await registry.register({ agentId: "agent_b", provider: "k8s" });
    await registry.enqueueWork({
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: {},
    });
    await registry.enqueueWork({
      kind: "provider.k8s.deployment.apply",
      provider: "k8s",
      payload: {},
    });
  }
  // Boot 2: rehydrate from the ledger.
  const restored = await InMemoryRuntimeAgentRegistry.fromLedger(ledger, {
    clock: fixedClock("2026-04-30T00:01:00.000Z"),
    now: "2026-04-30T00:01:00.000Z",
  });
  const agents = await restored.listAgents();
  assert.equal(agents.length, 2);
  assert.deepEqual(
    [...agents].map((agent) => agent.id).sort(),
    ["agent_a", "agent_b"],
  );
  const works = await restored.listWork();
  assert.equal(works.length, 2);
  assert.deepEqual(
    [...works].map((work) => work.status).sort(),
    ["queued", "queued"],
  );
});

Deno.test("InMemoryRuntimeAgentRegistry.fromLedger persists boot requeues back to ledger", async () => {
  const ledger = new InMemoryWorkLedger();
  {
    const registry = new InMemoryRuntimeAgentRegistry({
      clock: fixedClock("2026-04-30T00:00:00.000Z"),
      idGenerator: sequenceIds(["w_1", "lease_1"]),
      defaultLeaseTtlMs: 30_000,
      ledger,
    });
    await registry.register({ agentId: "agent_a", provider: "aws" });
    await registry.enqueueWork({
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: {},
    });
    await registry.leaseWork({ agentId: "agent_a" });
  }

  await InMemoryRuntimeAgentRegistry.fromLedger(ledger, {
    now: "2026-04-30T00:01:00.000Z",
  });

  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.works[0].status, "queued");
  assert.equal(snapshot.works[0].leasedByAgentId, undefined);
  assert.equal(snapshot.works[0].leaseId, undefined);
  assert.equal(snapshot.works[0].leaseExpiresAt, undefined);
});

Deno.test("StorageBackedWorkLedger persists through the storage transaction boundary", async () => {
  const driver = new MemoryStorageDriver();
  const ledger = new StorageBackedWorkLedger(driver);
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
    idGenerator: sequenceIds(["w_1"]),
    ledger,
  });

  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });

  const snapshot = driver.snapshot();
  assert.equal(snapshot.runtimeAgents[0].id, "agent_a");
  assert.equal(snapshot.runtimeAgentWorkItems[0].id, "work_w_1");
});

Deno.test("InMemoryRuntimeAgentRegistry mutations without ledger are still local-only", async () => {
  // Sanity check — when constructed without a ledger the registry must
  // not crash on the persist path. This guards against regressions that
  // make `ledger` accidentally required.
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-30T00:00:00.000Z"),
    idGenerator: sequenceIds(["w_1", "lease_1"]),
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);
  const completed = await registry.completeWork({
    agentId: "agent_a",
    leaseId: lease.id,
  });
  assert.equal(completed.status, "completed");
});

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function sequenceIds(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("test id sequence exhausted");
    index += 1;
    return value;
  };
}
