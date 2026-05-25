import { Command } from "@cliffy/command";

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
    listen:
      db:
        from: db.connection
        as: env
        prefix: DB
      assets:
        from: assets.bucket
        as: env
        prefix: ASSETS

  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      connection:
        as: service-binding

  assets:
    kind: object-store
    spec:
      name: my-app-assets
    publish:
      bucket:
        as: object-store
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
