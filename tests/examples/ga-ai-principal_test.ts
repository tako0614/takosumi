import { expect, test } from "bun:test";

import { parseRepositoryManifestText } from "../../contract/repository-manifest.ts";

const ROOT = new URL("../../", import.meta.url);
const PUBLIC_OIDC_OUTPUTS = [
  "public_url",
  "takosumi_accounts_issuer_url",
  "takosumi_accounts_client_id",
  "takosumi_accounts_redirect_uri",
] as const;

test("GA AI Principal fixture exposes only its public PKCE client identity", async () => {
  const manifest = parseRepositoryManifestText(
    await Bun.file(new URL(".well-known/takosumi.json", ROOT)).text(),
  );
  expect(manifest.ok).toBeTrue();
  if (!manifest.ok) return;
  const module = manifest.document.install.modules["examples/ga-ai-principal"];
  expect(module?.requires).toEqual([
    {
      kind: "http.endpoint",
      deliver: { variables: { url: "public_url" } },
    },
    {
      kind: "identity.oidc",
      callbackPath: "/__takosumi/ga-principal/callback",
      scopes: ["openid", "capsules:read"],
      deliver: {
        variables: {
          issuerUrl: "takosumi_accounts_issuer_url",
          clientId: "takosumi_accounts_client_id",
          redirectUri: "takosumi_accounts_redirect_uri",
        },
      },
    },
  ]);

  const source = await Bun.file(
    new URL("examples/ga-ai-principal/main.tf", ROOT),
  ).text();
  const outputNames = [...source.matchAll(/output\s+"([^"]+)"\s*\{/gu)].map(
    ([, name]) => name,
  );
  expect(outputNames).toEqual(PUBLIC_OIDC_OUTPUTS);
  expect((source.match(/sensitive\s*=\s*false/gu) ?? []).length).toBe(
    PUBLIC_OIDC_OUTPUTS.length,
  );
  expect(source).not.toMatch(/output\s+"[^"]*(?:secret|token|verifier|code)/iu);
});
