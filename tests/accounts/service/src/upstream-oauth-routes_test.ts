import { expect, test } from "bun:test";
import type { TakosumiAccountsAuthProvidersResponse } from "@takosjp/takosumi-accounts-contract";
import { handleAuthProvidersRequest } from "../../../../accounts/service/src/upstream-oauth-routes.ts";
import type { UpstreamOAuthOptions } from "../../../../accounts/service/src/mod.ts";

async function readProviders(
  response: Response,
): Promise<TakosumiAccountsAuthProvidersResponse> {
  expect(response.status).toEqual(200);
  expect(response.headers.get("cache-control")).toEqual("no-store");
  return (await response.json()) as TakosumiAccountsAuthProvidersResponse;
}

test("handleAuthProvidersRequest reports built-ins disabled when nothing configured", async () => {
  const body = await readProviders(handleAuthProvidersRequest({}));
  expect(body.providers).toEqual([
    { id: "google", enabled: false },
    { id: "passkey", enabled: false },
  ]);
});

test("handleAuthProvidersRequest marks configured upstream providers enabled", async () => {
  const upstreamOAuth: UpstreamOAuthOptions = {
    subjectSecret: "secret",
    providers: [
      {
        providerId: "google",
        clientId: "google-client",
        redirectUri: "https://accounts.example.test/callback",
      },
    ],
  };
  const body = await readProviders(
    handleAuthProvidersRequest({ upstreamOAuth }),
  );
  expect(body.providers).toContainEqual({ id: "google", enabled: true });
  expect(body.providers).toContainEqual({ id: "passkey", enabled: false });
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
  expect(body.providers).toContainEqual({ id: "passkey", enabled: true });
});

test("handleAuthProvidersRequest hides custom upstream provider ids from hosted dashboard discovery", async () => {
  const upstreamOAuth: UpstreamOAuthOptions = {
    subjectSecret: "secret",
    providers: [
      {
        providerId: "keycloak",
        clientId: "kc-client",
        redirectUri: "https://accounts.example.test/callback",
      },
    ],
  };
  const body = await readProviders(
    handleAuthProvidersRequest({ upstreamOAuth }),
  );
  expect(body.providers).toEqual([
    { id: "google", enabled: false },
    { id: "passkey", enabled: false },
  ]);
});

test("handleAuthProvidersRequest hides retired GitHub sign-in config", async () => {
  const upstreamOAuth: UpstreamOAuthOptions = {
    subjectSecret: "secret",
    providers: [
      {
        providerId: "github",
        clientId: "gh-client",
        redirectUri: "https://accounts.example.test/callback",
      },
    ],
  };
  const body = await readProviders(
    handleAuthProvidersRequest({ upstreamOAuth }),
  );
  expect(body.providers).toEqual([
    { id: "google", enabled: false },
    { id: "passkey", enabled: false },
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
