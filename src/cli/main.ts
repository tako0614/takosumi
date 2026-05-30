import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { installCommand } from "./commands/install.ts";
import { deployCommand } from "./commands/deploy.ts";
import { rollbackCommand } from "./commands/rollback.ts";
import { planCommand } from "./commands/plan.ts";
import { serverCommand } from "./commands/server.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { initCommand } from "./commands/init.ts";
import { versionCommand } from "./commands/version.ts";
import { runtimeAgentCommand } from "./commands/runtime_agent.ts";
import { artifactCommand } from "./commands/artifact.ts";
import { TAKOSUMI_CLI_VERSION } from "./version.ts";

// deno-lint-ignore no-explicit-any
export type TakosumiCommand = Command<any>;

function createTakosumi(): TakosumiCommand {
  return new Command()
    .name("takosumi")
    .description("Takosumi: operator-portable PaaS toolkit")
    .version(TAKOSUMI_CLI_VERSION)
    .command("install", installCommand)
    .command("deploy", deployCommand)
    .command("rollback", rollbackCommand)
    .command("plan", planCommand)
    .command("server", serverCommand)
    .command("migrate", migrateCommand)
    .command("init", initCommand)
    .command("artifact", artifactCommand)
    .command("runtime-agent", runtimeAgentCommand)
    .command("version", versionCommand)
    // Cliffy ships shell completion generators for bash / zsh / fish; wiring
    // the bundled subcommand here is the cleanest way to expose
    // `takosumi completions <shell>` without re-implementing the generator.
    .command("completions", new CompletionsCommand());
}

export const takosumi: TakosumiCommand = createTakosumi();

if (import.meta.main) {
  await takosumi.parse(Deno.args);
}
