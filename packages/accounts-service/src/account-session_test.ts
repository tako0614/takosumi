import { expect, test } from "bun:test";

import {
  ACCOUNT_SESSION_COOKIE_NAME,
  clearAccountSessionCookie,
  extractAccountSessionId,
  handleAccountSessionMeDelete,
  handleAccountSessionMeGet,
  mintAccountSessionId,
  rotateAccountSession,
  serializeAccountSessionCookie,
  TAKOSUMI_ACCOUNTS_SESSION_ME_PATH,
} from "./account-session.ts";
import { InMemoryAccountsStore } from "./store.ts";

test("mintAccountSessionId yields a fresh sess_ prefixed identifier", () => {
  const first = mintAccountSessionId();
  const second = mintAccountSessionId();
  expect(first.startsWith("sess_")).toEqual(true);
  expect(second.startsWith("sess_")).toEqual(true);
  expect(first).not.toEqual(second);
});

test("serializeAccountSessionCookie sets HttpOnly + SameSite=Strict", () => {
  const cookie = serializeAccountSessionCookie("sess_xyz", {
    secure: true,
    maxAgeSeconds: 60,
  });
  expect(cookie.includes("HttpOnly")).toEqual(true);
  expect(cookie.includes("SameSite=Strict")).toEqual(true);
  expect(cookie.includes("Secure")).toEqual(true);
  expect(cookie.includes(`${ACCOUNT_SESSION_COOKIE_NAME}=sess_xyz`)).toEqual(true);
});

test("clearAccountSessionCookie produces Max-Age=0", () => {
  const cookie = clearAccountSessionCookie(true);
  expect(cookie.includes("Max-Age=0")).toEqual(true);
  expect(cookie.includes("HttpOnly")).toEqual(true);
});

test("extractAccountSessionId prefers Authorization bearer", () => {
  const request = new Request("https://accounts.example.test/", {
    headers: {
      authorization: "Bearer sess_from_header",
      cookie: "takosumi_session=sess_from_cookie",
    },
  });
  expect(extractAccountSessionId(request)).toEqual("sess_from_header");
});

test("extractAccountSessionId falls back to cookie when no header", () => {
  const request = new Request("https://accounts.example.test/", {
    headers: {
      cookie: "takosumi_session=sess_from_cookie",
    },
  });
  expect(extractAccountSessionId(request)).toEqual("sess_from_cookie");
});

test("extractAccountSessionId returns null when no credential present", () => {
  const request = new Request("https://accounts.example.test/");
  expect(extractAccountSessionId(request)).toEqual(null);
});

test("rotateAccountSession mints a new session id and revokes the prior one", async () => {
  const store = new InMemoryAccountsStore();
  const now = 1_000;
  store.saveAccount({
    subject: "tsub_rotate",
    createdAt: now,
    updatedAt: now,
  });
  const oldSessionId = "sess_initial";
  store.saveAccountSession({
    sessionId: oldSessionId,
    subject: "tsub_rotate",
    createdAt: now,
    expiresAt: now + 60_000,
  });

  const rotated = await rotateAccountSession({
    store,
    oldSessionId,
    subject: "tsub_rotate",
    now,
    ttlMs: 60_000,
  });

  expect(rotated.sessionId.startsWith("sess_")).toEqual(true);
  expect(rotated.sessionId).not.toEqual(oldSessionId);
  expect(rotated.expiresAt).toEqual(now + 60_000);
  // The new session must resolve to the subject.
  expect(store.findAccountSession(rotated.sessionId)?.subject).toEqual("tsub_rotate");
  // The old session id must no longer resolve (rotated single-use).
  expect(store.findAccountSession(oldSessionId)).toEqual(undefined);
});

test("rotateAccountSession with no prior session just mints a new one", async () => {
  const store = new InMemoryAccountsStore();
  const now = 2_000;
  store.saveAccount({
    subject: "tsub_first_login",
    createdAt: now,
    updatedAt: now,
  });
  const rotated = await rotateAccountSession({
    store,
    oldSessionId: null,
    subject: "tsub_first_login",
    now,
    ttlMs: 30_000,
  });
  expect(store.findAccountSession(rotated.sessionId)?.subject).toEqual("tsub_first_login");
});

