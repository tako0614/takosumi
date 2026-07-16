#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompatibilityAuthorities } from "../../scripts/lib/provider-release-compatibility.mjs";
import { buildSanitizedProviderProofEnvironment } from "../../scripts/lib/provider-proof-environment.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const authorities = await loadCompatibilityAuthorities();
const descriptor = JSON.parse(
  await Bun.file(join(repoRoot, "provider/release/version.json")).text(),
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
const terraformPath = findCommand("terraform", sanitized.environment);
const server = Bun.spawn(
  ["bun", join(repoRoot, "tests/proofs/fixtures/provider-compatibility-server.ts")],
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
  network_mirror {
    url     = "https://app.takosumi.com/opentofu/providers/"
    include = ["${authorities.identity.provider.openTofuAddress}"]
  }
}
`,
  );
  const binary = join(binaryDir, `terraform-provider-takosumi_v${descriptor.version}`);
  run(
    descriptor.toolchain.go.path,
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

  run("tofu", ["init", "-backend=false", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: oldEnv,
  });
  const lock = await readFile(join(moduleDir, ".terraform.lock.hcl"), "utf8");
  if (
    !lock.includes(`provider "${authorities.identity.provider.openTofuAddress}"`) ||
    !lock.includes(`version     = "${authorities.identity.provider.version}"`) ||
    !lock.includes(`"zh:${authorities.identity.provider.linuxAmd64ArchiveSha256}"`)
  ) {
    throw new Error("old-state proof lockfile did not bind the exact public 1.0.0 archive");
  }
  const beforeOldApply = await requestCounts(origin);
  run("tofu", ["apply", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: oldEnv,
  });
  const afterOldApply = await requestCounts(origin);
  assertOldApplyPhase(beforeOldApply, afterOldApply);

  expectNoChange(
    runDetailed(
      "tofu",
      ["plan", "-refresh=false", "-detailed-exitcode", "-input=false", "-no-color"],
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
  run("tofu", ["apply", "-refresh-only", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: currentEnv,
  });
  const afterCurrentRefresh = await requestCounts(origin);
  assertCurrentObservePhase(afterCurrentNoOp, afterCurrentRefresh);

  expectNoChange(
    runDetailed(
      "tofu",
      ["plan", "-detailed-exitcode", "-input=false", "-no-color"],
      { cwd: moduleDir, env: oldEnv },
    ),
    "old provider rollback plan against state refreshed by current candidate",
  );
  const afterRollback = await requestCounts(origin);
  assertRollbackPhase(afterCurrentRefresh, afterRollback);
  run("tofu", ["destroy", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: oldEnv,
  });
  const currentCreateCanonicalized = await proveCurrentOmittedBucketCreate({
    root,
    origin,
    providerAddress: authorities.identity.provider.openTofuAddress,
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

  process.stdout.write(
    `${JSON.stringify(
      {
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
        currentOmittedBucketCreateCanonicalized: currentCreateCanonicalized,
        terraformEvidence,
        phaseEvidence: {
          oldApply: "six-resource-put-and-target-pool-put-exact",
          currentRefreshFreePlan: "zero-managed-route-requests",
          currentRefresh: "six-resource-observe-and-target-pool-get-exact",
          oldRollback: "six-resource-get-and-target-pool-get-exact",
        },
        exactHistoricalNetworkMirror: true,
        devOverrideUsedOnlyForCandidate: true,
      },
      null,
      2,
    )}\n`,
  );
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
    throw new Error("Terraform schema proof omitted the Terraform provider FQN");
  }
  if (schemaDocument.provider_schemas?.[openTofuAddress]) {
    throw new Error("Terraform schema proof treated the OpenTofu FQN as interchangeable");
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
  const resource = state.values?.root_module?.resources?.find(
    (entry: { address?: string }) =>
      entry.address === "takosumi_object_bucket.terraform",
  );
  if (
    resource?.provider_name !== terraformAddress ||
    resource?.values?.storage_class !== "standard"
  ) {
    throw new Error(
      "Terraform state proof did not retain its explicit FQN and canonical state",
    );
  }

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
  run(terraformPath, ["destroy", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: environment,
  });
  return {
    status: "proof-complete",
    cliPath: terraformPath,
    terraformAddress,
    openTofuAddress,
    schemaLoadedAtTerraformAddress: true,
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
  currentConfig,
  baseEnvironment,
}: {
  root: string;
  origin: string;
  providerAddress: string;
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
  const before = await requestCounts(origin);
  run("tofu", ["apply", "-auto-approve", "-input=false", "-no-color"], {
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
    run("tofu", ["show", "-json", "-no-color"], {
      cwd: moduleDir,
      env: environment,
    }).stdout,
  );
  const resource = show.values?.root_module?.resources?.find(
    (entry: { address?: string }) =>
      entry.address === "takosumi_object_bucket.omitted",
  );
  if (resource?.values?.storage_class !== "standard") {
    throw new Error(
      "current ObjectBucket create did not persist the known standard storage class",
    );
  }
  run("tofu", ["destroy", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: environment,
  });
  return true;
}

async function readReadyOrigin(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("compatibility server exited before readiness");
    output += decoder.decode(next.value, { stream: true });
  }
  const match = /^READY (http:\/\/[^\n]+)\n/.exec(output);
  if (!match) throw new Error(`invalid compatibility server readiness: ${output.trim()}`);
  reader.releaseLock();
  return match[1];
}

async function requestCounts(origin: string) {
  const response = await fetch(`${origin}/__proof/counts`);
  if (!response.ok) throw new Error("failed to read compatibility server request counters");
  return (await response.json()) as Record<string, number>;
}

function count(counts: Record<string, number>, key: string) {
  return counts[key] ?? 0;
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
  const actual = count(after, route) - count(before, route);
  if (actual !== expected) {
    throw new Error(
      `${phase} expected ${route} delta ${expected}, observed ${actual}`,
    );
  }
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
  for (const route of managedRoutes()) {
    assertRouteDelta(before, after, route, 0, phase);
  }
}

function assertOldApplyPhase(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  for (const [kind, name] of historicalResourceRoutes) {
    assertRouteDelta(
      before,
      after,
      `PUT /v1/resources/${kind}/${name}`,
      1,
      "historical apply",
    );
    assertRouteDelta(
      before,
      after,
      `GET /v1/resources/${kind}/${name}`,
      0,
      "historical apply",
    );
    assertRouteDelta(
      before,
      after,
      `POST /v1/resources/${kind}/${name}/observe`,
      0,
      "historical apply",
    );
  }
  assertRouteDelta(
    before,
    after,
    "PUT /v1/target-pools/default",
    1,
    "historical apply",
  );
  assertRouteDelta(
    before,
    after,
    "GET /v1/target-pools/default",
    0,
    "historical apply",
  );
}

function assertCurrentObservePhase(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  for (const [kind, name] of historicalResourceRoutes) {
    assertRouteDelta(
      before,
      after,
      `POST /v1/resources/${kind}/${name}/observe`,
      1,
      "current refresh",
    );
    assertRouteDelta(
      before,
      after,
      `PUT /v1/resources/${kind}/${name}`,
      0,
      "current refresh",
    );
    assertRouteDelta(
      before,
      after,
      `GET /v1/resources/${kind}/${name}`,
      0,
      "current refresh",
    );
  }
  assertRouteDelta(
    before,
    after,
    "GET /v1/target-pools/default",
    1,
    "current refresh",
  );
  assertRouteDelta(
    before,
    after,
    "PUT /v1/target-pools/default",
    0,
    "current refresh",
  );
}

function assertRollbackPhase(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  for (const [kind, name] of historicalResourceRoutes) {
    assertRouteDelta(
      before,
      after,
      `GET /v1/resources/${kind}/${name}`,
      1,
      "historical rollback",
    );
    assertRouteDelta(
      before,
      after,
      `POST /v1/resources/${kind}/${name}/observe`,
      0,
      "historical rollback",
    );
    assertRouteDelta(
      before,
      after,
      `PUT /v1/resources/${kind}/${name}`,
      0,
      "historical rollback",
    );
  }
  assertRouteDelta(
    before,
    after,
    "GET /v1/target-pools/default",
    1,
    "historical rollback",
  );
  assertRouteDelta(
    before,
    after,
    "PUT /v1/target-pools/default",
    0,
    "historical rollback",
  );
}

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const result = runDetailed(command, args, options);
  if (result.status !== 0) throw commandError(command, args, result);
  return result;
}

function runDetailed(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function expectNoChange(
  result: ReturnType<typeof spawnSync>,
  label: string,
) {
  if (result.status !== 0) {
    throw new Error(`${label} was not no-op: ${commandOutput(result)}`);
  }
}

function commandError(
  command: string,
  args: string[],
  result: ReturnType<typeof spawnSync>,
) {
  return new Error(`${command} ${args.join(" ")} failed (${result.status}): ${commandOutput(result)}`);
}

function commandOutput(result: ReturnType<typeof spawnSync>) {
  return String(result.stderr || result.stdout || "").trim();
}
