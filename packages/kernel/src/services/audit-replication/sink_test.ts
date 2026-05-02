import assert from "node:assert/strict";
import {
  AuditReplicationDriver,
  type AuditReplicationFailure,
  type AuditReplicationSink,
  InMemoryAuditReplicationSink,
  runReplicationBatch,
} from "./sink.ts";
import {
  DEFAULT_AUDIT_RETENTION_POLICY,
  resolveAuditRetention,
} from "./policy.ts";
import type { ChainedAuditEvent } from "../observability/audit_chain.ts";
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

function makeChained(
  id: string,
  sequence: number,
  occurredAt: string,
): ChainedAuditEvent {
  return {
    sequence,
    event: makeEvent(id, occurredAt),
    previousHash: "0".repeat(64),
    hash: `hash_${id}`,
  };
}

Deno.test("InMemoryAuditReplicationSink captures replicated records", async () => {
  const sink = new InMemoryAuditReplicationSink({ id: "test" });
  const result = await sink.replicate(
    makeChained("audit_1", 1, "2026-04-27T00:00:00.000Z"),
  );
  assert.equal(result.accepted, true);
  assert.equal(sink.records().length, 1);
  assert.equal(sink.records()[0]?.event.id, "audit_1");
});

Deno.test("InMemoryAuditReplicationSink dedups duplicate event ids", async () => {
  const sink = new InMemoryAuditReplicationSink();
  await sink.replicate(makeChained("audit_1", 1, "2026-04-27T00:00:00.000Z"));
  const second = await sink.replicate(
    makeChained("audit_1", 1, "2026-04-27T00:00:00.000Z"),
  );
  assert.equal(second.accepted, false);
  assert.equal(sink.records().length, 1);
});

Deno.test("runReplicationBatch falls back to sequential replicate", async () => {
  const sink: AuditReplicationSink = {
    id: "fallback",
    replicate: (record) =>
      Promise.resolve({
        id: record.event.id,
        sequence: record.sequence,
        accepted: true,
      }),
  };
  const result = await runReplicationBatch(sink, [
    makeChained("audit_1", 1, "2026-04-27T00:00:00.000Z"),
    makeChained("audit_2", 2, "2026-04-27T00:01:00.000Z"),
  ]);
  assert.equal(result.accepted, 2);
  assert.equal(result.results.length, 2);
});

Deno.test("AuditReplicationDriver isolates sink failures", async () => {
  const ok = new InMemoryAuditReplicationSink({ id: "ok" });
  const failingSink: AuditReplicationSink = {
    id: "broken",
    replicate: () => Promise.reject(new Error("downstream offline")),
  };
  const failures: AuditReplicationFailure[] = [];
  const driver = new AuditReplicationDriver({
    sinks: [ok, failingSink],
    onFailure: (failure) => failures.push(failure),
  });

  const fanout = await driver.replicate(
    makeChained("audit_1", 1, "2026-04-27T00:00:00.000Z"),
  );

  assert.equal(fanout.length, 2);
  assert.equal(fanout[0]?.ok, true);
  assert.equal(fanout[1]?.ok, false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.sink, "broken");
  assert.equal(failures[0]?.eventId, "audit_1");
  // OK sink still received the record despite the broken peer.
  assert.equal(ok.records().length, 1);
});

Deno.test("resolveAuditRetention defaults to 365d when no env supplied", () => {
  const resolved = resolveAuditRetention();
  assert.equal(resolved.regime, "default");
  assert.equal(resolved.retentionDays, 365);
  assert.equal(resolved.deleteAfterArchive, false);
  assert.equal(
    resolved.archiveGracePeriodDays,
    DEFAULT_AUDIT_RETENTION_POLICY.archiveGracePeriodDays,
  );
});

Deno.test("resolveAuditRetention applies regulated 7y band for HIPAA", () => {
  const resolved = resolveAuditRetention({
    env: { TAKOS_AUDIT_RETENTION_REGIME: "hipaa" },
  });
  assert.equal(resolved.regime, "hipaa");
  assert.equal(resolved.retentionDays, 2555);
});

Deno.test("resolveAuditRetention honors explicit override env", () => {
  const resolved = resolveAuditRetention({
    env: {
      TAKOS_AUDIT_RETENTION_REGIME: "sox",
      TAKOS_AUDIT_RETENTION_DAYS: "180",
      TAKOS_AUDIT_DELETE_AFTER_ARCHIVE: "true",
      TAKOS_AUDIT_ARCHIVE_GRACE_DAYS: "45",
    },
  });
  assert.equal(resolved.regime, "sox");
  assert.equal(resolved.retentionDays, 180);
  assert.equal(resolved.deleteAfterArchive, true);
  assert.equal(resolved.archiveGracePeriodDays, 45);
});

Deno.test("resolveAuditRetention falls back to default for unknown regime", () => {
  const resolved = resolveAuditRetention({
    env: { TAKOS_AUDIT_RETENTION_REGIME: "made-up" },
  });
  assert.equal(resolved.regime, "default");
  assert.equal(resolved.retentionDays, 365);
});

Deno.test("resolveAuditRetention rejects non-positive override and falls back to band", () => {
  const resolved = resolveAuditRetention({
    env: {
      TAKOS_AUDIT_RETENTION_REGIME: "regulated",
      TAKOS_AUDIT_RETENTION_DAYS: "-1",
    },
  });
  assert.equal(resolved.retentionDays, 2555);
});
