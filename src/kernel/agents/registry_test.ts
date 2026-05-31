import { test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryRuntimeAgentRegistry, InMemoryWorkLedger } from "./mod.ts";
import { DomainError } from "../shared/errors.ts";

test("runtime agents register, heartbeat, lease, complete, and revoke work", async () => {
  const ids = sequenceIds([
    "agent_seq",
    "work_low",
    "work_high",
    "lease_seq",
    "lease_revoke",
  ]);
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: ids,
    defaultLeaseTtlMs: 60_000,
  });

  const registered = await registry.register({
    provider: "local-docker",
    endpoint: "http://agent.local",
    capabilities: {
      providers: ["local-docker"],
      maxConcurrentLeases: 1,
      labels: { region: "local" },
    },
    metadata: { boot: 1 },
  });

  assert.equal(registered.id, "agent_agent_seq");
  assert.equal(registered.status, "ready");
  assert.equal(registered.registeredAt, "2026-04-27T00:00:00.000Z");
  assert.deepEqual(registered.capabilities.providers, ["local-docker"]);

  const heartbeat = await registry.heartbeat({
    agentId: registered.id,
    heartbeatAt: "2026-04-27T00:00:10.000Z",
    status: "ready",
    metadata: { live: true },
  });

  assert.equal(heartbeat.lastHeartbeatAt, "2026-04-27T00:00:10.000Z");
  assert.deepEqual(heartbeat.metadata, { boot: 1, live: true });

  const lowPriority = await registry.enqueueWork({
    kind: "runtime.materialize",
    payload: { desiredStateId: "desired_low" },
    provider: "local-docker",
    priority: 1,
    queuedAt: "2026-04-27T00:00:01.000Z",
  });
  const highPriority = await registry.enqueueWork({
    kind: "runtime.materialize",
    payload: { desiredStateId: "desired_high" },
    provider: "local-docker",
    priority: 10,
    queuedAt: "2026-04-27T00:00:02.000Z",
  });

  const lease = await registry.leaseWork({
    agentId: registered.id,
    now: "2026-04-27T00:00:20.000Z",
  });

  assert.ok(lease);
  assert.equal(lease.id, "lease_lease_seq");
  assert.equal(lease.workId, highPriority.id);
  assert.equal(lease.expiresAt, "2026-04-27T00:01:20.000Z");
  assert.equal(lease.work.status, "leased");
  assert.equal(lease.work.attempts, 1);

  const completed = await registry.completeWork({
    agentId: registered.id,
    leaseId: lease.id,
    completedAt: "2026-04-27T00:00:30.000Z",
  });

  assert.equal(completed.id, highPriority.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completedAt, "2026-04-27T00:00:30.000Z");

  await registry.enqueueWork({
    workId: "work_requeued_on_revoke",
    kind: "runtime.materialize",
    payload: { desiredStateId: "desired_revoke" },
    provider: "local-docker",
    priority: 20,
    queuedAt: "2026-04-27T00:00:03.000Z",
  });
  const revokeLease = await registry.leaseWork({
    agentId: registered.id,
    leaseTtlMs: 120_000,
    now: "2026-04-27T00:00:40.000Z",
  });

  assert.ok(revokeLease);
  assert.equal(revokeLease.workId, "work_requeued_on_revoke");

  const revoked = await registry.revoke(
    registered.id,
    "2026-04-27T00:00:50.000Z",
  );

  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedAt, "2026-04-27T00:00:50.000Z");

  const requeued = await registry.getWork("work_requeued_on_revoke");
  assert.equal(requeued?.status, "queued");
  assert.equal(requeued?.leasedByAgentId, undefined);
  assert.equal(requeued?.leaseId, undefined);
  assert.equal(requeued?.leaseExpiresAt, undefined);

  const remainingLease = await registry.leaseWork({
    agentId: registered.id,
    now: "2026-04-27T00:01:00.000Z",
  });
  assert.equal(remainingLease, undefined);

  assert.equal((await registry.getWork(lowPriority.id))?.status, "queued");
});

test("runtime agent registry rejects heartbeat after revoke", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await registry.register({ agentId: "agent_a", provider: "noop" });
  await registry.revoke("agent_a", "2026-04-27T00:00:01.000Z");

  assert.throws(
    () => registry.heartbeat({ agentId: "agent_a" }),
    (error) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "conflict");
      assert.equal(error.details?.agentId, "agent_a");
      return true;
    },
  );
});

