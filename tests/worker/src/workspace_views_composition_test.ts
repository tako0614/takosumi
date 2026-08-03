import { expect, test } from "bun:test";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../worker/src/bindings.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
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
  // This empty bootstrap-mode fixture currently uses ten physical D1 reads:
  // request admission + absent-fence probe, Workspace, member, Resource page,
  // Capsule page, definition page, activation page, and two TargetPool reads.
  // It deliberately does not pretend the generic Form provider is one SQL
  // statement. A non-empty Resource page adds one bounded lock batch; each
  // returned Form currently adds its package-evidence read.
  expect(db.preparedQueries).toHaveLength(10);

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
  expect(db.preparedQueries).toHaveLength(20);
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
