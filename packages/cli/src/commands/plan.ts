import { Command } from "@cliffy/command";
import { loadConfig, resolveMode } from "../config.ts";
import { expandManifestLocal, planLocal } from "../local_runner.ts";
import { loadManifest, selectManifestPath } from "../manifest_loader.ts";
import { callKernel } from "../remote_client.ts";

function createPlanCommand() {
  return new Command()
    .description(
      "Validate a Takosumi manifest without applying (path is required; " +
        "project-layout discovery is provided by takosumi-git)",
    )
    .arguments("[manifest:string]")
    .option(
      "--manifest <path:string>",
      "Manifest path, same as [manifest] (required)",
    )
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Auth token")
    .action(async ({ manifest: manifestFlag, remote, token }, manifestPath) => {
      const manifest = await loadManifest(selectManifestPath({
        argument: manifestPath,
        flag: manifestFlag,
      }));
      console.log(`loaded manifest from ${manifest.path} (${manifest.format})`);

      const target = resolveMode({ remote, token }, await loadConfig());
      if (target.mode === "remote") {
        console.log(`requesting plan from remote kernel: ${target.url}`);
        const { status, body } = await callKernel({
          url: target.url,
          token: target.token,
          path: "/v1/deployments",
          body: { mode: "plan", manifest: manifest.value },
        });
        if (status >= 400) {
          console.error(`kernel returned ${status}:`, body);
          Deno.exit(1);
        }
        console.log(JSON.stringify(body, null, 2));
        return;
      }

      let resources;
      try {
        resources = expandManifestLocal(manifest.value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`error: ${message}`);
        Deno.exit(1);
      }

      const outcome = await planLocal(resources);
      if (outcome.status !== "succeeded") {
        console.error(`plan ${outcome.status}:`);
        for (const issue of outcome.issues) {
          console.error(`  - ${issue.path}: ${issue.message}`);
        }
        Deno.exit(1);
      }
      console.log(JSON.stringify({ status: "ok", outcome }, null, 2));
    });
}

export const planCommand: ReturnType<typeof createPlanCommand> =
  createPlanCommand();