test("runtime agent reportProgress extends lease without losing it", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["agent_1", "work_1", "lease_1"]),
    defaultLeaseTtlMs: 60_000,
  });
  await registry.register({ provider: "aws" });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: { db: "primary" },
  });
  const lease = await registry.leaseWork({ agentId: "agent_agent_1" });
  assert.ok(lease);
  assert.equal(lease.expiresAt, "2026-04-27T00:01:00.000Z");
  assert.equal(lease.renewAfter, "2026-04-27T00:00:30.000Z");

  const progressed = await registry.reportProgress({
    agentId: "agent_agent_1",
    leaseId: lease.id,
    progress: { stage: "rds.creating", percent: 10 },
    extendUntil: "2026-04-27T00:05:00.000Z",
    reportedAt: "2026-04-27T00:00:25.000Z",
  });
  assert.equal(progressed.status, "leased");
  assert.equal(progressed.leaseExpiresAt, "2026-04-27T00:05:00.000Z");
  assert.deepEqual(progressed.lastProgress, {
    stage: "rds.creating",
    percent: 10,
  });
  assert.equal(progressed.lastProgressAt, "2026-04-27T00:00:25.000Z");

  const completed = await registry.completeWork({
    agentId: "agent_agent_1",
    leaseId: lease.id,
    completedAt: "2026-04-27T00:04:30.000Z",
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.lastProgress, {
    stage: "rds.creating",
    percent: 10,
  });
});

test("runtime agent reportProgress refuses to shrink the lease", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["a", "w", "l"]),
    defaultLeaseTtlMs: 120_000,
  });
  await registry.register({ provider: "gcp" });
  await registry.enqueueWork({
    kind: "provider.gcp.cloud-sql.create",
    provider: "gcp",
    payload: {},
  });
  const lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);
  const expiresAt = lease.expiresAt;
  const updated = await registry.reportProgress({
    agentId: "agent_a",
    leaseId: lease.id,
    extendUntil: "2026-04-27T00:00:05.000Z",
    reportedAt: "2026-04-27T00:00:01.000Z",
  });
  assert.equal(updated.leaseExpiresAt, expiresAt);
});

test("runtime agent reportProgress requires a valid lease", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  assert.throws(
    () =>
      registry.reportProgress({
        agentId: "agent_a",
        leaseId: "lease_missing",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "not_found");
      return true;
    },
  );
});

test("runtime agent detectStaleAgents marks idle agents expired and requeues their leases", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w_a", "w_b", "lease_a", "lease_b"]),
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.register({ agentId: "agent_b", provider: "aws" });
  await registry.heartbeat({
    agentId: "agent_b",
    heartbeatAt: "2026-04-27T00:01:25.000Z",
  });

  const work = await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const lease = await registry.leaseWork({
    agentId: "agent_a",
    now: "2026-04-27T00:00:30.000Z",
  });
  assert.ok(lease);
  assert.equal(lease.workId, work.id);

  const detection = await registry.detectStaleAgents({
    ttlMs: 30_000,
    now: "2026-04-27T00:01:30.000Z",
  });
  assert.equal(detection.stale.length, 1);
  assert.equal(detection.stale[0].id, "agent_a");
  assert.equal(detection.stale[0].status, "expired");
  assert.equal(detection.stale[0].expiredAt, "2026-04-27T00:01:30.000Z");
  assert.equal(detection.requeuedWork.length, 1);
  assert.equal(detection.requeuedWork[0].id, work.id);
  assert.equal(detection.requeuedWork[0].status, "queued");

  const refreshed = await registry.getWork(work.id);
  assert.equal(refreshed?.status, "queued");
  assert.equal(refreshed?.leasedByAgentId, undefined);
});

test("runtime agent detectStaleAgents returns empty when none idle", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await registry.register({ agentId: "agent_a", provider: "k8s" });
  const detection = await registry.detectStaleAgents({
    ttlMs: 60_000,
    now: "2026-04-27T00:00:30.000Z",
  });
  assert.equal(detection.stale.length, 0);
  assert.equal(detection.requeuedWork.length, 0);
});

test("runtime agent detectStaleAgents skips already-revoked agents", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.revoke("agent_a", "2026-04-27T00:00:10.000Z");
  const detection = await registry.detectStaleAgents({
    ttlMs: 5_000,
    now: "2026-04-27T00:01:00.000Z",
  });
  assert.equal(detection.stale.length, 0);
});

test("runtime agent detectStaleAgents requires a positive ttl", () => {
  const registry = new InMemoryRuntimeAgentRegistry();
  assert.throws(
    () => registry.detectStaleAgents({ ttlMs: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "invalid_argument");
      return true;
    },
  );
});

