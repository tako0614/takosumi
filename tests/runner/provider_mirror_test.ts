import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";

const ROOT = new URL("../../", import.meta.url);
const MIRROR_PROVIDERS = new URL("runner/mirror-providers.tf", ROOT);
const TOFU_RC = new URL("runner/tofu.rc", ROOT);
const RUNNER_DOCKERFILE = new URL("runner/Dockerfile", ROOT);
const PROVIDERS_TS = new URL("runner/lib/providers.ts", ROOT);

function providerSourcesFromMirrorConfig(config: string): readonly string[] {
  return Array.from(
    config.matchAll(/\bsource\s*=\s*"([^"]+)"/gu),
    (match) => match[1]!,
  ).sort();
}

test("runner provider mirror pins Cloudflare to the GA Takos lockfile version", async () => {
  const config = await readFile(MIRROR_PROVIDERS, "utf8");

  expect(config).toContain(
    'source  = "registry.opentofu.org/cloudflare/cloudflare"',
  );
  expect(config).toContain('version = "= 5.19.1"');
  expect(config).not.toContain('version = "~> 5.0"');
});

test("runner provider mirror uses exact versions for offline-only providers", async () => {
  const config = await readFile(MIRROR_PROVIDERS, "utf8");

  expect(config).toContain('version = "= 3.9.0"');
  expect(config).toContain('version = "= 4.3.0"');
  expect(config).toContain('version = "= 3.6.0"');
  expect(config).not.toContain('version = "~> 6.0"');
  expect(config).not.toContain("hashicorp/aws");
});

test("runner image may curate a cache without making its providers runtime defaults", async () => {
  const mirror = await readFile(MIRROR_PROVIDERS, "utf8");
  const tofuRc = await readFile(TOFU_RC, "utf8");
  const providersTs = await readFile(PROVIDERS_TS, "utf8");
  const providers = providerSourcesFromMirrorConfig(mirror);

  expect(providers).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
    "registry.opentofu.org/hashicorp/http",
    "registry.opentofu.org/hashicorp/random",
    "registry.opentofu.org/hashicorp/tls",
  ]);
  for (const provider of providers) {
    expect(tofuRc).not.toContain(JSON.stringify(provider));
    expect(providersTs).not.toContain(JSON.stringify(provider));
  }
  expect(tofuRc).toContain("filesystem_mirror");
  expect(tofuRc).toContain("direct {}");
  expect(providersTs).not.toContain("DEFAULT_MIRRORED_PROVIDERS");
});

test("runner image configures only an OpenTofu provider plugin cache", async () => {
  const dockerfile = await readFile(RUNNER_DOCKERFILE, "utf8");

  expect(dockerfile).toContain(
    "ENV TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR=/tmp/takosumi-provider-cache",
  );
  expect(dockerfile).not.toContain("TAKOSUMI_APP_ARTIFACT_CACHE_DIR");
  expect(dockerfile).not.toContain("TAKOSUMI_BUILD_CACHE_DIR");
});

test("GA runner pins its base image and verified OpenTofu runtime bytes", async () => {
  const dockerfile = await readFile(RUNNER_DOCKERFILE, "utf8");

  expect(dockerfile).toContain(
    "BUN_BASE_IMAGE=oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
  );
  expect(dockerfile).toContain("ARG OPENTOFU_VERSION=1.12.5");
  expect(dockerfile).toContain(
    "ARG OPENTOFU_SHA256=dade9650e6b74fc7a8b986bd8717497d32f9e09cf82e479afef4977fa3085536",
  );
  expect(dockerfile).not.toContain("FROM oven/bun:1\n");
});

test("runner image copies the lifecycle provider-configuration contract closure", async () => {
  const dockerfile = await readFile(RUNNER_DOCKERFILE, "utf8");

  for (const path of [
    "provider-env-rules.ts",
    "provider-configurations.ts",
    "redaction.ts",
    "types.ts",
  ]) {
    expect(dockerfile).toContain(`COPY contract/${path} ./contract/${path}`);
  }
});
