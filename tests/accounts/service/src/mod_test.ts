import { expect, test } from "bun:test";
import {
  createAccountsHandler,
  createEphemeralAccountsHandler,
} from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

test("Accounts exposes identity discovery without a Capsule projection registry", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "http://localhost:8787",
    subject: "tsub_local",
    store: new InMemoryAccountsStore(),
  });

  const discovery = await handler(
    new Request("http://localhost:8787/.well-known/openid-configuration"),
  );
  expect(discovery.status).toBe(200);

  const retiredProjection = await handler(
    new Request("http://localhost:8787/v1/capsule-projections"),
  );
  expect(retiredProjection.status).toBe(404);
  expect(await retiredProjection.json()).toMatchObject({
    error: { code: "not_found" },
  });
});

test("Accounts rejects production HTTPS with an ephemeral signing key", async () => {
  await expect(
    createEphemeralAccountsHandler({
      issuer: "https://app.example.test",
      store: new InMemoryAccountsStore(),
    }),
  ).rejects.toThrow("ephemeral OIDC signing key");
});

test("production-capable Accounts handler requires an explicit durable-store choice", () => {
  expect(() =>
    createAccountsHandler({ issuer: "https://app.example.test" } as never),
  ).toThrow("requires an explicit AccountsStore");
});

test("static public OIDC clients enforce exact redirect and allowed scopes", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "http://localhost:8787",
    subject: "tsub_local",
    store: new InMemoryAccountsStore(),
    clients: [
      {
        clientId: "takos-mobile-host-example",
        redirectUris: ["takos://oauth/callback"],
        tokenEndpointAuthMethod: "none",
        allowedScopes: ["openid", "profile", "offline_access"],
      },
    ],
  });
  const authorize = new URL("http://localhost:8787/oauth/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "takos-mobile-host-example",
    redirect_uri: "takos://oauth/callback/",
    scope: "openid",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  }).toString();

  const redirectMismatch = await handler(new Request(authorize));
  expect(redirectMismatch.status).toBe(400);
  expect(await redirectMismatch.json()).toMatchObject({
    error: "invalid_request",
    error_description: "redirect_uri is not registered for this client",
  });

  authorize.searchParams.set("redirect_uri", "takos://oauth/callback");
  authorize.searchParams.set("scope", "openid spaces:read");
  const scopeMismatch = await handler(new Request(authorize));
  expect(scopeMismatch.status).toBe(400);
  expect(await scopeMismatch.json()).toMatchObject({
    error: "invalid_scope",
  });
});

test("authorize refuses a subresource load so an <img> cannot harvest a code", async () => {
  const handler = await createEphemeralAccountsHandler({
    issuer: "http://localhost:8787",
    subject: "tsub_local",
    store: new InMemoryAccountsStore(),
    clients: [
      {
        clientId: "takos-mobile-host-example",
        redirectUris: ["takos://oauth/callback"],
        tokenEndpointAuthMethod: "none",
        allowedScopes: ["openid"],
      },
    ],
  });
  const authorize = new URL("http://localhost:8787/oauth/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "takos-mobile-host-example",
    redirect_uri: "takos://oauth/callback",
    scope: "openid",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  }).toString();

  // A launcher tile <img> pointed at /oauth/authorize: the browser labels the
  // request `image` and sends the session cookie with it.
  for (const dest of ["image", "iframe", "script", "empty"]) {
    const subresource = await handler(
      new Request(authorize, { headers: { "sec-fetch-dest": dest } }),
    );
    expect(subresource.status).toBe(400);
    expect(await subresource.json()).toMatchObject({
      error: "invalid_request",
      error_description: "authorize must be a top-level navigation",
    });
  }

  // A real navigation still reaches the sign-in gate rather than a 400.
  const navigation = await handler(
    new Request(authorize, { headers: { "sec-fetch-dest": "document" } }),
  );
  expect(navigation.status).not.toBe(400);
});
