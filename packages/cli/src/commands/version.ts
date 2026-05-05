import { Command } from "@cliffy/command";
import { TAKOSUMI_CLI_VERSION } from "../version.ts";

function createVersionCommand() {
  return new Command()
    .description("Show takosumi CLI version")
    .action(() => {
      console.log(`takosumi ${TAKOSUMI_CLI_VERSION}`);
    });
}

export const versionCommand: ReturnType<typeof createVersionCommand> =
  createVersionCommand();
