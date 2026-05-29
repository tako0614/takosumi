import type { JsonObject } from "takosumi-contract/reference/compat";
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
  type RevokeDebtDueOpenInput,
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
    // `revokeDebtSourceKey` returns a Promise now (Web Crypto digest).
    const sourceKey = await revokeDebtSourceKey(input);
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

  async listDueOpenDebts(
    input: RevokeDebtDueOpenInput,
  ): Promise<readonly RevokeDebtRecord[]> {
    // Push the due-filter into SQL so not-due rows are never scanned past the
    // index (the `(owner_space_id, status, next_retry_at)` index covers this
    // predicate). `limit` bounds the per-tick scan. Ordering matches
    // `compareRevokeDebtRecords` (created_at asc, id asc).
    const params: SqlParameters = input.limit !== undefined
      ? [input.ownerSpaceId, input.now, input.limit]
      : [input.ownerSpaceId, input.now];
    const result = await this.#query<RevokeDebtRow>(
      SELECT_COLUMNS +
        " from takosumi_revoke_debts where owner_space_id = $1 and status = 'open' " +
        "and next_retry_at is not null and next_retry_at <= $2::timestamptz " +
        "order by created_at asc, id asc" +
        (input.limit !== undefined ? " limit $3" : ""),
      params,
    );
    return result.rows.map(rowToRecord).sort(compareRevokeDebtRecords);
  }

  async recordRetryAttempt(
    input: RevokeDebtRetryAttemptInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getById(input.ownerSpaceId, input.id);
    if (!existing) return undefined;
    const next = recordRevokeDebtRetryAttempt(existing, input);
    if (next === existing) return existing;
    return (await this.#updateMutable(next, expectedGuard(existing))).record;
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
      const outcome = await this.#updateMutable(next, expectedGuard(record));
      // Only report rows this pod actually aged. On a lost CAS race another
      // pod already transitioned the row, so it must not be counted here.
      if (outcome.won && outcome.record) aged.push(outcome.record);
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
    return (await this.#updateMutable(next, expectedGuard(existing))).record;
  }

  async reopen(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getById(input.ownerSpaceId, input.id);
    if (!existing) return undefined;
    const next = reopenRevokeDebt(existing, input.now);
    if (next === existing) return existing;
    return (await this.#updateMutable(next, expectedGuard(existing))).record;
  }

  async clear(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getById(input.ownerSpaceId, input.id);
    if (!existing) return undefined;
    const next = clearRevokeDebt(existing, input.now);
    if (next === existing) return existing;
    return (await this.#updateMutable(next, expectedGuard(existing))).record;
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

  /**
   * Apply a state transition with an optimistic-concurrency (compare-and-set)
   * guard. `expected` carries the pre-read `(status, retryAttempts)` captured
   * from the row this transition was computed against; the UPDATE only matches
   * the row when those columns are still unchanged. This fences cross-pod
   * cleanup so a stale read cannot clobber another pod's retry/clear/aging
   * transition (re-opening a cleared debt and double-revoking).
   *
   * On a lost race (0 rows updated) we do NOT throw — we re-read the row and
   * return its now-current value (or `undefined` if it truly vanished) with
   * `won: false`. The public methods already return
   * `RevokeDebtRecord | undefined` and the cleanup worker tolerates an
   * undefined/current row, so a lost race degrades to a no-op on this pod
   * instead of a worker-tick failure. `won` lets callers (e.g. `ageOpenDebts`)
   * count only transitions this pod actually performed.
   */
  async #updateMutable(
    record: RevokeDebtRecord,
    expected: {
      readonly status: RevokeDebtStatus;
      readonly retryAttempts: number;
    },
  ): Promise<UpdateOutcome> {
    const result = await this.#query<RevokeDebtRow>(
      "update takosumi_revoke_debts set " +
        "status = $3, retry_attempts = $4, last_retry_at = $5::timestamptz, next_retry_at = $6::timestamptz, last_retry_error_json = $7::jsonb, status_updated_at = $8::timestamptz, aged_at = $9::timestamptz, cleared_at = $10::timestamptz " +
        "where owner_space_id = $1 and id = $2 and status = $11 and retry_attempts = $12 " +
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
        expected.status,
        expected.retryAttempts,
      ],
    );
    const row = result.rows[0];
    if (row) return { won: true, record: rowToRecord(row) };
    // Lost the CAS race (or the row was concurrently deleted): re-read and
    // return the current row so callers observe the winning transition rather
    // than overwriting it.
    const current = await this.#getById(record.ownerSpaceId, record.id);
    return { won: false, ...(current ? { record: current } : {}) };
  }

  #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.#client.query<Row>(sql, parameters);
  }
}

/**
 * Result of a compare-and-set `#updateMutable`. `won` is true when this pod's
 * UPDATE matched the guard (it performed the transition); false when another
 * pod transitioned the row first. `record` is the post-transition row on a
 * win, or the re-read current row on a lost race (undefined if it vanished).
 */
interface UpdateOutcome {
  readonly won: boolean;
  readonly record?: RevokeDebtRecord;
}

/**
 * Capture the optimistic-concurrency guard columns from a pre-read row. The
 * `(status, retryAttempts)` pair changes on every meaningful transition, so a
 * UPDATE guarded on these only matches when the row is unchanged since it was
 * read.
 */
function expectedGuard(
  record: RevokeDebtRecord,
): { readonly status: RevokeDebtStatus; readonly retryAttempts: number } {
  return { status: record.status, retryAttempts: record.retryAttempts };
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
