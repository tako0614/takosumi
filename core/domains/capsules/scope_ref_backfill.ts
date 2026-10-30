/**
 * Operator backfill that freezes every Capsule's `scopeRef` (TASK-0118 Phase 9,
 * stage 9.0).
 *
 * A Capsule created before stage 9.0 has no stored `scopeRef` and derives from
 * its Workspace id (`capsuleScopeRef`). This backfill writes exactly that value
 * into the Capsule record, so nothing derived from it moves; afterwards a later
 * stage can stop reading the Workspace id. It covers every row, destroyed ones
 * included, and never touches a row that already has a `scopeRef`.
 *
 * Each write is one conditional UPDATE of one row: it sets the value only while
 * the row still has no `scopeRef` and its record and column still name the
 * expected Workspace, so a concurrent writer is never overwritten and a
 * re-run is a no-op. The record JSON is updated in place (no read-modify-write
 * of the whole record). The tool runs no DDL.
 */

import type { SqlClient } from "../../adapters/storage/sql.ts";
import { stableJsonDigest } from "../../adapters/source/digest.ts";

/** One Capsule row as the backfill reads it. */
export interface CapsuleScopeRefRow {
  readonly id: string;
  readonly status: string;
  /** Physical Workspace column (`space_id`). */
  readonly columnWorkspaceId: string | null;
  /** `workspaceId` inside the stored record. */
  readonly recordWorkspaceId: string | null;
  /** `scopeRef` inside the stored record; `null` when absent. */
  readonly recordScopeRef: unknown;
}

export interface CapsuleScopeRefBackfillTarget {
  /** Every Capsule row, in id order. */
  listRows(): Promise<readonly CapsuleScopeRefRow[]>;
  /**
   * Atomically writes `scopeRef = workspaceId` into one row's record, only if
   * the row has no `scopeRef` and both its column and record still name
   * `workspaceId`. Returns whether a row changed.
   */
  freeze(capsuleId: string, workspaceId: string): Promise<boolean>;
}

export interface CapsuleScopeRefBackfillPlan {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  /** Rows to write: id and the Workspace id that becomes their scopeRef. */
  readonly writes: readonly { readonly capsuleId: string; readonly scopeRef: string }[];
  /** Rows whose stored scopeRef already equals their Workspace id. */
  readonly alreadyFrozen: number;
  /**
   * Rows whose stored scopeRef differs from their Workspace id. Legitimate
   * only after a later stage moved the Workspace; reported, never changed.
   */
  readonly diverged: readonly string[];
  /**
   * Rows refused: no usable Workspace id in the record or the column, or the
   * two disagree. They are never written; the operator resolves each one
   * before the gate query can reach zero.
   */
  readonly refused: readonly { readonly capsuleId: string; readonly reason: string }[];
  /** Digest of `writes`; `--apply` must name it. */
  readonly digest: string;
}

export interface CapsuleScopeRefBackfillResult {
  readonly frozen: number;
  /**
   * Reviewed rows the conditional write did not change: a writer gave them a
   * scopeRef, or moved their Workspace, between plan and apply.
   */
  readonly skipped: readonly string[];
  /**
   * Writable rows still missing a scopeRef after apply. Expected 0. A row can
   * lose a freshly frozen value to a concurrent whole-record Capsule write
   * that read it before the backfill (reads fall back to the same Workspace
   * id, so nothing derived moves); run the dry-run and apply again until this
   * is 0.
   */
  readonly remaining: number;
}

/** Read-only inventory. */
export async function planCapsuleScopeRefBackfill(
  target: CapsuleScopeRefBackfillTarget,
): Promise<CapsuleScopeRefBackfillPlan> {
  const rows = [...await target.listRows()].sort((a, b) => a.id.localeCompare(b.id));
  const byStatus: Record<string, number> = {};
  const writes: { capsuleId: string; scopeRef: string }[] = [];
  const diverged: string[] = [];
  const refused: { capsuleId: string; reason: string }[] = [];
  let alreadyFrozen = 0;
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const workspaceId = row.recordWorkspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      refused.push({ capsuleId: row.id, reason: "record_workspace_missing" });
      continue;
    }
    // `freeze` conditions on the column naming the same Workspace, so a row
    // without one could never be written: report it instead of planning a
    // write that would only ever be skipped.
    if (row.columnWorkspaceId === null) {
      refused.push({ capsuleId: row.id, reason: "workspace_column_missing" });
      continue;
    }
    if (row.columnWorkspaceId !== workspaceId) {
      refused.push({ capsuleId: row.id, reason: "workspace_column_mismatch" });
      continue;
    }
    if (row.recordScopeRef === null || row.recordScopeRef === undefined) {
      writes.push({ capsuleId: row.id, scopeRef: workspaceId });
    } else if (row.recordScopeRef === workspaceId) {
      alreadyFrozen += 1;
    } else if (typeof row.recordScopeRef === "string" && row.recordScopeRef.length > 0) {
      diverged.push(row.id);
    } else {
      refused.push({ capsuleId: row.id, reason: "record_scope_invalid" });
    }
  }
  return {
    total: rows.length,
    byStatus,
    writes,
    alreadyFrozen,
    diverged,
    refused,
    digest: await stableJsonDigest({ contract: "takosumi.capsule-scope-ref-backfill/v1", writes }),
  };
}

