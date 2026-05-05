import assert from "node:assert/strict";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import { SqlRevokeDebtStore } from "./revoke_debt_store_sql.ts";

interface FakeRow extends Record<string, unknown> {
  id: string;
  source_key: string;
  generated_object_id: string;
  source_export_snapshot_id: string | null;
  external_participant_id: string | null;
  reason: string;
  status: string;
  owner_space_id: string;
  originating_space_id: string;
  deployment_name: string | null;
  operation_plan_digest: string | null;
  journal_entry_id: string | null;
  operation_id: string | null;
  resource_name: string | null;
  provider_id: string | null;
  retry_policy_json: unknown;
  retry_attempts: number;
  last_retry_at: string | null;
  next_retry_at: string | null;
  last_retry_error_json: unknown;
  detail_json: unknown;
  created_at: string;
  status_updated_at: string;
  aged_at: string | null;
  cleared_at: string | null;
}

class FakeSqlClient implements SqlClient {
  readonly rows: FakeRow[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const trimmed = sql.trim().toLowerCase();
    const params = (parameters ?? []) as readonly unknown[];
    const cast = <T>(value: T): SqlQueryResult<Row> =>
      value as unknown as SqlQueryResult<Row>;
    if (trimmed.startsWith("insert into takosumi_revoke_debts")) {
      return Promise.resolve(cast(this.#insert(params)));
    }
    if (
      trimmed.startsWith("select distinct owner_space_id") &&
      trimmed.includes("from takosumi_revoke_debts")
    ) {
      return Promise.resolve(cast(this.#listOpenOwnerSpaces()));
    }
    if (
      trimmed.includes("from takosumi_revoke_debts") &&
      trimmed.includes("where source_key = $1")
    ) {
      return Promise.resolve(cast(this.#getBySourceKey(params)));
    }
    if (
      trimmed.includes("from takosumi_revoke_debts") &&
      trimmed.includes("where owner_space_id = $1 and id = $2")
    ) {
      return Promise.resolve(cast(this.#getById(params)));
    }
    if (trimmed.startsWith("update takosumi_revoke_debts")) {
      return Promise.resolve(cast(this.#update(params)));
    }
    if (
      trimmed.includes("from takosumi_revoke_debts") &&
      trimmed.includes(
        "where owner_space_id = $1 and deployment_name = $2",
      )
    ) {
      return Promise.resolve(cast(this.#listDeployment(params)));
    }
    if (
      trimmed.includes("from takosumi_revoke_debts") &&
      trimmed.includes("where owner_space_id = $1")
    ) {
      return Promise.resolve(cast(this.#listOwner(params)));
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  #insert(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [
      id,
      sourceKey,
      generatedObjectId,
      sourceExportSnapshotId,
      externalParticipantId,
      reason,
      ownerSpaceId,
      originatingSpaceId,
      deploymentName,
      operationPlanDigest,
      journalEntryId,
      operationId,
      resourceName,
      providerId,
      retryPolicyJson,
      nextRetryAt,
      detailJson,
      createdAt,
    ] = params as [
      string,
      string,
      string,
      string | undefined,
      string | undefined,
      string,
      string,
      string,
      string | undefined,
      string | undefined,
      string | undefined,
      string | undefined,
      string | undefined,
      string | undefined,
      string,
      string,
      string | null,
      string,
    ];
    const existing = this.rows.find((row) => row.source_key === sourceKey);
    if (existing) return { rows: [], rowCount: 0 };
    const row: FakeRow = {
      id,
      source_key: sourceKey,
      generated_object_id: generatedObjectId,
      source_export_snapshot_id: sourceExportSnapshotId ?? null,
      external_participant_id: externalParticipantId ?? null,
      reason,
      status: "open",
      owner_space_id: ownerSpaceId,
      originating_space_id: originatingSpaceId,
      deployment_name: deploymentName ?? null,
      operation_plan_digest: operationPlanDigest ?? null,
      journal_entry_id: journalEntryId ?? null,
      operation_id: operationId ?? null,
      resource_name: resourceName ?? null,
      provider_id: providerId ?? null,
      retry_policy_json: retryPolicyJson,
      retry_attempts: 0,
      last_retry_at: null,
      next_retry_at: nextRetryAt,
      last_retry_error_json: null,
      detail_json: detailJson ?? null,
      created_at: createdAt,
      status_updated_at: createdAt,
      aged_at: null,
      cleared_at: null,
    };
    this.rows.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }

  #getBySourceKey(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [sourceKey] = params as [string];
    const row = this.rows.find((entry) => entry.source_key === sourceKey);
    return row
      ? { rows: [{ ...row }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  #getById(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [ownerSpaceId, id] = params as [string, string];
    const row = this.rows.find((entry) =>
      entry.owner_space_id === ownerSpaceId && entry.id === id
    );
    return row
      ? { rows: [{ ...row }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  #update(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [
      ownerSpaceId,
      id,
      status,
      retryAttempts,
      lastRetryAt,
      nextRetryAt,
      lastRetryErrorJson,
      statusUpdatedAt,
      agedAt,
      clearedAt,
    ] = params as [
      string,
      string,
      string,
      number,
      string | null,
      string | null,
      string | null,
      string,
      string | null,
      string | null,
    ];
    const row = this.rows.find((entry) =>
      entry.owner_space_id === ownerSpaceId && entry.id === id
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.status = status;
    row.retry_attempts = retryAttempts;
    row.last_retry_at = lastRetryAt;
    row.next_retry_at = nextRetryAt;
    row.last_retry_error_json = lastRetryErrorJson;
    row.status_updated_at = statusUpdatedAt;
    row.aged_at = agedAt;
    row.cleared_at = clearedAt;
    return { rows: [{ ...row }], rowCount: 1 };
  }

  #listDeployment(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [ownerSpaceId, deploymentName] = params as [string, string];
    const rows = this.rows.filter((row) =>
      row.owner_space_id === ownerSpaceId &&
      row.deployment_name === deploymentName
    );
    return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
  }

  #listOwner(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [ownerSpaceId] = params as [string];
    const rows = this.rows.filter((row) => row.owner_space_id === ownerSpaceId);
    return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
  }

  #listOpenOwnerSpaces(): SqlQueryResult<{ owner_space_id: string }> {
    const rows = Array.from(
      new Set(
        this.rows
          .filter((row) => row.status === "open")
          .map((row) => row.owner_space_id),
      ),
    ).sort().map((ownerSpaceId) => ({ owner_space_id: ownerSpaceId }));
    return { rows, rowCount: rows.length };
  }
}

Deno.test("SqlRevokeDebtStore enqueues idempotently by source key", async () => {
  const client = new FakeSqlClient();
  const store = new SqlRevokeDebtStore({
    client,
    idFactory: () => "revoke-debt:sql-one",
  });
  const input = {
    generatedObjectId: "generated:takosumi-public-deploy/sql-app/logs",
    reason: "activation-rollback" as const,
    ownerSpaceId: "space:sql",
    deploymentName: "sql-app",
    operationPlanDigest:
      "sha256:2222222222222222222222222222222222222222222222222222222222222222" as const,
    journalEntryId: "operation:one",
    operationId: "operation:one",
    resourceName: "logs",
    providerId: "@takos/selfhost-filesystem",
    now: "2026-05-02T00:00:00.000Z",
  };

  const first = await store.enqueue(input);
  const second = await store.enqueue({
    ...input,
    now: "2026-05-02T00:01:00.000Z",
  });

  assert.equal(first.id, "revoke-debt:sql-one");
  assert.equal(second.id, first.id);
  assert.equal(client.rows.length, 1);
  assert.equal(first.status, "open");
  assert.equal(first.retryPolicy.kind, "operator-managed");
  assert.equal(first.retryAttempts, 0);
  assert.equal(first.nextRetryAt, "2026-05-02T00:00:00.000Z");
  assert.equal(first.statusUpdatedAt, "2026-05-02T00:00:00.000Z");
  assert.equal(first.createdAt, "2026-05-02T00:00:00.000Z");

  const byOwner = await store.listByOwnerSpace("space:sql");
  const byDeployment = await store.listByDeployment("space:sql", "sql-app");
  assert.equal(byOwner.length, 1);
  assert.equal(byDeployment.length, 1);
  assert.equal(byDeployment[0]?.sourceKey, first.sourceKey);
  assert.deepEqual(await store.listOpenOwnerSpaces(), ["space:sql"]);
});

Deno.test("SqlRevokeDebtStore persists retry, aging, reopen, and clearance transitions", async () => {
  const client = new FakeSqlClient();
  const store = new SqlRevokeDebtStore({
    client,
    idFactory: () => "revoke-debt:sql-lifecycle",
  });
  const debt = await store.enqueue({
    generatedObjectId: "generated:takosumi-public-deploy/sql-app/cache",
    reason: "activation-rollback",
    ownerSpaceId: "space:sql-lifecycle",
    deploymentName: "sql-app",
    retryPolicy: {
      kind: "operator-managed",
      maxAttempts: 2,
      backoffSeconds: 5,
      agingWindow: "PT1M",
    },
    now: "2026-05-02T00:00:00.000Z",
  });

  const retry = await store.recordRetryAttempt({
    id: debt.id,
    ownerSpaceId: "space:sql-lifecycle",
    result: "retryable-failure",
    error: { category: "provider_unavailable" },
    now: "2026-05-02T00:00:10.000Z",
  });
  assert.equal(retry?.status, "open");
  assert.equal(retry?.retryAttempts, 1);
  assert.equal(retry?.nextRetryAt, "2026-05-02T00:00:15.000Z");
  assert.deepEqual(retry?.lastRetryError, {
    category: "provider_unavailable",
  });

  const aged = await store.ageOpenDebts({
    ownerSpaceId: "space:sql-lifecycle",
    now: "2026-05-02T00:01:00.000Z",
  });
  assert.equal(aged.length, 1);
  assert.equal(aged[0]?.status, "operator-action-required");
  assert.equal(aged[0]?.agedAt, "2026-05-02T00:01:00.000Z");

  const reopened = await store.reopen({
    id: debt.id,
    ownerSpaceId: "space:sql-lifecycle",
    now: "2026-05-02T00:02:00.000Z",
  });
  assert.equal(reopened?.status, "open");
  assert.equal(reopened?.nextRetryAt, "2026-05-02T00:02:00.000Z");

  const exhausted = await store.recordRetryAttempt({
    id: debt.id,
    ownerSpaceId: "space:sql-lifecycle",
    result: "retryable-failure",
    error: { category: "provider_rejected" },
    now: "2026-05-02T00:02:10.000Z",
  });
  assert.equal(exhausted?.status, "operator-action-required");
  assert.equal(exhausted?.retryAttempts, 2);
  assert.equal(exhausted?.nextRetryAt, undefined);

  const cleared = await store.clear({
    id: debt.id,
    ownerSpaceId: "space:sql-lifecycle",
    now: "2026-05-02T00:03:00.000Z",
  });
  assert.equal(cleared?.status, "cleared");
  assert.equal(cleared?.clearedAt, "2026-05-02T00:03:00.000Z");
  assert.deepEqual(await store.listOpenOwnerSpaces(), []);
});
