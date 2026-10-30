import { expect, test } from "bun:test";
import { InMemoryAccountsStore } from "@takosjp/takosumi-accounts-service";
import { buildComposedApp } from "../../../deploy/node-postgres/src/composed-app.ts";
import { parseEnv } from "../../../deploy/node-postgres/src/handler.ts";

test("node-postgres discovery is never shared across Host / X-Forwarded-* variants", async () => {
  const config = parseEnv({
    TAKOSUMI_ACCOUNTS_ISSUER: "https://takosumi.example",
    TAKOSUMI_ACCOUNTS_DATABASE_URL: "postgres://unused",
  });
  const { app } = await buildComposedApp({
    config,
    store: new InMemoryAccountsStore(),
    productDiscovery: {
      oidcIssuer: config.issuer,
      mobileOidcClientId: config.mobileOidcClientId,
    },
    accountsHandler: async () => new Response(null, { status: 404 }),
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });
  const response = await app.fetch(
    new Request("http://internal:8787/.well-known/takosumi", {
      headers: { host: "internal:8787", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toContain("X-Forwarded-Host");
  const document = (await response.json()) as {
    oidcClientId?: string;
    endpoints: { oidc_issuer: string };
  };
  // The issuer comes from configuration, never from forwarded headers.
  expect(document.endpoints.oidc_issuer).toBe("https://takosumi.example");
  expect(document.oidcClientId).toBe("takosumi-mobile");
});
