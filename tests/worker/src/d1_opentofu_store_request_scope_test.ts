import { expect, test } from "bun:test";

import {
  acquireControlD1MaintenanceFence,
  releaseControlD1MaintenanceFence,
} from "../../../worker/src/d1_schema_maintenance.ts";
import {
  createCloudflareD1OpenTofuControlStore,
  createCloudflareD1OpenTofuControlStoreForRequest,
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const TEST_FENCE_IDENTITY = {
  sourceCommit: "a".repeat(40),
  manifestDigest: `sha256:${"b".repeat(64)}`,
  environment: "request-scope-test",
  databaseRole: "in_place" as const,
  releasePolicy: "in_place" as const,
};

async function createInactiveMaintenanceDatabase(): Promise<SqliteFakeD1> {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const fence = await acquireControlD1MaintenanceFence(
    db,
    TEST_FENCE_IDENTITY,
    "2026-08-03T00:00:00.000Z",
  );
  await releaseControlD1MaintenanceFence(
    db,
    fence,
    "2026-08-03T00:01:00.000Z",
  );
  return db;
}

function observe(db: SqliteFakeD1, queries: string[]): D1Database {
  return {
    prepare(query) {
      queries.push(query.trim());
      return db.prepare(query);
    },
    batch(statements) {
      return db.batch(statements);
    },
  };
}

function maintenanceReadCount(queries: readonly string[]): number {
  return queries.filter(
    (query) =>
      /_takosumi_control_schema_maintenance/iu.test(query) &&
      /where\s+singleton\s*=\s*1/iu.test(query),
  ).length;
}

function schemaReadinessQueryCount(queries: readonly string[]): number {
  return queries.filter(
    (query) =>
      /pragma_table_info\s*\(\s*['"]schema_migrations['"]\s*\)/iu.test(
        query,
      ) ||
      /from\s+schema_migrations\s+order\s+by\s+version/iu.test(query),
  ).length;
}

test("request-scoped store reuses one maintenance read for hot operations", async () => {
  const db = await createInactiveMaintenanceDatabase();
  const queries: string[] = [];
  const store = createCloudflareD1OpenTofuControlStoreForRequest(
    observe(db, queries),
    { schemaMode: "predeployed" },
  );

  await store.listWorkspaces();
  await store.listWorkspaces();

  expect(maintenanceReadCount(queries)).toBe(1);
});

test("the default store keeps checking the durable fence per operation", async () => {
  const db = await createInactiveMaintenanceDatabase();
  const queries: string[] = [];
  const store = createCloudflareD1OpenTofuControlStore(
    observe(db, queries),
    { schemaMode: "predeployed" },
  );

  await store.listWorkspaces();
  await store.listWorkspaces();

  expect(maintenanceReadCount(queries)).toBe(2);
});

test("request-scoped maintenance evidence does not cross store requests", async () => {
  const db = await createInactiveMaintenanceDatabase();
  const queries: string[] = [];

  const firstRequest = createCloudflareD1OpenTofuControlStoreForRequest(
    observe(db, queries),
    { schemaMode: "predeployed" },
  );
  await firstRequest.listWorkspaces();

  const secondRequest = createCloudflareD1OpenTofuControlStoreForRequest(
    observe(db, queries),
    { schemaMode: "predeployed" },
  );
  await secondRequest.listWorkspaces();

  expect(maintenanceReadCount(queries)).toBe(2);
});

test("warm request stores share binding schema readiness but not maintenance evidence", async () => {
  const db = await createInactiveMaintenanceDatabase();
  const queries: string[] = [];
  const binding = observe(db, queries);

  const firstRequest = createCloudflareD1OpenTofuControlStoreForRequest(
    binding,
    { schemaMode: "predeployed" },
  );
  await firstRequest.listWorkspaces();
  expect(schemaReadinessQueryCount(queries)).toBeGreaterThan(0);

  queries.length = 0;
  const secondRequest = createCloudflareD1OpenTofuControlStoreForRequest(
    binding,
    { schemaMode: "predeployed" },
  );
  await secondRequest.listWorkspaces();

  expect(maintenanceReadCount(queries)).toBe(1);
  expect(schemaReadinessQueryCount(queries)).toBe(0);
});

test("concurrent request stores keep separate admissions while sharing schema readiness", async () => {
  const db = await createInactiveMaintenanceDatabase();
  const queries: string[] = [];
  const binding = observe(db, queries);
  const firstRequest = createCloudflareD1OpenTofuControlStoreForRequest(
    binding,
    { schemaMode: "predeployed" },
  );
  const secondRequest = createCloudflareD1OpenTofuControlStoreForRequest(
    binding,
    { schemaMode: "predeployed" },
  );

  await Promise.all([
    firstRequest.listWorkspaces(),
    secondRequest.listWorkspaces(),
  ]);

  expect(maintenanceReadCount(queries)).toBe(2);
  // The fake binding records one matched ordered-ledger read per verifier. A
  // second verifier would double this count.
  expect(schemaReadinessQueryCount(queries)).toBe(1);
});

test("request-scoped store fails closed on an active fence", async () => {
  const db = await createInactiveMaintenanceDatabase();
  await acquireControlD1MaintenanceFence(
    db,
    TEST_FENCE_IDENTITY,
    "2026-08-03T00:02:00.000Z",
  );
  const store = createCloudflareD1OpenTofuControlStoreForRequest(db, {
    schemaMode: "predeployed",
  });

  await expect(store.listWorkspaces()).rejects.toThrow(
    "maintenance_fence_active",
  );
});

test("request-scoped store fails closed when the fence row is missing", async () => {
  const db = await createInactiveMaintenanceDatabase();
  await db
    .prepare(
      `delete from _takosumi_control_schema_maintenance where singleton = 1`,
    )
    .run();
  const store = createCloudflareD1OpenTofuControlStoreForRequest(db, {
    schemaMode: "predeployed",
  });

  await expect(store.listWorkspaces()).rejects.toThrow(
    "maintenance_fence_invalid",
  );
});

test("request-scoped store fails closed on corrupt fence evidence", async () => {
  const db = await createInactiveMaintenanceDatabase();
  await db
    .prepare(
      `update _takosumi_control_schema_maintenance
       set migration_bypass = 1
       where singleton = 1`,
    )
    .run();
  const store = createCloudflareD1OpenTofuControlStoreForRequest(db, {
    schemaMode: "predeployed",
  });

  await expect(store.listWorkspaces()).rejects.toThrow(
    "maintenance_fence_invalid",
  );
});
