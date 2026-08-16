import { expect, test } from "bun:test";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../worker/src/bindings.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
import {
  acquireControlD1MaintenanceFence,
  releaseControlD1MaintenanceFence,
} from "../../../worker/src/d1_schema_maintenance.ts";
import { createWorkerServiceApp } from "../../../worker/src/worker_service.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

test("cached Worker composition exposes WorkspaceViews with one fresh request admission per read", async () => {
  const db = new MaintenanceReadRecordingD1(new SqliteFakeD1());
  await ensureD1OpenTofuLedgerSchema(db);
  const { operations } = await createWorkerServiceApp(
    {
      TAKOSUMI_CONTROL_DB: db,
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "test-deploy-control-token",
    } as unknown as CloudflareWorkerEnv,
    "takosumi-api",
    { operatorInstallConfigs: [] },
  );
  const workspace = await operations.workspaces.createWorkspace({
    handle: "workspace-view-test",
    displayName: "Workspace View Test",
    type: "organization",
    ownerUserId: "owner_1",
  });

  expect(operations.workspaceViews).toBeDefined();
  db.resetMaintenanceReads();
  const first = await operations.workspaceViews!.readResources({
    workspaceId: workspace.id,
    space: workspace.id,
    subject: "owner_1",
    requiredAccess: "read",
    page: { limit: 25 },
  });
  expect(first).toMatchObject({
    view: "resources.v1",
    workspaceId: workspace.id,
    space: workspace.id,
    resources: { items: [] },
    workloads: { items: [] },
    forms: { items: [] },
    hasTargetPool: false,
  });
  expect(db.maintenanceReads).toBe(1);
  // Fixed cold-path statement budget for an empty first page: request
  // admission + absent-fence probe, Workspace, member, one Resource+Lock join,
  // one Capsule read, one definition page, and one TargetPool read.
  expect(db.preparedQueries).toHaveLength(8);

  await operations.workspaceViews!.readResources({
    workspaceId: workspace.id,
    space: workspace.id,
    subject: "owner_1",
    requiredAccess: "read",
    page: { limit: 25 },
  });
  // A cached service/request store would keep this at one. The Worker wiring
  // creates a new request-scoped store, and therefore a fresh durable
  // maintenance admission, for the second application read.
  expect(db.maintenanceReads).toBe(2);
  expect(db.preparedQueries).toHaveLength(16);
});

test("predeployed schema proof completes at composition and stays outside cold and warm view reads", async () => {
  const raw = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(raw);
  const fence = await acquireControlD1MaintenanceFence(
    raw,
    {
      sourceCommit: "a".repeat(40),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      environment: "workspace-view-composition-test",
      databaseRole: "in_place",
      releasePolicy: "in_place",
    },
    "2026-08-05T00:00:00.000Z",
  );
  await releaseControlD1MaintenanceFence(
    raw,
    fence,
    "2026-08-05T00:01:00.000Z",
  );
  const seededStore = new CloudflareD1OpenTofuControlStore(raw);
  await seededStore.putWorkspace({
    id: "workspace_predeployed_view",
    handle: "predeployed-view",
    displayName: "Predeployed View",
    type: "organization",
    ownerUserId: "owner_1",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  });
  const db = new MaintenanceReadRecordingD1(raw);
  const { operations } = await createWorkerServiceApp(
    {
      TAKOSUMI_CONTROL_DB: db,
      TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "test-deploy-control-token",
    } as unknown as CloudflareWorkerEnv,
    "takosumi-api",
    { operatorInstallConfigs: [] },
  );

  expect(schemaReadinessQueryCount(db.preparedQueries)).toBeGreaterThan(0);
  db.resetMaintenanceReads();
  for (let request = 0; request < 2; request += 1) {
    await operations.workspaceViews!.readResources({
      workspaceId: "workspace_predeployed_view",
      space: "workspace_predeployed_view",
      subject: "owner_1",
      requiredAccess: "read",
      page: { limit: 25 },
    });
    expect(schemaReadinessQueryCount(db.preparedQueries)).toBe(0);
    // Predeployed mode keeps both the request admission and the Workspace
    // record in a co-read maintenance snapshot. Neither read reopens the
    // schema proof after composition.
    expect(db.maintenanceReads).toBe((request + 1) * 2);
  }
});

class MaintenanceReadRecordingD1 implements D1Database {
  maintenanceReads = 0;
  readonly preparedQueries: string[] = [];

  constructor(private readonly delegate: D1Database) {}

  prepare(query: string): D1PreparedStatement {
    this.preparedQueries.push(query);
    if (/from\s+_takosumi_control_schema_maintenance\b/iu.test(query)) {
      this.maintenanceReads += 1;
    }
    return this.delegate.prepare(query);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    return this.delegate.batch<T>(statements);
  }

  resetMaintenanceReads(): void {
    this.maintenanceReads = 0;
    this.preparedQueries.length = 0;
  }
}

function schemaReadinessQueryCount(queries: readonly string[]): number {
  return queries.filter(
    (query) =>
      /pragma_table_info\s*\(\s*['"]schema_migrations['"]\s*\)/iu.test(
        query,
      ) || /from\s+schema_migrations\s+order\s+by\s+version/iu.test(query),
  ).length;
}
