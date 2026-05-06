import { Command } from "@cliffy/command";

const TEMPLATES = {
  "selfhosted-single-vm": `apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
template:
  template: selfhosted-single-vm@v1
  inputs:
    serviceName: api
    image: oci://ghcr.io/me/api:latest
    port: 8080
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
