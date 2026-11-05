import { expect, test } from "bun:test";
import { credentialProseFixtures, credentialSpanFixtures } from "../helpers/credential_span_fixtures.ts";

import {
  parseProviderConfigurationsEnvelope,
  providerConfigurationsEnvelope,
  providerConfigurationsJson,
} from "../../contract/provider-configurations.ts";

test.each(credentialSpanFixtures)("provider non-secret configuration rejects credential continuations: $name", ({ input }) => {
  expect(() => providerConfigurationsEnvelope([{
    provider: "hashicorp/null",
    configuration: { text: input },
  }])).toThrow("contains a secret-like value");
});

test.each(credentialProseFixtures)("provider non-secret configuration retains format prose: %s", (input) => {
  expect(providerConfigurationsEnvelope([{
    provider: "hashicorp/null",
    configuration: { text: input },
  }]).providers[0]?.configuration.text).toBe(input);
});

test("provider configuration envelope canonicalizes provider, alias, entry, and JSON-key order", () => {
  const envelope = providerConfigurationsEnvelope([
    {
      provider: "hashicorp/aws",
      alias: "west",
      configuration: { region: "us-west-2" },
    },
    {
      provider: "cloudflare/cloudflare",
      configuration: {
        retries: 3,
        request: { timeout_ms: 5000, mode: "strict" },
        base_url: "https://provider.example.test/api",
      },
    },
  ]);

  expect(
    envelope.providers.map(({ provider, alias }) => ({ provider, alias })),
  ).toEqual([
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      alias: null,
    },
    { provider: "registry.opentofu.org/hashicorp/aws", alias: "west" },
  ]);
  expect(providerConfigurationsJson(envelope)).toBe(
    '{"format":"takosumi.provider-configurations@v1","providers":[{"provider":"registry.opentofu.org/cloudflare/cloudflare","alias":null,"configuration":{"base_url":"https://provider.example.test/api","request":{"mode":"strict","timeout_ms":5000},"retries":3}},{"provider":"registry.opentofu.org/hashicorp/aws","alias":"west","configuration":{"region":"us-west-2"}}]}',
  );
});

test("provider configuration envelope rejects duplicate provider and alias identities", () => {
  expect(() =>
    parseProviderConfigurationsEnvelope({
      format: "takosumi.provider-configurations@v1",
      providers: [
        {
          provider: "cloudflare/cloudflare",
          alias: null,
          configuration: { base_url: "https://one.example.test/api" },
        },
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          alias: null,
          configuration: { base_url: "https://two.example.test/api" },
        },
      ],
    }),
  ).toThrow("duplicate provider/alias");
});

test("provider configuration envelope preserves an explicit provider-default entry", () => {
  const envelope = providerConfigurationsEnvelope([
    {
      provider: "cloudflare/cloudflare",
      configuration: {},
    },
  ]);

  expect(envelope).toEqual({
    format: "takosumi.provider-configurations@v1",
    providers: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: null,
        configuration: {},
      },
    ],
  });
  expect(providerConfigurationsJson(envelope)).toBe(
    '{"format":"takosumi.provider-configurations@v1","providers":[{"provider":"registry.opentofu.org/cloudflare/cloudflare","alias":null,"configuration":{}}]}',
  );
});
