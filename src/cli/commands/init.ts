import { Command } from "../command.ts";
import { writeTextFile } from "../runtime.ts";

const TEMPLATES = {
  package: `{
  "name": "my-app",
  "version": "0.1.0",
  "description": "Manifestless Takosumi source"
}
`,
} as const;

function createInitCommand(): Command {
  return new Command("init")
    .description(
      "Scaffold generic repository metadata. Writes to <output> when given, " +
        "otherwise prints to stdout.",
    )
    .argument("[output]", "Output file path (prints to stdout when omitted)")
    .option(
      "--template <name>",
      "Scaffold preset (package)",
      "package",
    )
    .action(
      async (output: string | undefined, opts: { template: string }) => {
        const content = TEMPLATES[opts.template as keyof typeof TEMPLATES] ??
          TEMPLATES.package;
        if (output) {
          await writeTextFile(output, content);
          console.log(`wrote ${output}`);
        } else {
          console.log(content);
        }
      },
    ) as Command;
}

export const initCommand: Command = createInitCommand();
