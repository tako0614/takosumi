#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_QUARANTINE_PATH,
  readJson,
  sha256,
  validateQuarantineManifest,
  verifyManifestSidecar,
} from "../../scripts/provider-custody.mjs";
import {
  createProviderCompatibilityProofArtifact,
  DEFAULT_COMPATIBILITY_PROOF_PATH,
  loadCompatibilityAuthorities,
  resolveCompatibilityGoCommand,
  structuralSha256,
  writeProviderCompatibilityProofArtifact,
} from "../../scripts/lib/provider-custody-compatibility.mjs";
import { buildSanitizedProviderProofEnvironment } from "../../scripts/lib/provider-proof-environment.mjs";
import { assertExactRequestDeltas } from "../../scripts/lib/provider-proof-requests.mjs";
import { assertProviderStateIdentity } from "../../scripts/lib/provider-proof-state.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const authorities = await loadCompatibilityAuthorities();
const descriptor = JSON.parse(
  await Bun.file(join(repoRoot, "provider/release/version.json")).text(),
);
const quarantine = validateQuarantineManifest(
  await readJson(PROVIDER_QUARANTINE_PATH),
);
await verifyManifestSidecar(PROVIDER_QUARANTINE_PATH);
const retainedQuarantineRoot = await verifyRetainedQuarantineRoot(
  process.env.TAKOSUMI_PROVIDER_QUARANTINE_ROOT,
  quarantine,
);
const historicalResourceRoutes = [
  ["ContainerService", "agent"],
  ["EdgeWorker", "api"],
  ["KVStore", "cache"],
  ["ObjectBucket", "assets"],
  ["Queue", "events"],
  ["SQLDatabase", "main"],
] as const;
const root = await mkdtemp(join(tmpdir(), "takosumi-provider-state-proof-"));
const proofHome = join(root, "home");
await mkdir(proofHome, { recursive: true });
const goModuleCache =
  process.env.GOMODCACHE ?? join(homedir(), "go", "pkg", "mod");
const sanitized = buildSanitizedProviderProofEnvironment(process.env, {
  home: proofHome,
  overrides: {
    CHECKPOINT_DISABLE: "1",
    GOMODCACHE: goModuleCache,
    TF_IN_AUTOMATION: "1",
  },
});
const openTofuPath = findCommand("tofu", sanitized.environment);
if (!openTofuPath)
  throw new Error("OpenTofu CLI is required for provider state proof");
const terraformPath = findCommand("terraform", sanitized.environment);
const candidateGoPath = await resolveCompatibilityGoCommand(
  descriptor.toolchain.go,
);
const server = Bun.spawn(
  [
    "bun",
    join(repoRoot, "tests/proofs/fixtures/provider-compatibility-server.ts"),
  ],
  { env: sanitized.environment, stdout: "pipe", stderr: "inherit" },
);

