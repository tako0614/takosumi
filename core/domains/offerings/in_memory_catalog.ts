import type { OfferingCatalog, OfferingCatalogReader } from "takosumi-contract";

export class InMemoryOfferingCatalogReader implements OfferingCatalogReader {
  readonly #catalogs = new Map<string, OfferingCatalog>();

  constructor(catalogs: readonly OfferingCatalog[] = []) {
    for (const catalog of catalogs) this.set(catalog);
  }

  set(catalog: OfferingCatalog): void {
    const key = `${catalog.id}\u0000${catalog.version}`;
    if (this.#catalogs.has(key)) {
      throw new TypeError(
        `Offering catalog ${catalog.id}@${catalog.version} is immutable`,
      );
    }
    this.#catalogs.set(key, structuredClone(catalog));
  }

  async getCatalog(
    catalogId: string,
    catalogVersion: string,
  ): Promise<OfferingCatalog | undefined> {
    const catalog = this.#catalogs.get(`${catalogId}\u0000${catalogVersion}`);
    return catalog ? structuredClone(catalog) : undefined;
  }
}
