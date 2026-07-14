import { expect, test } from "bun:test";
import { assertEquals, assertRejects } from "../../../helpers/assert.ts";
import {
  buildUpstreamAuthorizationUrl,
  oidcOAuthProvider,
  exchangeUpstreamAuthorizationCode,
} from "../../../../accounts/service/src/upstream.ts";

function fixtureProvider() {
  return oidcOAuthProvider({
    id: "fixture-oidc",
    issuer: "https://idp.example.test",
    authorizationEndpoint: "https://idp.example.test/oauth/authorize",
    tokenEndpoint: "https://idp.example.test/oauth/token",
    userInfoEndpoint: "https://idp.example.test/oauth/userinfo",
  });
}

test("buildUpstreamAuthorizationUrl includes scopes, state, and PKCE", () => {
  const url = buildUpstreamAuthorizationUrl({
    provider: fixtureProvider(),
    clientId: "fixture-client",
    redirectUri: "https://accounts.example.test/callback/fixture-oidc",
    state: "state-1",
    codeChallenge: "challenge-1",
  });

  expect(url.origin + url.pathname).toEqual(
    "https://idp.example.test/oauth/authorize",
  );
  expect(url.searchParams.get("response_type")).toEqual("code");
  expect(url.searchParams.get("client_id")).toEqual("fixture-client");
  expect(url.searchParams.get("redirect_uri")).toEqual(
    "https://accounts.example.test/callback/fixture-oidc",
  );
  expect(url.searchParams.get("scope")).toEqual("openid profile email");
  expect(url.searchParams.get("state")).toEqual("state-1");
  expect(url.searchParams.get("code_challenge")).toEqual("challenge-1");
  expect(url.searchParams.get("code_challenge_method")).toEqual("S256");
});

test("oidcOAuthProvider builds explicit OIDC authorization requests", () => {
  const provider = oidcOAuthProvider({
    id: "keycloak",
    issuer: "https://idp.example.test/realms/takos",
    authorizationEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/auth",
    tokenEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/token",
    userInfoEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/userinfo",
  });

  const url = buildUpstreamAuthorizationUrl({
    provider,
    clientId: "keycloak-client",
    redirectUri: "https://accounts.example.test/callback/oidc",
    state: "state-oidc",
  });

  expect(url.origin + url.pathname).toEqual(
    "https://idp.example.test/realms/takos/protocol/openid-connect/auth",
  );
  expect(url.searchParams.get("scope")).toEqual("openid profile email");
  expect(url.searchParams.get("client_id")).toEqual("keycloak-client");
  expect(url.searchParams.get("state")).toEqual("state-oidc");
});

test("exchangeUpstreamAuthorizationCode exchanges token and derives stable subject", async () => {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url === "https://idp.example.test/oauth/token") {
      expect(request.method).toEqual("POST");
      const body = new URLSearchParams(await request.text());
      expect(body.get("grant_type")).toEqual("authorization_code");
      expect(body.get("client_id")).toEqual("fixture-client");
      expect(body.get("client_secret")).toEqual("fixture-secret");
      return Response.json({ access_token: "fixture-access-token" });
    }
    if (request.url === "https://idp.example.test/oauth/userinfo") {
      expect(request.headers.get("authorization")).toEqual(
        "Bearer fixture-access-token",
      );
      return Response.json({
        sub: "fixture-subject-123",
        name: "Fixture User",
      });
    }
    return new Response("unexpected request", { status: 500 });
  };

  const result = await exchangeUpstreamAuthorizationCode({
    provider: fixtureProvider(),
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    redirectUri: "https://accounts.example.test/callback/fixture-oidc",
    code: "code-1",
    subjectSecret: "subject-secret",
    fetch: fetchImpl,
  });

  expect(requests.length).toEqual(2);
  expect(result.providerId).toEqual("fixture-oidc");
  expect(result.upstreamIssuer).toEqual("https://idp.example.test");
  expect(result.upstreamSubject).toEqual("fixture-subject-123");
  expect(result.takosumiSubject.startsWith("tsub_")).toEqual(true);
});

test("exchangeUpstreamAuthorizationCode supports explicit OIDC subject claims", async () => {
  const provider = oidcOAuthProvider({
    id: "keycloak",
    issuer: "https://idp.example.test/realms/takos",
    authorizationEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/auth",
    tokenEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/token",
    userInfoEndpoint:
      "https://idp.example.test/realms/takos/protocol/openid-connect/userinfo",
    subjectClaim: "sub",
  });
  const fetchImpl: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    if (
      request.url ===
      "https://idp.example.test/realms/takos/protocol/openid-connect/token"
    ) {
      return Promise.resolve(Response.json({ access_token: "oidc-token" }));
    }
    if (
      request.url ===
      "https://idp.example.test/realms/takos/protocol/openid-connect/userinfo"
    ) {
      expect(request.headers.get("authorization")).toEqual("Bearer oidc-token");
      return Promise.resolve(Response.json({ sub: "user-1" }));
    }
    return Promise.resolve(new Response("unexpected request", { status: 500 }));
  };

  const result = await exchangeUpstreamAuthorizationCode({
    provider,
    clientId: "keycloak-client",
    clientSecret: "keycloak-secret",
    redirectUri: "https://accounts.example.test/callback/oidc",
    code: "code-oidc",
    subjectSecret: "subject-secret",
    fetch: fetchImpl,
  });

  expect(result.providerId).toEqual("keycloak");
  expect(result.upstreamIssuer).toEqual(
    "https://idp.example.test/realms/takos",
  );
  expect(result.upstreamSubject).toEqual("user-1");
  expect(result.takosumiSubject.startsWith("tsub_")).toEqual(true);
});

test("exchangeUpstreamAuthorizationCode rejects missing upstream subjects", async () => {
  const fetchImpl: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://idp.example.test/oauth/token") {
      return Promise.resolve(
        Response.json({ access_token: "fixture-access-token" }),
      );
    }
    return Promise.resolve(Response.json({ email: "user@example.test" }));
  };

  await assertRejects(
    () =>
      exchangeUpstreamAuthorizationCode({
        provider: fixtureProvider(),
        clientId: "fixture-client",
        redirectUri: "https://accounts.example.test/callback/fixture-oidc",
        code: "code-1",
        subjectSecret: "subject-secret",
        fetch: fetchImpl,
      }),
    TypeError,
    "subject claim",
  );
});
