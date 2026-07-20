import type {
  IsoTimestamp,
  OfferingCatalog,
  Page,
  PageParams,
} from "takosumi-contract";
import { offeringCatalogProblems } from "./service.ts";
import type { OfferingCatalogStore } from "./catalog_store.ts";

export class OfferingCatalogAdminError extends Error {
  constructor(
    readonly code: "invalid_catalog" | "catalog_not_found" | "catalog_conflict",
    message: string,
  ) {
    super(message);
    this.name = "OfferingCatalogAdminError";
  }
}

export interface OfferingCatalogAdminServiceOptions {
  readonly store: OfferingCatalogStore;
  readonly now?: () => IsoTimestamp;
}

export class OfferingCatalogAdminService {
  readonly #store: OfferingCatalogStore;
  readonly #now: () => IsoTimestamp;

  constructor(options: OfferingCatalogAdminServiceOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async publish(input: {
    readonly catalog: unknown;
    readonly actorId: string;
  }): Promise<{
    readonly status: "created" | "already_exists";
    readonly catalog: OfferingCatalog;
  }> {
    const problems = offeringCatalogProblems(input.catalog);
    if (problems.length > 0) {
      throw new OfferingCatalogAdminError(
        "invalid_catalog",
        `Offering catalog is invalid: ${problems.join(", ")}`,
      );
    }
    const catalog = structuredClone(input.catalog) as OfferingCatalog;
    const result = await this.#store.createCatalog({
      catalog,
      createdAt: this.#now(),
      createdBy: requiredActor(input.actorId),
    });
    if (result.status === "conflict") {
      throw new OfferingCatalogAdminError(
        "catalog_conflict",
        "the exact Offering catalog id/version is already immutable with different content",
      );
    }
    return {
      status: result.status,
      catalog: structuredClone(result.record.catalog),
    };
  }

  async get(
    catalogId: string,
    catalogVersion: string,
  ): Promise<OfferingCatalog> {
    const catalog = await this.#store.getCatalog(catalogId, catalogVersion);
    if (!catalog) {
      throw new OfferingCatalogAdminError(
        "catalog_not_found",
        "the exact Offering catalog was not found",
      );
    }
    return structuredClone(catalog);
  }

  async list(params: PageParams): Promise<Page<OfferingCatalog>> {
    const page = await this.#store.listCatalogs(params);
    return {
      items: page.items.map((record) => structuredClone(record.catalog)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}

function requiredActor(value: string): string {
  const actor = value.trim();
  if (actor.length === 0 || actor.length > 256) {
    throw new OfferingCatalogAdminError(
      "invalid_catalog",
      "an operator actor id is required",
    );
  }
  return actor;
}
