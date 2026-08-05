import { expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import type { SqlClient } from "../../../../core/adapters/storage/sql.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { createD1ResourceShapeStores } from "../../../../core/domains/resource-shape/d1_stores.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import { createSqlResourceShapeStores } from "../../../../core/domains/resource-shape/sql_stores.ts";
import {
  D1WorkspaceResourcesProjectionReader,
  SqlWorkspaceResourcesProjectionReader,
} from "../../../../core/domains/workspace-views/mod.ts";
import type { D1Like } from "../../../../core/domains/resource-shape/d1_stores.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const WORKSPACE_ID = "workspace_projection";
const TS = "2026-08-03T00:00:00.000Z";

test("D1 and Postgres Workspace resources projections keep parity at two statements independent of row count", async () => {
  const d1 = new CountingD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  const d1Resources = createD1ResourceShapeStores(d1);
  const d1Control = new CloudflareD1OpenTofuControlStore(d1);
  const postgres = await PGliteSqlClient.create();
  const postgresQueries: string[] = [];
  const sqlClient: SqlClient = {
    query(sql, parameters) {
      postgresQueries.push(sql);
      return postgres.query(sql, parameters);
    },
    transaction(fn) {
      return postgres.transaction(fn);
    },
  };
  const sqlResources = createSqlResourceShapeStores(sqlClient);
  const sqlControl = new SqlOpenTofuControlStore({ client: sqlClient });
  const d1Reader = new D1WorkspaceResourcesProjectionReader(d1);
  const sqlReader = new SqlWorkspaceResourcesProjectionReader(sqlClient);

  try {
    for (const total of [1, 25]) {
      for (let index = total === 1 ? 0 : 1; index < total; index += 1) {
        const resource = resourceFixture(index);
        const lock = lockFixture(resource.id);
        const capsule = capsuleFixture(index);
        await Promise.all([
          d1Resources.resources.upsert(resource),
          d1Resources.locks.put(lock),
          d1Control.putCapsule(capsule),
          sqlResources.resources.upsert(resource),
          sqlResources.locks.put(lock),
          sqlControl.putCapsule(capsule),
        ]);
      }

      d1.resetCounts();
      postgresQueries.length = 0;
      const input = {
        workspaceId: WORKSPACE_ID,
        space: WORKSPACE_ID,
        resources: { limit: 100 },
        workloads: { limit: 100 },
      } as const;
      const [d1Projection, sqlProjection] = await Promise.all([
        d1Reader.read(input),
        sqlReader.read(input),
      ]);

      expect(d1Projection).toEqual(sqlProjection);
      expect(d1Projection.resources.items).toHaveLength(total);
      expect(d1Projection.workloads.items).toHaveLength(total);
      expect(d1Projection.resources.items[0]).toMatchObject({
        metadata: { labels: { public: "yes" } },
        status: {
          resolution: {
            selectedImplementation: "cloudflare_workers",
            portability: "mostly_portable",
          },
        },
      });
      expect(d1Projection.workloads.items[0]).not.toHaveProperty(
        "currentOutputId",
      );
      expect(d1Projection.workloads.items[0]).not.toHaveProperty(
        "installingPrincipalId",
      );
      expect(d1.preparedQueries).toHaveLength(2);
      expect(d1.batchSizes).toEqual([2]);
      expect(postgresQueries).toHaveLength(2);
    }

    d1.resetCounts();
    postgresQueries.length = 0;
    const exhausted = {
      workspaceId: WORKSPACE_ID,
      space: WORKSPACE_ID,
      resources: null,
      workloads: null,
    } as const;
    expect(await d1Reader.read(exhausted)).toEqual({
      resources: { items: [] },
      workloads: { items: [] },
    });
    expect(await sqlReader.read(exhausted)).toEqual({
      resources: { items: [] },
      workloads: { items: [] },
    });
    expect(d1.preparedQueries).toEqual([]);
    expect(d1.batchSizes).toEqual([]);
    expect(postgresQueries).toEqual([]);
  } finally {
    await postgres.close();
  }
});

test("D1 Workspace projection fails closed on incomplete batch evidence", async () => {
  const statement = {
    bind() {
      return statement;
    },
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({}),
  };
  const db = {
    prepare: () => statement,
    batch: async () => [{}],
  } as unknown as D1Like;
  const reader = new D1WorkspaceResourcesProjectionReader(db);

  await expect(
    reader.read({
      workspaceId: WORKSPACE_ID,
      space: WORKSPACE_ID,
      resources: { limit: 25 },
      workloads: null,
    }),
  ).rejects.toThrow("incomplete batch evidence");
});

class CountingD1 extends SqliteFakeD1 {
  readonly preparedQueries: string[] = [];
  readonly batchSizes: number[] = [];

  override prepare(query: string): D1PreparedStatement {
    this.preparedQueries.push(query);
    return super.prepare(query);
  }

  override batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.batchSizes.push(statements.length);
    return super.batch<T>(statements);
  }

  resetCounts(): void {
    this.preparedQueries.length = 0;
    this.batchSizes.length = 0;
  }
}

function resourceFixture(index: number): ResourceShapeRecord {
  const suffix = String(index).padStart(3, "0");
  return {
    id: `tkrn:${WORKSPACE_ID}:EdgeWorker:resource-${suffix}`,
    spaceId: WORKSPACE_ID,
    kind: "EdgeWorker",
    name: `resource-${suffix}`,
    managedBy: "opentofu",
    spec: { privateInput: `secret-${suffix}` },
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    labels: { public: "yes" },
    createdAt: TS,
    updatedAt: TS,
  };
}

function lockFixture(resourceId: string): ResolutionLockRecord {
  return {
    resourceId,
    selectedImplementation: "cloudflare_workers",
    target: "cloudflare-main",
    locked: true,
    reason: ["fixture"],
    portability: "mostly_portable",
    lockedAt: TS,
    updatedAt: TS,
  };
}

function capsuleFixture(index: number): Capsule {
  const suffix = String(index).padStart(3, "0");
  return {
    id: `capsule-${suffix}`,
    workspaceId: WORKSPACE_ID,
    projectId: `project-${suffix}`,
    name: `capsule-${suffix}`,
    slug: `capsule-${suffix}`,
    sourceId: `source-${suffix}`,
    installConfigId: "install-config",
    installingPrincipalId: "private-installer",
    environment: "production",
    currentStateGeneration: 1,
    currentOutputId: "private-output-pointer",
    status: "active",
    createdAt: TS,
    updatedAt: TS,
  };
}
