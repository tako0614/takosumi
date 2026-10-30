/**
 * Read-only check that every Capsule row, destroyed ones included, resolves to
 * a canonical artifact root (TASK-0118 Phase 9, stage 9.1-f).
 *
 * A Capsule's artifact keys follow its persisted `storage_root`: `apps/{cap}`
 * for a Capsule created after ownership expansion, or the legacy
 * `workspaces/{ws}/capsules/{cap}` root the ownership backfill froze. A row
 * without a persisted root still resolves through a fallback that derives the
 * legacy root from the Capsule's frozen `scopeRef` (else its Workspace id). The
 * stage 9.5 bridge removes that fallback, so this check reports those rows as
 * `derived`, and it reports any row that resolves to no canonical root at all
 * as `unresolvable`. It also reports rows whose record names another
 * Workspace than their `space_id` column, and `apps/` Source archives
 * allocated for a Capsule that does not exist (an abandoned install
 * reservation). It reads only; it never writes or runs DDL.
 */

import type { SqlClient } from "../../adapters/storage/sql.ts";
import { capsuleArtifactRoot } from "../../adapters/storage/artifact-references.ts";
import {
  D1_APP_SOURCE_ARCHIVE_OWNERS_QUERY,
  POSTGRES_APP_SOURCE_ARCHIVE_OWNERS_QUERY,
} from "../../adapters/storage/source-archive-reference-query.ts";

/** One Capsule row as the check reads it. */
export interface CapsuleStorageRootRow {
  readonly id: string;
  readonly status: string;
  /** The physical Workspace column (`space_id`). */
  readonly columnWorkspaceId: string | null;
  /**
   * The persisted `storage_root`: a string, `null` when the column is empty,
   * `undefined` when the schema has no such column yet (D1 before v77).
   */
  readonly storageRoot: string | null | undefined;
  /** Whether the stored record is a JSON object. */
  readonly recordValid: boolean;
  readonly recordId: unknown;
  readonly recordWorkspaceId: unknown;
  /** `scopeRef` inside the stored record; `undefined` when absent. */
  readonly recordScopeRef: unknown;
}

/** `apps/{cap}/sources/{src}/…` archive refs of one Source, grouped by the Capsule segment. */
export interface AppSourceArchiveOwnerRow {
  readonly sourceId: string;
  readonly capsuleId: string;
  readonly refs: number;
}

export interface CapsuleStorageRootCheckTarget {
  /** Every Capsule row, destroyed ones included. */
  listRows(): Promise<readonly CapsuleStorageRootRow[]>;
  /** Every `apps/` Source archive ref in SourceSnapshots and SourceSyncRuns. */
  listAppSourceArchiveOwners(): Promise<readonly AppSourceArchiveOwnerRow[]>;
}

export type CapsuleStorageRootResolution =
  | { readonly ok: true; readonly root: string; readonly kind: "apps" | "legacy" | "derived" }
  | { readonly ok: false; readonly reason: CapsuleStorageRootUnresolvableReason };

export type CapsuleStorageRootUnresolvableReason =
  | "record_invalid"
  | "record_id_mismatch"
  | "storage_root_not_canonical"
  | "scope_missing"
  | "scope_invalid";

export interface CapsuleStorageRootReport {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  /** Persisted `apps/` roots, persisted legacy roots, and roots derived without one. */
  readonly byRoot: { readonly apps: number; readonly legacy: number; readonly derived: number };
  /** Rows that resolve only through the fallback stage 9.5 removes. */
  readonly derived: readonly string[];
  readonly unresolvable: readonly {
    readonly capsuleId: string;
    readonly status: string;
    readonly reason: CapsuleStorageRootUnresolvableReason;
  }[];
  /** Rows whose record `workspaceId` differs from their `space_id` column. */
  readonly workspaceColumnMismatch: readonly string[];
  /**
   * `apps/` Source archives allocated for a Capsule with no row: an install
   * reservation that was never created. Reported for the storage inventory;
   * they do not fail the check.
   */
  readonly orphanAppArchives: readonly AppSourceArchiveOwnerRow[];
  /** Every row resolves to a canonical root and agrees with its Workspace column. */
  readonly ok: boolean;
}

/**
 * The root a row resolves to, exactly as the stores' `getCapsuleStorageRoot`
 * and the allocator (`capsuleArtifactRoot`) resolve it.
 */
export function resolveCapsuleStorageRoot(row: CapsuleStorageRootRow): CapsuleStorageRootResolution {
  if (!row.recordValid) return { ok: false, reason: "record_invalid" };
  if (row.recordId !== row.id) return { ok: false, reason: "record_id_mismatch" };
  if (typeof row.storageRoot === "string") {
    try {
      const root = capsuleArtifactRoot("", row.id, row.storageRoot);
      return { ok: true, root, kind: root.startsWith("apps/") ? "apps" : "legacy" };
    } catch {
      return { ok: false, reason: "storage_root_not_canonical" };
    }
  }
  // No persisted root: the legacy root written under the frozen scope
  // (`capsuleScopeRef`): the stored scopeRef, else the record's Workspace id.
  const scope = row.recordScopeRef === undefined ? row.recordWorkspaceId : row.recordScopeRef;
  if (scope === undefined || scope === null) return { ok: false, reason: "scope_missing" };
  if (typeof scope !== "string" || scope.length === 0) return { ok: false, reason: "scope_invalid" };
  try {
    return { ok: true, root: capsuleArtifactRoot(scope, row.id), kind: "derived" };
  } catch {
    return { ok: false, reason: "scope_invalid" };
  }
}

