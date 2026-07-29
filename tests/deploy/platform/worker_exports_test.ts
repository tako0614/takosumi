import { expect, test } from "bun:test";
import worker, * as platformWorker from "../../../deploy/platform/worker.ts";
import {
  D1_ACCOUNTS_STORE_INIT_SQL,
  type D1Database,
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

  const result =
    await platformWorker.runScheduledAccountsRefreshChainRetention({
      TAKOSUMI_ACCOUNTS_DB: db,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    });

  expect(result.failures).toBe(0);
  expect(result.scanned).toBe(1);
  expect(result.chainLinks).toBe(1);
  expect(result.done).toBe(true);
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
