import assert from "node:assert/strict";
import {
  AuditReplicationConfigurationError,
  CompositeExternalReplicationSink,
  type S3ImmutableLogPort,
  S3ImmutableLogReplicationSink,
  selectAuditExternalReplicationSink,
  StdoutReplicationSink,
  verifyAuditReplicationConsistency,
} from "./external_log.ts";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  chainAuditEvent,
  type ChainedAuditEvent,
} from "../observability/audit_chain.ts";
import type { AuditEvent } from "../../domains/audit/types.ts";

function makeEvent(id: string, occurredAt: string): AuditEvent {
  return {
    id,
    eventClass: "security",
    type: "worker.authz",
    severity: "info",
    actor: {
      actorAccountId: "acct_1",
      roles: ["owner"],
      requestId: `req_${id}`,
    },
    spaceId: "space_a",
    groupId: "group_a",
    targetType: "worker",
    targetId: "worker_a",
    payload: { action: "allow" },
    occurredAt,
  };
}

async function buildChain(count: number): Promise<ChainedAuditEvent[]> {
  const records: ChainedAuditEvent[] = [];
  let previous: ChainedAuditEvent | undefined;
  for (let i = 1; i <= count; i++) {
    const event = makeEvent(
      `audit_${i}`,
      new Date(Date.UTC(2026, 3, 27, 0, i, 0)).toISOString(),
    );
    const next = await chainAuditEvent(event, previous);
    records.push(next);
    previous = next;
  }
  return records;
}

class FakeS3Port implements S3ImmutableLogPort {
  readonly objects = new Map<string, { body: string; lockedUntil: string }>();

  putObject(input: {
    bucket: string;
    key: string;
    body: string;
    contentType: "application/json";
    objectLockMode: "GOVERNANCE" | "COMPLIANCE";
    objectLockRetainUntilDate: string;
  }): Promise<void> {
    const fullKey = `${input.bucket}/${input.key}`;
    if (this.objects.has(fullKey)) {
      // S3 versioning would create a new version; under Object Lock the
      // previous version is retained immutably. Simulate this by refusing
      // overwrite for the test (proving idempotency of the sink).
      return Promise.resolve();
    }
    this.objects.set(fullKey, {
      body: input.body,
      lockedUntil: input.objectLockRetainUntilDate,
    });
    return Promise.resolve();
  }

  listObjects(input: {
    bucket: string;
    prefix: string;
  }): Promise<readonly string[]> {
    const prefix = `${input.bucket}/${input.prefix}`;
    const matches = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(input.bucket.length + 1));
    return Promise.resolve(matches);
  }

  getObject(input: { bucket: string; key: string }): Promise<string> {
    const fullKey = `${input.bucket}/${input.key}`;
    const entry = this.objects.get(fullKey);
    if (!entry) throw new Error(`missing ${fullKey}`);
    return Promise.resolve(entry.body);
  }
}

Deno.test("StdoutReplicationSink captures records and is idempotent", async () => {
  const lines: string[] = [];
  const sink = new StdoutReplicationSink({ write: (line) => lines.push(line) });
  const chain = await buildChain(3);
  for (const record of chain) await sink.replicate(record);
  // Replay the first record - sink must dedupe.
  await sink.replicate(chain[0]);
  const replayed = await sink.readChain();
  assert.equal(replayed.length, 3);
  assert.equal(lines.length, 3);
  assert.deepEqual(replayed.map((r) => r.sequence), [1, 2, 3]);
});

Deno.test("S3ImmutableLogReplicationSink writes objects with Object Lock", async () => {
  const port = new FakeS3Port();
  const fixed = new Date("2026-05-01T00:00:00.000Z");
  const sink = new S3ImmutableLogReplicationSink({
    port,
    bucket: "audit-bucket",
    prefix: "chain",
    retentionMode: "COMPLIANCE",
    retentionDays: 30,
    clock: () => fixed,
  });
  const chain = await buildChain(2);
  for (const record of chain) await sink.replicate(record);

  // Two objects, lexically sorted by sequence.
  const keys = [...port.objects.keys()].sort();
  assert.equal(keys.length, 2);
  assert.match(keys[0], /chain\/0000000001-/);
  assert.match(keys[1], /chain\/0000000002-/);
  const first = port.objects.get(keys[0])!;
  assert.equal(
    first.lockedUntil,
    new Date(fixed.getTime() + 30 * 86_400_000).toISOString(),
  );

  const replayed = await sink.readChain();
  assert.equal(replayed.length, 2);
  assert.equal(replayed[0].sequence, 1);
  assert.equal(replayed[0].hash, chain[0].hash);
});