export async function checkCapsuleStorageRoots(
  target: CapsuleStorageRootCheckTarget,
): Promise<CapsuleStorageRootReport> {
  const rows = [...await target.listRows()].sort((a, b) => a.id.localeCompare(b.id));
  const byStatus: Record<string, number> = {};
  const byRoot = { apps: 0, legacy: 0, derived: 0 };
  const derived: string[] = [];
  const unresolvable: { capsuleId: string; status: string; reason: CapsuleStorageRootUnresolvableReason }[] = [];
  const workspaceColumnMismatch: string[] = [];
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.recordValid && row.recordWorkspaceId !== row.columnWorkspaceId) workspaceColumnMismatch.push(row.id);
    const resolved = resolveCapsuleStorageRoot(row);
    if (!resolved.ok) {
      unresolvable.push({ capsuleId: row.id, status: row.status, reason: resolved.reason });
      continue;
    }
    byRoot[resolved.kind] += 1;
    if (resolved.kind === "derived") derived.push(row.id);
  }
  const capsuleIds = new Set(rows.map((row) => row.id));
  const orphanAppArchives = [...await target.listAppSourceArchiveOwners()]
    .filter((owner) => !capsuleIds.has(owner.capsuleId))
    .sort((a, b) => a.capsuleId.localeCompare(b.capsuleId) || a.sourceId.localeCompare(b.sourceId));
  return {
    total: rows.length, byStatus, byRoot, derived, unresolvable, workspaceColumnMismatch, orphanAppArchives,
    ok: unresolvable.length === 0 && workspaceColumnMismatch.length === 0,
  };
}

/** Minimal read-only D1 surface (a Worker binding, the REST transport, or a SQLite copy). */
export interface CapsuleStorageRootD1 {
  prepare(sql: string): {
    bind(...values: readonly unknown[]): {
      all<T = unknown>(): Promise<{ readonly results?: readonly T[] }>;
    };
  };
}

/** Cloudflare D1 Control store (`capsules.record_json`, `capsules.storage_root` from v77). */
export function d1CapsuleStorageRootCheckTarget(db: CapsuleStorageRootD1): CapsuleStorageRootCheckTarget {
  return {
    async listRows() {
      const column = await db.prepare(
        "select name from pragma_table_info('capsules') where name = 'storage_root'",
      ).bind().all<{ name: string }>();
      const hasRoot = (column.results ?? []).length === 1;
      const result = await db.prepare(
        `select id, status, space_id, ${hasRoot ? "storage_root" : "null as storage_root"},
                case when json_valid(record_json) then json_type(record_json) = 'object' else 0 end as record_valid,
                case when json_valid(record_json) then json_extract(record_json, '$.id') end as record_id,
                case when json_valid(record_json) then json_extract(record_json, '$.workspaceId') end as record_workspace_id,
                case when json_valid(record_json) then json_type(record_json, '$.scopeRef') end as scope_type,
                case when json_valid(record_json) then json_extract(record_json, '$.scopeRef') end as record_scope_ref
           from capsules
          order by id`,
      ).bind().all<{
        id: string;
        status: string;
        space_id: string | null;
        storage_root: string | null;
        record_valid: number | null;
        record_id: unknown;
        record_workspace_id: unknown;
        scope_type: string | null;
        record_scope_ref: unknown;
      }>();
      return (result.results ?? []).map((row) => ({
        id: row.id,
        status: row.status,
        columnWorkspaceId: row.space_id,
        storageRoot: hasRoot ? row.storage_root : undefined,
        recordValid: row.record_valid === 1,
        recordId: row.record_id,
        recordWorkspaceId: row.record_workspace_id,
        recordScopeRef: row.scope_type === null
          ? undefined
          : row.scope_type === "text"
            ? row.record_scope_ref
            : { type: row.scope_type },
      }));
    },
    async listAppSourceArchiveOwners() {
      const result = await db.prepare(
        D1_APP_SOURCE_ARCHIVE_OWNERS_QUERY,
      ).bind().all<{ source_id: string; capsule_id: string; refs: number }>();
      return (result.results ?? []).map((row) => ({
        sourceId: row.source_id, capsuleId: row.capsule_id, refs: Number(row.refs),
      }));
    },
  };
}

/** Postgres Control store (`takosumi_capsules.installation_json jsonb`, `storage_root`). */
export function sqlCapsuleStorageRootCheckTarget(client: SqlClient): CapsuleStorageRootCheckTarget {
  return {
    async listRows() {
      const result = await client.query<{
        id: string;
        status: string;
        space_id: string | null;
        storage_root: string | null;
        record_type: string | null;
        record_id: string | null;
        record_workspace_id: string | null;
        scope_type: string | null;
        record_scope_ref: string | null;
      }>(
        `select id, status, space_id, storage_root,
                jsonb_typeof(installation_json) as record_type,
                installation_json->>'id' as record_id,
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
        storageRoot: row.storage_root,
        recordValid: row.record_type === "object",
        recordId: row.record_id,
        recordWorkspaceId: row.record_workspace_id,
        recordScopeRef: row.scope_type === null
          ? undefined
          : row.scope_type === "string"
            ? row.record_scope_ref
            : { type: row.scope_type },
      }));
    },
    async listAppSourceArchiveOwners() {
      const result = await client.query<{ source_id: string; capsule_id: string; refs: string | number }>(
        POSTGRES_APP_SOURCE_ARCHIVE_OWNERS_QUERY,
      );
      return result.rows.map((row) => ({
        sourceId: row.source_id, capsuleId: row.capsule_id, refs: Number(row.refs),
      }));
    },
  };
}
