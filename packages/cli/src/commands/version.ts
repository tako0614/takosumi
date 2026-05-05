import { Command } from "@cliffy/command";

const VERSION = "0.1.0";

function createVersionCommand() {
  return new Command()
    .description("Show takosumi CLI version")
    .action(() => {
      console.log(`takosumi ${VERSION}`);
    });
}

export const versionCommand: ReturnType<typeof createVersionCommand> =
  createVersionCommand();