try {
  const origin = await readReadyOrigin(server.stdout);
  const moduleDir = join(root, "module");
  const binaryDir = join(root, "candidate-provider");
  await mkdir(moduleDir, { recursive: true });
  await mkdir(binaryDir, { recursive: true });
  await Bun.write(
    join(moduleDir, "main.tf"),
    `terraform {
  required_providers {
    takosumi = {
      source  = "${authorities.identity.provider.openTofuAddress}"
      version = "= ${authorities.identity.provider.version}"
    }
  }
}

provider "takosumi" {
  endpoint = "${origin}"
  space    = "compat"
}

resource "takosumi_kv_store" "legacy" {
  name        = "cache"
  consistency = "eventual"
}

resource "takosumi_object_bucket" "legacy" {
  name       = "assets"
  interfaces = ["s3_api"]
}

resource "takosumi_queue" "legacy" {
  name           = "events"
  max_retries    = 3
  max_batch_size = 10
}

resource "takosumi_sql_database" "legacy" {
  name   = "main"
  engine = "sqlite"
}

resource "takosumi_container_service" "legacy" {
  name        = "agent"
  image       = "ghcr.io/example/agent:1.0.0"
  ports       = [8080]
  public_http = true
}

resource "takosumi_edge_worker" "legacy" {
  name               = "api"
  artifact_url       = "https://example.invalid/api-worker.js"
  artifact_sha256    = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  compatibility_date = "2026-07-16"
}

resource "takosumi_target_pool" "legacy" {
  name = "default"
  target = [{
    name     = "fixture"
    type     = "fixture"
    priority = 10
  }]
}
`,
  );
  const oldConfig = join(root, "old.tofurc");
  await Bun.write(
    oldConfig,
    `provider_installation {
  filesystem_mirror {
    path    = ${JSON.stringify(retainedQuarantineRoot)}
    include = ["${authorities.identity.provider.openTofuAddress}"]
  }
}
`,
  );
  const binary = join(
    binaryDir,
    `terraform-provider-takosumi_v${descriptor.version}`,
  );
  run(
    candidateGoPath,
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-mod=readonly",
      "-ldflags",
      `-buildid= -X main.version=${descriptor.version}`,
      "-o",
      binary,
      ".",
    ],
    {
      cwd: join(repoRoot, "provider"),
      env: {
        ...sanitized.environment,
        CGO_ENABLED: "0",
        GOCACHE: join(root, "gocache"),
        GOENV: "off",
        GOPROXY: "off",
        GOSUMDB: "off",
      },
    },
  );
  await chmod(binary, 0o755);
  const currentConfig = join(root, "current.tofurc");
  await Bun.write(
    currentConfig,
    `provider_installation {
  dev_overrides {
    "${authorities.identity.provider.openTofuAddress}" = "${binaryDir}"
  }
  direct {}
}
`,
  );
  const baseEnv = {
    ...sanitized.environment,
    TF_DATA_DIR: join(root, "tofu-data"),
  };
  const oldEnv = { ...baseEnv, TF_CLI_CONFIG_FILE: oldConfig };
  const currentEnv = { ...baseEnv, TF_CLI_CONFIG_FILE: currentConfig };

  run(openTofuPath, ["init", "-backend=false", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: oldEnv,
  });
  const lock = await readFile(join(moduleDir, ".terraform.lock.hcl"), "utf8");
  if (
    !lock.includes(
      `provider "${authorities.identity.provider.openTofuAddress}"`,
    ) ||
    !lock.includes(`version     = "${authorities.identity.provider.version}"`)
  ) {
    throw new Error(
      "old-state proof lockfile did not bind the exact retained quarantined 1.0.0 archive",
    );
  }
  const beforeOldApply = await requestCounts(origin);
  run(openTofuPath, ["apply", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: oldEnv,
  });
  const afterOldApply = await requestCounts(origin);
  assertOldApplyPhase(beforeOldApply, afterOldApply);

  expectNoChange(
    runDetailed(
      openTofuPath,
      [
        "plan",
        "-refresh=false",
        "-detailed-exitcode",
        "-input=false",
        "-no-color",
      ],
      { cwd: moduleDir, env: currentEnv },
    ),
    "current candidate refresh-free plan against old state",
  );
  const afterCurrentNoOp = await requestCounts(origin);
  assertNoManagedRouteDelta(
    afterOldApply,
    afterCurrentNoOp,
    "current refresh-free no-op",
  );
  run(
    openTofuPath,
    ["apply", "-refresh-only", "-auto-approve", "-input=false", "-no-color"],
    {
      cwd: moduleDir,
      env: currentEnv,
    },
  );
  const afterCurrentRefresh = await requestCounts(origin);
  assertCurrentObservePhase(afterCurrentNoOp, afterCurrentRefresh);

  expectNoChange(
    runDetailed(
      openTofuPath,
      ["plan", "-detailed-exitcode", "-input=false", "-no-color"],
      { cwd: moduleDir, env: oldEnv },
    ),
    "old provider rollback plan against state refreshed by current candidate",
  );
  const afterRollback = await requestCounts(origin);
  assertRollbackPhase(afterCurrentRefresh, afterRollback);
  run(openTofuPath, ["destroy", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: oldEnv,
  });
  const currentCreateCanonicalized = await proveCurrentOmittedBucketCreate({
    root,
    origin,
    providerAddress: authorities.identity.provider.openTofuAddress,
    openTofuPath,
    currentConfig,
    baseEnvironment: sanitized.environment,
  });
  const terraformEvidence = terraformPath
    ? await proveTerraformAddressState({
        root,
        origin,
        terraformPath,
        terraformAddress: authorities.identity.provider.terraformServeAddress,
        openTofuAddress: authorities.identity.provider.openTofuAddress,
        binaryDir,
        baseEnvironment: sanitized.environment,
      })
    : {
        status: "blocked-prerequisite",
        reason: "terraform-cli-unavailable",
        addressesTreatedAsInterchangeable: false,
      };
  if (
    terraformEvidence.status === "proof-complete" &&
    terraformEvidence.schemaStructuralSha256 !==
      currentCreateCanonicalized.schemaStructuralSha256
  ) {
    throw new Error(
      "OpenTofu and Terraform state proof exposed different candidate schemas",
    );
  }

  const proof = {
    kind: "takosumi.provider-old-state-compatibility-proof@v1",
    baselineVersion: authorities.identity.provider.version,
    candidateVersion: authorities.policy.candidate.version,
    resourceTypes: [
      "takosumi_container_service",
      "takosumi_edge_worker",
      "takosumi_kv_store",
      "takosumi_object_bucket",
      "takosumi_queue",
      "takosumi_sql_database",
      "takosumi_target_pool",
    ],
    stateValuesRecorded: false,
    environmentEvidence: sanitized.evidence,
    credentialsUsed: sanitized.evidence.credentialsUsed,
    oldStateRefreshFreeNoOp: true,
    currentObserveRefresh: true,
    currentMutationDuringRefresh: false,
    oldProviderRollbackNoOp: true,
    currentOmittedBucketCreateCanonicalized:
      currentCreateCanonicalized.storageClassKnownStandard,
    openTofuEvidence: currentCreateCanonicalized,
    terraformEvidence,
    phaseEvidence: {
      oldApply: "six-resource-put-and-target-pool-put-exact",
      currentRefreshFreePlan: "zero-managed-route-requests",
      currentRefresh: "six-resource-observe-and-target-pool-get-exact",
      oldRollback: "six-resource-get-and-target-pool-get-exact",
    },
    exactHistoricalFilesystemMirror: true,
    devOverrideUsedOnlyForCandidate: true,
  };
  if (terraformPath) {
    const artifact = await createProviderCompatibilityProofArtifact({
      proof,
      toolchains: {
        openTofu: await cliIdentity(openTofuPath, sanitized.environment),
        terraform: await cliIdentity(terraformPath, sanitized.environment),
      },
    });
    await writeProviderCompatibilityProofArtifact(artifact, {
      path:
        process.env.TAKOSUMI_PROVIDER_COMPATIBILITY_PROOF_PATH ??
        DEFAULT_COMPATIBILITY_PROOF_PATH,
    });
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  }
} finally {
  server.kill();
  await server.exited;
  await rm(root, { recursive: true, force: true });
}

