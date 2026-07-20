import {
  pageSortedBy,
  type OfferingCatalog,
  type Page,
  type PageParams,
} from "takosumi-contract";
import { stableStringify } from "../../adapters/source/digest.ts";
import type {
  CreateOfferingCatalogResult,
  OfferingCatalogStore,
  StoredOfferingCatalog,
} from "./catalog_store.ts";

export class InMemoryOfferingCatalogReader implements OfferingCatalogStore {
  readonly persistence = "ephemeral" as const;
  readonly #catalogs = new Map<string, StoredOfferingCatalog>();

  constructor(catalogs: readonly OfferingCatalog[] = []) {
    for (const catalog of catalogs) {
      this.#set({
        catalog,
        createdAt: catalog.effectiveAt,
        createdBy: "host-composition",
      });
    }
  }

  set(catalog: OfferingCatalog): void {
    this.#set({
      catalog,
      createdAt: catalog.effectiveAt,
      createdBy: "host-composition",
    });
  }

  #set(record: StoredOfferingCatalog): void {
    const key = catalogKey(record.catalog);
    if (this.#catalogs.has(key)) {
      throw new TypeError(
        `Offering catalog ${record.catalog.id}@${record.catalog.version} is immutable`,
      );
    }
    this.#catalogs.set(key, structuredClone(record));
  }

  async getCatalog(
    catalogId: string,
    catalogVersion: string,
  ): Promise<OfferingCatalog | undefined> {
    const record = this.#catalogs.get(`${catalogId}@${catalogVersion}`);
    return record === undefined ? undefined : structuredClone(record.catalog);
  }

  async createCatalog(
    record: StoredOfferingCatalog,
  ): Promise<CreateOfferingCatalogResult> {
    const key = catalogKey(record.catalog);
    const existing = this.#catalogs.get(key);
    if (existing) {
      return {
        status:
          stableStringify(existing.catalog) === stableStringify(record.catalog)
            ? "already_exists"
            : "conflict",
        record: structuredClone(existing),
      };
    }
    this.#catalogs.set(key, structuredClone(record));
    return { status: "created", record: structuredClone(record) };
  }

  async listCatalogs(params: PageParams): Promise<Page<StoredOfferingCatalog>> {
    const page = pageSortedBy(
      [...this.#catalogs.values()].sort((left, right) => {
        const byTime = left.createdAt.localeCompare(right.createdAt);
        return byTime !== 0
          ? byTime
          : catalogKey(left.catalog).localeCompare(catalogKey(right.catalog));
      }),
      params,
      (record) => ({
        createdAt: record.createdAt,
        id: catalogKey(record.catalog),
      }),
    );
    return {
      items: page.items.map((record) => structuredClone(record)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}

function catalogKey(catalog: OfferingCatalog): string {
  return `${catalog.id}@${catalog.version}`;
}
