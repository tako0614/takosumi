#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PROVIDER_QUARANTINE_PATH,
  PROVIDER_RELEASE_ROOT,
  materializeProviderMirror,
  readJson,
  verifyManifestSidecar,
} from "../../scripts/lib/provider-release.mjs";

const manifest = await readJson(PROVIDER_QUARANTINE_PATH);
const manifestDigest = await verifyManifestSidecar(PROVIDER_QUARANTINE_PATH);
const workdir = await mkdtemp(
  join(tmpdir(), "takosumi-provider-mirror-proof-"),
);

try {
  const materializedRoot = join(workdir, "materialized-network-mirror");
  await materializeProviderMirror({
    outputRoot: materializedRoot,
    cacheRoot: join(workdir, "verified-cache"),
  });

  const configPath = join(workdir, "tofurc");
  const moduleRoot = join(workdir, "module");
  await mkdir(moduleRoot, { recursive: true });
  await Bun.write(
    configPath,
    `provider_installation {
  network_mirror {
    url     = "${manifest.mirror.baseUrl}"
    include = ["${manifest.providerAddress}"]
  }
}
`,
  );
  await Bun.write(
    join(moduleRoot, "main.tf"),
    `terraform {
  required_providers {
    takosumi = {
      source  = "${manifest.providerAddress}"
      version = "= ${manifest.version}"
    }
  }
}
`,
  );

  const env = {
    ...process.env,
    TF_CLI_CONFIG_FILE: configPath,
    TF_DATA_DIR: join(workdir, "tofu-data"),
    CHECKPOINT_DISABLE: "1",
    TF_IN_AUTOMATION: "1",
  };
  run("tofu", ["init", "-backend=false", "-input=false", "-no-color"], {
    cwd: moduleRoot,
    env,
  });
  const lock = await readFile(join(moduleRoot, ".terraform.lock.hcl"), "utf8");
  if (!lock.includes(`provider "${manifest.providerAddress}"`)) {
    throw new Error("OpenTofu lockfile omitted the exact provider address");
  }
  if (!lock.includes(`version     = "${manifest.version}"`)) {
    throw new Error(
      "OpenTofu lockfile omitted historical provider version 1.0.0",
    );
  }
  const linuxArchive = manifest.mirror.assets.find(
    (asset: { kind: string; platform?: string }) =>
      asset.kind === "archive" && asset.platform === "linux_amd64",
  );
  if (!linuxArchive || !lock.includes(`"zh:${linuxArchive.sha256}"`)) {
    throw new Error(
      "OpenTofu lockfile omitted the exact live linux_amd64 archive digest",
    );
  }

  const schema = JSON.parse(
    run("tofu", ["providers", "schema", "-json"], { cwd: moduleRoot, env })
      .stdout,
  );
  if (!schema.provider_schemas?.[manifest.providerAddress]) {
    throw new Error("OpenTofu did not load the installed provider schema");
  }

  const installedBinary = join(
    env.TF_DATA_DIR,
    "providers",
    manifest.providerAddress,
    manifest.version,
    "linux_amd64",
    `terraform-provider-takosumi_v${manifest.version}`,
  );
  const reportedVersion = run(
    "go",
    [
      "run",
      resolve(
        PROVIDER_RELEASE_ROOT,
        "provider",
        "release",
        "inspect-version.go",
      ),
      installedBinary,
    ],
    { cwd: PROVIDER_RELEASE_ROOT, env: process.env },
  ).stdout.trim();
  if (reportedVersion !== manifest.source.providerReportedVersion) {
    throw new Error(
      `historical installed provider reported ${reportedVersion}, expected quarantined ${manifest.source.providerReportedVersion}`,
    );
  }
  const buildInfo = run("go", ["version", "-m", installedBinary], {
    cwd: PROVIDER_RELEASE_ROOT,
    env: process.env,
  }).stdout;
  if (
    !buildInfo.includes(`vcs.revision=${manifest.source.sourceCommit}`) ||
    !buildInfo.includes("vcs.modified=true")
  ) {
    throw new Error(
      "historical installed binary provenance no longer matches quarantine evidence",
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        kind: "takosumi.provider-network-mirror-install-proof@v1",
        providerAddress: manifest.providerAddress,
        version: manifest.version,
        mirrorBaseUrl: manifest.mirror.baseUrl,
        manifestDigest,
        devOverrideUsed: false,
        directFallbackUsed: false,
        schemaLoaded: true,
        historicalProviderReportedVersion: reportedVersion,
        historicalProvenance: manifest.source.provenance,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(workdir, { recursive: true, force: true });
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
