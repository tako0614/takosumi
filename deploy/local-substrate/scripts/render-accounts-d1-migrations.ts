import { resolve } from "node:path";
import { listD1AccountsMigrations } from "../../../cli/src/cli-accounts-db.ts";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error(
    "usage: bun render-accounts-d1-migrations.ts <output-json-path>",
  );
}

const migrations = listD1AccountsMigrations().map((migration) => ({
  version: migration.version,
  name: migration.name,
  sql: migration.sql,
}));

await Bun.write(
  resolve(outputPath),
  `${JSON.stringify(
    {
      kind: "takosumi.accounts.local-d1-migrations@v1",
      migrations,
    },
    null,
    2,
  )}\n`,
);