async function proveTerraformAddressState({
  root,
  origin,
  terraformPath,
  terraformAddress,
  openTofuAddress,
  binaryDir,
  baseEnvironment,
}: {
  root: string;
  origin: string;
  terraformPath: string;
  terraformAddress: string;
  openTofuAddress: string;
  binaryDir: string;
  baseEnvironment: NodeJS.ProcessEnv;
}) {
  const moduleDir = join(root, "terraform-state-module");
  const config = join(root, "terraformrc");
  await mkdir(moduleDir, { recursive: true });
  await Bun.write(
    config,
    `provider_installation {
  dev_overrides {
    "${terraformAddress}" = "${binaryDir}"
  }
  direct {}
}
`,
  );
  await Bun.write(
    join(moduleDir, "main.tf"),
    `terraform {
  required_providers {
    takosumi = {
      source = "${terraformAddress}"
    }
  }
}

provider "takosumi" {
  endpoint = "${origin}"
  space    = "compat"
}

resource "takosumi_object_bucket" "terraform" {
  name       = "terraform-default"
  interfaces = ["s3_api"]
}
`,
  );
  const environment = {
    ...baseEnvironment,
    TF_CLI_CONFIG_FILE: config,
    TF_DATA_DIR: join(root, "terraform-state-data"),
  };
  const schemaDocument = JSON.parse(
    run(terraformPath, ["providers", "schema", "-json"], {
      cwd: moduleDir,
      env: environment,
    }).stdout,
  );
  if (!schemaDocument.provider_schemas?.[terraformAddress]) {
    throw new Error(
      "Terraform schema proof omitted the Terraform provider FQN",
    );
  }
  if (schemaDocument.provider_schemas?.[openTofuAddress]) {
    throw new Error(
      "Terraform schema proof treated the OpenTofu FQN as interchangeable",
    );
  }

  const beforeApply = await requestCounts(origin);
  run(terraformPath, ["apply", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: environment,
  });
  const afterApply = await requestCounts(origin);
  assertRouteDelta(
    beforeApply,
    afterApply,
    "PUT /v1/resources/ObjectBucket/terraform-default",
    1,
    "Terraform explicit-FQN apply",
  );
  const state = JSON.parse(
    run(terraformPath, ["show", "-json", "-no-color"], {
      cwd: moduleDir,
      env: environment,
    }).stdout,
  );
  assertProviderStateIdentity({
    state,
    resourceAddress: "takosumi_object_bucket.terraform",
    providerAddress: terraformAddress,
    expectedValues: { storage_class: "standard" },
    label: "Terraform state proof",
  });

  expectNoChange(
    runDetailed(
      terraformPath,
      ["plan", "-detailed-exitcode", "-input=false", "-no-color"],
      { cwd: moduleDir, env: environment },
    ),
    "Terraform explicit-FQN refresh plan",
  );
  const afterPlan = await requestCounts(origin);
  assertRouteDelta(
    afterApply,
    afterPlan,
    "POST /v1/resources/ObjectBucket/terraform-default/observe",
    1,
    "Terraform explicit-FQN refresh",
  );
  assertRouteDelta(
    afterApply,
    afterPlan,
    "PUT /v1/resources/ObjectBucket/terraform-default",
    0,
    "Terraform explicit-FQN refresh",
  );
  run(
    terraformPath,
    ["destroy", "-auto-approve", "-input=false", "-no-color"],
    {
      cwd: moduleDir,
      env: environment,
    },
  );
  return {
    status: "proof-complete",
    cliPath: terraformPath,
    terraformAddress,
    openTofuAddress,
    schemaLoadedAtTerraformAddress: true,
    schemaStructuralSha256: structuralSha256(
      schemaDocument.provider_schemas[terraformAddress],
    ),
    stateProviderAddressExact: true,
    refreshPlanNoOp: true,
    addressesTreatedAsInterchangeable: false,
    stateValuesRecorded: false,
  };
}

