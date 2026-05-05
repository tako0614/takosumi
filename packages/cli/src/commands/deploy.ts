import { Command } from "@cliffy/command";
import { loadManifest } from "../manifest_loader.ts";
import { loadConfig, resolveMode } from "../config.ts";
import { callKernel } from "../remote_client.ts";
import { applyLocal, expandManifestLocal, planLocal } from "../local_runner.ts";

function createDeployCommand() {
  return new Command()
    .description("Apply a Takosumi manifest")
    .arguments("<manifest:string>")
    .option("--remote <url:string>", "Remote kernel URL")
    .option("--token <token:string>", "Auth token")
    .option("--dry-run", "Validate only, do not apply")
    .action(async ({ remote, token, dryRun }, manifestPath) => {
      const manifest = await loadManifest(manifestPath);
      console.log(`loaded manifest from ${manifest.path} (${manifest.format})`);

      const target = resolveMode({ remote, token }, await loadConfig());

      if (target.mode === "remote") {
        console.log(`submitting to remote kernel: ${target.url}`);
        const { status, body } = await callKernel({
          url: target.url,
          token: target.token,
          path: "/v1/deployments",
          body: { mode: dryRun ? "plan" : "apply", manifest: manifest.value },
        });
        if (status >= 400) {
          console.error(`kernel returned ${status}:`, body);
          Deno.exit(1);
        }
        console.log(dryRun ? "plan accepted:" : "deployment accepted:", body);
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
      if (resources.length === 0) {
        console.error(
          "manifest expanded to zero resources; nothing to apply",
        );
        Deno.exit(1);
      }

      if (dryRun) {
        console.log(
          `local mode: planning ${resources.length} resource(s) in-process`,
        );
        const outcome = await planLocal(resources);
        if (outcome.status !== "succeeded") {
          console.error(`plan ${outcome.status}:`);
          for (const issue of outcome.issues) {
            console.error(`  - ${issue.path}: ${issue.message}`);
          }
          Deno.exit(1);
        }
        console.log(JSON.stringify({ status: "ok", outcome }, null, 2));
        return;
      }

      console.log(
        `local mode: applying ${resources.length} resource(s) in-process`,
      );
      const outcome = await applyLocal(resources);
      if (outcome.status !== "succeeded") {
        console.error(`apply ${outcome.status}:`);
        for (const issue of outcome.issues) {
          console.error(`  - ${issue.path}: ${issue.message}`);
        }
        Deno.exit(1);
      }
      for (const applied of outcome.applied) {
        console.log(
          `  ✓ ${applied.name} (${applied.providerId}) → ${applied.handle}`,
        );
      }
    });
}

export const deployCommand: ReturnType<typeof createDeployCommand> =
  createDeployCommand();
