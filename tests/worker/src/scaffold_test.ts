import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

const repoRoot = new URL("../../../", import.meta.url);
const cloudflareRoot = new URL("deploy/cloudflare/", repoRoot);
const platformRoot = new URL("deploy/platform/", repoRoot);
const runnerImageRoot = new URL("runner/", repoRoot);
const workerSrcRoot = new URL("../../../worker/src/", import.meta.url);

test("Cloudflare scaffold wires D1/R2 and the OpenTofu runner container", async () => {
  const wrangler = await readText(new URL("wrangler.toml", cloudflareRoot));
  const workerService = await readText(
    new URL("worker_service.ts", workerSrcRoot),
  );

  assert.doesNotMatch(wrangler, /TAKOS_WORKLOAD_CONTAINER/);
  assert.doesNotMatch(wrangler, /TAKOS_SERVICE_CONTAINER/);
  assert.match(wrangler, /no_bundle = true/);
  assert.match(wrangler, /name = "takosumi-cloudflare"/);
  assert.match(wrangler, /takosumi-cloudflare-worker\.mjs/);
  assert.match(wrangler, /bun build --target browser/);
  assert.match(wrangler, /--external cloudflare:workers/);
  assert.match(wrangler, /binding = "TAKOSUMI_CONTROL_DB"/);
  assert.match(wrangler, /binding = "R2_ARTIFACTS"/);
  assert.match(wrangler, /R2_ARTIFACTS_BUCKET_NAME = "takos-artifacts"/);
  assert.match(wrangler, /TAKOSUMI_RUNTIME_MODE = "cloudflare-worker"/);
  assert.doesNotMatch(wrangler, /TAKOS_RUNTIME_MODE/);
  assert.match(wrangler, /name = "COORDINATION"/);
  assert.match(wrangler, /binding = "RUN_QUEUE"/);
  assert.match(wrangler, /queue = "takosumi-runs"/);
  assert.doesNotMatch(wrangler, /binding = "TAKOS_QUEUE"/);
  assert.doesNotMatch(wrangler, /takosumi-control-plane/);
  assert.match(wrangler, /name = "RUNNER"/);
  assert.match(wrangler, /class_name = "OpenTofuRunnerObject"/);
  assert.match(wrangler, /\[\[containers\]\]/);
  assert.match(wrangler, /image = "runner\/Dockerfile"/);
  assert.match(wrangler, /image_build_context = "\.\.\/\.\."/);
  assert.match(wrangler, /new_sqlite_classes = \["CoordinationObject"\]/);
  assert.match(wrangler, /new_sqlite_classes = \["OpenTofuRunnerObject"\]/);
  assert.match(workerService, /ownKeyProviderRunner: opentofuRunner/);
});

test("platform scaffold exposes production hardening evidence gates", async () => {
  const wrangler = await readText(new URL("wrangler.toml", platformRoot));
  const worker = await readText(new URL("worker.ts", platformRoot));

  assert.match(wrangler, /TAKOSUMI_PRODUCTION_HARDENING_GATE = "observe"/);
  assert.match(wrangler, /TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF/);
  assert.match(wrangler, /TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF/);
  assert.match(wrangler, /TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF/);
  assert.match(wrangler, /TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF/);
  assert.match(worker, /\/internal\/platform\/hardening-gates/);
  assert.match(worker, /evaluateProductionHardeningGates/);
});

