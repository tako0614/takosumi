import type { JsonObject } from "takosumi-contract";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import {
  ageRevokeDebtIfDue,
  clearRevokeDebt,
  compareRevokeDebtRecords,
  defaultRetryPolicy,
  markRevokeDebtOperatorActionRequired,
  recordRevokeDebtRetryAttempt,
  reopenRevokeDebt,
  type RevokeDebtAgeOpenInput,
  type RevokeDebtEnqueueInput,
  type RevokeDebtReason,
  type RevokeDebtRecord,
  type RevokeDebtRetryAttemptInput,
  revokeDebtSourceKey,
  type RevokeDebtStatus,
  type RevokeDebtStore,
  type RevokeDebtTransitionInput,
} from "./revoke_debt_store.ts";

export class SqlRevokeDebtStore implements RevokeDebtStore {
  readonly #client: SqlClient;
  readonly #idFactory: () => string;

  constructor(input: {
    readonly client: SqlClient;
    readonly idFactory?: () => string;
  }) {
    this.#client = input.client;
    this.#idFactory = input.idFactory ??
      (() => `revoke-debt:${crypto.randomUUID()}`);
  }

  async enqueue(
    input: RevokeDebtEnqueueInput,
  ): Promise<RevokeDebtRecord> {
    const sourceKey = revokeDebtSourceKey(input);
    const retryPolicy = input.retryPolicy ?? defaultRetryPolicy();
    const inserted = await this.#query<RevokeDebtRow>(
      "insert into takosumi_revoke_debts " +
        "(id, source_key, generated_object_id, source_export_snapshot_id, external_participant_id, reason, status, owner_space_id, originating_space_id, deployment_name, operation_plan_digest, journal_entry_id, operation_id, resource_name, provider_id, retry_policy_json, retry_attempts, last_retry_at, next_retry_at, last_retry_error_json, detail_json, created_at, status_updated_at, aged_at, cleared_at) " +
        "values ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, 0, null, $16::timestamptz, null, $17::jsonb, $18::timestamptz, $18::timestamptz, null, null) " +
        "on conflict (source_key) do nothing " +
        RETURNING_COLUMNS,
      [
        this.#idFactory(),
        sourceKey,
        input.generatedObjectId,
        input.sourceExportSnapshotId ?? null,
        input.externalParticipantId ?? null,
        input.reason,
        input.ownerSpaceId,
        input.originatingSpaceId ?? input.ownerSpaceId,
        input.deploymentName ?? null,
        input.operationPlanDigest ?? null,
        input.journalEntryId ?? null,
        input.operationId ?? null,
        input.resourceName ?? null,
        input.providerId ?? null,
        JSON.stringify(retryPolicy),
        input.now,
        input.detail ? JSON.stringify(input.detail) : null,
        input.now,
      ],
    );
    const row = inserted.rows[0];
    if (row) return rowToRecord(row);

