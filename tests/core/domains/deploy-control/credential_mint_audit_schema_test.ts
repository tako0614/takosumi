import { expect, test } from "bun:test";
import type { CredentialMintEvent } from "takosumi-contract/security";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient, splitSqlStatements } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";

const event: CredentialMintEvent = {
  id: "mint_authority", runId: "run", workspaceId: "workspace", capsuleId: "app",
  connectionId: "connection", phase: "plan", capabilities: [],
  actorAccountId: "member", connectionOwnerAccountId: "owner", ownershipEpoch: 3,
  createdAt: "2026-10-29T00:00:00.000Z",
};

test("mint audit uses migrated PostgreSQL and the additive D1 schema bridge", async () => {
  for (const current of [false, true]) {
    const pg = current ? await PGliteSqlClient.create()
      : await PGliteSqlClient.createThroughMigrationVersion(122);
    try {
      if (!current) {
        // PostgreSQL hosts apply additive migrations before constructing the
        // current runtime; D1 separately retains its pre-expansion bridge.
        for (const migration of postgresStorageMigrationStatements.filter((entry) => entry.version > 122)) {
          for (const statement of splitSqlStatements(migration.sql)) await pg.query(statement);
        }
      }
      const sql = new SqlOpenTofuControlStore({ client: pg });
      const d1 = new SqliteFakeD1();
      await ensureD1OpenTofuLedgerSchema(d1, current ? {} : { throughMigrationVersion: 75 });
      const worker = new CloudflareD1OpenTofuControlStore(d1, { schemaMode: "predeployed" });
      for (const store of [sql, worker]) {
        expect(await store.putCredentialMintEvent(event)).toEqual(event);
        expect(await store.listCredentialMintEventsForRun(event.runId)).toEqual([event]);
      }
      const expected = { actor_account_id: "member", connection_owner_account_id: "owner", ownership_epoch: 3 };
      expect((await pg.query(`select actor_account_id,connection_owner_account_id,ownership_epoch
        from takosumi_credential_mint_events where id=$1`, [event.id])).rows[0]).toEqual(expected);
      if (current) {
        expect(await d1.prepare(`select actor_account_id,connection_owner_account_id,ownership_epoch
          from credential_mint_events where id=?`).bind(event.id).first()).toEqual(expected);
      }
    } finally { await pg.close(); }
  }
}, 30_000);
