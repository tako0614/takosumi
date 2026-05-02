import { Command } from "@cliffy/command";

const TEMPLATES = {
  "selfhosted-single-vm": `apiVersion: takos.dev/hosting/v1
kind: TakosDistribution
metadata:
  name: my-app
template:
  template: takosumi.dev/template/selfhosted-single-vm@v1
  inputs:
    serviceName: api
    image: oci://ghcr.io/me/api:latest
    port: 8080
`,
  empty: `apiVersion: takos.dev/hosting/v1
kind: TakosDistribution
metadata:
  name: my-app
resources: []
`,
} as const;

export const initCommand = new Command()
  .description("Scaffold a Takosumi manifest")
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