test("runtime agent heartbeat after expiry restores the agent to ready", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.detectStaleAgents({
    ttlMs: 1_000,
    now: "2026-04-27T00:00:10.000Z",
  });
  const restored = await registry.heartbeat({
    agentId: "agent_a",
    heartbeatAt: "2026-04-27T00:00:11.000Z",
  });
  assert.equal(restored.status, "ready");
  assert.equal(restored.expiredAt, undefined);
});

test("runtime agent enqueueWork deduplicates by idempotencyKey", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w_first", "w_second"]),
  });
  const a = await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
    idempotencyKey: "rds-primary",
  });
  const b = await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
    idempotencyKey: "rds-primary",
  });
  assert.equal(a.id, b.id);
  const all = await registry.listWork();
  assert.equal(all.length, 1);
});

test("runtime agent enqueueLongRunningOperation emits provider-prefixed kind", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w"]),
  });
  const work = await registry.enqueueLongRunningOperation({
    provider: "aws",
    descriptor: "rds.create",
    desiredStateId: "desired_1",
    targetId: "primary",
    payload: { engine: "postgres" },
    idempotencyKey: "aws-rds-primary",
  });
  assert.equal(work.kind, "provider.aws.rds.create");
  assert.equal(work.provider, "aws");
  assert.equal(work.payload.descriptor, "rds.create");
  assert.equal(work.payload.desiredStateId, "desired_1");
  assert.equal(work.payload.targetId, "primary");
  assert.equal(work.payload.engine, "postgres");
  assert.equal(work.idempotencyKey, "aws-rds-primary");
});

test("runtime agent leaseWork honours maxConcurrentLeases", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w1", "w2", "l1", "l2"]),
    defaultLeaseTtlMs: 60_000,
  });
  await registry.register({
    agentId: "agent_a",
    provider: "aws",
    capabilities: { providers: ["aws"], maxConcurrentLeases: 1 },
  });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const first = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(first);
  const second = await registry.leaseWork({ agentId: "agent_a" });
  assert.equal(second, undefined);
});

test("runtime agent register rejects host-key mismatch", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  await registry.register({
    agentId: "agent_a",
    provider: "aws",
    hostKeyDigest: "digest-a",
  });
  await assert.rejects(
    () =>
      registry.register({
        agentId: "agent_a",
        provider: "aws",
        hostKeyDigest: "digest-b",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "conflict");
      assert.equal(error.details?.agentId, "agent_a");
      return true;
    },
  );
});

test("runtime agent register accepts repeat enrollments with the same host key", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
  });
  const first = await registry.register({
    agentId: "agent_a",
    provider: "aws",
    hostKeyDigest: "digest-a",
  });
  const second = await registry.register({
    agentId: "agent_a",
    provider: "aws",
    hostKeyDigest: "digest-a",
    metadata: { region: "ap-northeast-1" },
  });
  assert.equal(second.id, first.id);
  assert.equal(second.hostKeyDigest, "digest-a");
  assert.equal(second.metadata.region, "ap-northeast-1");
});

// ---------------------------------------------------------------------------
// Phase 18 / C4 — host-key impersonation guard requeues stranded leases.
// ---------------------------------------------------------------------------
test("runtime agent register on host-key mismatch requeues every leased work item the prior agent held (C4)",
  async () => {
    const registry = new InMemoryRuntimeAgentRegistry({
      clock: fixedClock("2026-04-30T00:00:00.000Z"),
      idGenerator: sequenceIds(["w_1", "w_2", "lease_1", "lease_2"]),
      defaultLeaseTtlMs: 60_000,
    });
    const original = await registry.register({
      agentId: "agent_a",
      provider: "aws",
      hostKeyDigest: "digest-original",
    });
    assert.equal(original.hostKeyDigest, "digest-original");
    const work1 = await registry.enqueueWork({
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: { db: "primary" },
    });
    const work2 = await registry.enqueueWork({
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: { db: "replica" },
    });
    const lease1 = await registry.leaseWork({ agentId: "agent_a" });
    const lease2 = await registry.leaseWork({ agentId: "agent_a" });
    assert.ok(lease1);
    assert.ok(lease2);
    assert.equal(lease1.workId, work1.id);
    assert.equal(lease2.workId, work2.id);

    // A forged enrollment under the same agentId presents a different
    // host-key digest. The registry must:
    //   1. requeue every work item the prior agent held in `leased`,
    //   2. mark the prior agent record as `revoked`,
    //   3. throw conflict so the operator must opt-in to a credential
    //      rotation explicitly.
    let mismatchError: DomainError | undefined;
    try {
      await registry.register({
        agentId: "agent_a",
        provider: "aws",
        hostKeyDigest: "digest-forged",
      });
    } catch (error) {
      assert.ok(error instanceof DomainError);
      mismatchError = error;
    }
    assert.ok(mismatchError, "expected register to throw");
    assert.equal(mismatchError!.code, "conflict");
    assert.deepEqual(mismatchError!.details?.requeuedWorkIds, [
      work1.id,
      work2.id,
    ]);

    const requeued1 = await registry.getWork(work1.id);
    const requeued2 = await registry.getWork(work2.id);
    assert.equal(requeued1?.status, "queued");
    assert.equal(requeued1?.leasedByAgentId, undefined);
    assert.equal(requeued1?.leaseId, undefined);
    assert.equal(requeued1?.leaseExpiresAt, undefined);
    assert.equal(requeued2?.status, "queued");
    assert.equal(requeued2?.leasedByAgentId, undefined);

    const revoked = await registry.getAgent("agent_a");
    assert.equal(revoked?.status, "revoked");
    assert.ok(revoked?.revokedAt);
  },
);

