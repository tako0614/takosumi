import assert from "node:assert/strict";
import {
  InMemoryReplayProtectionStore,
  type ReplayProtectionMarkInput,
  type ReplayProtectionStore,
  SqlReplayProtectionStore,
} from "./mod.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../storage/sql.ts";

interface ReplayLogRow extends Record<string, unknown> {
  readonly namespace: string;
  readonly request_id: string;
  readonly timestamp_ms: number;
  readonly expires_at_ms: number;
  readonly seen_at_ms: number;
}

/**
 * Minimal fake SQL backend that emulates Postgres `INSERT ... ON CONFLICT
 * DO NOTHING` and `DELETE` semantics against the
 * `internal_request_replay_log` schema. The fake intentionally exposes a
 * shared underlying store so two `SqlReplayProtectionStore` instances —
 * standing in for two PaaS replicas — can race on the same row set just
 * like real pods would race on a shared Postgres backend.
 */
class FakeSharedReplayBackend {
  readonly rows = new Map<string, ReplayLogRow>();

  client(): SqlClient {
    const rows = this.rows;
    return {
      query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: SqlParameters,
      ): Promise<SqlQueryResult<Row>> {
        const params = (parameters ?? []) as readonly unknown[];
        const trimmed = sql.trim().toLowerCase();
        if (trimmed.startsWith("insert into")) {
          const [namespace, requestId, timestampMs, expiresAtMs, seenAtMs] =
            params as [string, string, number, number, number];
          const key = `${namespace}:${requestId}`;
          if (rows.has(key)) {
            return Promise.resolve({ rows: [] as Row[], rowCount: 0 });
          }
          rows.set(key, {
            namespace,
            request_id: requestId,
            timestamp_ms: timestampMs,
            expires_at_ms: expiresAtMs,
            seen_at_ms: seenAtMs,
          });
          return Promise.resolve({ rows: [] as Row[], rowCount: 1 });
        }
        if (trimmed.startsWith("delete from")) {
          const [now] = params as [number];
          let removed = 0;
          for (const [key, row] of rows) {
            if (row.expires_at_ms <= now) {
              rows.delete(key);
              removed += 1;
            }
          }
          return Promise.resolve({ rows: [] as Row[], rowCount: removed });
        }
        throw new Error(`unexpected sql in fake replay backend: ${sql}`);
      },
    };
  }
}

const baseInput: ReplayProtectionMarkInput = {
  namespace: "internal-request",
  requestId: "req_replay_basic",
  timestamp: Date.parse("2026-04-30T00:00:00.000Z"),
  expiresAt: Date.parse("2026-04-30T00:00:05.000Z"),
  seenAt: Date.parse("2026-04-30T00:00:00.500Z"),
};

Deno.test("InMemoryReplayProtectionStore admits a fresh request once and rejects replays", async () => {
  const store: ReplayProtectionStore = new InMemoryReplayProtectionStore();
  assert.equal(await store.markSeen(baseInput), true);
  assert.equal(await store.markSeen(baseInput), false);
});

Deno.test("InMemoryReplayProtectionStore namespaces are isolated", async () => {
  const store: ReplayProtectionStore = new InMemoryReplayProtectionStore();
  assert.equal(await store.markSeen(baseInput), true);
  // Same id but different namespace must still be admitted — request and
  // response signatures are tracked independently.
  assert.equal(
    await store.markSeen({ ...baseInput, namespace: "internal-response" }),
    true,
  );
});

Deno.test("InMemoryReplayProtectionStore evicts expired entries via cleanupExpired", async () => {
  const store: ReplayProtectionStore = new InMemoryReplayProtectionStore();
  assert.equal(await store.markSeen(baseInput), true);
  // Cleanup runs at a wall-clock past the expiry — the row must drop and
  // the same id must be re-admittable as a fresh request afterwards.
  await store.cleanupExpired(baseInput.expiresAt + 1);
  assert.equal(
    await store.markSeen({
      ...baseInput,
      seenAt: baseInput.expiresAt + 2,
    }),
    true,
  );
});

