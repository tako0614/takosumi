import { expect, test } from "bun:test";

import {
  createAccountsHandler,
  type PasskeyHttpOptions,
} from "../../../../accounts/service/src/mod.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { ACCOUNTS_JSON_BODY_MAX_BYTES } from "../../../../accounts/service/src/http-helpers.ts";
import { passkeyChallengeKey } from "../../../../accounts/service/src/passkey-challenge-store.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const issuer = "https://accounts.example.test";
const passkeys: PasskeyHttpOptions = {
  rpId: "accounts.example.test",
  rpName: "Takosumi",
  origin: issuer,
};

function seededHandler() {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_member",
    email: "member@example.test",
    displayName: "Member",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_member",
    subject: "tsub_member",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return {
    store,
    handler: createAccountsHandler({ issuer, store, passkeys }),
  };
}

function browserJsonRequest(path: string, body: unknown, origin = issuer) {
  return new Request(`${issuer}${path}`, {
    method: "POST",
    headers: {
      cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_member`,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("passkey registration options require a live session and derive the subject from it", async () => {
  const { handler } = seededHandler();
  const missingSession = await handler(
    new Request(`${issuer}/api/v1/auth/passkeys/register/options`, {
      method: "POST",
      headers: { origin: issuer, "content-type": "application/json" },
      body: JSON.stringify({ subject: "tsub_member" }),
    }),
  );
  expect(missingSession.status).toBe(401);

  const response = await handler(
    browserJsonRequest("/api/v1/auth/passkeys/register/options", {
      subject: "tsub_attacker_selected",
      userName: "chosen-name",
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    user: { id: "tsub_member", name: "chosen-name" },
  });
});

test("passkey authentication options do not reveal whether an account exists", async () => {
  const { handler, store } = seededHandler();
  store.savePasskeyCredential({
    credentialId: "credential_member",
    subject: "tsub_member",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    signCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const unknown = await handler(
    new Request(`${issuer}/api/v1/auth/passkeys/authenticate/options`, {
      method: "POST",
      headers: { origin: issuer, "content-type": "application/json" },
      body: JSON.stringify({ subject: "tsub_unknown" }),
    }),
  );
  const registered = await handler(
    new Request(`${issuer}/api/v1/auth/passkeys/authenticate/options`, {
      method: "POST",
      headers: { origin: issuer, "content-type": "application/json" },
      body: JSON.stringify({ subject: "tsub_member" }),
    }),
  );
  expect(unknown.status).toBe(200);
  expect(registered.status).toBe(200);
  expect(await unknown.json()).toMatchObject({ allowCredentials: [] });
  expect(await registered.json()).toMatchObject({ allowCredentials: [] });
});

test("parallel passkey challenges use distinct store keys instead of clobbering", async () => {
  const { handler, store } = seededHandler();
  const first = await handler(
    browserJsonRequest("/api/v1/auth/passkeys/register/options", {}),
  );
  const second = await handler(
    browserJsonRequest("/api/v1/auth/passkeys/register/options", {}),
  );
  const firstBody = (await first.json()) as { challenge: string };
  const secondBody = (await second.json()) as { challenge: string };
  expect(firstBody.challenge).not.toBe(secondBody.challenge);

  const firstStored = await store.consumePasskeyChallenge(
    passkeyChallengeKey({
      intent: "register",
      subject: "tsub_member",
      sessionId: "sess_member",
      challenge: firstBody.challenge,
    }),
    Date.now(),
  );
  const secondStored = await store.consumePasskeyChallenge(
    passkeyChallengeKey({
      intent: "register",
      subject: "tsub_member",
      sessionId: "sess_member",
      challenge: secondBody.challenge,
    }),
    Date.now(),
  );
  expect(firstStored).toBe(firstBody.challenge);
  expect(secondStored).toBe(secondBody.challenge);
});

test("cookie mutations require exact issuer Origin and route Content-Type", async () => {
  const { handler, store } = seededHandler();
  const noOrigin = await handler(
    new Request(`${issuer}/api/v1/account/session/me`, {
      method: "DELETE",
      headers: { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_member` },
    }),
  );
  expect(noOrigin.status).toBe(403);
  expect(store.findAccountSession("sess_member")).toBeDefined();

  const wrongType = await handler(
    new Request(`${issuer}/api/v1/auth/passkeys/register/options`, {
      method: "POST",
      headers: {
        cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_member`,
        origin: issuer,
        "content-type": "text/plain",
      },
      body: "{}",
    }),
  );
  expect(wrongType.status).toBe(415);

  const explicitBearer = await handler(
    new Request(`${issuer}/api/v1/auth/passkeys/register/options`, {
      method: "POST",
      headers: {
        authorization: "Bearer sess_member",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(explicitBearer.status).toBe(200);

  const exactOrigin = await handler(
    new Request(`${issuer}/api/v1/account/session/me`, {
      method: "DELETE",
      headers: {
        cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_member`,
        origin: issuer,
      },
    }),
  );
  expect(exactOrigin.status).toBe(204);
  expect(store.findAccountSession("sess_member")).toBeUndefined();
});

test("bodyless cookie mutations tolerate Cloudflare empty body streams", async () => {
  const { handler, store } = seededHandler();
  const response = await handler(
    new Request(`${issuer}/api/v1/account/session/me`, {
      method: "DELETE",
      headers: {
        cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_member`,
        origin: issuer,
      },
      // Cloudflare can reconstruct a bodyless mutation as a zero-byte stream.
      // Its absence of Content-Type must not turn a valid DELETE into 415.
      body: "",
    }),
  );
  expect(response.status).toBe(204);
  expect(store.findAccountSession("sess_member")).toBeUndefined();
});

test("Accounts JSON reader rejects streamed bytes beyond the route cap", async () => {
  const { handler } = seededHandler();
  const response = await handler(
    new Request(`${issuer}/api/v1/auth/passkeys/register/options`, {
      method: "POST",
      headers: {
        cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_member`,
        origin: issuer,
        "content-type": "application/json",
      },
      body: `{"padding":"${"x".repeat(ACCOUNTS_JSON_BODY_MAX_BYTES)}"}`,
    }),
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    error: { code: "request_too_large" },
  });
});