test("runtime agent register awaits host-key mismatch requeue persistence before conflict",
  async () => {
    class CountingLedger extends InMemoryWorkLedger {
      applied = 0;
      override async apply(
        mutation: Parameters<InMemoryWorkLedger["apply"]>[0],
      ) {
        await Promise.resolve();
        await super.apply(mutation);
        this.applied += 1;
      }
    }
    const ledger = new CountingLedger();
    const registry = new InMemoryRuntimeAgentRegistry({
      clock: fixedClock("2026-04-30T00:00:00.000Z"),
      idGenerator: sequenceIds(["w_1", "lease_1"]),
      defaultLeaseTtlMs: 60_000,
      ledger,
    });
    await registry.register({
      agentId: "agent_a",
      provider: "aws",
      hostKeyDigest: "digest-1",
    });
    await registry.enqueueWork({
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: {},
    });
    const lease = await registry.leaseWork({ agentId: "agent_a" });
    assert.ok(lease);
    const appliedBeforeMismatch = ledger.applied;

    await assert.rejects(
      () =>
        registry.register({
          agentId: "agent_a",
          provider: "aws",
          hostKeyDigest: "digest-2",
        }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, "conflict");
        return true;
      },
    );

    assert.equal(ledger.applied, appliedBeforeMismatch + 1);
    const snapshot = await ledger.snapshot();
    assert.equal(snapshot.agents[0]?.status, "revoked");
    assert.equal(snapshot.works[0]?.status, "queued");
    assert.equal(snapshot.works[0]?.leaseId, undefined);
  },
);

test("runtime agent register supports operator-driven credential rotation (C4)",
  async () => {
    const registry = new InMemoryRuntimeAgentRegistry({
      clock: fixedClock("2026-04-30T00:00:00.000Z"),
      idGenerator: sequenceIds(["w_1", "lease_1", "lease_2"]),
      defaultLeaseTtlMs: 60_000,
    });
    await registry.register({
      agentId: "agent_a",
      provider: "aws",
      hostKeyDigest: "digest-1",
    });
    const work = await registry.enqueueWork({
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: {},
    });
    const lease = await registry.leaseWork({ agentId: "agent_a" });
    assert.ok(lease);

    // Operator restarts the agent with a fresh host key. Passing
    // `allowHostKeyRotation: true` lets the registry replay the
    // requeue-and-revoke step and then re-enroll under the new digest in
    // the same call.
    const rotated = await registry.register({
      agentId: "agent_a",
      provider: "aws",
      hostKeyDigest: "digest-2",
      allowHostKeyRotation: true,
    });
    assert.equal(rotated.status, "ready");
    assert.equal(rotated.hostKeyDigest, "digest-2");

    const requeued = await registry.getWork(work.id);
    assert.equal(requeued?.status, "queued");
    assert.equal(requeued?.attempts, 1);

    // The rotated agent can immediately lease the requeued work.
    const newLease = await registry.leaseWork({ agentId: "agent_a" });
    assert.ok(newLease);
    assert.equal(newLease.workId, work.id);
    assert.equal(newLease.work.attempts, 2);
  },
);

