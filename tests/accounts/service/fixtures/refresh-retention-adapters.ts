import { PGlite } from "@electric-sql/pglite";
import { D1AccountsStore } from "../../../../accounts/service/src/d1-store.ts";
import { loadD1AccountsMigrationCatalog } from "../../../../accounts/service/src/d1-migrations.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { InMemoryAccountsStore, type AccountsStore } from "../../../../accounts/service/src/store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

export type RetentionBackend = "memory" | "d1" | "postgres";

export async function createRetentionAdapter(backend: RetentionBackend): Promise<{
  store: AccountsStore;
  d1?: SqliteFakeD1;
  postgres?: PGlite;
  close(): Promise<void>;
}> {
  if (backend === "memory") return { store: new InMemoryAccountsStore(), close: async () => {} };
  if (backend === "d1") {
    const db = new SqliteFakeD1();
    const store = new D1AccountsStore(db);
    await store.initialize();
    const migration = (await loadD1AccountsMigrationCatalog()).migrations.find(
      (entry) => entry.name === "refresh_chain_retention_indexes",
    );
    if (!migration) throw new Error("retention index migration missing");
    for (const statement of migration.body) await db.prepare(statement.sql).bind(...statement.params).run();
    return { store, d1: db, close: async () => {} };
  }
  const db = new PGlite();
  try {
    // Narrow OAuth tables, with the same columns as the owning token adapter.
    // Real chain migrations and native PostgreSQL SQL execute below. This does
    // not claim a complete migration rehearsal or multiwriter PostgreSQL proof.
    await db.exec(`CREATE SCHEMA accounts_v1;
      CREATE TABLE accounts_v1.authorization_codes (
        code_hash text PRIMARY KEY, client_id text, redirect_uri text, scope text,
        subject text, takosumi_subject text, capsule_id text, workspace_id text,
        role text, nonce text, code_challenge text, code_challenge_method text,
        created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE TABLE accounts_v1.oauth_access_tokens (
        token_hash text PRIMARY KEY, client_id text, audience text, scope text,
        subject text, takosumi_subject text, capsule_id text, workspace_id text,
        role text, interface_id text, interface_binding_id text,
        interface_resolved_revision bigint, created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE accounts_v1.oauth_refresh_tokens (LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);`);
    await db.exec(`CREATE TABLE accounts_v1.personal_access_tokens (
      token_hash text UNIQUE NOT NULL, token_id text PRIMARY KEY, token_prefix text,
      subject text, name text, scopes text[], workspace_id text, app_ids text[],
      created_at timestamptz NOT NULL, expires_at timestamptz, revoked_at timestamptz,
      last_used_at timestamptz
    );`);
    for (const name of ["019_refresh_chain.sql", "021_auth_code_token_links_sentinel.sql", "036_refresh_chain_retention_indexes.sql"]) {
      await db.exec(await Bun.file(new URL(`../../../../accounts/service/migrations/${name}`, import.meta.url)).text());
    }
    const store = new PostgresAccountsStore({
      queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({ rows: (await db.query(sql, [...args])).rows as T[] }),
    });
    return { store, postgres: db, close: () => db.close() };
  } catch (error) {
    await db.close();
    throw error;
  }
}
