import { Command } from "../command.ts";
import { TAKOSUMI_CLI_VERSION } from "../version.ts";

function createVersionCommand(): Command {
  return new Command("version")
    .description("Show takosumi CLI version")
    .action(() => {
      console.log(`takosumi ${TAKOSUMI_CLI_VERSION}`);
    }) as Command;
}

export const versionCommand: Command = createVersionCommand();
