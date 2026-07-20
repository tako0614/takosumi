import { expect, test } from "bun:test";
import type { OfferingCatalog } from "takosumi-contract";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import {
  D1OfferingCatalogStore,
  SqlOfferingCatalogStore,
  type OfferingCatalogStore,
} from "../../../../core/domains/offerings/mod.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const dialects = ["d1", "postgres"] as const;

for (const dialect of dialects) {
  test(`${dialect} Offering catalogs are immutable, idempotent, and paginated`, async () => {
    const handle = await createStore(dialect);
    try {
      const first = catalog(
        "catalog-a",
        "profile-a",
        "2026-07-20T00:00:00.000Z",
      );
      const second = catalog(
        "catalog-b",
        "profile-b",
        "2026-07-20T00:00:01.000Z",
      );
      const firstRecord = {
        catalog: first,
        createdAt: "2026-07-20T00:01:00.000Z",
        createdBy: "acct_operator",
      } as const;
      expect((await handle.store.createCatalog(firstRecord)).status).toBe(
        "created",
      );
      expect((await handle.store.createCatalog(firstRecord)).status).toBe(
        "already_exists",
      );
      expect(
        (
          await handle.store.createCatalog({
            ...firstRecord,
            catalog: { ...first, offerings: [] },
          })
        ).status,
      ).toBe("conflict");
      expect(
        (
          await handle.store.createCatalog({
            catalog: second,
            createdAt: "2026-07-20T00:01:01.000Z",
            createdBy: "acct_operator",
          })
        ).status,
      ).toBe("created");

      expect(await handle.store.getCatalog(first.id, first.version)).toEqual(
        first,
      );
      const page1 = await handle.store.listCatalogs({ limit: 1 });
      expect(page1.items.map((entry) => entry.catalog.id)).toEqual([
        "catalog-a",
      ]);
      expect(page1.nextCursor).toBeDefined();
      const page2 = await handle.store.listCatalogs({
        limit: 1,
        cursor: page1.nextCursor,
      });
      expect(page2.items.map((entry) => entry.catalog.id)).toEqual([
        "catalog-b",
      ]);
      expect(page2.nextCursor).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
}

type StoreHandle = {
  readonly store: OfferingCatalogStore;
  readonly close: () => Promise<void>;
};

async function createStore(
  dialect: (typeof dialects)[number],
): Promise<StoreHandle> {
  if (dialect === "d1") {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    return {
      store: new D1OfferingCatalogStore(db),
      close: async () => {},
    };
  }
  const client = await PGliteSqlClient.create();
  return {
    store: new SqlOfferingCatalogStore(client),
    close: async () => await client.close(),
  };
}

function catalog(
  id: string,
  profile: string,
  effectiveAt: string,
): OfferingCatalog {
  return {
    id,
    version: "v1",
    effectiveAt,
    offerings: [
      {
        id: "endpoint",
        version: "v1",
        subject: {
          type: "services.example.test/v1/Endpoint",
          ref: `${id}/endpoint`,
          version: "v1",
          digest: `sha256:${"a".repeat(64)}`,
        },
        requirements: [],
        profile,
        region: "global",
        maturity: "stable",
        audience: { public: true },
        status: "active",
      },
    ],
  };
}
