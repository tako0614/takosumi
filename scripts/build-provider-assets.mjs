#!/usr/bin/env bun
/**
 * Build the takosumi OpenTofu provider network mirror into Worker static
 * assets. The generated files are copied by the dashboard/Vite build from
 * dashboard/public/ into dashboard/dist/ and are then served by the platform
 * Worker's ASSETS binding.
 *
 * Usage:
 *   TAKOSUMI_PROVIDER_VERSION=0.1.0 bun scripts/build-provider-assets.mjs
 *   TAKOSUMI_PROVIDER_PLATFORMS=linux_amd64,darwin_arm64 ...
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const providerRoot = join(repoRoot, "provider");
const mirrorRoot = join(
  repoRoot,
  "dashboard",
  "public",
  "opentofu",
  "providers",
  "registry.opentofu.org",
  "takosjp",
  "takosumi",
);

const version = process.env.TAKOSUMI_PROVIDER_VERSION?.trim();
if (!version) {
  throw new Error("TAKOSUMI_PROVIDER_VERSION is required");
}

const platforms = (process.env.TAKOSUMI_PROVIDER_PLATFORMS ?? "linux_amd64")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(parsePlatform);

if (platforms.length === 0) {
  throw new Error("TAKOSUMI_PROVIDER_PLATFORMS resolved to no platforms");
}

assertCommand("go", ["version"]);
assertCommand("zip", ["-v"]);

await mkdir(mirrorRoot, { recursive: true });

const archives = {};
const indexPlatforms = [];
const workdir = await mkdtemp(join(tmpdir(), "takosumi-provider-assets-"));

try {
  for (const platform of platforms) {
    const archiveName =
      `terraform-provider-takosumi_${version}_${platform.os}_${platform.arch}.zip`;
    const binaryName =
      `terraform-provider-takosumi_v${version}${platform.os === "windows" ? ".exe" : ""}`;
    const buildDir = join(workdir, `${platform.os}_${platform.arch}`);
    await mkdir(buildDir, { recursive: true });

    run("go", ["build", "-trimpath", "-o", join(buildDir, binaryName), "."], {
      cwd: providerRoot,
      env: {
        ...process.env,
        GOOS: platform.os,
        GOARCH: platform.arch,
        CGO_ENABLED: process.env.CGO_ENABLED ?? "0",
      },
    });

    run("zip", ["-q", "-j", join(mirrorRoot, archiveName), join(buildDir, binaryName)], {
      cwd: providerRoot,
      env: process.env,
    });

    const archiveBytes = await readFile(join(mirrorRoot, archiveName));
    const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
    const platformKey = `${platform.os}_${platform.arch}`;
    archives[platformKey] = {
      url: archiveName,
      hashes: [`zh:${sha256}`],
    };
    indexPlatforms.push({ os: platform.os, arch: platform.arch });
  }
} finally {
  await rm(workdir, { recursive: true, force: true });
}

await writeJson(join(mirrorRoot, "index.json"), {
  versions: {
    [version]: {
      protocols: ["5.0"],
      platforms: indexPlatforms,
    },
  },
});
await writeJson(join(mirrorRoot, `${version}.json`), { archives });

console.log(`wrote takosumi provider mirror assets to ${mirrorRoot}`);

function parsePlatform(value) {
  const [os, arch, extra] = value.split("_");
  if (!os || !arch || extra) {
    throw new Error(`invalid platform ${value}; expected GOOS_GOARCH`);
  }
  return { os, arch };
}

function assertCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`${command} is required to build provider assets`);
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