// ---------------------------------------------------------------------------
// Phase 18 / C5 — kernel restart resumability via the persistent work ledger.
// ---------------------------------------------------------------------------
test("runtime agent registry resumes in-flight long-running work after a kernel restart (C5)",
  async () => {
    const ledger = new InMemoryWorkLedger();
    // Phase 1: a kernel boots, an agent registers + leases a long-running
    // op, then the kernel crashes.
    {
      const registry = new InMemoryRuntimeAgentRegistry({
        clock: fixedClock("2026-04-30T00:00:00.000Z"),
        idGenerator: sequenceIds([
          "w_long",
          "lease_long",
        ]),
        defaultLeaseTtlMs: 600_000,
        ledger,
      });
      await registry.register({
        agentId: "agent_a",
        provider: "aws",
        hostKeyDigest: "digest-1",
      });
      await registry.enqueueLongRunningOperation({
        provider: "aws",
        descriptor: "rds.create",
        desiredStateId: "desired_long",
        targetId: "primary",
        payload: { engine: "postgres" },
      });
      const lease = await registry.leaseWork({
        agentId: "agent_a",
        now: "2026-04-30T00:00:00.000Z",
      });
      assert.ok(lease);
      // Halfway through, agent reports progress — the ledger captures it.
      await registry.reportProgress({
        agentId: "agent_a",
        leaseId: lease.id,
        progress: { stage: "rds.creating", percent: 35 },
        extendUntil: "2026-04-30T00:30:00.000Z",
        reportedAt: "2026-04-30T00:05:00.000Z",
      });
      // Kernel crashes here — the in-memory `registry` is dropped on the
      // floor with the work item still in `leased` state.
    }

    // Phase 2: kernel restart. A fresh registry is hydrated from the
    // ledger. The lease window is still valid (extendUntil = 00:30, now
    // = 00:10) so the work item stays `leased` and the in-flight op
    // resumes seamlessly when the agent reconnects via heartbeat.
    {
      const restored = await InMemoryRuntimeAgentRegistry.fromLedger(ledger, {
        clock: fixedClock("2026-04-30T00:10:00.000Z"),
        defaultLeaseTtlMs: 600_000,
        now: "2026-04-30T00:10:00.000Z",
      });
      const work = await restored.getWork("work_w_long");
      assert.ok(work);
      assert.equal(work.status, "leased");
      assert.equal(work.leasedByAgentId, "agent_a");
      assert.equal(work.attempts, 1);
      assert.deepEqual(work.lastProgress, {
        stage: "rds.creating",
        percent: 35,
      });

      // The agent reconnects and reports completion using the same lease.
      const completed = await restored.completeWork({
        agentId: "agent_a",
        leaseId: "lease_lease_long",
        completedAt: "2026-04-30T00:15:00.000Z",
      });
      assert.equal(completed.status, "completed");
      assert.equal(completed.completedAt, "2026-04-30T00:15:00.000Z");
    }
  },
);

test("runtime agent registry rehydration requeues stale leases on kernel boot (C5)",
  async () => {
    const ledger = new InMemoryWorkLedger();
    {
      const registry = new InMemoryRuntimeAgentRegistry({
        clock: fixedClock("2026-04-30T00:00:00.000Z"),
        idGenerator: sequenceIds(["w_stale", "lease_stale"]),
        defaultLeaseTtlMs: 30_000,
        ledger,
      });
      await registry.register({ agentId: "agent_a", provider: "aws" });
      await registry.enqueueWork({
        kind: "provider.aws.rds.create",
        provider: "aws",
        payload: {},
      });
      const lease = await registry.leaseWork({
        agentId: "agent_a",
        now: "2026-04-30T00:00:00.000Z",
      });
      assert.ok(lease);
      // Lease expires at 00:00:30. Kernel "crashes" at 00:00:10.
    }

    // Restart at 00:01:00 — the lease has elapsed, so the rehydrator
    // must reset the work item to `queued` so the next lease attempt
    // picks it up rather than letting the agent execute it twice.
    const restored = await InMemoryRuntimeAgentRegistry.fromLedger(ledger, {
      clock: fixedClock("2026-04-30T00:01:00.000Z"),
      idGenerator: sequenceIds(["lease_resumed"]),
      defaultLeaseTtlMs: 30_000,
      now: "2026-04-30T00:01:00.000Z",
    });
    const requeued = await restored.getWork("work_w_stale");
    assert.equal(requeued?.status, "queued");
    assert.equal(requeued?.leasedByAgentId, undefined);
    assert.equal(requeued?.leaseId, undefined);
    assert.equal(requeued?.leaseExpiresAt, undefined);

    // A fresh lease can pick the work up cleanly.
    const next = await restored.leaseWork({
      agentId: "agent_a",
      now: "2026-04-30T00:01:00.000Z",
    });
    assert.ok(next);
    assert.equal(next.workId, "work_w_stale");
    assert.equal(next.work.attempts, 2);
  },
);

