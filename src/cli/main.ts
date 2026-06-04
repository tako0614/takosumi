import { Command } from "./command.ts";
import { serverCommand } from "./commands/server.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { initCommand } from "./commands/init.ts";
import { versionCommand } from "./commands/version.ts";
import { createCompletionsCommand } from "./commands/completions.ts";
import { TAKOSUMI_CLI_VERSION } from "./version.ts";

export type TakosumiCommand = Command;

function createTakosumi(): TakosumiCommand {
  const program = new Command()
    .name("takosumi")
    .description("Takosumi: in-repo operator CLI (server / migrate / init)")
    .version(TAKOSUMI_CLI_VERSION);
  program.addCommand(serverCommand);
  program.addCommand(migrateCommand);
  program.addCommand(initCommand);
  program.addCommand(versionCommand);
  // commander has no bundled shell completion generator (unlike cliffy's
  // CompletionsCommand), so we ship an explicit one that emits per-shell
  // completion scripts for the top-level subcommands.
  program.addCommand(createCompletionsCommand(program));
  return program;
}

export const takosumi: TakosumiCommand = createTakosumi();

if (import.meta.main) {
  await takosumi.parseAsync(process.argv.slice(2), { from: "user" });
}
