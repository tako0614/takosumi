import { expect, test } from "bun:test";

import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
  CONTROL_D1_PRODUCTION_V66_V69_INTERNAL_GUARD,
  readControlD1MigrationLedger,
  SqliteControlD1Database,
} from "../../../deploy/platform/control_d1_schema.ts";
import { runControlD1SchemaProductionV66V69Cli } from "../../../deploy/platform/control_d1_schema_cli.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../worker/src/bindings.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { readControlD1MaintenanceState } from "../../../worker/src/d1_schema_maintenance.ts";

const SOURCE_COMMIT = "a".repeat(40);
const DATABASE_ID = "production-v66-v69-test-db";
const NOW = "2026-09-23T07:00:00.000Z";

async function targetPlan() {
  return buildControlD1SchemaPlan({ throughMigrationVersion: 69 });
}

function productionApplyOptions(
  overrides: Partial<Parameters<typeof applyControlD1Schema>[2]> = {},
) {
  return {
    sourceCommit: SOURCE_COMMIT,
    environment: "production" as const,
    activatedAt: NOW,
    releasedAt: () => NOW,
    maintenanceDrainMilliseconds: 0,
    waitForRequestDrain: async () => {},
    retainMaintenanceFence: true,
    databaseRole: "in_place" as const,
    releasePolicy: "in_place" as const,
    databaseId: DATABASE_ID,
    internalGuard: CONTROL_D1_PRODUCTION_V66_V69_INTERNAL_GUARD,
    ...overrides,
  };
}

function countingDatabase(database: SqliteControlD1Database) {
  const stats = { batches: 0 };
  const wrapped: D1Database = {
    prepare: (query: string): D1PreparedStatement => database.prepare(query),
    batch: async <T = unknown>(
      statements: readonly D1PreparedStatement[],
    ): Promise<readonly D1Result<T>[]> => {
      stats.batches += 1;
      return database.batch<T>(statements);
    },
  };
  return { database: wrapped, stats };
}

function faultAfterCommittedHead(
  database: SqliteControlD1Database,
  targetHead: 67 | 68,
) {
  let injected = false;
  const stats = { batches: 0 };
  const wrapped: D1Database = {
    prepare: (query: string): D1PreparedStatement => database.prepare(query),
    batch: async <T = unknown>(
      statements: readonly D1PreparedStatement[],
    ): Promise<readonly D1Result<T>[]> => {
      stats.batches += 1;
      const result = await database.batch<T>(statements);
      const row = await database
        .prepare("select max(version) as version from schema_migrations")
        .first<{ readonly version: number | string | null }>();
      if (!injected && Number(row?.version ?? 0) === targetHead) {
        injected = true;
        throw new Error(`fault_after_${targetHead}`);
      }
      return result;
    },
  };
  return { database: wrapped, stats };
}

test("production v66-v69 guard rejects wrong head without creating a fence", async () => {
  const plan = await targetPlan();
  const database = new SqliteControlD1Database();
  const counted = countingDatabase(database);
  try {
    await ensureD1OpenTofuLedgerSchema(database, { throughMigrationVersion: 65 });
    await expect(
      applyControlD1Schema(
        counted.database,
        plan,
        productionApplyOptions(),
      ),
    ).rejects.toMatchObject({ code: "production_v66_v69_ledger_mismatch" });
    expect(counted.stats.batches).toBe(0);
    expect(await readControlD1MaintenanceState(database)).toEqual({
      status: "absent",
    });
  } finally {
    database.close();
  }
});

test("production v66-v69 plan uses the full canonical catalog and rejects future head", async () => {
  const currentPlan = await targetPlan();
  const futurePlan = {
    ...currentPlan,
    migrations: [
      ...currentPlan.migrations,
      {
        version: 70,
        name: "future_test_migration",
        checksum: "future-checksum",
      },
    ],
  };
  let requestedOptions: unknown = "not-called";
  const output: string[] = [];
  const code = await runControlD1SchemaProductionV66V69Cli(
    ["plan", "--environment", "production"],
    {},
    (value) => output.push(value),
    {
      sourceCommit: SOURCE_COMMIT,
      now: () => NOW,
      buildSchemaPlan: async (options) => {
        requestedOptions = options;
        return futurePlan;
      },
    },
  );
  expect(code).toBe(1);
  expect(requestedOptions).toBeUndefined();
  expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
    status: "failed",
    failureCode: "production_v66_v69_plan_target_mismatch",
  });
});

test("production v66-v69 guard rejects future ledger before fence creation", async () => {
  const plan = await targetPlan();
  const database = new SqliteControlD1Database();
  const counted = countingDatabase(database);
  try {
    await ensureD1OpenTofuLedgerSchema(database, { throughMigrationVersion: 69 });
    await database
      .prepare(
        `insert into schema_migrations (version, name, checksum, applied_at)
         values (70, 'future_test_migration', 'future-checksum', ?)`,
      )
      .bind(NOW)
      .run();
    await expect(
      applyControlD1Schema(
        counted.database,
        plan,
        productionApplyOptions(),
      ),
    ).rejects.toMatchObject({
      code: "production_v66_v69_future_ledger_rejected",
    });
    expect(counted.stats.batches).toBe(0);
    expect(await readControlD1MaintenanceState(database)).toEqual({
      status: "absent",
    });
  } finally {
    database.close();
  }
});