async function proveCurrentOmittedBucketCreate({
  root,
  origin,
  providerAddress,
  openTofuPath,
  currentConfig,
  baseEnvironment,
}: {
  root: string;
  origin: string;
  providerAddress: string;
  openTofuPath: string;
  currentConfig: string;
  baseEnvironment: NodeJS.ProcessEnv;
}) {
  const moduleDir = join(root, "current-create-module");
  await mkdir(moduleDir, { recursive: true });
  await Bun.write(
    join(moduleDir, "main.tf"),
    `terraform {
  required_providers {
    takosumi = {
      source = "${providerAddress}"
    }
  }
}

provider "takosumi" {
  endpoint = "${origin}"
  space    = "compat"
}

resource "takosumi_object_bucket" "omitted" {
  name       = "current-default"
  interfaces = ["s3_api"]
}
`,
  );
  const environment = {
    ...baseEnvironment,
    TF_CLI_CONFIG_FILE: currentConfig,
    TF_DATA_DIR: join(root, "current-create-tofu-data"),
  };
  const schemaDocument = JSON.parse(
    run(openTofuPath, ["providers", "schema", "-json"], {
      cwd: moduleDir,
      env: environment,
    }).stdout,
  );
  const providerSchema = schemaDocument.provider_schemas?.[providerAddress];
  if (!providerSchema) {
    throw new Error("OpenTofu current-state proof omitted its provider FQN");
  }
  const before = await requestCounts(origin);
  run(openTofuPath, ["apply", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: environment,
  });
  const after = await requestCounts(origin);
  assertRouteDelta(
    before,
    after,
    "PUT /v1/resources/ObjectBucket/current-default",
    1,
    "current omitted ObjectBucket create",
  );
  assertRouteDelta(
    before,
    after,
    "POST /v1/resources/preview",
    1,
    "current omitted ObjectBucket preview",
  );
  const show = JSON.parse(
    run(openTofuPath, ["show", "-json", "-no-color"], {
      cwd: moduleDir,
      env: environment,
    }).stdout,
  );
  assertProviderStateIdentity({
    state: show,
    resourceAddress: "takosumi_object_bucket.omitted",
    providerAddress,
    expectedValues: { storage_class: "standard" },
    label: "current OpenTofu ObjectBucket state",
  });
  run(openTofuPath, ["destroy", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: environment,
  });
  return {
    status: "proof-complete",
    cliPath: openTofuPath,
    providerAddress,
    schemaStructuralSha256: structuralSha256(providerSchema),
    stateProviderAddressExact: true,
    storageClassKnownStandard: true,
    addressesTreatedAsInterchangeable: false,
    stateValuesRecorded: false,
  };
}

