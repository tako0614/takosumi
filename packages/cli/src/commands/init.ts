import { Command } from "@cliffy/command";

const TEMPLATES = {
  "selfhosted-single-vm": `apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/selfhost-postgres"
    spec: { version: "16", size: small }
  - shape: object-store@v1
    name: assets
    provider: "@takos/selfhost-filesystem"
    spec: { name: api-assets }
  - shape: web-service@v1
    name: api
    provider: "@takos/selfhost-docker-compose"
    spec:
      image: oci://ghcr.io/me/api:latest
      port: 8080
      scale: { min: 1, max: 1 }
      bindings:
        DATABASE_URL: "\${ref:db.connectionString}"
        ASSETS_BUCKET: "\${ref:assets.bucket}"
`,
  empty: `apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
resources: []
`,
} as const;

function createInitCommand() {
  return new Command()
    .description(
      "Scaffold a Takosumi manifest. Writes to <output> when given, " +
        "otherwise prints to stdout. Project-layout scaffolding " +
        "(.takosumi/manifest.yml) is provided by takosumi-git.",
    )
    .option(
      "--template <name:string>",
      "Template (selfhosted-single-vm | empty)",
      { default: "selfhosted-single-vm" },
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
