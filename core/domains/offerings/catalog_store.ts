import type {
  IsoTimestamp,
  OfferingCatalog,
  OfferingCatalogReader,
  Page,
  PageParams,
} from "takosumi-contract";

export interface StoredOfferingCatalog {
  readonly catalog: OfferingCatalog;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: string;
}

export type CreateOfferingCatalogResult =
  | {
      readonly status: "created" | "already_exists";
      readonly record: StoredOfferingCatalog;
    }
  | {
      readonly status: "conflict";
      readonly record: StoredOfferingCatalog;
    };

/**
 * Durable, immutable operator catalog authority. The public reader remains the
 * narrow selection-engine port; mutation and inventory are operator-only host
 * concerns and never contain Cloud price, capacity, manager, or support data.
 */
export interface OfferingCatalogStore extends OfferingCatalogReader {
  createCatalog(
    record: StoredOfferingCatalog,
  ): Promise<CreateOfferingCatalogResult>;
  listCatalogs(params: PageParams): Promise<Page<StoredOfferingCatalog>>;
}
