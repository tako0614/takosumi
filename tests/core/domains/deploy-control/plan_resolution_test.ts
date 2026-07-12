import { expect, test } from "bun:test";

import { providerEnvBindingsFromResolved } from "../../../../core/domains/deploy-control/plan_resolution.ts";
import type { ResolvedInstallationProviderEnvBinding } from "../../../../core/domains/connections/mod.ts";

test("managed Provider Connection threads generic provider configuration into root binding", () => {
  const resolved: readonly ResolvedInstallationProviderEnvBinding[] = [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      connection: {
        id: "conn_operator_compat",
        provider: "cloudflare",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        kind: "cloudflare_api_token",
        scope: "operator",
        status: "verified",
        materialization: "secret",
        envNames: ["CLOUDFLARE_API_TOKEN"],
        scopeHints: {
          managedProvider: true,
          managedProviderProfile: "compat.cloudflare.workers.v1",
          providerConfig: {
            base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
          },
          accountId: "ts_acc_takosumi_cloud",
        },
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
      },
      materialization: "secret",
    },
  ];

  expect(providerEnvBindingsFromResolved(resolved)).toEqual([
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      credentialDelivery: "generated_root_variable",
      configuration: {
        base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
      },
    },
  ]);
});
