import { PGlite } from "@electric-sql/pglite";
import { D1AccountsStore } from "../../../../accounts/service/src/d1-store.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

export async function passkeyAdapter(backend: "memory" | "d1" | "postgres") {
  if (backend === "memory") return { store: new InMemoryAccountsStore(), close: async () => {} };
  if (backend === "d1") {
    const d1 = new SqliteFakeD1();
    const store = new D1AccountsStore(d1);
    await store.initialize();
    return { store, d1, close: async () => {} };
  }
  const postgres = new PGlite();
  try {
    await postgres.exec("CREATE SCHEMA accounts_v1");
    await postgres.exec(await Bun.file(new URL(
      "../../../../accounts/service/migrations/022_passkey_challenges.sql", import.meta.url,
    )).text());
    const store = new PostgresAccountsStore({
      queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({
        rows: (await postgres.query(sql, [...args])).rows as T[],
      }),
    });
    return { store, postgres, close: () => postgres.close() };
  } catch (error) {
    await postgres.close();
    throw error;
  }
}