Deno.test("verifyAuditReplicationConsistency detects DB tampering against external replica", async () => {
  const chain = await buildChain(3);
  const tampered: ChainedAuditEvent[] = chain.map((r, i) =>
    i === 1
      ? {
        ...r,
        // operator silently rewrote the hash in the DB
        hash: "x".repeat(64),
      }
      : r
  );
  const result = await verifyAuditReplicationConsistency(tampered, chain);
  assert.equal(result.ok, false);
  // The primary chain itself is internally inconsistent (sequence 2's hash
  // no longer matches its event), so we expect the primary-chain-invalid
  // signal to fire first - that's the correct tamper detection signal.
  assert.equal(result.reason, "primary-chain-invalid");
});

Deno.test("verifyAuditReplicationConsistency detects deleted DB rows present in immutable replica", async () => {
  const chain = await buildChain(3);
  const truncated = [chain[0], chain[1]];
  const result = await verifyAuditReplicationConsistency(truncated, chain);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "primary-shorter-than-external");
  assert.equal(result.primaryCount, 2);
  assert.equal(result.externalCount, 3);
});

Deno.test("verifyAuditReplicationConsistency tolerates primary ahead of replica (catch-up)", async () => {
  const chain = await buildChain(3);
  // External replica only has the first two; primary already wrote the third.
  const result = await verifyAuditReplicationConsistency(
    chain,
    chain.slice(0, 2),
  );
  assert.equal(result.ok, true);
  assert.equal(result.primaryCount, 3);
  assert.equal(result.externalCount, 2);
});

Deno.test("verifyAuditReplicationConsistency reports hash mismatch when external and primary disagree at same sequence", async () => {
  const chain = await buildChain(3);
  // Build a parallel chain where event 2 has a different occurredAt so its
  // hash differs but the previous-hash structure is internally valid.
  const other: ChainedAuditEvent[] = [];
  let prev: ChainedAuditEvent | undefined;
  for (let i = 1; i <= 3; i++) {
    const event = makeEvent(
      `audit_${i}`,
      new Date(Date.UTC(2026, 3, 28, 0, i, 0)).toISOString(),
    );
    const next = await chainAuditEvent(event, prev);
    other.push(next);
    prev = next;
  }
  const result = await verifyAuditReplicationConsistency(chain, other);
  assert.equal(result.ok, false);
  // Both chains are internally valid SHA chains, so the divergence shows up
  // as a per-sequence hash mismatch.
  assert.equal(result.reason, "hash-mismatch");
  assert.equal(result.mismatchAtSequence, 1);
});

Deno.test("CompositeExternalReplicationSink fans out and uses first sink as canonical readChain", async () => {
  const a = new StdoutReplicationSink({ write: () => {} });
  const b = new StdoutReplicationSink({ write: () => {} });
  const composite = new CompositeExternalReplicationSink([a, b]);
  const chain = await buildChain(2);
  for (const record of chain) await composite.replicate(record);
  assert.equal((await a.readChain()).length, 2);
  assert.equal((await b.readChain()).length, 2);
  // composite delegates readChain to first sink
  assert.equal((await composite.readChain()).length, 2);
});

Deno.test("selectAuditExternalReplicationSink fails closed in production without configuration", () => {
  assert.throws(
    () =>
      selectAuditExternalReplicationSink({
        env: { TAKOS_ENVIRONMENT: "production" },
      }),
    AuditReplicationConfigurationError,
  );
  assert.throws(
    () =>
      selectAuditExternalReplicationSink({
        env: { TAKOS_ENVIRONMENT: "staging" },
      }),
    AuditReplicationConfigurationError,
  );
});

Deno.test("selectAuditExternalReplicationSink returns undefined locally without config", () => {
  const sink = selectAuditExternalReplicationSink({
    env: { TAKOS_ENVIRONMENT: "local" },
  });
  assert.equal(sink, undefined);
});

Deno.test("selectAuditExternalReplicationSink builds stdout sink from env", () => {
  const sink = selectAuditExternalReplicationSink({
    env: {
      TAKOS_ENVIRONMENT: "production",
      TAKOS_AUDIT_REPLICATION_KIND: "stdout",
    },
  });
  assert.ok(sink instanceof StdoutReplicationSink);
});

