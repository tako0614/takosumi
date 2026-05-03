import { Command } from "@cliffy/command";
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

export const takosumi = new Command()
  .name("takosumi")
  .description("Takosumi: self-hostable PaaS toolkit")
  .version("0.7.0")
  .command("deploy", deployCommand)
  .command("destroy", destroyCommand)
  .command("status", statusCommand)
  .command("plan", planCommand)
  .command("server", serverCommand)
  .command("migrate", migrateCommand)
  .command("init", initCommand)
  .command("artifact", artifactCommand)
  .command("runtime-agent", runtimeAgentCommand)
  .command("version", versionCommand);

if (import.meta.main) {
  await takosumi.parse(Deno.args);
}
