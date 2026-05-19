import { Command } from "@cliffy/command";

const TEMPLATES = {
  "worker-postgres": `apiVersion: takosumi.dev/v1

metadata:
  id: com.example.my-app
  name: My App

components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      routes:
        - /
    listen:
      com.example.my-app.db:
        as: env
        prefix: DATABASE_
      com.example.my-app.assets:
        as: env
        prefix: ASSETS_

  db:
    kind: postgres
    publish:
      - com.example.my-app.db

  assets:
    kind: object-store
    publish:
      - com.example.my-app.assets
`,
  empty: `apiVersion: takosumi.dev/v1

metadata:
  id: com.example.my-app
  name: My App

components: {}
`,
} as const;

function createInitCommand() {
  return new Command()
    .description(
      "Scaffold a Takosumi AppSpec. Writes to <output> when given, " +
        "otherwise prints to stdout.",
    )
    .option(
      "--template <name:string>",
      "Scaffold preset (worker-postgres | empty)",
      { default: "worker-postgres" },
    )
    .arguments("[output:string]")
    .action(async ({ template }, output) => {
      const content = TEMPLATES[template as keyof typeof TEMPLATES] ??
        TEMPLATES.empty;
      if (output) {
        await Deno.writeTextFile(output, content);
        console.log(`wrote ${output}`);
      } else {
        console.log(content);
      }
    });
}

export const initCommand: ReturnType<typeof createInitCommand> =
  createInitCommand();