test("Cloudflare scaffold docs describe internal plan/apply Run routing", async () => {
  const readme = await readText(new URL("README.md", cloudflareRoot));

  assert.match(readme, /plan/);
  assert.match(readme, /apply/);
  assert.match(readme, /destroy/);
  assert.match(readme, /Cloudflare Containers/);
  assert.match(readme, /OpenTofu/);
  assert.match(readme, /\/internal\/v1\/plan-runs/);
  assert.match(readme, /\/internal\/v1\/apply-runs/);
  assert.match(readme, /destroy_plan/);
  assert.match(readme, /destroy_apply/);
  assert.match(readme, /\/internal\/v1\/\*/);
  assert.match(readme, /D1/);
  assert.match(readme, /R2/);
  assert.match(readme, /r2_object_storage/);
  assert.match(
    readme,
    /spaces\/\{spaceId\}\/installations\/\{installationId\}\/runs\/\{runId\}\/plan\.bin/,
  );
  assert.match(readme, /plan\.json\.zst/);
  assert.match(readme, /R2_STATE/);
  assert.match(readme, /opentofu-plan-runs\/` objects are accepted only/);
  assert.match(readme, /does not depend on a still-warm runner-local file/);
  assert.doesNotMatch(readme, /five public deploy control endpoints/);
  assert.doesNotMatch(readme, /\/v1\/installations\/dry-run/);
  assert.doesNotMatch(readme, /\/storage\/healthz checks/);
  assert.doesNotMatch(readme, /\/queue\/test verifies/);
});

test("OpenTofu runner image stays isolated from the Worker browser bundle", async () => {
  const dockerfile = await readText(new URL("Dockerfile", runnerImageRoot));
  const server = await readText(new URL("entrypoint.ts", runnerImageRoot));

  assert.match(dockerfile, /FROM oven\/bun:1/);
  assert.match(dockerfile, /OPENTOFU_VERSION/);
  assert.match(dockerfile, /apt-get install[\s\S]*\bgit\b/);
  assert.match(dockerfile, /tofu version/);
  assert.match(server, /Bun\.serve/);
  assert.match(server, /Bun\.spawn\(command/);
  assert.match(server, /prepareGeneratedRootWorkspace/);
  assert.match(server, /restoreGeneratedRootApplyWorkspace/);
  assert.match(server, /materializeSource/);
  assert.match(server, /handlePlanArtifactRequest/);
  assert.match(server, /verifyPlanArtifact/);
  assert.match(server, /assertHttpsSourceUrl\(source\.url, "git source url"\)/);
  assert.match(
    server,
    /assertHttpsSourceUrl\(source\.url, "prepared source url"\)/,
  );
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
  // M2: the source-archive restore route extracts the snapshot tar.zst into the
  // source root through the SAME tar-slip hardening (escape quoting, file/dir
  // only, decompressed cap) used for prepared sources.
  assert.match(server, /handleSourceArchiveRestoreRequest/);
  assert.match(server, /assertSafeZstdTarArchive/);
  assert.match(server, /"tar",\s*"-x",\s*"--zstd"/);
  assert.doesNotMatch(server, /existingWorkspace/);
  assert.doesNotMatch(server, /-auto-approve/);
  assert.doesNotMatch(server, /rule\.endsWith/);
  assert.doesNotMatch(dockerfile.toLowerCase(), new RegExp("de" + "no"));
  assert.doesNotMatch(server.toLowerCase(), new RegExp("de" + "no"));
});

test("OpenTofu runner DO routes M2 state through R2_STATE with at-rest encryption", async () => {
  const container = await readText(
    new URL("durable/OpenTofuRunnerObject.ts", workerSrcRoot),
  );
  const stateCrypto = await readText(new URL("state_crypto.ts", workerSrcRoot));

  // State goes to the R2_STATE bucket under the spec key layout, encrypted at
  // rest, with current.json written AFTER the state object.
  assert.match(container, /env\.R2_STATE/);
  assert.match(container, /spaces\/\$\{[\s\S]*?states/);
  assert.match(container, /\.tfstate\.enc/);
  assert.match(container, /current\.json/);
  assert.match(container, /padStart\(8, "0"\)/);
  assert.match(container, /recoverCurrentState/);
  assert.match(container, /takosumi-reconciled/);
  // When no stateScope is present the legacy R2_ARTIFACTS path is used.
  assert.match(container, /parseStateScope/);
  assert.match(container, /stateArtifactKeys/);
  // Plan binary + plan JSON artifacts also gain `.enc` encryption.
  assert.match(container, /encryptedKey\(key\)/);
  assert.match(container, /encryptedKey\(planJsonArtifactKey/);
  assert.match(container, /persistPlanJsonArtifact/);
  // The DO reuses the existing secret-store crypto; it does NOT mint a new one.
  assert.match(container, /StateArtifactCrypto/);
  assert.match(stateCrypto, /selectSecretBoundaryCrypto/);
  assert.match(stateCrypto, /content digest mismatch/);
  // The container never sees the passphrase; decryption happens in the DO.
  assert.doesNotMatch(container, /TAKOSUMI_SECRET_STORE_PASSPHRASE/);
});

async function readText(path: URL | string): Promise<string> {
  return readFile(path, "utf8");
}