Deno.test("SqlReplayProtectionStore: only one of two simulated PaaS replicas wins the race", async () => {
  const backend = new FakeSharedReplayBackend();
  const replicaA: ReplayProtectionStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const replicaB: ReplayProtectionStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const input: ReplayProtectionMarkInput = {
    ...baseInput,
    requestId: "req_replay_two_replicas",
  };

  // Replica A observes the signed request first.
  assert.equal(await replicaA.markSeen(input), true);
  // Replica B then receives the same replayed request — the shared
  // `internal_request_replay_log` row already exists, so the
  // `INSERT ... ON CONFLICT DO NOTHING` reports zero rows affected and the
  // verifier rejects the request as a replay.
  assert.equal(await replicaB.markSeen(input), false);
});

Deno.test("SqlReplayProtectionStore: concurrent markSeen calls only succeed once", async () => {
  const backend = new FakeSharedReplayBackend();
  const replicaA: ReplayProtectionStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const replicaB: ReplayProtectionStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const input: ReplayProtectionMarkInput = {
    ...baseInput,
    requestId: "req_replay_concurrent",
  };
  const [resultA, resultB] = await Promise.all([
    replicaA.markSeen(input),
    replicaB.markSeen(input),
  ]);
  // Exactly one replica's INSERT must claim the row; the other must lose
  // the race. The backend is single-threaded so the resolution order is
  // deterministic, but the observable contract is "exactly one true".
  assert.equal(Number(resultA) + Number(resultB), 1);
});

Deno.test("SqlReplayProtectionStore.cleanupExpired drops only stale rows", async () => {
  const backend = new FakeSharedReplayBackend();
  const store: ReplayProtectionStore = new SqlReplayProtectionStore({
    client: backend.client(),
  });
  const stale: ReplayProtectionMarkInput = {
    ...baseInput,
    requestId: "req_replay_stale",
    expiresAt: Date.parse("2026-04-30T00:00:01.000Z"),
  };
  const fresh: ReplayProtectionMarkInput = {
    ...baseInput,
    requestId: "req_replay_fresh",
    expiresAt: Date.parse("2026-04-30T00:00:30.000Z"),
  };
  assert.equal(await store.markSeen(stale), true);
  assert.equal(await store.markSeen(fresh), true);

  // Cleanup at t=10s must evict `stale` (expired at t=1s) but keep
  // `fresh` (expires at t=30s).
  await store.cleanupExpired(Date.parse("2026-04-30T00:00:10.000Z"));
  assert.equal(backend.rows.has(`internal-request:${stale.requestId}`), false);
  assert.equal(backend.rows.has(`internal-request:${fresh.requestId}`), true);

  // After cleanup the stale id is fresh again — a new signed request
  // reusing the same id (allowed once the signature TTL has elapsed) is
  // admitted by the replay store.
  assert.equal(
    await store.markSeen({
      ...stale,
      seenAt: Date.parse("2026-04-30T00:00:10.500Z"),
      expiresAt: Date.parse("2026-04-30T00:00:15.000Z"),
    }),
    true,
  );
});

Deno.test("SqlReplayProtectionStore honors a custom table name", async () => {
  const backend = new FakeSharedReplayBackend();
  const observed: string[] = [];
  const wrapped: SqlClient = {
    query(sql, parameters) {
      observed.push(sql);
      return backend.client().query(sql, parameters);
    },
  };
  const store: ReplayProtectionStore = new SqlReplayProtectionStore({
    client: wrapped,
    tableName: "alt_replay_log",
  });
  await store.markSeen({ ...baseInput, requestId: "req_replay_custom_table" });
  await store.cleanupExpired(baseInput.expiresAt + 1);
  assert.equal(
    observed.every((sql) => sql.includes("alt_replay_log")),
    true,
  );
});
