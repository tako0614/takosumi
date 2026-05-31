import { Command } from "../command.ts";

const TEMPLATES = {
  "worker-postgres": `apiVersion: v1

metadata:
  id: com.example.my-app
  name: My App

components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
      compatibilityDate: "2025-01-01"
    connect:
      db:
        output: db.connection
        inject: env
        prefix: DB
      assets:
        output: assets.bucket
        inject: env
        prefix: ASSETS

  db:
    kind: postgres
    spec:
      version: "16"
      size: small

  assets:
    kind: object-store
    spec:
      name: my-app-assets
`,
  empty: `apiVersion: v1

metadata:
  id: com.example.my-app
  name: My App

components:
  app:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
`,
} as const;

function createInitCommand(): Command {
  return new Command("init")
    .description(
      "Scaffold a Takosumi AppSpec. Writes to <output> when given, " +
        "otherwise prints to stdout.",
    )
    .argument("[output]", "Output file path (prints to stdout when omitted)")
    .option(
      "--template <name>",
      "Scaffold preset (worker-postgres | empty)",
      "worker-postgres",
    )
    .action(
      async (output: string | undefined, opts: { template: string }) => {
        const content = TEMPLATES[opts.template as keyof typeof TEMPLATES] ??
          TEMPLATES.empty;
        if (output) {
          await Deno.writeTextFile(output, content);
          console.log(`wrote ${output}`);
        } else {
          console.log(content);
        }
      },
    ) as Command;
}

export const initCommand: Command = createInitCommand();
