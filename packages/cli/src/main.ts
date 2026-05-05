import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { deployCommand } from "./commands/deploy.ts";
import { destroyCommand } from "./commands/destroy.ts";
import { statusCommand } from "./commands/status.ts";
import { planCommand } from "./commands/plan.ts";
import { serverCommand } from "./commands/server.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { initCommand } from "./commands/init.ts";
import { versionCommand } from "./commands/version.ts";
import { runtimeAgentCommand } from "./commands/runtime_agent.ts";
import { artifactCommand } from "./commands/artifact.ts";
import { pluginCommand } from "./commands/plugin.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { TAKOSUMI_CLI_VERSION } from "./version.ts";

function createTakosumi(): Command {
  return (new Command()
    .name("takosumi")
    .description("Takosumi: self-hostable PaaS toolkit")
    .version(TAKOSUMI_CLI_VERSION)
    .command("deploy", deployCommand)
    .command("destroy", destroyCommand)
    .command("status", statusCommand)
    .command("plan", planCommand)
    .command("server", serverCommand)
    .command("migrate", migrateCommand)
    .command("init", initCommand)
    .command("artifact", artifactCommand)
    .command("plugin", pluginCommand)
    .command("doctor", doctorCommand)
    .command("runtime-agent", runtimeAgentCommand)
    .command("version", versionCommand)
    // Cliffy ships shell completion generators for bash / zsh / fish; wiring
    // the bundled subcommand here is the cleanest way to expose
    // `takosumi completions <shell>` without re-implementing the generator.
    .command("completions", new CompletionsCommand())) as unknown as Command;
}

export const takosumi: Command = createTakosumi();

if (import.meta.main) {
  await takosumi.parse(Deno.args);
}