    const existing = await this.#getBySourceKey(sourceKey);
    if (!existing) {
      throw new Error("revoke debt insert conflicted but no row was readable");
    }
    return existing;
  }

  async listByOwnerSpace(
    ownerSpaceId: string,
  ): Promise<readonly RevokeDebtRecord[]> {
    const result = await this.#query<RevokeDebtRow>(
      SELECT_COLUMNS +
        " from takosumi_revoke_debts where owner_space_id = $1 " +
        "order by created_at asc, id asc",
      [ownerSpaceId],
    );
    return result.rows.map(rowToRecord).sort(compareRevokeDebtRecords);
  }

  async listByDeployment(
    ownerSpaceId: string,
    deploymentName: string,
  ): Promise<readonly RevokeDebtRecord[]> {
    const result = await this.#query<RevokeDebtRow>(
      SELECT_COLUMNS +
        " from takosumi_revoke_debts where owner_space_id = $1 and deployment_name = $2 " +
        "order by created_at asc, id asc",
      [ownerSpaceId, deploymentName],
    );
    return result.rows.map(rowToRecord).sort(compareRevokeDebtRecords);
  }

  async listOpenOwnerSpaces(): Promise<readonly string[]> {
    const result = await this.#query<OwnerSpaceRow>(
      "select distinct owner_space_id from takosumi_revoke_debts " +
        "where status = 'open' order by owner_space_id asc",
    );
    return result.rows.map((row) => row.owner_space_id).sort();
  }

  async recordRetryAttempt(
    input: RevokeDebtRetryAttemptInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getById(input.ownerSpaceId, input.id);
    if (!existing) return undefined;
    const next = recordRevokeDebtRetryAttempt(existing, input);
    if (next === existing) return existing;
    return await this.#updateMutable(next);
  }

  async ageOpenDebts(
    input: RevokeDebtAgeOpenInput,
  ): Promise<readonly RevokeDebtRecord[]> {
    const result = await this.#query<RevokeDebtRow>(
      SELECT_COLUMNS +
        " from takosumi_revoke_debts where owner_space_id = $1 and status = 'open' " +
        "order by created_at asc, id asc",
      [input.ownerSpaceId],
    );
    const aged: RevokeDebtRecord[] = [];
    for (const row of result.rows) {
      if (input.limit !== undefined && aged.length >= input.limit) break;
      const record = rowToRecord(row);
      const next = ageRevokeDebtIfDue(record, input.now);
      if (!next) continue;
      aged.push(await this.#updateMutable(next));
    }
    return aged.sort(compareRevokeDebtRecords);
  }

  async markOperatorActionRequired(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getById(input.ownerSpaceId, input.id);
    if (!existing) return undefined;
    const next = markRevokeDebtOperatorActionRequired(existing, input.now);
    if (next === existing) return existing;
    return await this.#updateMutable(next);
  }

  async reopen(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getById(input.ownerSpaceId, input.id);
    if (!existing) return undefined;
    const next = reopenRevokeDebt(existing, input.now);
    if (next === existing) return existing;
    return await this.#updateMutable(next);
  }

  async clear(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getById(input.ownerSpaceId, input.id);
    if (!existing) return undefined;
    const next = clearRevokeDebt(existing, input.now);
    if (next === existing) return existing;
    return await this.#updateMutable(next);
  }

  async #getBySourceKey(
    sourceKey: `sha256:${string}`,
  ): Promise<RevokeDebtRecord | undefined> {
    const result = await this.#query<RevokeDebtRow>(
      SELECT_COLUMNS + " from takosumi_revoke_debts where source_key = $1",
      [sourceKey],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async #getById(
    ownerSpaceId: string,
    id: string,
  ): Promise<RevokeDebtRecord | undefined> {
    const result = await this.#query<RevokeDebtRow>(
      SELECT_COLUMNS +
        " from takosumi_revoke_debts where owner_space_id = $1 and id = $2",
      [ownerSpaceId, id],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async #updateMutable(
    record: RevokeDebtRecord,
  ): Promise<RevokeDebtRecord> {
    const result = await this.#query<RevokeDebtRow>(
      "update takosumi_revoke_debts set " +
        "status = $3, retry_attempts = $4, last_retry_at = $5::timestamptz, next_retry_at = $6::timestamptz, last_retry_error_json = $7::jsonb, status_updated_at = $8::timestamptz, aged_at = $9::timestamptz, cleared_at = $10::timestamptz " +
        "where owner_space_id = $1 and id = $2 " +
        RETURNING_COLUMNS,
      [
        record.ownerSpaceId,
        record.id,
        record.status,
        record.retryAttempts,
        record.lastRetryAt ?? null,
        record.nextRetryAt ?? null,
        record.lastRetryError ? JSON.stringify(record.lastRetryError) : null,
        record.statusUpdatedAt,
        record.agedAt ?? null,
        record.clearedAt ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `revoke debt row disappeared during update: ${record.id}`,
      );
    }
    return rowToRecord(row);
  }

  #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.#client.query<Row>(sql, parameters);
  }
}

