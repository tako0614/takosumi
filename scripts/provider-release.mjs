#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  PROVIDER_REGISTRY_PATH,
  PROVIDER_RELEASE_ROOT,
  buildProviderRelease,
  manifestDigest,
  loadProviderReleaseRegistry,
  materializeProviderMirror,
  verifyNetworkMirrorLayout,
  verifyProviderReleaseBundle,
  verifyProviderPrepublication,
  verifyProviderReleaseSource,
} from "./lib/provider-release.mjs";

export async function runProviderReleaseCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest, command);
  switch (command) {
    case "verify-source": {
      const result = await verifyProviderReleaseSource();
      printJson({
        kind: "takosumi.provider-release-source-verification@v1",
        ...result,
      });
      return result;
    }
    case "materialize": {
      const outputRoot = resolve(
        args.output ??
          resolve(
            PROVIDER_RELEASE_ROOT,
            "dashboard",
            "dist",
            "opentofu",
            "providers",
          ),
      );
      const result = await materializeProviderMirror({
        outputRoot,
        registryPath: resolve(args.registry ?? PROVIDER_REGISTRY_PATH),
        artifactRoot: args["artifact-root"]
          ? resolve(args["artifact-root"])
          : undefined,
        cacheRoot: args["cache-root"] ? resolve(args["cache-root"]) : undefined,
      });
      printJson({
        kind: "takosumi.provider-mirror-materialization@v1",
        ...result,
      });
      return result;
    }
    case "verify-mirror": {
      if (!args.root) throw new Error("verify-mirror requires --root");
      const loaded = await loadProviderReleaseRegistry(
        resolve(args.registry ?? PROVIDER_REGISTRY_PATH),
      );
      const result = await verifyNetworkMirrorLayout(
        resolve(args.root),
        loaded.manifests,
      );
      printJson({
        kind: "takosumi.provider-mirror-verification@v1",
        ...result,
      });
      return result;
    }
    case "verify-bundle": {
      if (!args.root) throw new Error("verify-bundle requires --root");
      const result = await verifyProviderReleaseBundle({
        bundleRoot: resolve(args.root),
      });
      printJson({
        kind: "takosumi.provider-release-bundle-verification@v1",
        ...result,
      });
      return result;
    }
    case "prepublish-check": {
      if (!args.root) throw new Error("prepublish-check requires --root");
      const result = await verifyProviderPrepublication({
        bundleRoot: resolve(args.root),
      });
      printJson({
        kind: "takosumi.provider-release-prepublication@v1",
        ...result,
      });
      return result;
    }
    case "build": {
      if (!args.output || !args["source-commit"] || !args.tag) {
        throw new Error("build requires --output, --source-commit, and --tag");
      }
      const result = await buildProviderRelease({
        repoRoot: resolve(args.repo ?? PROVIDER_RELEASE_ROOT),
        outputRoot: resolve(args.output),
        sourceCommit: args["source-commit"],
        tag: args.tag,
        testOnlyAllowUnsignedTag:
          args["test-only-allow-unsigned-tag"] === "true",
      });
      printJson({
        kind: "takosumi.provider-release-build@v1",
        outputRoot: result.outputRoot,
        version: result.version,
        tag: result.tag,
        sourceCommit: result.sourceCommit,
        manifestDigest: result.manifestDigest,
      });
      return result;
    }
    case "manifest-digest": {
      if (!args.manifest)
        throw new Error("manifest-digest requires --manifest");
      const path = resolve(args.manifest);
      const result = { path, sha256: await manifestDigest(path) };
      printJson(result);
      return result;
    }
    default:
      throw new Error(
        "usage: bun scripts/provider-release.mjs <verify-source|materialize|verify-mirror|verify-bundle|prepublish-check|build|manifest-digest> [options]",
      );
  }
}

const COMMAND_OPTIONS = {
  "verify-source": new Set(),
  materialize: new Set(["output", "registry", "artifact-root", "cache-root"]),
  "verify-mirror": new Set(["root", "registry"]),
  "verify-bundle": new Set(["root"]),
  "prepublish-check": new Set(["root"]),
  build: new Set([
    "output",
    "source-commit",
    "tag",
    "repo",
    "test-only-allow-unsigned-tag",
  ]),
  "manifest-digest": new Set(["manifest"]),
};

function parseArgs(argv, command) {
  const result = {};
  const allowed = COMMAND_OPTIONS[command] ?? new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument ${token}`);
    const name = token.slice(2);
    if (!name) throw new Error("empty option name");
    if (!allowed.has(name)) {
      throw new Error(`unknown option --${name} for ${String(command)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option --${name} requires a value`);
    }
    if (name in result) throw new Error(`duplicate option --${name}`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.main) {
  await runProviderReleaseCli();
}
