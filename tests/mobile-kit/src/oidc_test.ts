import { expect, test } from "bun:test";
import {
  createOidcAuthorizationUrl,
  createPkcePair,
  exchangeOidcCode,
  parseOidcCallback,
} from "../../../mobile-kit/src/index.ts";

test("createPkcePair creates S256 verifier material", async () => {
  const pair = await createPkcePair();
  expect(pair.codeChallengeMethod).toBe("S256");
  expect(pair.codeVerifier.length).toBe(64);
  expect(pair.codeChallenge.length).toBeGreaterThan(20);
});

test("createOidcAuthorizationUrl builds a public PKCE authorize URL", () => {
  const url = new URL(
    createOidcAuthorizationUrl({
      metadata: {
        issuer: "https://host.example",
        authorization_endpoint: "https://host.example/oauth/authorize",
      },
      clientId: "mobile",
      redirectUri: "takos://oauth/callback",
      state: "state-1",
      codeChallenge: "challenge-1",
    }),
  );

  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")).toBe("openid profile offline_access");
});

test("parseOidcCallback validates state", () => {
  expect(
    parseOidcCallback("takos://oauth/callback?code=c1&state=s1", "s1"),
  ).toEqual({ code: "c1", state: "s1" });
  expect(() =>
    parseOidcCallback("takos://oauth/callback?code=c1&state=s2", "s1"),
  ).toThrow("OIDC callback state mismatch.");
});

test("exchangeOidcCode posts public PKCE token exchange", async () => {
  const requests: Request[] = [];
  const token = await exchangeOidcCode({
    metadata: {
      issuer: "https://host.example",
      authorization_endpoint: "https://host.example/oauth/authorize",
      token_endpoint: "https://host.example/oauth/token",
    },
    clientId: "takos-mobile",
    redirectUri: "takos://oauth/callback",
    code: "code-1",
    codeVerifier: "verifier-1",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          access_token: "access-1",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  expect(token.access_token).toBe("access-1");
  expect(token.token_type).toBe("Bearer");
  expect(requests[0].method).toBe("POST");
  expect(await requests[0].text()).toContain("code_verifier=verifier-1");
});