const SELECT_COLUMNS =
  "select id, source_key, generated_object_id, source_export_snapshot_id, external_participant_id, reason, status, owner_space_id, originating_space_id, deployment_name, operation_plan_digest, journal_entry_id, operation_id, resource_name, provider_id, retry_policy_json, retry_attempts, last_retry_at, next_retry_at, last_retry_error_json, detail_json, created_at, status_updated_at, aged_at, cleared_at";
const RETURNING_COLUMNS =
  "returning id, source_key, generated_object_id, source_export_snapshot_id, external_participant_id, reason, status, owner_space_id, originating_space_id, deployment_name, operation_plan_digest, journal_entry_id, operation_id, resource_name, provider_id, retry_policy_json, retry_attempts, last_retry_at, next_retry_at, last_retry_error_json, detail_json, created_at, status_updated_at, aged_at, cleared_at";

interface RevokeDebtRow extends Record<string, unknown> {
  readonly id: string;
  readonly source_key: string;
  readonly generated_object_id: string;
  readonly source_export_snapshot_id: string | null;
  readonly external_participant_id: string | null;
  readonly reason: string;
  readonly status: string;
  readonly owner_space_id: string;
  readonly originating_space_id: string;
  readonly deployment_name: string | null;
  readonly operation_plan_digest: string | null;
  readonly journal_entry_id: string | null;
  readonly operation_id: string | null;
  readonly resource_name: string | null;
  readonly provider_id: string | null;
  readonly retry_policy_json: unknown;
  readonly retry_attempts: number;
  readonly last_retry_at: string | Date | null;
  readonly next_retry_at: string | Date | null;
  readonly last_retry_error_json: unknown;
  readonly detail_json: unknown;
  readonly created_at: string | Date;
  readonly status_updated_at: string | Date;
  readonly aged_at: string | Date | null;
  readonly cleared_at: string | Date | null;
}

interface OwnerSpaceRow extends Record<string, unknown> {
  readonly owner_space_id: string;
}

function rowToRecord(row: RevokeDebtRow): RevokeDebtRecord {
  return {
    id: row.id,
    sourceKey: row.source_key as `sha256:${string}`,
    generatedObjectId: row.generated_object_id,
    ...(row.source_export_snapshot_id
      ? { sourceExportSnapshotId: row.source_export_snapshot_id }
      : {}),
    ...(row.external_participant_id
      ? { externalParticipantId: row.external_participant_id }
      : {}),
    reason: row.reason as RevokeDebtReason,
    status: row.status as RevokeDebtStatus,
    ownerSpaceId: row.owner_space_id,
    originatingSpaceId: row.originating_space_id,
    ...(row.deployment_name ? { deploymentName: row.deployment_name } : {}),
    ...(row.operation_plan_digest
      ? { operationPlanDigest: row.operation_plan_digest as `sha256:${string}` }
      : {}),
    ...(row.journal_entry_id ? { journalEntryId: row.journal_entry_id } : {}),
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
    ...(row.resource_name ? { resourceName: row.resource_name } : {}),
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    retryPolicy: parseJson(row.retry_policy_json) as JsonObject,
    retryAttempts: row.retry_attempts,
    ...(row.last_retry_at
      ? { lastRetryAt: toIsoString(row.last_retry_at) }
      : {}),
    ...(row.next_retry_at
      ? { nextRetryAt: toIsoString(row.next_retry_at) }
      : {}),
    ...(row.last_retry_error_json
      ? { lastRetryError: parseJson(row.last_retry_error_json) as JsonObject }
      : {}),
    ...(row.detail_json
      ? { detail: parseJson(row.detail_json) as JsonObject }
      : {}),
    createdAt: toIsoString(row.created_at),
    statusUpdatedAt: toIsoString(row.status_updated_at),
    ...(row.aged_at ? { agedAt: toIsoString(row.aged_at) } : {}),
    ...(row.cleared_at ? { clearedAt: toIsoString(row.cleared_at) } : {}),
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
