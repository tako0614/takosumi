import { Command } from "@cliffy/command";

const VERSION = "0.1.0";

export const versionCommand = new Command()
  .description("Show takosumi CLI version")
  .action(() => {
    console.log(`takosumi ${VERSION}`);
  });
