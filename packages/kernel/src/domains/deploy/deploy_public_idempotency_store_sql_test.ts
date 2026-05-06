import assert from "node:assert/strict";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import { SqlDeployPublicIdempotencyStore } from "./deploy_public_idempotency_store_sql.ts";

interface FakeRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  request_digest: string;
  response_status: number;
  response_body_json: unknown;
  created_at: string;
}

interface FakeLockRow {
  tenant_id: string;
  idempotency_key: string;
  owner_token: string;
  locked_until_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

class FakeSqlClient implements SqlClient {
  readonly rows: FakeRow[] = [];
  readonly locks: FakeLockRow[] = [];
  nowMs = Date.parse("2026-05-02T00:00:00.000Z");

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const params = (parameters ?? []) as readonly unknown[];
    const trimmed = sql.trim().toLowerCase();
    const cast = <T>(value: T): SqlQueryResult<Row> =>
      value as unknown as SqlQueryResult<Row>;
    if (
      trimmed.startsWith(
        "insert into takosumi_deploy_idempotency_keys",
      )
    ) {
      return Promise.resolve(cast(this.#insert(params)));
    }
    if (
      trimmed.startsWith(
        "insert into takosumi_deploy_idempotency_locks",
      )
    ) {
      return Promise.resolve(cast(this.#acquireLock(params)));
    }
    if (
      trimmed.startsWith(
        "update takosumi_deploy_idempotency_locks",
      )
    ) {
      return Promise.resolve(cast(this.#renewLock(params)));
    }
    if (
      trimmed.startsWith(
        "delete from takosumi_deploy_idempotency_locks",
      )
    ) {
      return Promise.resolve(cast(this.#releaseLock(params)));
    }
    if (
      trimmed.startsWith(
        "select id, tenant_id, idempotency_key, request_digest, response_status, response_body_json, created_at " +
          "from takosumi_deploy_idempotency_keys where tenant_id = $1 and idempotency_key = $2",
      )
    ) {
      return Promise.resolve(cast(this.#get(params)));
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  #insert(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [
      id,
      tenantId,
      key,
      requestDigest,
      responseStatus,
      responseBodyJson,
      now,
    ] = params as [string, string, string, string, number, string, string];
    const existing = this.rows.find((row) =>
      row.tenant_id === tenantId && row.idempotency_key === key
    );
    if (existing) return { rows: [], rowCount: 0 };
    const row: FakeRow = {
      id,
      tenant_id: tenantId,
      idempotency_key: key,
      request_digest: requestDigest,
      response_status: responseStatus,
      response_body_json: responseBodyJson,
      created_at: now,
    };
    this.rows.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }

  #get(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [tenantId, key] = params as [string, string];
    const row = this.rows.find((entry) =>
      entry.tenant_id === tenantId && entry.idempotency_key === key
    );
    return row
      ? { rows: [{ ...row }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  #acquireLock(params: readonly unknown[]): SqlQueryResult<{
    owner_token: string;
  }> {
    const [tenantId, key, ownerToken, leaseMs] = params as [
      string,
      string,
      string,
      number,
    ];
    const existing = this.locks.find((lock) =>
      lock.tenant_id === tenantId && lock.idempotency_key === key
    );
    if (existing) {
      if (existing.locked_until_ms > this.nowMs) {
        return { rows: [], rowCount: 0 };
      }
      existing.owner_token = ownerToken;
      existing.locked_until_ms = this.nowMs + leaseMs;
      existing.updated_at_ms = this.nowMs;
      return { rows: [{ owner_token: ownerToken }], rowCount: 1 };
    }
    this.locks.push({
      tenant_id: tenantId,
      idempotency_key: key,
      owner_token: ownerToken,
      locked_until_ms: this.nowMs + leaseMs,
      created_at_ms: this.nowMs,
      updated_at_ms: this.nowMs,
    });
    return { rows: [{ owner_token: ownerToken }], rowCount: 1 };
  }

  #renewLock(
    params: readonly unknown[],
  ): SqlQueryResult<Record<string, never>> {
    const [tenantId, key, ownerToken, leaseMs] = params as [
      string,
      string,
      string,
      number,
    ];
    const existing = this.locks.find((lock) =>
      lock.tenant_id === tenantId && lock.idempotency_key === key &&
      lock.owner_token === ownerToken
    );
    if (!existing) return { rows: [], rowCount: 0 };
    existing.locked_until_ms = this.nowMs + leaseMs;
    existing.updated_at_ms = this.nowMs;
    return { rows: [], rowCount: 1 };
  }

  #releaseLock(
    params: readonly unknown[],
  ): SqlQueryResult<Record<string, never>> {
    const [tenantId, key, ownerToken] = params as [string, string, string];
    const before = this.locks.length;
    for (let index = this.locks.length - 1; index >= 0; index--) {
      const lock = this.locks[index];
      if (
        lock.tenant_id === tenantId && lock.idempotency_key === key &&
        lock.owner_token === ownerToken
      ) {
        this.locks.splice(index, 1);
      }
    }
    return { rows: [], rowCount: before - this.locks.length };
  }
}

Deno.test("SqlDeployPublicIdempotencyStore saves and reads first response", async () => {
  const client = new FakeSqlClient();
  const store = new SqlDeployPublicIdempotencyStore({
    client,
    idFactory: () => "idem-row-1",
  });
  const saved = await store.save({
    tenantId: "tenant-1",
    key: "key-1",
    requestDigest: "sha256:abc",
    responseStatus: 200,
    responseBody: { status: "ok", outcome: { applied: [] } },
    now: "2026-05-02T00:00:00.000Z",
  });
  assert.equal(saved.id, "idem-row-1");
  assert.equal(saved.responseStatus, 200);
  assert.deepEqual(saved.responseBody, {
    status: "ok",
    outcome: { applied: [] },
  });

  const fetched = await store.get("tenant-1", "key-1");
  assert.deepEqual(fetched, saved);
});

Deno.test("SqlDeployPublicIdempotencyStore never overwrites an existing key", async () => {
  const client = new FakeSqlClient();
  let id = 0;
  const store = new SqlDeployPublicIdempotencyStore({
    client,
    idFactory: () => `idem-row-${++id}`,
  });
  const first = await store.save({
    tenantId: "tenant-1",
    key: "key-1",
    requestDigest: "sha256:first",
    responseStatus: 200,
    responseBody: { status: "ok" },
    now: "2026-05-02T00:00:00.000Z",
  });
  const second = await store.save({
    tenantId: "tenant-1",
    key: "key-1",
    requestDigest: "sha256:second",
    responseStatus: 500,
    responseBody: { status: "error" },
    now: "2026-05-02T00:00:01.000Z",
  });
  assert.deepEqual(second, first);
  assert.equal(client.rows.length, 1);
});

Deno.test(
  "SqlDeployPublicIdempotencyStore serialises concurrent acquirers on the same key",
  async () => {
    const client = new FakeSqlClient();
    const store = new SqlDeployPublicIdempotencyStore({
      client,
      lockPollMs: 1,
    });
    const order: string[] = [];

    await store.acquireLock("tenant-1", "key-1");
    order.push("first-acquired");

    let secondAcquired = false;
    const second = (async () => {
      await store.acquireLock("tenant-1", "key-1");
      order.push("second-acquired");
      secondAcquired = true;
      await store.releaseLock("tenant-1", "key-1");
    })();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(secondAcquired, false);

    await store.releaseLock("tenant-1", "key-1");
    await second;
    assert.deepEqual(order, ["first-acquired", "second-acquired"]);
    assert.equal(client.locks.length, 0);
  },
);

Deno.test(
  "SqlDeployPublicIdempotencyStore serialises same idempotency key across store instances",
  async () => {
    const client = new FakeSqlClient();
    const first = new SqlDeployPublicIdempotencyStore({
      client,
      lockPollMs: 1,
    });
    const second = new SqlDeployPublicIdempotencyStore({
      client,
      lockPollMs: 1,
    });

    await first.acquireLock("tenant-1", "key-1");
    let secondEnteredCriticalSection = false;
    const waiter = (async () => {
      await second.acquireLock("tenant-1", "key-1");
      secondEnteredCriticalSection = true;
      await second.releaseLock("tenant-1", "key-1");
    })();

    await delay(5);
    assert.equal(
      secondEnteredCriticalSection,
      false,
      "second store must wait while first store owns the SQL lease",
    );
    assert.equal(client.locks.length, 1);

    await first.releaseLock("tenant-1", "key-1");
    await waiter;
    assert.equal(secondEnteredCriticalSection, true);
    assert.equal(client.locks.length, 0);
  },
);

Deno.test(
  "SqlDeployPublicIdempotencyStore can take over an expired SQL lease",
  async () => {
    const client = new FakeSqlClient();
    const first = new SqlDeployPublicIdempotencyStore({
      client,
      lockLeaseMs: 60_000,
      lockPollMs: 1,
    });
    const second = new SqlDeployPublicIdempotencyStore({
      client,
      lockLeaseMs: 60_000,
      lockPollMs: 1,
    });

    await first.acquireLock("tenant-1", "key-1");
    client.nowMs += 60_001;
    await second.acquireLock("tenant-1", "key-1");

    assert.equal(client.locks.length, 1);
    await first.releaseLock("tenant-1", "key-1");
    assert.equal(
      client.locks.length,
      1,
      "stale holder must not delete the takeover owner's lease",
    );
    await second.releaseLock("tenant-1", "key-1");
    assert.equal(client.locks.length, 0);
  },
);

Deno.test(
  "SqlDeployPublicIdempotencyStore does not block unrelated idempotency keys",
  async () => {
    const client = new FakeSqlClient();
    const store = new SqlDeployPublicIdempotencyStore({
      client,
      lockPollMs: 1,
    });

    await store.acquireLock("tenant-1", "key-1");
    await store.acquireLock("tenant-1", "key-2");
    assert.equal(client.locks.length, 2);
    await store.releaseLock("tenant-1", "key-1");
    await store.releaseLock("tenant-1", "key-2");
    assert.equal(client.locks.length, 0);
  },
);

Deno.test(
  "SqlDeployPublicIdempotencyStore local lock keys tenant and idempotency key as a tuple",
  async () => {
    const client = new FakeSqlClient();
    const store = new SqlDeployPublicIdempotencyStore({
      client,
      lockPollMs: 1,
    });

    await store.acquireLock("tenant a", "key");
    const second = store.acquireLock("tenant", "a key");
    const acquired = await resolvesWithin(second, 20);

    assert.equal(
      acquired,
      true,
      "tuple-distinct keys must not collide in the process-local lock map",
    );
    assert.equal(client.locks.length, 2);
    await store.releaseLock("tenant", "a key");
    await store.releaseLock("tenant a", "key");
    assert.equal(client.locks.length, 0);
  },
);

Deno.test("SqlDeployPublicIdempotencyStore releaseLock is a no-op when unheld", async () => {
  const client = new FakeSqlClient();
  const store = new SqlDeployPublicIdempotencyStore({ client, lockPollMs: 1 });

  await store.releaseLock("tenant-1", "missing");
  await store.acquireLock("tenant-1", "missing");
  await store.releaseLock("tenant-1", "missing");
  assert.equal(client.locks.length, 0);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise.then(() => true), timeout]).finally(() => {
    clearTimeout(timer);
  });
}
