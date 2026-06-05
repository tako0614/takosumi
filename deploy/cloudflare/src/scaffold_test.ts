import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

const cloudflareRoot = new URL("../", import.meta.url);

test("Cloudflare scaffold wires D1/R2 and the OpenTofu runner container", async () => {
  const wrangler = await readText(new URL("wrangler.toml", cloudflareRoot));

  assert.doesNotMatch(wrangler, /TAKOS_WORKLOAD_CONTAINER/);
  assert.doesNotMatch(wrangler, /TAKOS_SERVICE_CONTAINER/);
  assert.match(wrangler, /no_bundle = true/);
  assert.match(wrangler, /name = "takosumi-cloudflare"/);
  assert.match(wrangler, /takosumi-cloudflare-worker\.mjs/);
  assert.match(wrangler, /bun build --target browser/);
  assert.match(wrangler, /--external cloudflare:workers/);
  assert.match(wrangler, /binding = "TAKOS_D1"/);
  assert.match(wrangler, /binding = "TAKOS_ARTIFACTS"/);
  assert.match(wrangler, /TAKOS_ARTIFACTS_BUCKET_NAME = "takos-artifacts"/);
  assert.match(wrangler, /name = "TAKOS_COORDINATION"/);
  assert.match(wrangler, /binding = "TAKOS_OPENTOFU_RUN_QUEUE"/);
  assert.match(wrangler, /queue = "takosumi-opentofu-runs"/);
  assert.match(wrangler, /name = "TAKOS_OPENTOFU_RUNNER"/);
  assert.match(wrangler, /class_name = "TakosumiOpenTofuRunner"/);
  assert.match(wrangler, /\[\[containers\]\]/);
  assert.match(wrangler, /image = "deploy\/cloudflare\/runner\/Dockerfile"/);
  assert.match(wrangler, /image_build_context = "\.\.\/\.\."/);
  assert.match(wrangler, /new_sqlite_classes = \["TakosCoordinationObject"\]/);
  assert.match(wrangler, /new_sqlite_classes = \["TakosumiOpenTofuRunner"\]/);
});

test("Cloudflare scaffold docs describe PlanRun and ApplyRun routing", async () => {
  const readme = await readText(new URL("README.md", cloudflareRoot));

  assert.match(readme, /plan/);
  assert.match(readme, /apply/);
  assert.match(readme, /destroy/);
  assert.match(readme, /Cloudflare Containers/);
  assert.match(readme, /OpenTofu/);
  assert.match(readme, /\/v1\/plan-runs/);
  assert.match(readme, /\/v1\/apply-runs/);
  assert.match(readme, /operation: "destroy"/);
  assert.match(readme, /\/api\/internal\/v1\/\*/);
  assert.match(readme, /D1/);
  assert.match(readme, /R2/);
  assert.match(readme, /object-storage/);
  assert.match(readme, /opentofu-plan-runs/);
  assert.match(readme, /does not depend on a still-warm runner-local file/);
  assert.doesNotMatch(readme, /five public deploy control endpoints/);
  assert.doesNotMatch(readme, /\/v1\/installations\/dry-run/);
});

test("OpenTofu runner image stays isolated from the Worker browser bundle", async () => {
  const dockerfile = await readText(
    new URL("runner/Dockerfile", cloudflareRoot),
  );
  const server = await readText(new URL("runner/server.ts", cloudflareRoot));

  assert.match(dockerfile, /FROM oven\/bun:1/);
  assert.match(dockerfile, /OPENTOFU_VERSION/);
  assert.match(dockerfile, /apt-get install[\s\S]*\bgit\b/);
  assert.match(dockerfile, /tofu version/);
  assert.match(server, /Bun\.serve/);
  assert.match(server, /Bun\.spawn\(command/);
  assert.match(server, /preparePlanWorkspace/);
  assert.match(server, /prepareApplyWorkspace/);
  assert.match(server, /materializeSource/);
  assert.match(server, /handlePlanArtifactRequest/);
  assert.match(server, /verifyPlanArtifact/);
  assert.match(server, /assertHttpsSourceUrl\(source\.url, "git source url"\)/);
  assert.match(server, /assertHttpsSourceUrl\(source\.url, "prepared source url"\)/);
  assert.match(server, /fetch\(source\.url, \{ redirect: "error" \}\)/);
  assert.match(server, /readResponseBytesWithCap/);
  assert.match(server, /PREPARED_SOURCE_MAX_DECOMPRESSED_BYTES/);
  assert.match(server, /maxSourceArchiveBytes/);
  assert.match(server, /maxSourceDecompressedBytes/);
  assert.match(server, /--no-same-owner/);
  assert.match(server, /--keep-old-files/);
  assert.match(server, /duplicates normalized path/);
  assert.match(server, /unsupported entry type/);
  assert.match(server, /assertRealPathInsideSourceRoot/);
  assert.match(server, /after symlink resolution/);
  assert.match(server, /does not allow local source paths/);
  assert.match(server, /return provider === rule \|\| provider\.endsWith/);
  assert.match(server, /"tofu",\s*"plan"/);
  assert.match(server, /"tofu",\s*"apply"/);
  assert.doesNotMatch(server, /existingWorkspace/);
  assert.doesNotMatch(server, /-auto-approve/);
  assert.doesNotMatch(server, /rule\.endsWith/);
  assert.doesNotMatch(dockerfile.toLowerCase(), new RegExp("de" + "no"));
  assert.doesNotMatch(server.toLowerCase(), new RegExp("de" + "no"));
});

async function readText(path: URL | string): Promise<string> {
  return readFile(path, "utf8");
}