test("production v66-v69 accepts an inactive prior release at head66 as a new run", async () => {
  const plan66 = await buildControlD1SchemaPlan({ throughMigrationVersion: 66 });
  const plan69 = await targetPlan();
  const database = new SqliteControlD1Database();
  try {
    await applyControlD1Schema(database, plan66, {
      sourceCommit: SOURCE_COMMIT,
      environment: "production",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: false,
      databaseRole: "in_place",
      releasePolicy: "in_place",
      databaseId: DATABASE_ID,
    });
    expect(await readControlD1MaintenanceState(database)).toEqual({
      status: "inactive",
    });
    const applied = await applyControlD1Schema(
      database,
      plan69,
      productionApplyOptions(),
    );
    expect(applied.appliedMigrationVersions).toEqual(
      plan69.migrations
        .filter((migration) => migration.version > 66)
        .map((migration) => migration.version),
    );
    expect(applied.maintenanceStatus).toBe("retained");
  } finally {
    database.close();
  }
});

test("production v66-v69 guard refuses environment override and retain-false", async () => {
  const plan = await targetPlan();
  const environmentDatabase = new SqliteControlD1Database();
  const retainDatabase = new SqliteControlD1Database();
  const environmentCounted = countingDatabase(environmentDatabase);
  const retainCounted = countingDatabase(retainDatabase);
  try {
    await ensureD1OpenTofuLedgerSchema(environmentDatabase, {
      throughMigrationVersion: 66,
    });
    await ensureD1OpenTofuLedgerSchema(retainDatabase, {
      throughMigrationVersion: 66,
    });
    await expect(
      applyControlD1Schema(
        environmentCounted.database,
        plan,
        productionApplyOptions({ environment: "staging" }),
      ),
    ).rejects.toMatchObject({
      code: "production_v66_v69_environment_fixed",
    });
    await expect(
      applyControlD1Schema(
        retainCounted.database,
        plan,
        productionApplyOptions({ retainMaintenanceFence: false }),
      ),
    ).rejects.toMatchObject({
      code: "production_v66_v69_retain_fence_required",
    });
    expect(environmentCounted.stats.batches).toBe(0);
    expect(retainCounted.stats.batches).toBe(0);
  } finally {
    environmentDatabase.close();
    retainDatabase.close();
  }
});

test("production v66-v69 resumes an exact active fence before v67", async () => {
  const plan = await targetPlan();
  const database = new SqliteControlD1Database();
  let firstDrain = true;
  try {
    await ensureD1OpenTofuLedgerSchema(database, {
      throughMigrationVersion: 66,
    });
    const interrupted = productionApplyOptions({
      waitForRequestDrain: async () => {
        if (firstDrain) {
          firstDrain = false;
          throw new Error("fault_after_fence_before_67");
        }
      },
    });
    await expect(applyControlD1Schema(database, plan, interrupted)).rejects.toThrow(
      "fault_after_fence_before_67",
    );
    expect(await readControlD1MaintenanceState(database)).toMatchObject({
      status: "active",
      fence: {
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        environment: "production",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: DATABASE_ID,
        sourceExportSha256: null,
        predecessor: null,
      },
    });
    expect(
      (await readControlD1MigrationLedger(database)).at(-1)?.version,
    ).toBe(66);

    const resumed = await applyControlD1Schema(
      database,
      plan,
      productionApplyOptions(),
    );
    expect(resumed.appliedMigrationVersions).toEqual(
      plan.migrations
        .filter((migration) => migration.version > 66)
        .map((migration) => migration.version),
    );
    expect(resumed.verification).toMatchObject({
      status: "ready",
      latestMigrationVersion: 69,
    });
  } finally {
    database.close();
  }
});

for (const targetHead of [67, 68] as const) {
  test(`production v66-v69 resumes after committed fault at v${targetHead}`, async () => {
    const plan = await targetPlan();
    const database = new SqliteControlD1Database();
    const faulted = faultAfterCommittedHead(database, targetHead);
    try {
      await ensureD1OpenTofuLedgerSchema(database, {
        throughMigrationVersion: 66,
      });
      const apply = () =>
        applyControlD1Schema(
          faulted.database,
          plan,
          productionApplyOptions(),
        );

      await expect(apply()).rejects.toThrow(`fault_after_${targetHead}`);
      expect(await readControlD1MigrationLedger(database)).toHaveLength(
        plan.migrations.filter((migration) => migration.version <= targetHead)
          .length,
      );
      expect(await readControlD1MaintenanceState(database)).toMatchObject({
        status: "active",
        fence: {
          sourceCommit: SOURCE_COMMIT,
          manifestDigest: plan.manifestDigest,
          environment: "production",
          databaseRole: "in_place",
          releasePolicy: "in_place",
          databaseId: DATABASE_ID,
          sourceExportSha256: null,
          predecessor: null,
        },
      });

      const resumed = await apply();
      expect(resumed.maintenanceStatus).toBe("retained");
      expect(resumed.appliedMigrationVersions).toEqual(
        plan.migrations
          .filter((migration) => migration.version > targetHead)
          .map((migration) => migration.version),
      );
      expect(resumed.verification).toMatchObject({
        status: "ready",
        latestMigrationVersion: 69,
      });
      expect(faulted.stats.batches).toBeGreaterThan(1);
      expect(await readControlD1MaintenanceState(database)).toMatchObject({
        status: "active",
      });
    } finally {
      database.close();
    }
  });
}
