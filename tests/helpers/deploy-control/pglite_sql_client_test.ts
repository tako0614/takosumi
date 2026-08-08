import { expect, test } from "bun:test";

import { PGliteSqlClient } from "./pglite_sql_client.ts";

test("PGliteSqlClient gives each caller an isolated migrated database", async () => {
  const first = await PGliteSqlClient.create();
  const second = await PGliteSqlClient.create();
  try {
    await first.exec(
      "create table pglite_fixture_isolation (value text)",
    );
    await first.exec(
      "insert into pglite_fixture_isolation (value) values ('first')",
    );

    expect(
      (await first.rawQuery<{ value: string }>(
        "select value from pglite_fixture_isolation",
      )).rows,
    ).toEqual([{ value: "first" }]);
    expect(
      (await second.rawQuery<{ relation: string | null }>(
        "select to_regclass('public.pglite_fixture_isolation') as relation",
      )).rows,
    ).toEqual([{ relation: null }]);
  } finally {
    await first.close();
    await second.close();
  }
});

test("PGliteSqlClient closes its PGlite runtime promptly", async () => {
  const client = await PGliteSqlClient.create();
  expect(client.closed).toBe(false);

  await client.close();

  expect(client.closed).toBe(true);
  await expect(client.query("select 1")).rejects.toThrow("PGlite is closed");
});
