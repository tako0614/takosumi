import { Command } from "@cliffy/command";
import { loadManifest } from "../manifest_loader.ts";
import { loadConfig, resolveMode } from "../config.ts";
import { callKernel } from "../remote_client.ts";
import { destroyLocal, expandManifestLocal } from "../local_runner.ts";

/**
 * `takosumi destroy <manifest>` — tear down a previously-applied manifest.
 *
 * Remote mode posts the manifest back to `POST /v1/deployments` with
 * `mode: "destroy"`. Matching the deploy command's URL is intentional: the
 * kernel handles all three lifecycle modes (apply / plan / destroy) on the
 * same path, distinguished by the body's `mode` field. The kernel uses the
 * persisted state from the prior apply to look up the real per-resource
 * handles (ARN / object id / …) so providers see the same handle they
 * returned at deploy time.
 */
export const destroyCommand = new Command()
  .description("Destroy resources declared in a Takosumi manifest")
  .arguments("<manifest:string>")
  .option("--remote <url:string>", "Remote kernel URL")
  .option("--token <token:string>", "Auth token")
  .option(
    "--force",
    "Force destroy by resource name even when no prior apply record exists. " +
      "Safe for self-hosted resources (filesystem, docker, systemd); cloud " +
      "resources whose handle differs from the resource name will likely " +
      "fail to delete.",
  )
  .action(async ({ remote, token, force }, manifestPath) => {
    const manifest = await loadManifest(manifestPath);
    const target = resolveMode({ remote, token }, await loadConfig());
    if (target.mode === "remote") {
      const { status, body } = await callKernel({
        url: target.url,
        token: target.token,
        path: "/v1/deployments",
        body: {
          mode: "destroy",
          manifest: manifest.value,
          ...(force ? { force: true } : {}),
        },
      });
      if (status >= 400) {
        console.error(`kernel returned ${status}:`, body);
        Deno.exit(1);
      }
      console.log("destroy accepted:", body);
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
      console.log("local mode: manifest expanded to zero resources; nothing to destroy");
      return;
    }

    console.log(
      `local mode: destroying ${resources.length} resource(s) in-process`,
    );
    const outcome = await destroyLocal(resources);
    if (outcome.status === "failed-validation") {
      console.error("destroy failed-validation:");
      for (const issue of outcome.issues) {
        console.error(`  - ${issue.path}: ${issue.message}`);
      }
      Deno.exit(1);
    }
    for (const entry of outcome.destroyed) {
      console.log(
        `  ✓ ${entry.name} (${entry.providerId}) → ${entry.handle}`,
      );
    }
    for (const error of outcome.errors) {
      console.error(
        `  ✗ ${error.name} (${error.providerId}) → ${error.handle}: ${error.message}`,
      );
    }
    if (outcome.status === "partial") {
      Deno.exit(1);
    }
  });
