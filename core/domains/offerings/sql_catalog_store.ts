import {
  clampPageLimit,
  decodeCursor,
  pageFromProbeBy,
  type OfferingCatalog,
  type Page,
  type PageParams,
} from "takosumi-contract";
import { stableStringify } from "../../adapters/source/digest.ts";
import { deployControlPostgresTableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { SqlClient, SqlValue } from "../../adapters/storage/sql.ts";
import type {
  CreateOfferingCatalogResult,
  OfferingCatalogStore,
  StoredOfferingCatalog,
} from "./catalog_store.ts";

type CatalogRow = Record<string, unknown> & {
  readonly record_json: unknown;
  readonly created_at: unknown;
  readonly created_by: unknown;
};

export class SqlOfferingCatalogStore implements OfferingCatalogStore {
  constructor(readonly client: SqlClient) {}

  async createCatalog(
    record: StoredOfferingCatalog,
  ): Promise<CreateOfferingCatalogResult> {
    const result = await this.client.query(
      `insert into ${names.offeringCatalogs}
        (catalog_key, catalog_id, catalog_version, effective_at,
         record_json, created_at, created_by)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7)
       on conflict do nothing`,
      [
        catalogKey(record.catalog),
        record.catalog.id,
        record.catalog.version,
        record.catalog.effectiveAt,
        JSON.stringify(record.catalog),
        record.createdAt,
        record.createdBy,
      ],
    );
    if (result.rowCount > 0) {
      return { status: "created", record: structuredClone(record) };
    }
    const existing = await this.#getRecord(
      record.catalog.id,
      record.catalog.version,
    );
    if (!existing) {
      throw new Error(
        `Offering catalog create conflict did not resolve ${catalogKey(record.catalog)}`,
      );
    }
    return {
      status:
        stableStringify(existing.catalog) === stableStringify(record.catalog)
          ? "already_exists"
          : "conflict",
      record: existing,
    };
  }

  async getCatalog(
    catalogId: string,
    catalogVersion: string,
  ): Promise<OfferingCatalog | undefined> {
    return (await this.#getRecord(catalogId, catalogVersion))?.catalog;
  }

  async listCatalogs(params: PageParams): Promise<Page<StoredOfferingCatalog>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const parameters: SqlValue[] = cursor
      ? [cursor.createdAt, cursor.id, limit + 1]
      : [limit + 1];
    const result = await this.client.query<CatalogRow>(
      `select record_json, created_at, created_by
       from ${names.offeringCatalogs}
       ${cursor ? "where (created_at, catalog_key) > ($1,$2)" : ""}
       order by created_at asc, catalog_key asc limit $${parameters.length}`,
      parameters,
    );
    return pageFromProbeBy(result.rows.map(decodeRecord), limit, (record) => ({
      createdAt: record.createdAt,
      id: catalogKey(record.catalog),
    }));
  }

  async #getRecord(
    catalogId: string,
    catalogVersion: string,
  ): Promise<StoredOfferingCatalog | undefined> {
    const result = await this.client.query<CatalogRow>(
      `select record_json, created_at, created_by
       from ${names.offeringCatalogs}
       where catalog_key = $1 limit 1`,
      [`${catalogId}@${catalogVersion}`],
    );
    return result.rows[0] === undefined
      ? undefined
      : decodeRecord(result.rows[0]);
  }
}

export function createSqlOfferingCatalogStore(
  client: SqlClient,
): SqlOfferingCatalogStore {
  return new SqlOfferingCatalogStore(client);
}

function decodeRecord(row: CatalogRow): StoredOfferingCatalog {
  const catalog =
    typeof row.record_json === "string"
      ? (JSON.parse(row.record_json) as OfferingCatalog)
      : (row.record_json as OfferingCatalog);
  return {
    catalog,
    createdAt: requiredString(row.created_at, "created_at"),
    createdBy: requiredString(row.created_by, "created_by"),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid Offering catalog ${field}`);
  }
  return value;
}

function catalogKey(catalog: OfferingCatalog): string {
  return `${catalog.id}@${catalog.version}`;
}
