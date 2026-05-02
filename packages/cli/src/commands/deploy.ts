import { Command } from "@cliffy/command";
import { loadManifest } from "../manifest_loader.ts";
import { loadConfig, resolveMode } from "../config.ts";
import { callKernel } from "../remote_client.ts";

export const deployCommand = new Command()
  .description("Apply a Takosumi manifest")
  .arguments("<manifest:string>")
  .option("--remote <url:string>", "Remote kernel URL")
  .option("--token <token:string>", "Auth token")
  .option("--dry-run", "Validate only, do not apply")
  .action(async ({ remote, token, dryRun }, manifestPath) => {
    const manifest = await loadManifest(manifestPath);
    console.log(`loaded manifest from ${manifest.path} (${manifest.format})`);

    if (dryRun) {
      console.log(JSON.stringify(manifest.value, null, 2));
      return;
    }

    const target = resolveMode({ remote, token }, loadConfig());

    if (target.mode === "remote") {
      console.log(`submitting to remote kernel: ${target.url}`);
      const { status, body } = await callKernel({
        url: target.url,
        token: target.token,
        path: "/v1/deployments",
        body: { mode: "apply", manifest: manifest.value },
      });
      if (status >= 400) {
        console.error(`kernel returned ${status}:`, body);
        Deno.exit(1);
      }
      console.log("deployment accepted:", body);
      return;
    }

    console.log("local mode: in-process apply (not yet wired)");
    console.log(
      "tip: start the kernel with `takosumi server` and re-run with --remote",
    );
  });