test("runtime agent failWork records result payload", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w", "l"]),
  });
  await registry.register({ agentId: "agent_a", provider: "k8s" });
  await registry.enqueueWork({
    kind: "provider.k8s.deployment.apply",
    provider: "k8s",
    payload: {},
  });
  const lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);
  const failed = await registry.failWork({
    agentId: "agent_a",
    leaseId: lease.id,
    reason: "k8s admission webhook denied",
    result: { admission: "denied", reason: "PSP" },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureReason, "k8s admission webhook denied");
  assert.deepEqual(failed.result, { admission: "denied", reason: "PSP" });
});

test("runtime agent completeWork records result payload", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w", "l"]),
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
    result: { providerOperationId: "op_1", resourceId: "db-primary" },
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, {
    providerOperationId: "op_1",
    resourceId: "db-primary",
  });
});

test("runtime agent terminal reporter receives completed and failed work", async () => {
  const reported: string[] = [];
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w1", "l1", "w2", "l2"]),
    terminalReporter: {
      complete: (work) => {
        reported.push(`complete:${work.id}:${work.status}`);
        return Promise.resolve();
      },
      fail: (work) => {
        reported.push(`fail:${work.id}:${work.status}`);
        return Promise.resolve();
      },
    },
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  let lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);
  await registry.completeWork({ agentId: "agent_a", leaseId: lease.id });
  await registry.enqueueWork({
    kind: "provider.aws.rds.delete",
    provider: "aws",
    payload: {},
  });
  lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);
  await registry.failWork({
    agentId: "agent_a",
    leaseId: lease.id,
    reason: "provider rejected request",
  });

  assert.deepEqual(reported, [
    "complete:work_w1:completed",
    "fail:work_w2:failed",
  ]);
});

test("runtime agent leaseWork caps requested TTL", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w", "l"]),
    defaultLeaseTtlMs: 30_000,
    maxLeaseTtlMs: 120_000,
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const lease = await registry.leaseWork({
    agentId: "agent_a",
    leaseTtlMs: 60 * 60 * 1000,
  });
  assert.ok(lease);
  assert.equal(lease.expiresAt, "2026-04-27T00:02:00.000Z");
  assert.equal(lease.renewAfter, "2026-04-27T00:01:00.000Z");
});

test("runtime agent reportProgress caps lease extension", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w", "l"]),
    defaultLeaseTtlMs: 30_000,
    maxLeaseTtlMs: 120_000,
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
  });
  const lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);
  const progressed = await registry.reportProgress({
    agentId: "agent_a",
    leaseId: lease.id,
    extendUntil: "2026-04-27T01:00:00.000Z",
  });
  assert.equal(progressed.leaseExpiresAt, "2026-04-27T00:02:00.000Z");
});

test("runtime agent idempotency keys dedupe only non-terminal work", async () => {
  const registry = new InMemoryRuntimeAgentRegistry({
    clock: fixedClock("2026-04-27T00:00:00.000Z"),
    idGenerator: sequenceIds(["w1", "l1", "w2"]),
  });
  await registry.register({ agentId: "agent_a", provider: "aws" });
  const first = await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
    idempotencyKey: "rds-primary",
  });
  const lease = await registry.leaseWork({ agentId: "agent_a" });
  assert.ok(lease);
  await registry.completeWork({
    agentId: "agent_a",
    leaseId: lease.id,
  });
  const second = await registry.enqueueWork({
    kind: "provider.aws.rds.create",
    provider: "aws",
    payload: {},
    idempotencyKey: "rds-primary",
  });
  assert.notEqual(second.id, first.id);
  assert.equal((await registry.listWork()).length, 2);
});

