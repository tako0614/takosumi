import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";

const ROOT = new URL("../../", import.meta.url);
const MIRROR_PROVIDERS = new URL("runner/mirror-providers.tf", ROOT);

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
  expect(config).toContain('version = "= 6.51.0"');
  expect(config).not.toContain('version = "~> 6.0"');
});