async function readReadyOrigin(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const next = await reader.read();
    if (next.done)
      throw new Error("compatibility server exited before readiness");
    output += decoder.decode(next.value, { stream: true });
  }
  const match = /^READY (http:\/\/[^\n]+)\n/.exec(output);
  if (!match)
    throw new Error(`invalid compatibility server readiness: ${output.trim()}`);
  reader.releaseLock();
  return match[1];
}

async function requestCounts(origin: string) {
  const response = await fetch(`${origin}/__proof/counts`);
  if (!response.ok)
    throw new Error("failed to read compatibility server request counters");
  return (await response.json()) as Record<string, number>;
}

async function verifyRetainedQuarantineRoot(
  input: string | undefined,
  manifest: {
    mirror: {
      assets: Array<{ path: string; size: number; sha256: string }>;
    };
  },
) {
  if (!input) {
    throw new Error(
      "TAKOSUMI_PROVIDER_QUARANTINE_ROOT must point to the operator-retained 1.0.0 filesystem mirror",
    );
  }
  if (!isAbsolute(input) || resolve(input) !== input) {
    throw new Error(
      "TAKOSUMI_PROVIDER_QUARANTINE_ROOT must be an absolute canonical path",
    );
  }
  const rootInfo = await lstat(input);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(
      "retained provider quarantine root must be a real directory",
    );
  }
  if ((await realpath(input)) !== input) {
    throw new Error("retained provider quarantine root must not use symlinks");
  }
  for (const asset of manifest.mirror.assets) {
    const path = join(input, asset.path);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path
    ) {
      throw new Error(
        `retained provider quarantine asset is unsafe: ${asset.path}`,
      );
    }
    const bytes = await readFile(path);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
      throw new Error(
        `retained provider quarantine asset drifted: ${asset.path}`,
      );
    }
  }
  return input;
}