test("concurrent leaseWork calls never double-claim the same queued candidate (G9)",
  async () => {
    // A ledger whose `apply` yields to the microtask queue before
    // committing, and that tracks whether two critical sections overlap.
    // The `#serialize` mutex must keep `leaseWork` critical sections
    // strictly non-overlapping so the candidate-select → claim window is
    // never interleaved (which would let two leases claim the same item).
    let inFlight = 0;
    let maxOverlap = 0;
    class SlowLedger extends InMemoryWorkLedger {
      override async apply(
        mutation: Parameters<InMemoryWorkLedger["apply"]>[0],
      ) {
        inFlight += 1;
        maxOverlap = Math.max(maxOverlap, inFlight);
        try {
          await Promise.resolve();
          await Promise.resolve();
          await super.apply(mutation);
        } finally {
          inFlight -= 1;
        }
      }
    }
    const ledger = new SlowLedger();
    let leaseSeq = 0;
    const registry = new InMemoryRuntimeAgentRegistry({
      clock: fixedClock("2026-04-30T00:00:00.000Z"),
      idGenerator: () => `lease_${++leaseSeq}`,
      defaultLeaseTtlMs: 600_000,
      ledger,
    });
    await registry.register({
      agentId: "agent_a",
      provider: "aws",
      // No maxConcurrentLeases cap so both leases can proceed.
    });
    await registry.enqueueWork({
      workId: "work_1",
      kind: "provider.aws.rds.create",
      provider: "aws",
      priority: 10,
      payload: {},
    });
    await registry.enqueueWork({
      workId: "work_2",
      kind: "provider.aws.rds.create",
      provider: "aws",
      priority: 5,
      payload: {},
    });

    // Fire two leaseWork calls without awaiting between them.
    const [a, b] = await Promise.all([
      registry.leaseWork({ agentId: "agent_a" }),
      registry.leaseWork({ agentId: "agent_a" }),
    ]);

    // The mutex serialized the two critical sections — their ledger
    // persists never overlapped.
    assert.equal(maxOverlap, 1);

    assert.ok(a);
    assert.ok(b);
    // Both leases must claim distinct work items — no double-claim.
    assert.notEqual(a.workId, b.workId);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(
      [a.workId, b.workId].sort(),
      ["work_1", "work_2"],
    );

    // Each work item must reflect exactly one lease id, and the in-memory
    // map must agree with the ledger.
    const work1 = await registry.getWork("work_1");
    const work2 = await registry.getWork("work_2");
    assert.equal(work1?.status, "leased");
    assert.equal(work2?.status, "leased");
    assert.equal(work1?.attempts, 1);
    assert.equal(work2?.attempts, 1);
    const snapshot = await ledger.snapshot();
    const ledgerWork1 = snapshot.works.find((w) => w.id === "work_1");
    const ledgerWork2 = snapshot.works.find((w) => w.id === "work_2");
    assert.equal(ledgerWork1?.leaseId, work1?.leaseId);
    assert.equal(ledgerWork2?.leaseId, work2?.leaseId);

    // A third lease attempt finds nothing left to claim.
    const c = await registry.leaseWork({ agentId: "agent_a" });
    assert.equal(c, undefined);
  },
);

test("register host-key revoke/requeue is serialized against concurrent leaseWork",
  async () => {
    // register()'s host-key-rotation branch requeues every leased work item
    // the prior agent held (read-then-write over #work) and then awaits the
    // ledger before re-enrolling. It must run under the same `#serialize` gate
    // as leaseWork so the two critical sections never overlap; otherwise a
    // concurrent leaseWork could observe a half-revoked state and double-claim
    // or strand work.
    let inFlight = 0;
    let maxOverlap = 0;
    class SlowLedger extends InMemoryWorkLedger {
      override async apply(
        mutation: Parameters<InMemoryWorkLedger["apply"]>[0],
      ) {
        inFlight += 1;
        maxOverlap = Math.max(maxOverlap, inFlight);
        try {
          await Promise.resolve();
          await Promise.resolve();
          await super.apply(mutation);
        } finally {
          inFlight -= 1;
        }
      }
    }
    const ledger = new SlowLedger();
    let leaseSeq = 0;
    const registry = new InMemoryRuntimeAgentRegistry({
      clock: fixedClock("2026-04-30T00:00:00.000Z"),
      idGenerator: () => `lease_${++leaseSeq}`,
      defaultLeaseTtlMs: 600_000,
      ledger,
    });
    await registry.register({
      agentId: "agent_a",
      provider: "aws",
      hostKeyDigest: "digest-1",
    });
    await registry.enqueueWork({
      workId: "work_1",
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: {},
    });

    // Fire a host-key-rotation register (which revokes + requeues) concurrently
    // with a leaseWork. The mutex must keep their ledger persists from
    // overlapping.
    const [rotated, lease] = await Promise.all([
      registry.register({
        agentId: "agent_a",
        provider: "aws",
        hostKeyDigest: "digest-2",
        allowHostKeyRotation: true,
      }),
      registry.leaseWork({ agentId: "agent_a" }),
    ]);

    assert.equal(maxOverlap, 1);
    assert.equal(rotated.status, "ready");
    assert.equal(rotated.hostKeyDigest, "digest-2");

    // Whichever order the serialized sections ran, the registry must end in a
    // consistent state: the work item is never stranded in `leased` by a
    // revoked/expired agent, and in-memory state agrees with the ledger.
    const work = await registry.getWork("work_1");
    assert.ok(work);
    const snapshot = await ledger.snapshot();
    const ledgerWork = snapshot.works.find((w) => w.id === "work_1");
    assert.equal(ledgerWork?.status, work.status);
    assert.equal(ledgerWork?.leaseId, work.leaseId);
    assert.equal(ledgerWork?.leasedByAgentId, work.leasedByAgentId);
    if (work.status === "leased") {
      assert.ok(lease);
      assert.equal(lease.workId, "work_1");
      assert.equal(work.leaseId, lease.id);
    }
  },
);