/**
 * Applies a reviewed plan. The current inventory must still produce the same
 * write set (`expectedDigest`), so the operator applies exactly what was
 * reviewed in the dry-run.
 */
export async function applyCapsuleScopeRefBackfill(
  target: CapsuleScopeRefBackfillTarget,
  expectedDigest: string,
): Promise<CapsuleScopeRefBackfillResult> {
  const plan = await planCapsuleScopeRefBackfill(target);
  if (plan.digest !== expectedDigest) {
    throw new Error("Capsule scopeRef backfill plan changed since review; run --dry-run again");
  }
  let frozen = 0;
  const skipped: string[] = [];
  for (const write of plan.writes) {
    if (await target.freeze(write.capsuleId, write.scopeRef)) frozen += 1;
    else skipped.push(write.capsuleId);
  }
  const after = await planCapsuleScopeRefBackfill(target);
  return { frozen, skipped, remaining: after.writes.length };
}

/** Minimal structural D1 surface (satisfied by a Worker binding or REST transport). */
export interface CapsuleScopeRefD1 {
  prepare(sql: string): {
    bind(...values: readonly unknown[]): {
      all<T = unknown>(): Promise<{ readonly results?: readonly T[] }>;
      run(): Promise<{ readonly meta?: { readonly changes?: number } }>;
    };
  };
}

/** Cloudflare D1 Control store (`capsules.record_json`, `capsules.space_id`). */
export function d1CapsuleScopeRefBackfillTarget(
  db: CapsuleScopeRefD1,
): CapsuleScopeRefBackfillTarget {
  return {
    async listRows() {
      const result = await db.prepare(
        `select id, status, space_id,
                json_extract(record_json, '$.workspaceId') as record_workspace_id,
                json_type(record_json, '$.scopeRef') as scope_type,
                json_extract(record_json, '$.scopeRef') as record_scope_ref
           from capsules
          order by id`,
      ).bind().all<{
        id: string;
        status: string;
        space_id: string | null;
        record_workspace_id: string | null;
        scope_type: string | null;
        record_scope_ref: unknown;
      }>();
      return (result.results ?? []).map((row) => ({
        id: row.id,
        status: row.status,
        columnWorkspaceId: row.space_id,
        recordWorkspaceId: row.record_workspace_id,
        recordScopeRef: row.scope_type === null
          ? null
          : row.scope_type === "text"
            ? row.record_scope_ref
            : { type: row.scope_type },
      }));
    },
    async freeze(capsuleId, workspaceId) {
      const result = await db.prepare(
        `update capsules
            set record_json = json_set(record_json, '$.scopeRef', ?)
          where id = ?
            and json_type(record_json, '$.scopeRef') is null
            and json_extract(record_json, '$.workspaceId') = ?
            and space_id = ?`,
      ).bind(workspaceId, capsuleId, workspaceId, workspaceId).run();
      return (result.meta?.changes ?? 0) === 1;
    },
  };
}

/** Postgres Control store (`takosumi_capsules.installation_json jsonb`, `space_id`). */
export function sqlCapsuleScopeRefBackfillTarget(
  client: SqlClient,
): CapsuleScopeRefBackfillTarget {
  return {
    async listRows() {
      const result = await client.query<{
        id: string;
        status: string;
        space_id: string | null;
        record_workspace_id: string | null;
        scope_type: string | null;
        record_scope_ref: string | null;
      }>(
        `select id, status, space_id,
                installation_json->>'workspaceId' as record_workspace_id,
                jsonb_typeof(installation_json->'scopeRef') as scope_type,
                installation_json->>'scopeRef' as record_scope_ref
           from takosumi_capsules
          order by id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        columnWorkspaceId: row.space_id,
        recordWorkspaceId: row.record_workspace_id,
        recordScopeRef: row.scope_type === null || row.scope_type === "null"
          ? (row.scope_type === "null" ? { type: "null" } : null)
          : row.scope_type === "string"
            ? row.record_scope_ref
            : { type: row.scope_type },
      }));
    },
    async freeze(capsuleId, workspaceId) {
      const result = await client.query(
        `update takosumi_capsules
            set installation_json = jsonb_set(
              installation_json, '{scopeRef}', to_jsonb($2::text), true
            )
          where id = $1
            and installation_json->'scopeRef' is null
            and installation_json->>'workspaceId' = $2
            and space_id = $2`,
        [capsuleId, workspaceId],
      );
      return result.rowCount === 1;
    },
  };
}
