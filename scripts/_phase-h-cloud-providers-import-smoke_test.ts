/**
 * Phase H test — all 6 cloud provider workspace packages export factory
 * functions whose return value is a structurally valid `KernelPlugin`
 * suitable for `createPaaSApp({ kindAliases, plugins: [...] })`.
 *
 * This locks in the "Phase D extraction" outcome: provider materializers
 * live in `@takos/takosumi-{cloudflare,aws,gcp,kubernetes,deno-deploy,
 * selfhost}-providers`, kernel core is cloud-SDK-free, and operators wire
 * providers into the kernel by importing the relevant package and pushing
 * the factory result into the plain `plugins[]` array.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.6";
import {
  CLOUD_PROVIDER_ROWS,
  isValidKernelPlugin,
} from "./_phase-h-cloud-providers-import-smoke.ts";

Deno.test("phase-h: all 17 cloud-provider factories return valid KernelPlugin", () => {
  assertEquals(CLOUD_PROVIDER_ROWS.length, 17);
  for (const row of CLOUD_PROVIDER_ROWS) {
    assert(
      isValidKernelPlugin(row.plugin),
      `${row.pkg}.${row.factory} did not return a KernelPlugin shape`,
    );
  }
});

Deno.test("phase-h: 6 cloud provider packages are covered (no missing publisher)", () => {
  const pkgs = new Set(CLOUD_PROVIDER_ROWS.map((row) => row.pkg));
  assertEquals(
    pkgs,
    new Set([
      "cloudflare",
      "aws",
      "gcp",
      "kubernetes",
      "deno-deploy",
      "selfhost",
    ]),
  );
});

Deno.test("phase-h: each KernelPlugin advertises a takosumi.com reference kind URI", () => {
  const allowedKindUris = new Set([
    "https://takosumi.com/kinds/v1/worker",
    "https://takosumi.com/kinds/v1/web-service",
    "https://takosumi.com/kinds/v1/object-store",
    "https://takosumi.com/kinds/v1/postgres",
    "https://takosumi.com/kinds/v1/gateway",
  ]);
  for (const row of CLOUD_PROVIDER_ROWS) {
    const provides = (row.plugin as { provides: readonly string[] }).provides ??
      [];
    assert(provides.length > 0, `${row.factory} declares no provides[]`);
    for (const kindUri of provides) {
      assert(
        allowedKindUris.has(kindUri),
        `${row.factory} provides unknown kind URI: ${kindUri}`,
      );
    }
  }
});
