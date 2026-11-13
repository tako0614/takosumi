import { expect, test } from "bun:test";
import { D1_ACCOUNTS_STORE_INIT_SQL } from "../../../../accounts/service/src/d1-store.ts";
import {
  advanceD1RefreshRetentionCheckpoint,
  readD1RefreshRetentionCheckpoint,
} from "../../../../accounts/service/src/refresh-chain-retention-d1.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

test("retention checkpoint survives restart and fences stale overlapping progress and reset", async () => {
  const db = new SqliteFakeD1();
  await db.exec(D1_ACCOUNTS_STORE_INIT_SQL);
  const initial = await readD1RefreshRetentionCheckpoint(db);
  expect(initial).toEqual({ generation: 0 });
  const cursor = { phase: "chain_links" as const, after: '[100,"held-parent"]' };
  expect(await advanceD1RefreshRetentionCheckpoint(db, initial, cursor)).toBe(true);
  const resumed = await readD1RefreshRetentionCheckpoint(db);
  expect(resumed).toEqual({ generation: 1, cursor });
  expect(await advanceD1RefreshRetentionCheckpoint(db, initial, undefined)).toBe(false);
  expect(await readD1RefreshRetentionCheckpoint(db)).toEqual(resumed);
  expect(await advanceD1RefreshRetentionCheckpoint(db, resumed, undefined)).toBe(true);
  expect(await advanceD1RefreshRetentionCheckpoint(db, resumed, cursor)).toBe(false);
  expect(await readD1RefreshRetentionCheckpoint(db)).toEqual({ generation: 2 });
});

test("an invalid persisted retention checkpoint is refused without replacing it", async () => {
  const db = new SqliteFakeD1();
  await db.exec(D1_ACCOUNTS_STORE_INIT_SQL);
  const document = JSON.stringify({ generation: -1, cursor: { phase: "unknown" } });
  await db.prepare(`INSERT INTO takosumi_accounts_documents(bucket, key, document, updated_at)
    VALUES ('maintenance_cursors', 'refresh-chain-retention', ?, 0)`).bind(document).run();
  await expect(readD1RefreshRetentionCheckpoint(db)).rejects.toThrow("invalid D1 refresh-chain retention checkpoint");
  const row = await db.prepare(`SELECT document FROM takosumi_accounts_documents
    WHERE bucket = 'maintenance_cursors' AND key = 'refresh-chain-retention'`).first<{ document: string }>();
  expect(row?.document).toBe(document);
});
