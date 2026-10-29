import type { ProviderConnection } from "takosumi-contract/connections";
import type { UsageEvent } from "takosumi-contract/billing";
import { clampPageLimit, decodeCursor, pageFromProbe, type Page, type PageParams } from "takosumi-contract/pagination";
import type { SqlClient } from "../../adapters/storage/sql.ts";
import type { D1Like } from "../../adapters/storage/d1.ts";
import { usageEventFromRow } from "../deploy-control/store_row_mappers.ts";

export interface AccountResourceReader {
  listConnections(accountId: string, page: PageParams): Promise<Page<ProviderConnection>>;
  listUsage(accountId: string, page: PageParams): Promise<Page<UsageEvent>>;
}

type UsageRow = Parameters<typeof usageEventFromRow>[0] & { payerAccountId: string };
type ConnectionRow = { id: string; owner_account_id: string | null; connection_json: string | ProviderConnection; created_at: string };
type Query = <T extends Record<string, unknown>>(sql: string, values: readonly (string | number)[]) => Promise<readonly T[]>;

/** Reads only public connection metadata and usage; never touches sealed blobs. */
function reader(query: Query, dialect: "postgres" | "d1"): AccountResourceReader {
  const prefix = dialect === "postgres" ? "takosumi_" : "";
  const parameter = (position: number) => dialect === "postgres" ? `$${position}` : `?${position}`;
  const keyset = (page: PageParams, values: (string | number)[]): string => {
    const cursor = decodeCursor(page.cursor);
    if (page.cursor && !cursor) throw new TypeError("Malformed page cursor");
    if (!cursor) return "";
    values.push(cursor.createdAt, cursor.id);
    return ` and (created_at > ${parameter(values.length - 1)} or (created_at = ${parameter(values.length - 1)} and id > ${parameter(values.length)}))`;
  };
  return {
    async listConnections(accountId, page) {
      const values: (string | number)[] = [accountId];
      const after = keyset(page, values);
      const limit = clampPageLimit(page.limit);
      values.push(limit + 1);
      const legacyOwner = dialect === "postgres" ? "connection_json->>'ownerAccountId'" : "json_extract(connection_json,'$.ownerAccountId')";
      const rows = await query<ConnectionRow>(`select id, owner_account_id, connection_json, created_at from ${prefix}connections where coalesce(owner_account_id, ${legacyOwner}) = ${parameter(1)}${after} order by created_at, id limit ${parameter(values.length)}`, values);
      const connections = rows.map((row) => {
        const connection: ProviderConnection = typeof row.connection_json === "string" ? JSON.parse(row.connection_json) : row.connection_json;
        // The physical predicate is authority; JSON disagreement must not leak
        // another person's connection metadata or widen a malformed scope.
        if (connection.id !== row.id || (row.owner_account_id ?? connection.ownerAccountId) !== accountId || connection.scope === "operator") throw new Error("Connection ownership projection is inconsistent");
        return row.owner_account_id === null ? connection : { ...connection, ownerAccountId: row.owner_account_id };
      });
      return pageFromProbe(connections, limit);
    },
    async listUsage(accountId, page) {
      const values: (string | number)[] = [accountId];
      const after = keyset(page, values);
      const limit = clampPageLimit(page.limit);
      values.push(limit + 1);
      const rows = await query<UsageRow>(`select id, workspace_id as "workspaceId", capsule_id as "capsuleId", run_id as "runId", payer_account_id as "payerAccountId", meter_id as "meterId", resource_family as "resourceFamily", resource_id as "resourceId", operation, resource_metadata_json as "resourceMetadataJson", kind, quantity, usd_micros as "usdMicros", rating_status as "ratingStatus", source, idempotency_key as "idempotencyKey", created_at as "createdAt" from ${prefix}usage_events where payer_account_id = ${parameter(1)}${after} order by created_at, id limit ${parameter(values.length)}`, values);
      const events = rows.map((row) => {
        if (row.payerAccountId !== accountId) throw new Error("Usage payer projection is inconsistent");
        return { ...usageEventFromRow(row), payerAccountId: row.payerAccountId };
      });
      return pageFromProbe(events, limit);
    },
  };
}

export function sqlAccountResourceReader(client: SqlClient): AccountResourceReader {
  return reader(async <T extends Record<string, unknown>>(sql: string, values: readonly (string | number)[]) => (await client.query<T>(sql, values)).rows, "postgres");
}

export function d1AccountResourceReader(db: D1Like): AccountResourceReader {
  return reader(async <T extends Record<string, unknown>>(sql: string, values: readonly (string | number)[]) => (await db.prepare(sql).bind(...values).all<T>()).results ?? [], "d1");
}
