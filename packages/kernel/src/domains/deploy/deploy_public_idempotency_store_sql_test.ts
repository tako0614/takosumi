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

class FakeSqlClient implements SqlClient {
  readonly rows: FakeRow[] = [];

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
