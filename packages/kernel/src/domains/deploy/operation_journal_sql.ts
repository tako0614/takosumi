import type { JsonObject } from "takosumi-contract";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import {
  assertReplayCompatible,
  compareJournalEntries,
  type OperationJournalAppendInput,
  operationJournalEffectDigest,
  type OperationJournalEntry,
  type OperationJournalPhase,
  type OperationJournalStage,
  type OperationJournalStatus,
  type OperationJournalStore,
} from "./operation_journal.ts";

/**
 * SQL-backed operation journal for public deploy WAL stage records. The table
 * is append-only per `(space, plan, journalEntryId, stage)` and idempotent for
 * exact effect replays; mismatching effect digests are rejected before callers
 * can advance a side-effecting stage.
 */
export class SqlOperationJournalStore implements OperationJournalStore {
  readonly #client: SqlClient;
  readonly #idFactory: () => string;

  constructor(input: {
    readonly client: SqlClient;
    readonly idFactory?: () => string;
  }) {
    this.#client = input.client;
    this.#idFactory = input.idFactory ?? (() => crypto.randomUUID());
  }

  async append(
    input: OperationJournalAppendInput,
  ): Promise<OperationJournalEntry> {
    const effectDigest = operationJournalEffectDigest(input.effect);
    const effectJson = JSON.stringify(input.effect);
    const status = input.status ?? "recorded";
    const inserted = await this.#query<OperationJournalRow>(
      "insert into takosumi_operation_journal_entries " +
        "(id, space_id, deployment_name, operation_plan_digest, journal_entry_id, operation_id, phase, stage, operation_kind, resource_name, provider_id, effect_digest, effect_json, status, created_at) " +
        "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::timestamptz) " +
        "on conflict (space_id, operation_plan_digest, journal_entry_id, stage) do nothing " +
        "returning id, space_id, deployment_name, operation_plan_digest, journal_entry_id, operation_id, phase, stage, operation_kind, resource_name, provider_id, effect_digest, effect_json, status, created_at",
      [
        this.#idFactory(),
        input.spaceId,
        input.deploymentName,
        input.operationPlanDigest,
        input.journalEntryId,
        input.operationId,
        input.phase,
        input.stage,
        input.operationKind,
        input.resourceName,
        input.providerId,
        effectDigest,
        effectJson,
        status,
        input.createdAt,
      ],
    );
    const row = inserted.rows[0];
    if (row) return rowToEntry(row);

    const existing = await this.#getStage({
      spaceId: input.spaceId,
      operationPlanDigest: input.operationPlanDigest,
      journalEntryId: input.journalEntryId,
      stage: input.stage,
    });
    if (!existing) {
      throw new Error(
        "operation journal insert conflicted but no existing row was readable",
      );
    }
    assertReplayCompatible(existing, effectDigest);
    return existing;
  }

  async listByPlan(
    spaceId: string,
    operationPlanDigest: `sha256:${string}`,
  ): Promise<readonly OperationJournalEntry[]> {
    const result = await this.#query<OperationJournalRow>(
      "select id, space_id, deployment_name, operation_plan_digest, journal_entry_id, operation_id, phase, stage, operation_kind, resource_name, provider_id, effect_digest, effect_json, status, created_at " +
        "from takosumi_operation_journal_entries where space_id = $1 and operation_plan_digest = $2 " +
        "order by created_at asc, stage asc, operation_id asc",
      [spaceId, operationPlanDigest],
    );
    return result.rows.map(rowToEntry).sort(compareJournalEntries);
  }

  async listByDeployment(
    spaceId: string,
    deploymentName: string,
  ): Promise<readonly OperationJournalEntry[]> {
    const result = await this.#query<OperationJournalRow>(
      "select id, space_id, deployment_name, operation_plan_digest, journal_entry_id, operation_id, phase, stage, operation_kind, resource_name, provider_id, effect_digest, effect_json, status, created_at " +
        "from takosumi_operation_journal_entries where space_id = $1 and deployment_name = $2 " +
        "order by created_at asc, stage asc, operation_id asc",
      [spaceId, deploymentName],
    );
    return result.rows.map(rowToEntry).sort(compareJournalEntries);
  }

  async #getStage(input: {
    readonly spaceId: string;
    readonly operationPlanDigest: string;
    readonly journalEntryId: string;
    readonly stage: OperationJournalStage;
  }): Promise<OperationJournalEntry | undefined> {
    const result = await this.#query<OperationJournalRow>(
      "select id, space_id, deployment_name, operation_plan_digest, journal_entry_id, operation_id, phase, stage, operation_kind, resource_name, provider_id, effect_digest, effect_json, status, created_at " +
        "from takosumi_operation_journal_entries " +
        "where space_id = $1 and operation_plan_digest = $2 and journal_entry_id = $3 and stage = $4",
      [
        input.spaceId,
        input.operationPlanDigest,
        input.journalEntryId,
        input.stage,
      ],
    );
    const row = result.rows[0];
    return row ? rowToEntry(row) : undefined;
  }

  #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.#client.query<Row>(sql, parameters);
  }
}

interface OperationJournalRow extends Record<string, unknown> {
  readonly id: string;
  readonly space_id: string;
  readonly deployment_name: string | null;
  readonly operation_plan_digest: string;
  readonly journal_entry_id: string;
  readonly operation_id: string;
  readonly phase: string;
  readonly stage: string;
  readonly operation_kind: string;
  readonly resource_name: string | null;
  readonly provider_id: string | null;
  readonly effect_digest: string;
  readonly effect_json: unknown;
  readonly status: string;
  readonly created_at: string | Date;
}

function rowToEntry(row: OperationJournalRow): OperationJournalEntry {
  return {
    id: row.id,
    spaceId: row.space_id,
    ...(row.deployment_name ? { deploymentName: row.deployment_name } : {}),
    operationPlanDigest: row.operation_plan_digest as `sha256:${string}`,
    journalEntryId: row.journal_entry_id,
    operationId: row.operation_id,
    phase: row.phase as OperationJournalPhase,
    stage: row.stage as OperationJournalStage,
    operationKind: row.operation_kind,
    ...(row.resource_name ? { resourceName: row.resource_name } : {}),
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    effectDigest: row.effect_digest as `sha256:${string}`,
    effect: parseJson(row.effect_json) as JsonObject,
    status: row.status as OperationJournalStatus,
    createdAt: toIsoString(row.created_at),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const trimmed = value.trim();
  if (trimmed.includes(" ") && !trimmed.includes("T")) {
    return new Date(trimmed.replace(" ", "T")).toISOString();
  }
  return trimmed;
}
