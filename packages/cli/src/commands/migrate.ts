import { Command } from "@cliffy/command";

export const migrateCommand = new Command()
  .description("Run Takosumi DB migrations")
  .option("--dry-run", "Show planned migrations without applying")
  .action(async ({ dryRun }) => {
    const args = ["run", "-A"];
    if (dryRun) args.push("scripts/db-migrate.ts", "--dry-run");
    else args.push("scripts/db-migrate.ts");
    console.log("delegating to kernel scripts/db-migrate.ts");
    console.log(
      "hint: cd packages/kernel && deno task " +
        (dryRun ? "db:migrate:dry-run" : "db:migrate"),
    );
  });
