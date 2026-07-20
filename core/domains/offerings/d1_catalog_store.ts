import {
  clampPageLimit,
  decodeCursor,
  pageFromProbeBy,
  type OfferingCatalog,
  type Page,
  type PageParams,
} from "takosumi-contract";
import { stableStringify } from "../../adapters/source/digest.ts";
import { deployControlD1TableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { D1Like } from "../resource-shape/d1_stores.ts";
import type {
  CreateOfferingCatalogResult,
  OfferingCatalogStore,
  StoredOfferingCatalog,
} from "./catalog_store.ts";

interface CatalogRow {
  readonly record_json: string;
  readonly created_at: string;
  readonly created_by: string;
}

interface CatalogListRow extends CatalogRow {
  readonly catalog_key: string;
}

export class D1OfferingCatalogStore implements OfferingCatalogStore {
  constructor(readonly db: D1Like) {}

  async createCatalog(
    record: StoredOfferingCatalog,
  ): Promise<CreateOfferingCatalogResult> {
    const key = catalogKey(record.catalog);
    const result = await this.db
      .prepare(
        `insert or ignore into ${names.offeringCatalogs}
          (catalog_key, catalog_id, catalog_version, effective_at,
           record_json, created_at, created_by)
         values (?,?,?,?,?,?,?)`,
      )
      .bind(
        key,
        record.catalog.id,
        record.catalog.version,
        record.catalog.effectiveAt,
        JSON.stringify(record.catalog),
        record.createdAt,
        record.createdBy,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return { status: "created", record: structuredClone(record) };
    }
    const existing = await this.#getRecord(
      record.catalog.id,
      record.catalog.version,
    );
    if (!existing) {
      throw new Error(
        `Offering catalog create conflict did not resolve ${key}`,
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
    const rows = await this.db
      .prepare(
        `select catalog_key, record_json, created_at, created_by
         from ${names.offeringCatalogs}
         ${cursor ? "where (created_at > ? or (created_at = ? and catalog_key > ?))" : ""}
         order by created_at asc, catalog_key asc limit ?`,
      )
      .bind(
        ...(cursor
          ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
          : [limit + 1]),
      )
      .all<CatalogListRow>();
    return pageFromProbeBy(
      (rows.results ?? []).map(decodeRecord),
      limit,
      (record) => ({
        createdAt: record.createdAt,
        id: catalogKey(record.catalog),
      }),
    );
  }

  async #getRecord(
    catalogId: string,
    catalogVersion: string,
  ): Promise<StoredOfferingCatalog | undefined> {
    const row = await this.db
      .prepare(
        `select record_json, created_at, created_by
         from ${names.offeringCatalogs}
         where catalog_key = ? limit 1`,
      )
      .bind(`${catalogId}@${catalogVersion}`)
      .first<CatalogRow>();
    return row === null || row === undefined ? undefined : decodeRecord(row);
  }
}

export function createD1OfferingCatalogStore(
  db: D1Like,
): D1OfferingCatalogStore {
  return new D1OfferingCatalogStore(db);
}

function decodeRecord(row: CatalogRow): StoredOfferingCatalog {
  return {
    catalog: JSON.parse(row.record_json) as OfferingCatalog,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function catalogKey(catalog: OfferingCatalog): string {
  return `${catalog.id}@${catalog.version}`;
}
