#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompatibilityAuthorities } from "../../scripts/lib/provider-release-compatibility.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const authorities = await loadCompatibilityAuthorities();
const descriptor = JSON.parse(
  await Bun.file(join(repoRoot, "provider/release/version.json")).text(),
);
const root = await mkdtemp(join(tmpdir(), "takosumi-provider-state-proof-"));
const server = Bun.spawn(
  ["bun", join(repoRoot, "tests/proofs/fixtures/provider-compatibility-server.ts")],
  { stdout: "pipe", stderr: "inherit" },
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
    { cwd: join(repoRoot, "provider"), env: { ...process.env, CGO_ENABLED: "0", GOCACHE: join(root, "gocache") } },
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
    ...process.env,
    TF_DATA_DIR: join(root, "tofu-data"),
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
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
  run("tofu", ["apply", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: oldEnv,
  });
  const afterOldApply = await requestCounts(origin);

  expectNoChange(
    runDetailed(
      "tofu",
      ["plan", "-refresh=false", "-detailed-exitcode", "-input=false", "-no-color"],
      { cwd: moduleDir, env: currentEnv },
    ),
    "current candidate refresh-free plan against old state",
  );
  run("tofu", ["apply", "-refresh-only", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: currentEnv,
  });
  const afterCurrentRefresh = await requestCounts(origin);
  const observeCount = countMatching(
    afterCurrentRefresh,
    /^POST \/v1\/resources\/[^/]+\/[^/]+\/observe$/,
  );
  if (observeCount !== 6) {
    throw new Error(`current candidate used ${observeCount}/6 read-only observe paths`);
  }
  if (
    countMatching(afterCurrentRefresh, /^PUT \/v1\/resources\/[^/]+\/[^/]+$/) !== 6 ||
    count(afterCurrentRefresh, "PUT /v1/target-pools/default") !== 1
  ) {
    throw new Error("current refresh proof unexpectedly mutated the resource");
  }

  expectNoChange(
    runDetailed(
      "tofu",
      ["plan", "-detailed-exitcode", "-input=false", "-no-color"],
      { cwd: moduleDir, env: oldEnv },
    ),
    "old provider rollback plan against state refreshed by current candidate",
  );
  const afterRollback = await requestCounts(origin);
  const rollbackReads =
    countMatching(afterRollback, /^GET \/v1\/resources\/[^/]+\/[^/]+$/) -
    countMatching(afterCurrentRefresh, /^GET \/v1\/resources\/[^/]+\/[^/]+$/);
  if (rollbackReads !== 6) {
    throw new Error("rollback proof did not execute the historical GET read path");
  }
  run("tofu", ["destroy", "-auto-approve", "-input=false", "-no-color"], {
    cwd: moduleDir,
    env: oldEnv,
  });

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
        credentialsUsed: false,
        oldStateRefreshFreeNoOp: true,
        currentObserveRefresh: true,
        currentMutationDuringRefresh: false,
        oldProviderRollbackNoOp: true,
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

function countMatching(counts: Record<string, number>, pattern: RegExp) {
  return Object.entries(counts).reduce(
    (total, [key, value]) => total + (pattern.test(key) ? value : 0),
    0,
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
