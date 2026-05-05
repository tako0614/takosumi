import assert from "node:assert/strict";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import { OperationJournalReplayMismatchError } from "./operation_journal.ts";
import { SqlOperationJournalStore } from "./operation_journal_sql.ts";

interface FakeRow extends Record<string, unknown> {
  id: string;
  space_id: string;
  deployment_name: string | null;
  operation_plan_digest: string;
  journal_entry_id: string;
  operation_id: string;
  phase: string;
  stage: string;
  operation_kind: string;
  resource_name: string | null;
  provider_id: string | null;
  effect_digest: string;
  effect_json: unknown;
  status: string;
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
    if (trimmed.startsWith("insert into takosumi_operation_journal_entries")) {
      return Promise.resolve(cast(this.#insert(params)));
    }
    if (
      trimmed.includes("from takosumi_operation_journal_entries") &&
      trimmed.includes(
        "where space_id = $1 and operation_plan_digest = $2 and journal_entry_id = $3 and stage = $4",
      )
    ) {
      return Promise.resolve(cast(this.#getStage(params)));
    }
    if (
      trimmed.includes("from takosumi_operation_journal_entries") &&
      trimmed.includes("where space_id = $1 and operation_plan_digest = $2")
    ) {
      return Promise.resolve(cast(this.#listPlan(params)));
    }
    if (
      trimmed.includes("from takosumi_operation_journal_entries") &&
      trimmed.includes("where space_id = $1 and deployment_name = $2")
    ) {
      return Promise.resolve(cast(this.#listDeployment(params)));
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  #insert(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [
      id,
      spaceId,
      deploymentName,
      operationPlanDigest,
      journalEntryId,
      operationId,
      phase,
      stage,
      operationKind,
      resourceName,
      providerId,
      effectDigest,
      effectJson,
      status,
      createdAt,
    ] = params as [
      string,
      string,
      string | undefined,
      string,
      string,
      string,
      string,
      string,
      string,
      string | undefined,
      string | undefined,
      string,
      string,
      string,
      string,
    ];
    const existing = this.rows.find((row) =>
      row.space_id === spaceId &&
      row.operation_plan_digest === operationPlanDigest &&
      row.journal_entry_id === journalEntryId &&
      row.stage === stage
    );
    if (existing) return { rows: [], rowCount: 0 };
    const row: FakeRow = {
      id,
      space_id: spaceId,
      deployment_name: deploymentName ?? null,
      operation_plan_digest: operationPlanDigest,
      journal_entry_id: journalEntryId,
      operation_id: operationId,
      phase,
      stage,
      operation_kind: operationKind,
      resource_name: resourceName ?? null,
      provider_id: providerId ?? null,
      effect_digest: effectDigest,
      effect_json: effectJson,
      status,
      created_at: createdAt,
    };
    this.rows.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }

  #getStage(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [spaceId, operationPlanDigest, journalEntryId, stage] = params as [
      string,
      string,
      string,
      string,
    ];
    const row = this.rows.find((entry) =>
      entry.space_id === spaceId &&
      entry.operation_plan_digest === operationPlanDigest &&
      entry.journal_entry_id === journalEntryId &&
      entry.stage === stage
    );
    return row
      ? { rows: [{ ...row }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  #listPlan(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [spaceId, operationPlanDigest] = params as [string, string];
    return {
      rows: this.rows
        .filter((row) =>
          row.space_id === spaceId &&
          row.operation_plan_digest === operationPlanDigest
        )
        .map((row) => ({ ...row })),
      rowCount: this.rows.length,
    };
  }

  #listDeployment(params: readonly unknown[]): SqlQueryResult<FakeRow> {
    const [spaceId, deploymentName] = params as [string, string];
    const rows = this.rows
      .filter((row) =>
        row.space_id === spaceId && row.deployment_name === deploymentName
      )
      .map((row) => ({ ...row }));
    return { rows, rowCount: rows.length };
  }
}

Deno.test("SqlOperationJournalStore appends and replays the same stage", async () => {
  const client = new FakeSqlClient();
  const store = new SqlOperationJournalStore({
    client,
    idFactory: () => "journal-row-1",
  });
  const input = {
    spaceId: "space:sql",
    deploymentName: "sql-app",
    operationPlanDigest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const,
    journalEntryId: "operation:one",
    operationId: "operation:one",
    phase: "apply" as const,
    stage: "prepare" as const,
    operationKind: "create",
    resourceName: "logs",
    providerId: "@takos/selfhost-filesystem",
    effect: { expected: "first" },
    createdAt: "2026-05-02T00:00:00.000Z",
  };
  const first = await store.append(input);
  const replay = await store.append(input);

  assert.deepEqual(replay, first);
  assert.equal(client.rows.length, 1);
  const listed = await store.listByPlan(
    input.spaceId,
    input.operationPlanDigest,
  );
  assert.deepEqual(listed, [first]);
  assert.deepEqual(
    await store.listByDeployment(input.spaceId, "sql-app"),
    [first],
  );
});

Deno.test("SqlOperationJournalStore rejects replay effect mismatch", async () => {
  const client = new FakeSqlClient();
  const store = new SqlOperationJournalStore({
    client,
    idFactory: () => "journal-row-1",
  });
  const input = {
    spaceId: "space:sql",
    operationPlanDigest:
      "sha256:2222222222222222222222222222222222222222222222222222222222222222" as const,
    journalEntryId: "operation:one",
    operationId: "operation:one",
    phase: "apply" as const,
    stage: "prepare" as const,
    operationKind: "create",
    effect: { expected: "first" },
    createdAt: "2026-05-02T00:00:00.000Z",
  };

  await store.append(input);
  await assert.rejects(
    () => store.append({ ...input, effect: { expected: "second" } }),
    OperationJournalReplayMismatchError,
  );
});
