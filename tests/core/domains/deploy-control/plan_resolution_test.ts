import { expect, test } from "bun:test";

import { providerBindingsFromResolved } from "../../../../core/domains/deploy-control/plan_resolution.ts";
import type { ResolvedCapsuleProviderBinding } from "../../../../core/domains/connections/mod.ts";

test("managed Provider Connection threads generic provider configuration into root binding", () => {
  const resolved: readonly ResolvedCapsuleProviderBinding[] = [
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
          managedProviderProfile: "compat.example.v1",
          providerConfig: {
            base_url: "https://operator.example.test/compat/example/v1",
          },
          accountId: "ts_acc_takosumi_cloud",
        },
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
      },
      materialization: "secret",
      moduleLocalName: "cloudflare",
    },
  ];

  expect(providerBindingsFromResolved(resolved)).toEqual([
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "cloudflare",
      configuration: {
        base_url: "https://operator.example.test/compat/example/v1",
      },
    },
  ]);
});

test("root binding generation rejects legacy aliases and missing local names", () => {
  const connection = {
    id: "conn_exact_binding",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    scope: "workspace" as const,
    workspaceId: "workspace_exact_binding",
    status: "verified" as const,
    materialization: "secret" as const,
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
  expect(() =>
    providerBindingsFromResolved([
      {
        provider: connection.providerSource,
        connection,
        materialization: "secret",
      },
    ])
  ).toThrow(/must declare moduleLocalName/);
  expect(() =>
    providerBindingsFromResolved([
      {
        provider: connection.providerSource,
        connection,
        materialization: "secret",
        moduleLocalName: "cloudflare",
        alias: "zone",
      },
    ])
  ).toThrow(/deprecated ambiguous ProviderBinding alias/);
});
