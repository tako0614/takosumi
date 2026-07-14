import { expect, test } from "bun:test";
import type { TakosumiAccountsAuthProvidersResponse } from "@takosjp/takosumi-accounts-contract";
import { handleAuthProvidersRequest } from "../../../../accounts/service/src/upstream-oauth-routes.ts";
import type { UpstreamOAuthOptions } from "../../../../accounts/service/src/mod.ts";
import { oidcOAuthProvider } from "../../../../accounts/service/src/upstream.ts";

function testProvider(id: string) {
  return oidcOAuthProvider({
    id,
    issuer: `https://${id}.example.test`,
    authorizationEndpoint: `https://${id}.example.test/authorize`,
    tokenEndpoint: `https://${id}.example.test/token`,
    userInfoEndpoint: `https://${id}.example.test/userinfo`,
  });
}

async function readProviders(
  response: Response,
): Promise<TakosumiAccountsAuthProvidersResponse> {
  expect(response.status).toEqual(200);
  expect(response.headers.get("cache-control")).toEqual("no-store");
  return (await response.json()) as TakosumiAccountsAuthProvidersResponse;
}

test("handleAuthProvidersRequest reports no methods when nothing is configured", async () => {
  const body = await readProviders(handleAuthProvidersRequest({}));
  expect(body.providers).toEqual([]);
});

test("handleAuthProvidersRequest marks configured upstream providers enabled", async () => {
  const upstreamOAuth: UpstreamOAuthOptions = {
    subjectSecret: "secret",
    providers: [
      {
        providerId: "primary-oidc",
        label: "Primary OIDC",
        protocol: "oidc",
        clientId: "primary-client",
        redirectUri: "https://accounts.example.test/callback",
        provider: testProvider("primary-oidc"),
      },
    ],
  };
  const body = await readProviders(
    handleAuthProvidersRequest({ upstreamOAuth }),
  );
  expect(body.providers).toEqual([
    {
      id: "primary-oidc",
      enabled: true,
      label: "Primary OIDC",
      protocol: "oidc",
    },
  ]);
});

test("handleAuthProvidersRequest enables passkey when passkeys configured", async () => {
  const body = await readProviders(
    handleAuthProvidersRequest({
      passkeys: {
        rpId: "example.test",
        rpName: "Example",
        origin: "https://app.example.test",
      },
    }),
  );
  expect(body.providers).toEqual([
    {
      id: "passkey",
      enabled: true,
      label: "Passkey",
      protocol: "webauthn",
    },
  ]);
});

test("handleAuthProvidersRequest publishes generic OIDC descriptors", async () => {
  const upstreamOAuth: UpstreamOAuthOptions = {
    subjectSecret: "secret",
    providers: [
      {
        providerId: "keycloak",
        label: "Company SSO",
        protocol: "oidc",
        clientId: "kc-client",
        redirectUri: "https://accounts.example.test/callback",
        provider: testProvider("keycloak"),
      },
    ],
  };
  const body = await readProviders(
    handleAuthProvidersRequest({ upstreamOAuth }),
  );
  expect(body.providers).toEqual([
    {
      id: "keycloak",
      enabled: true,
      label: "Company SSO",
      protocol: "oidc",
    },
  ]);
});

test("handleAuthProvidersRequest treats an explicitly configured provider id generically", async () => {
  const upstreamOAuth: UpstreamOAuthOptions = {
    subjectSecret: "secret",
    providers: [
      {
        providerId: "github",
        clientId: "gh-client",
        redirectUri: "https://accounts.example.test/callback",
        provider: testProvider("github"),
      },
    ],
  };
  const body = await readProviders(
    handleAuthProvidersRequest({ upstreamOAuth }),
  );
  expect(body.providers).toEqual([
    {
      id: "github",
      enabled: true,
      label: "Single sign-on",
      protocol: "oidc",
    },
  ]);
});

test("handleAuthProvidersRequest never leaks credentials in the body", async () => {
  const upstreamOAuth: UpstreamOAuthOptions = {
    subjectSecret: "top-secret-subject-secret",
    providers: [
      {
        providerId: "github",
        clientId: "gh-client-id",
        clientSecret: "gh-client-secret",
        redirectUri: "https://accounts.example.test/callback",
        provider: testProvider("github"),
      },
    ],
  };
  const response = handleAuthProvidersRequest({ upstreamOAuth });
  const text = await response.text();
  expect(text).not.toContain("gh-client-id");
  expect(text).not.toContain("gh-client-secret");
  expect(text).not.toContain("top-secret-subject-secret");
  expect(text).not.toContain("callback");
});
