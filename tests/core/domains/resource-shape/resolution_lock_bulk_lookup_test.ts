import { expect, test } from "bun:test";

import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import type { D1PreparedStatement } from "../../../../worker/src/bindings.ts";
import { createD1ResourceShapeStores } from "../../../../core/domains/resource-shape/d1_stores.ts";
import { createSqlResourceShapeStores } from "../../../../core/domains/resource-shape/sql_stores.ts";
import type { SqlClient } from "../../../../core/adapters/storage/sql.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type { ResolutionLockRecord } from "../../../../core/domains/resource-shape/records.ts";

const TS = "2026-08-03T00:00:00.000Z";

function lock(resourceId: string, implementation: string): ResolutionLockRecord {
  return {
    resourceId,
    selectedImplementation: implementation,
    target: "target-bulk",
    locked: true,
    reason: ["bulk test"],
    lockedAt: TS,
    updatedAt: TS,
  };
}

function batchIds(first: string, second: string): string[] {
  return [
    first,
    second,
    ...Array.from({ length: 98 }, (_, index) => `lock-bulk-missing-${index}`),
  ];
}

class CountingD1 extends SqliteFakeD1 {
  readonly preparedQueries: string[] = [];

  override prepare(query: string): D1PreparedStatement {
    this.preparedQueries.push(query);
    return super.prepare(query);
  }
}

function isResolutionLockBatchQuery(query: string): boolean {
  return /from\s+(?:takosumi_)?resolution_locks\s+where\s+resource_id\s+in\s*\(/iu.test(
    query,
  );
}

test("D1 ResolutionLockStore getMany uses one bounded prepared query", async () => {
  const db = new CountingD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const stores = createD1ResourceShapeStores(db);
  const first = lock("lock-bulk-d1-first", "implementation-first");
  const second = lock("lock-bulk-d1-second", "implementation-second");
  await stores.locks.put(first);
  await stores.locks.put(second);
  db.preparedQueries.length = 0;

  expect(await stores.locks.getMany([])).toEqual([]);
  expect(db.preparedQueries).toEqual([]);

  const read = await stores.locks.getMany(
    batchIds(first.resourceId, second.resourceId),
  );
  expect(
    [...read].sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId),
    ),
  ).toEqual(
    [first, second].sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId),
    ),
  );
  expect(db.preparedQueries.filter(isResolutionLockBatchQuery)).toHaveLength(1);

  await expect(
    stores.locks.getMany(
      Array.from({ length: 101 }, (_, index) => `lock-bulk-d1-limit-${index}`),
    ),
  ).rejects.toThrow("at most 100 ids");
  expect(db.preparedQueries.filter(isResolutionLockBatchQuery)).toHaveLength(1);
});

test("Postgres ResolutionLockStore getMany uses one bounded query", async () => {
  const database = await PGliteSqlClient.create();
  const queries: string[] = [];
  const client: SqlClient = {
    query(sql, parameters) {
      queries.push(sql);
      return database.query(sql, parameters);
    },
    transaction(fn) {
      return database.transaction(fn);
    },
  };
  try {
    const stores = createSqlResourceShapeStores(client);
    const first = lock("lock-bulk-pg-first", "implementation-first");
    const second = lock("lock-bulk-pg-second", "implementation-second");
    await stores.locks.put(first);
    await stores.locks.put(second);
    queries.length = 0;

    expect(await stores.locks.getMany([])).toEqual([]);
    expect(queries).toEqual([]);

    const read = await stores.locks.getMany(
      batchIds(first.resourceId, second.resourceId),
    );
    expect(
      [...read].sort((left, right) =>
        left.resourceId.localeCompare(right.resourceId),
      ),
    ).toEqual(
      [first, second].sort((left, right) =>
        left.resourceId.localeCompare(right.resourceId),
      ),
    );
    expect(queries.filter(isResolutionLockBatchQuery)).toHaveLength(1);

    await expect(
      stores.locks.getMany(
        Array.from({ length: 101 }, (_, index) => `lock-bulk-pg-limit-${index}`),
      ),
    ).rejects.toThrow("at most 100 ids");
    expect(queries.filter(isResolutionLockBatchQuery)).toHaveLength(1);
  } finally {
    await database.close();
  }
});
