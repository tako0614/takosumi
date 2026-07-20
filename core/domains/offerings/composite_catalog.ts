import type { OfferingCatalog, OfferingCatalogReader } from "takosumi-contract";

/** Exact lookup across installed authorities, rejecting ambiguous ownership. */
export class CompositeOfferingCatalogReader implements OfferingCatalogReader {
  constructor(readonly readers: readonly OfferingCatalogReader[]) {
    if (readers.length === 0) {
      throw new TypeError("at least one Offering catalog reader is required");
    }
  }

  async getCatalog(
    catalogId: string,
    catalogVersion: string,
  ): Promise<OfferingCatalog | undefined> {
    const matches = (
      await Promise.all(
        this.readers.map((reader) =>
          reader.getCatalog(catalogId, catalogVersion),
        ),
      )
    ).filter((catalog): catalog is OfferingCatalog => catalog !== undefined);
    if (matches.length > 1) {
      throw new TypeError(
        `ambiguous Offering catalog authority for ${catalogId}@${catalogVersion}`,
      );
    }
    return matches[0] === undefined ? undefined : structuredClone(matches[0]);
  }
}
