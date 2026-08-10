import { expect, test } from "bun:test";
import worker, * as platformWorker from "../../../deploy/platform/worker.ts";
import {
  D1_ACCOUNTS_STORE_INIT_SQL,
  type D1Database,
  type D1ExecResult,
  type D1PreparedStatement,
  type D1Result,
} from "../../../accounts/service/src/d1-store.ts";
import { listD1AccountsMigrations } from "../../../cli/src/cli-accounts-db.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

test("platform Worker exposes only handler-compatible runtime exports", () => {
  expect(worker).toBeDefined();
  expect(typeof worker.fetch).toBe("function");

  for (const [name, value] of Object.entries(platformWorker)) {
    if (name === "default") continue;
    expect(typeof value, `${name} must be a Worker RPC handler or class`).toBe(
      "function",
    );
  }
});

test("platform exports its already-composed Capsule execution authority", async () => {
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "capsule-authority-token",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_ENVIRONMENT: "test",
  } as never;

  const first = await platformWorker.platformCapsuleExecutionAuthority(env);
  const second = await platformWorker.platformCapsuleExecutionAuthority(env);

  expect(second).toBe(first);
  expect(typeof first.resolveExactMany).toBe("function");
  await expect(
    first.resolveExactMany([
      { workspaceId: "workspace_missing", capsuleId: "capsule_missing" },
    ]),
  ).resolves.toEqual([undefined]);
});

test("platform scheduled Accounts retention runs a bounded predeployed slice", async () => {
  const db = new SqliteFakeD1();
  await db.exec(D1_ACCOUNTS_STORE_INIT_SQL);
  const retentionMigration = listD1AccountsMigrations().find(
    (migration) => migration.name === "refresh_chain_retention_indexes",
  );
  await db.exec(retentionMigration!.sql);
  await insertDocument(db, "refresh_chain_links", "old-parent", {
    parentHash: "old-parent",
    childHash: "old-child",
    rootHash: "old-parent",
    createdAt: 1,
  });
  const predeployedDb = new NoDdlD1Database(db);

  const result = await platformWorker.runScheduledAccountsRefreshChainRetention(
    {
      TAKOSUMI_ACCOUNTS_DB: predeployedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    },
  );

  expect(result.failures).toBe(0);
  expect(result.scanned).toBe(1);
  expect(result.chainLinks).toBe(1);
  expect(result.done).toBe(true);
  expect(predeployedDb.execCount).toBe(0);
});

async function insertDocument(
  db: D1Database,
  bucket: string,
  key: string,
  document: unknown,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(bucket, key, JSON.stringify(document), 1)
    .run();
}

class NoDdlD1Database implements D1Database {
  execCount = 0;

  constructor(private readonly delegate: D1Database) {}

  prepare(query: string): D1PreparedStatement {
    return this.delegate.prepare(query);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    return this.delegate.batch<T>(statements);
  }

  exec(_query: string): Promise<D1ExecResult> {
    this.execCount += 1;
    return Promise.reject(new Error("request-time schema DDL is forbidden"));
  }
}
