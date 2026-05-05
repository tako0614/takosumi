import { Command } from "@cliffy/command";
import { dirname } from "@std/path";

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
    .description("Scaffold a Takosumi manifest")
    .option(
      "--template <name:string>",
      "Template (selfhosted-single-vm | empty)",
      { default: "selfhosted-single-vm" },
    )
    .option("--project", "Write the standard .takosumi/manifest.yml layout")
    .arguments("[output:string]")
    .action(async ({ template, project }, output) => {
      const content = TEMPLATES[template as keyof typeof TEMPLATES] ??
        TEMPLATES.empty;
      const target = project ? output ?? ".takosumi/manifest.yml" : output;
      if (target) {
        if (project) await Deno.mkdir(dirname(target), { recursive: true });
        await Deno.writeTextFile(target, content);
        console.log(`wrote ${target}`);
      } else {
        console.log(content);
      }
    });
}

export const initCommand: ReturnType<typeof createInitCommand> =
  createInitCommand();
