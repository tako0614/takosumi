import { expect, test } from "bun:test";
import {
  accountsExternalLoginConfigured,
  createCloudflareWorker,
  parseConfiguredOidcClients,
  parseLoginEmailAllowlist,
  type CloudflareWorkerEnv,
} from "../../../../deploy/accounts-cloudflare/src/handler.ts";
import { REQUIRED_PLATFORM_BINDINGS } from "../../../../deploy/accounts-cloudflare/src/bindings-check.ts";

function env(values: Record<string, unknown> = {}): CloudflareWorkerEnv {
  return values as CloudflareWorkerEnv;
}

test("Cloudflare Accounts worker keeps health local", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/healthz"),
    env(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    service: "takosumi-accounts",
  });
});

test("Cloudflare readiness checks canonical platform bindings only", async () => {
  const missing = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/readyz"),
    env(),
  );
  expect(missing.status).toBe(503);
  expect((await missing.json()).missing).not.toContain(
    "TAKOSUMI_ACCOUNTS_EXPORTS",
  );

  const complete: Record<string, unknown> = {};
  for (const name of [
    ...REQUIRED_PLATFORM_BINDINGS.d1,
    ...REQUIRED_PLATFORM_BINDINGS.r2,
    ...REQUIRED_PLATFORM_BINDINGS.durableObjects,
    ...REQUIRED_PLATFORM_BINDINGS.queues,
    ...REQUIRED_PLATFORM_BINDINGS.assets,
  ]) {
    complete[name] = {};
  }
  const ready = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/readyz"),
    env(complete),
  );
  expect(ready.status).toBe(200);
});

test("login allowlist and upstream discovery stay provider-neutral", () => {
  expect(
    parseLoginEmailAllowlist(
      env({ TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "a@example.test" }),
      "https://app.example.test",
    ),
  ).toEqual({ emails: ["a@example.test"], requireVerifiedEmail: true });
  expect(accountsExternalLoginConfigured(env())).toBe(false);
  expect(
    accountsExternalLoginConfigured(
      env({
        TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
        TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
          {
            providerId: "primary-oidc",
            issuer: "https://id.example.test",
            authorizationEndpoint: "https://id.example.test/authorize",
            tokenEndpoint: "https://id.example.test/token",
            userInfoEndpoint: "https://id.example.test/userinfo",
            clientId: "accounts-client",
            redirectUri: "https://app.example.test/sign-in/callback",
          },
        ]),
      }),
    ),
  ).toBe(true);
});

test("Cloudflare config preserves a host-specific public mobile OIDC client", () => {
  const mobileClient = {
    clientId: "takos-mobile-host-example",
    redirectUris: ["takos://oauth/callback"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid", "profile", "offline_access", "spaces:read"],
  } as const;

  expect(
    parseConfiguredOidcClients(
      env({ TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([mobileClient]) }),
    ),
  ).toEqual([mobileClient]);
});