test("TAKOSUMI_ACCOUNTS_SESSION_ME_PATH is /v1/account/session/me", () => {
  expect(TAKOSUMI_ACCOUNTS_SESSION_ME_PATH).toEqual("/v1/account/session/me");
});

test("handleAccountSessionMeGet returns subject+expiresAt for a valid cookie", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const sessionId = "sess_me_ok";
  store.saveAccount({
    subject: "tsub_me",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId,
    subject: "tsub_me",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const request = new Request(
    "https://accounts.example.test/v1/account/session/me",
    {
      headers: { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}` },
    },
  );
  const response = await handleAccountSessionMeGet({ request, store });
  expect(response.status).toEqual(200);
  const body = await response.json() as {
    subject: string;
    expiresAt: number;
    primaryAccountId?: string;
  };
  expect(body.subject).toEqual("tsub_me");
  expect(body.expiresAt).toEqual(now + 60_000);
  expect(body.primaryAccountId).toEqual(undefined);
});

test("handleAccountSessionMeGet returns 401 for missing cookie", async () => {
  const store = new InMemoryAccountsStore();
  const request = new Request(
    "https://accounts.example.test/v1/account/session/me",
  );
  const response = await handleAccountSessionMeGet({ request, store });
  expect(response.status).toEqual(401);
  await response.body?.cancel();
});

test("handleAccountSessionMeGet returns 401 for expired cookie", async () => {
  const store = new InMemoryAccountsStore();
  const past = Date.now() - 60_000;
  const sessionId = "sess_me_expired";
  store.saveAccount({
    subject: "tsub_me_expired",
    createdAt: past,
    updatedAt: past,
  });
  store.saveAccountSession({
    sessionId,
    subject: "tsub_me_expired",
    createdAt: past,
    expiresAt: past + 1, // already expired
  });
  const request = new Request(
    "https://accounts.example.test/v1/account/session/me",
    {
      headers: { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}` },
    },
  );
  const response = await handleAccountSessionMeGet({ request, store });
  expect(response.status).toEqual(401);
  await response.body?.cancel();
});

test("handleAccountSessionMeGet surfaces primaryAccountId when resolver returns one", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const sessionId = "sess_me_primary";
  store.saveAccount({
    subject: "tsub_primary",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId,
    subject: "tsub_primary",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const request = new Request(
    "https://accounts.example.test/v1/account/session/me",
    {
      headers: { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}` },
    },
  );
  const response = await handleAccountSessionMeGet({
    request,
    store,
    resolvePrimaryAccountId: (subject) => {
      expect(subject).toEqual("tsub_primary");
      return "acct_primary";
    },
  });
  expect(response.status).toEqual(200);
  const body = await response.json() as {
    subject: string;
    primaryAccountId?: string;
  };
  expect(body.primaryAccountId).toEqual("acct_primary");
});

test("handleAccountSessionMeDelete revokes session and emits clear cookie", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const sessionId = "sess_me_delete";
  store.saveAccount({
    subject: "tsub_delete",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId,
    subject: "tsub_delete",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const request = new Request(
    "https://accounts.example.test/v1/account/session/me",
    {
      method: "DELETE",
      headers: { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}` },
    },
  );
  const response = await handleAccountSessionMeDelete({
    request,
    store,
    secureCookie: true,
  });
  expect(response.status).toEqual(204);
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie.includes("Max-Age=0")).toEqual(true);
  expect(setCookie.includes("HttpOnly")).toEqual(true);
  expect(setCookie.includes("Secure")).toEqual(true);
  // The server-side record must be gone.
  expect(store.findAccountSession(sessionId)).toEqual(undefined);
});

test("handleAccountSessionMeDelete is idempotent when no session is presented", async () => {
  const store = new InMemoryAccountsStore();
  const request = new Request(
    "https://accounts.example.test/v1/account/session/me",
    { method: "DELETE" },
  );
  const response = await handleAccountSessionMeDelete({
    request,
    store,
    secureCookie: false,
  });
  expect(response.status).toEqual(204);
  expect((response.headers.get("set-cookie") ?? "").includes("Max-Age=0")).toEqual(true);
});