Deno.test("selectAuditExternalReplicationSink builds s3 sink with bucket + port", () => {
  const port = new FakeS3Port();
  const sink = selectAuditExternalReplicationSink({
    env: {
      TAKOS_ENVIRONMENT: "production",
      TAKOS_AUDIT_REPLICATION_KIND: "s3",
      TAKOS_AUDIT_REPLICATION_S3_BUCKET: "audit-bucket",
      TAKOS_AUDIT_REPLICATION_S3_PREFIX: "chain",
      TAKOS_AUDIT_REPLICATION_S3_RETENTION_MODE: "compliance",
      TAKOS_AUDIT_REPLICATION_S3_RETENTION_DAYS: "365",
    },
    s3Port: port,
  });
  assert.ok(sink instanceof S3ImmutableLogReplicationSink);
});

Deno.test("selectAuditExternalReplicationSink rejects s3 without bucket or port", () => {
  assert.throws(
    () =>
      selectAuditExternalReplicationSink({
        env: {
          TAKOS_ENVIRONMENT: "production",
          TAKOS_AUDIT_REPLICATION_KIND: "s3",
        },
      }),
    AuditReplicationConfigurationError,
  );
  assert.throws(
    () =>
      selectAuditExternalReplicationSink({
        env: {
          TAKOS_ENVIRONMENT: "production",
          TAKOS_AUDIT_REPLICATION_KIND: "s3",
          TAKOS_AUDIT_REPLICATION_S3_BUCKET: "audit-bucket",
        },
      }),
    AuditReplicationConfigurationError,
  );
});

Deno.test("StdoutReplicationSink readChain after random replicate order returns sorted chain", async () => {
  const sink = new StdoutReplicationSink({ write: () => {} });
  const chain = await buildChain(4);
  // Replay out of order.
  await sink.replicate(chain[2]);
  await sink.replicate(chain[0]);
  await sink.replicate(chain[3]);
  await sink.replicate(chain[1]);
  const replayed = await sink.readChain();
  assert.deepEqual(replayed.map((r) => r.sequence), [1, 2, 3, 4]);
});

Deno.test("verifyAuditReplicationConsistency accepts empty chains", async () => {
  const result = await verifyAuditReplicationConsistency([], []);
  assert.equal(result.ok, true);
  assert.equal(result.primaryCount, 0);
  assert.equal(result.externalCount, 0);
});

Deno.test("verifyAuditReplicationConsistency rejects empty primary with non-empty external", async () => {
  const chain = await buildChain(2);
  const result = await verifyAuditReplicationConsistency([], chain);
  assert.equal(result.ok, false);
  // empty primary against non-empty external is the canonical "DBA wiped
  // audit_events" case: primary < external, surfaced as primary-shorter-than-external.
  assert.equal(result.reason, "primary-shorter-than-external");
});

Deno.test("verifyAuditReplicationConsistency flags non-empty primary with empty external as configuration error", async () => {
  const chain = await buildChain(2);
  const result = await verifyAuditReplicationConsistency(chain, []);
  // An empty external replica with a non-empty primary means replication
  // never ran (or was wiped); the operator must investigate before trusting
  // the primary chain alone.
  assert.equal(result.ok, false);
  assert.equal(result.reason, "external-empty-but-primary-not");
});

Deno.test("S3ImmutableLogReplicationSink keys lexically sort identical to sequence order", async () => {
  const port = new FakeS3Port();
  const fixed = new Date("2026-05-01T00:00:00.000Z");
  const sink = new S3ImmutableLogReplicationSink({
    port,
    bucket: "b",
    clock: () => fixed,
  });
  // Build 12 events to verify zero-padding sorts past sequence 9 -> 10.
  const chain: ChainedAuditEvent[] = [];
  let prev: ChainedAuditEvent | undefined;
  for (let i = 1; i <= 12; i++) {
    const next = await chainAuditEvent(
      makeEvent(
        `audit_${i}`,
        `2026-04-27T00:${String(i).padStart(2, "0")}:00.000Z`,
      ),
      prev,
    );
    chain.push(next);
    prev = next;
  }
  for (const record of chain) await sink.replicate(record);
  const replayed = await sink.readChain();
  assert.deepEqual(replayed.map((r) => r.sequence), [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
  ]);
  assert.equal(replayed[0].previousHash, AUDIT_CHAIN_GENESIS_HASH);
});
