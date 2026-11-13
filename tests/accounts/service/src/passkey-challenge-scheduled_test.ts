import { expect, test } from "bun:test";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { runScheduledAccountsPasskeyChallengeRetention } from "../../../../deploy/platform/worker.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

test("scheduled passkey cleanup resumes held pages without runtime DDL and isolates invalid state", async () => {
  const db = new SqliteFakeD1();
  const store = new D1AccountsStore(db);
  await store.initialize();
  const now = Date.now();
  for (let n = 0; n < 65; n++) await store.savePasskeyChallenge(
    `a-held-${String(n).padStart(2, "0")}`, "live", now + 600_000,
  );
  await store.savePasskeyChallenge("z-expired", "expired", now - 1);
  let ddl = 0;
  const port: D1Database = {
    prepare(sql) {
      if (/^\s*(?:CREATE|ALTER|DROP)\b/i.test(sql)) { ddl++; throw new Error("runtime DDL"); }
      return db.prepare(sql);
    },
    batch: (statements) => db.batch(statements),
    exec: async () => { ddl++; throw new Error("runtime DDL"); },
  };
  const env = { TAKOSUMI_ACCOUNTS_DB: port, TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed" };
  expect(await runScheduledAccountsPasskeyChallengeRetention(env)).toEqual({ scanned: 64, deleted: 0, failures: 0 });
  expect(await runScheduledAccountsPasskeyChallengeRetention(env)).toEqual({ scanned: 2, deleted: 1, failures: 0 });
  expect(await store.consumePasskeyChallenge("a-held-00", Date.now())).toBe("live");
  await db.prepare(`UPDATE takosumi_accounts_documents SET document = ?
    WHERE bucket = 'maintenance_cursors' AND key = 'passkey-challenges-v1'`)
    .bind(JSON.stringify({ generation: -1, after: "" })).run();
  expect(await runScheduledAccountsPasskeyChallengeRetention(env)).toEqual({ scanned: 0, deleted: 0, failures: 1 });
  const checkpoint = await db.prepare(`SELECT document FROM takosumi_accounts_documents
    WHERE bucket = 'maintenance_cursors' AND key = 'passkey-challenges-v1'`).first<{ document: string }>();
  expect(JSON.parse(checkpoint!.document).generation).toBe(-1);
  expect(ddl).toBe(0);
});