test("detectStaleAgents partial persist failure does not corrupt registry state (G9)",
  async () => {
    // Ledger that commits the first stale-agent persist, then rejects the
    // second. The persist-first ordering must keep the first agent fully
    // consistent (in-memory + ledger) and leave the second agent + its
    // leased work completely untouched.
    class FailOnSecondLedger extends InMemoryWorkLedger {
      expiredApplies = 0;
      override async apply(
        mutation: Parameters<InMemoryWorkLedger["apply"]>[0],
      ) {
        // Only the detectStaleAgents persists carry an `expired` agent.
        // Commit the first, reject the second, leaving the third agent (if
        // any) and agent_b untouched.
        if (mutation.agent?.status === "expired") {
          this.expiredApplies += 1;
          if (this.expiredApplies === 2) {
            throw new Error("ledger unavailable");
          }
        }
        await super.apply(mutation);
      }
    }
    const ledger = new FailOnSecondLedger();
    const registry = new InMemoryRuntimeAgentRegistry({
      clock: fixedClock("2026-04-30T00:10:00.000Z"),
      idGenerator: sequenceIds(["w_a", "l_a", "w_b", "l_b"]),
      defaultLeaseTtlMs: 600_000,
      ledger,
    });

    // Two agents, each registered + leasing one work item at an old time.
    await registry.register({
      agentId: "agent_a",
      provider: "aws",
      heartbeatAt: "2026-04-30T00:00:00.000Z",
    });
    await registry.enqueueWork({
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: {},
      queuedAt: "2026-04-30T00:00:00.000Z",
    });
    const leaseA = await registry.leaseWork({
      agentId: "agent_a",
      now: "2026-04-30T00:00:01.000Z",
    });
    assert.ok(leaseA);

    await registry.register({
      agentId: "agent_b",
      provider: "aws",
      heartbeatAt: "2026-04-30T00:00:00.000Z",
    });
    await registry.enqueueWork({
      kind: "provider.aws.rds.create",
      provider: "aws",
      payload: {},
      queuedAt: "2026-04-30T00:00:00.000Z",
    });
    const leaseB = await registry.leaseWork({
      agentId: "agent_b",
      now: "2026-04-30T00:00:01.000Z",
    });
    assert.ok(leaseB);

    // The second persist inside detectStaleAgents rejects.
    await assert.rejects(
      () =>
        registry.detectStaleAgents({
          ttlMs: 60_000,
          now: "2026-04-30T00:10:00.000Z",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ledger unavailable/);
        return true;
      },
    );

    // First processed agent is fully expired and its work requeued, in both
    // the in-memory map and the ledger. The second agent + its work are
    // untouched (still ready/leased) — no split-brain.
    const agents = await registry.listAgents();
    const expired = agents.filter((a) => a.status === "expired");
    const ready = agents.filter((a) => a.status === "ready");
    assert.equal(expired.length, 1);
    assert.equal(ready.length, 1);

    const works = await registry.listWork();
    const requeued = works.filter((w) => w.status === "queued");
    const stillLeased = works.filter((w) => w.status === "leased");
    assert.equal(requeued.length, 1);
    assert.equal(stillLeased.length, 1);

    // In-memory and ledger must agree for every work + agent.
    const snapshot = await ledger.snapshot();
    for (const work of works) {
      const persisted = snapshot.works.find((w) => w.id === work.id);
      assert.equal(persisted?.status, work.status);
      assert.equal(persisted?.leaseId, work.leaseId);
    }
    for (const agent of agents) {
      const persisted = snapshot.agents.find((a) => a.id === agent.id);
      assert.equal(persisted?.status, agent.status);
    }

    // The still-leased agent_b lease remains valid and usable.
    const stillLeasedAgentId = stillLeased[0]?.leasedByAgentId;
    assert.ok(stillLeasedAgentId);
    const heldByB = stillLeasedAgentId === "agent_b";
    assert.ok(heldByB);
  },
);

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
