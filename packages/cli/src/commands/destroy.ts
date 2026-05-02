import { Command } from "@cliffy/command";
import { loadManifest } from "../manifest_loader.ts";
import { loadConfig, resolveMode } from "../config.ts";
import { callKernel } from "../remote_client.ts";

export const destroyCommand = new Command()
  .description("Destroy resources declared in a Takosumi manifest")
  .arguments("<manifest:string>")
  .option("--remote <url:string>", "Remote kernel URL")
  .option("--token <token:string>", "Auth token")
  .action(async ({ remote, token }, manifestPath) => {
    const manifest = await loadManifest(manifestPath);
    const target = resolveMode({ remote, token }, loadConfig());
    if (target.mode === "remote") {
      const { status, body } = await callKernel({
        url: target.url,
        token: target.token,
        path: "/v1/deployments/destroy",
        body: { manifest: manifest.value },
      });
      if (status >= 400) {
        console.error(`kernel returned ${status}:`, body);
        Deno.exit(1);
      }
      console.log("destroy accepted:", body);
      return;
    }
    console.log("local mode: in-process destroy (not yet wired)");
  });
