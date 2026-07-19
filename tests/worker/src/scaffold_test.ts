import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "bun:test";

const repoRoot = new URL("../../../", import.meta.url);
const platformRoot = new URL("deploy/platform/", repoRoot);
const runnerImageRoot = new URL("runner/", repoRoot);
const workerSrcRoot = new URL("../../../worker/src/", import.meta.url);

test("platform worker wrangler wires D1/R2 and the OpenTofu runner container", async () => {
  const wrangler = await readText(new URL("wrangler.toml", platformRoot));
  const workerService = await readText(
    new URL("worker_service.ts", workerSrcRoot),
  );

  assert.doesNotMatch(wrangler, /TAKOS_WORKLOAD_CONTAINER/);
  assert.doesNotMatch(wrangler, /TAKOS_SERVICE_CONTAINER/);
  // The single composed worker: accounts ledger + control-plane ledger.
  assert.match(wrangler, /name = "takosumi-platform"/);
  assert.match(wrangler, /main = "worker\.ts"/);
  assert.match(wrangler, /binding = "TAKOSUMI_ACCOUNTS_DB"/);
  assert.match(wrangler, /binding = "TAKOSUMI_CONTROL_DB"/);
  assert.match(wrangler, /binding = "R2_ARTIFACTS"/);
  assert.match(wrangler, /binding = "R2_SOURCE"/);
  assert.match(wrangler, /binding = "R2_STATE"/);
  assert.match(wrangler, /binding = "R2_BACKUPS"/);
  assert.doesNotMatch(wrangler, /TAKOS_RUNTIME_MODE/);
  assert.match(wrangler, /name = "COORDINATION"/);
  assert.match(wrangler, /binding = "RUN_QUEUE"/);
  assert.match(wrangler, /queue = "takosumi-runs"/);
  assert.doesNotMatch(wrangler, /binding = "TAKOS_QUEUE"/);
  assert.doesNotMatch(wrangler, /takosumi-control-plane/);
  assert.match(wrangler, /name = "RUN_OWNER"/);
  assert.match(wrangler, /class_name = "OpenTofuRunOwnerObject"/);
  assert.match(wrangler, /name = "RUNNER"/);
  assert.match(wrangler, /class_name = "OpenTofuRunnerObject"/);
  assert.match(wrangler, /\[\[containers\]\]/);
  assert.match(wrangler, /image = "\.\.\/\.\.\/runner\/Dockerfile"/);
  assert.match(wrangler, /image_build_context = "\.\.\/\.\."/);
  assert.match(wrangler, /new_sqlite_classes = \[[^\]]*"CoordinationObject"/);
  assert.match(wrangler, /new_sqlite_classes = \[[^\]]*"OpenTofuRunnerObject"/);
  assert.match(wrangler, /new_sqlite_classes = \["OpenTofuRunOwnerObject"\]/);
});

test("platform scaffold exposes production hardening evidence gates", async () => {
  const wrangler = await readText(new URL("wrangler.toml", platformRoot));
  const worker = await readText(new URL("worker.ts", platformRoot));

  assert.match(wrangler, /TAKOSUMI_PRODUCTION_HARDENING_GATE = "observe"/);
  assert.match(wrangler, /TAKOSUMI_PLATFORM_HARDENING_EVIDENCE/);
  assert.doesNotMatch(wrangler, /CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE/);
  // The OSS platform template names no Cloud feature: the generic Seam A is
  // config-driven (TAKOSUMI_CLOUD_EXTENSIONS + Cloud-supplied handler keys),
  // so no `TAKOSUMI_CLOUD_*` extension handler is hardcoded in the OSS wrangler.
  assert.doesNotMatch(wrangler, /TAKOSUMI_CLOUD_AI_GATEWAY/);
  assert.match(worker, /\/internal\/platform\/hardening-gates/);
  assert.match(worker, /evaluateProductionHardeningGates/);
});

test("OpenTofu runner image stays isolated from the Worker browser bundle", async () => {
  const dockerfile = await readText(new URL("Dockerfile", runnerImageRoot));
  // entrypoint.ts now delegates to runner/lib/*; assert against the combined
  // runner image source so the behaviors stay covered after the lib split.
  const server = await readRunnerServerSource();

  assert.match(dockerfile, /FROM oven\/bun:1/);
  assert.match(dockerfile, /OPENTOFU_VERSION/);
  assert.match(dockerfile, /apt-get install[\s\S]*\bgit\b/);
  assert.match(dockerfile, /tofu version/);
  assert.match(server, /Bun\.serve/);
  assert.match(server, /Bun\.spawn\(\[\.\.\.command\]/);
  assert.match(server, /prepareGeneratedRootWorkspace/);
  assert.match(server, /restoreGeneratedRootApplyWorkspace/);
  assert.match(server, /ensureSourceAvailable/);
  assert.match(server, /Git SourceSnapshot archive must be restored/);
  assert.match(server, /handlePlanArtifactRequest/);
  assert.match(server, /verifyPlanArtifact/);
  assert.match(server, /parseSourceSyncSource/);
  assert.match(server, /DEFAULT_SOURCE_ARCHIVE_MAX_DECOMPRESSED_BYTES/);
  assert.match(server, /maxSourceArchiveBytes/);
  assert.match(server, /maxSourceDecompressedBytes/);
  assert.match(server, /--no-same-owner/);
  assert.match(server, /--keep-old-files/);
  assert.match(server, /duplicates normalized path/);
  assert.match(server, /unsupported entry type/);
  assert.match(server, /assertRealPathInsideSourceRoot/);
  assert.match(server, /after symlink resolution/);
  assert.match(server, /return exactProviderSourceMatch\(provider, rule\)/);
  assert.match(server, /"tofu",\s*"plan"/);
  assert.match(server, /"tofu",\s*"apply"/);
  // M2: the source-archive restore route extracts the snapshot tar.zst into the
  // source root through the canonical tar-slip hardening (escape quoting,
  // file/dir only, decompressed cap).
  assert.match(server, /handleSourceArchiveRestoreRequest/);
  assert.match(server, /assertSafeZstdTarArchive/);
  assert.match(server, /"tar",\s*"-x",\s*"--zstd"/);
  assert.doesNotMatch(server, /kind === "prepared"|case "prepared"/);
  assert.doesNotMatch(server, /kind === "local"|case "local"/);
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
  assert.match(container, /workspaces\/\$\{[\s\S]*?state-versions/);
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

async function readRunnerServerSource(): Promise<string> {
  const parts = [await readText(new URL("entrypoint.ts", runnerImageRoot))];
  const libRoot = new URL("lib/", runnerImageRoot);
  const entries = await readdir(libRoot);
  for (const entry of entries.sort()) {
    if (entry.endsWith(".ts")) {
      parts.push(await readText(new URL(entry, libRoot)));
    }
  }
  return parts.join("\n");
}