function findCommand(command: string, environment: NodeJS.ProcessEnv) {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    env: environment,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function assertRouteDelta(
  before: Record<string, number>,
  after: Record<string, number>,
  route: string,
  expected: number,
  phase: string,
) {
  assertExactRequestDeltas({
    before,
    after,
    managedRoutes: [route],
    expected: { [route]: expected },
    phase,
  });
}

function managedRoutes() {
  const routes = historicalResourceRoutes.flatMap(([kind, name]) => [
    `GET /v1/resources/${kind}/${name}`,
    `PUT /v1/resources/${kind}/${name}`,
    `DELETE /v1/resources/${kind}/${name}`,
    `POST /v1/resources/${kind}/${name}/observe`,
  ]);
  return routes.concat([
    "POST /v1/resources/preview",
    "GET /v1/target-pools/default",
    "PUT /v1/target-pools/default",
    "DELETE /v1/target-pools/default",
  ]);
}

function assertNoManagedRouteDelta(
  before: Record<string, number>,
  after: Record<string, number>,
  phase: string,
) {
  assertExactRequestDeltas({
    before,
    after,
    managedRoutes: managedRoutes(),
    expected: {},
    phase,
  });
}

function assertOldApplyPhase(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  const expected: Record<string, number> = {
    "PUT /v1/target-pools/default": 1,
  };
  for (const [kind, name] of historicalResourceRoutes) {
    expected[`PUT /v1/resources/${kind}/${name}`] = 1;
  }
  assertExactRequestDeltas({
    before,
    after,
    managedRoutes: managedRoutes(),
    expected,
    phase: "historical apply",
  });
}

function assertCurrentObservePhase(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  const expected: Record<string, number> = {
    "GET /v1/target-pools/default": 1,
  };
  for (const [kind, name] of historicalResourceRoutes) {
    expected[`POST /v1/resources/${kind}/${name}/observe`] = 1;
  }
  assertExactRequestDeltas({
    before,
    after,
    managedRoutes: managedRoutes(),
    expected,
    phase: "current refresh",
  });
}

function assertRollbackPhase(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  const expected: Record<string, number> = {
    "GET /v1/target-pools/default": 1,
  };
  for (const [kind, name] of historicalResourceRoutes) {
    expected[`GET /v1/resources/${kind}/${name}`] = 1;
  }
  assertExactRequestDeltas({
    before,
    after,
    managedRoutes: managedRoutes(),
    expected,
    phase: "historical rollback",
  });
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const result = runDetailed(command, args, options);
  if (result.status !== 0) throw commandError(command, args, result);
  return result;
}

async function cliIdentity(path: string, environment: NodeJS.ProcessEnv) {
  const document = JSON.parse(
    run(path, ["version", "-json"], {
      cwd: repoRoot,
      env: environment,
    }).stdout,
  ) as { terraform_version?: unknown; platform?: unknown };
  if (
    typeof document.terraform_version !== "string" ||
    typeof document.platform !== "string"
  ) {
    throw new Error("provider proof CLI returned an invalid version document");
  }
  return {
    version: document.terraform_version,
    platform: document.platform,
    executableSha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}

function runDetailed(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function expectNoChange(result: ReturnType<typeof spawnSync>, label: string) {
  if (result.status !== 0) {
    throw new Error(`${label} was not no-op: ${commandOutput(result)}`);
  }
}

function commandError(
  command: string,
  args: string[],
  result: ReturnType<typeof spawnSync>,
) {
  return new Error(
    `${command} ${args.join(" ")} failed (${result.status}): ${commandOutput(result)}`,
  );
}

function commandOutput(result: ReturnType<typeof spawnSync>) {
  return String(result.stderr || result.stdout || "").trim();
}
