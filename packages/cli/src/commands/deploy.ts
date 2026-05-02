import { Command } from "@cliffy/command";
import type { ManifestResource } from "takosumi-contract";
import { loadManifest } from "../manifest_loader.ts";
import { loadConfig, resolveMode } from "../config.ts";
import { callKernel } from "../remote_client.ts";
import { applyLocal } from "../local_runner.ts";

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

    const resources = extractResources(manifest.value);
    if (resources.length === 0) {
      console.error(
        "manifest has no resources[] (template expansion is not yet wired in local mode)",
      );
      Deno.exit(1);
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

function extractResources(value: unknown): readonly ManifestResource[] {
  if (typeof value !== "object" || value === null) return [];
  const v = value as { resources?: readonly ManifestResource[] };
  return v.resources ?? [];
}
