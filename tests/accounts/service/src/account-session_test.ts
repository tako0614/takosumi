import { expect, test } from "bun:test";

import {
  ACCOUNT_SESSION_COOKIE_NAME,
  clearAccountSessionCookie,
  extractAccountSessionId,
  handleAccountSessionMeDelete,
  handleAccountSessionMeGet,
  mintAccountSessionId,
  requireAccountsBearer,
  rotateAccountSession,
  serializeAccountSessionCookie,
  TAKOSUMI_ACCOUNTS_SESSION_ME_PATH,
} from "../../../../accounts/service/src/account-session.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

test("mintAccountSessionId yields a fresh sess_ prefixed identifier", () => {
  const first = mintAccountSessionId();
  const second = mintAccountSessionId();
  expect(first.startsWith("sess_")).toEqual(true);
  expect(second.startsWith("sess_")).toEqual(true);
  expect(first).not.toEqual(second);
});

test("serializeAccountSessionCookie sets HttpOnly + SameSite=Lax", () => {
  const cookie = serializeAccountSessionCookie("sess_xyz", {
    secure: true,
    maxAgeSeconds: 60,
  });
  expect(cookie.includes("HttpOnly")).toEqual(true);
  expect(cookie.includes("SameSite=Lax")).toEqual(true);
  expect(cookie.includes("Secure")).toEqual(true);
  expect(cookie.includes(`${ACCOUNT_SESSION_COOKIE_NAME}=sess_xyz`)).toEqual(
    true,
  );
});

test("clearAccountSessionCookie produces Max-Age=0", () => {
  const cookie = clearAccountSessionCookie(true);
  expect(cookie.includes("Max-Age=0")).toEqual(true);
  expect(cookie.includes("HttpOnly")).toEqual(true);
  expect(cookie.includes("SameSite=Lax")).toEqual(true);
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
  expect(store.findAccountSession(rotated.sessionId)?.subject).toEqual(
    "tsub_rotate",
  );
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
  expect(store.findAccountSession(rotated.sessionId)?.subject).toEqual(
    "tsub_first_login",
  );
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
  const body = (await response.json()) as {
    subject: string;
    expiresAt: number;
    primaryAccountId?: string;
  };
  expect(body.subject).toEqual("tsub_me");
  expect(body.expiresAt).toEqual(now + 60_000);
  expect(body.primaryAccountId).toEqual(undefined);
});

test("handleAccountSessionMeGet returns null session for missing cookie", async () => {
  const store = new InMemoryAccountsStore();
  const request = new Request(
    "https://accounts.example.test/v1/account/session/me",
  );
  const response = await handleAccountSessionMeGet({ request, store });
  expect(response.status).toEqual(200);
  expect(await response.json()).toEqual({ session: null });
});

test("handleAccountSessionMeGet returns null session for expired cookie", async () => {
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
  expect(response.status).toEqual(200);
  expect(await response.json()).toEqual({ session: null });
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
  const body = (await response.json()) as {
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
  expect(
    (response.headers.get("set-cookie") ?? "").includes("Max-Age=0"),
  ).toEqual(true);
});

test("requireAccountsBearer resolves an arbitrary-prefix session by exact record", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const token = "opaque.browser-session.without-a-type-prefix";
  store.saveAccount({
    subject: "tsub_arbitrary_session",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: token,
    subject: "tsub_arbitrary_session",
    createdAt: now,
    expiresAt: now + 60_000,
  });

  const result = await requireAccountsBearer({
    request: bearerRequest(token),
    store,
    scope: "read",
  });

  expect(result.ok).toEqual(true);
  if (result.ok) {
    expect(result.auth).toEqual({
      subject: "tsub_arbitrary_session",
      credential: "session",
    });
  }
});

test("requireAccountsBearer resolves an arbitrary-prefix OAuth token by exact record", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.oauth-secret.without-a-type-prefix";
  store.saveAccessToken(token, {
    clientId: "client_arbitrary_oauth",
    scope: "capsules:read",
    subject: "client-local-principal",
    takosumiSubject: "tsub_arbitrary_oauth",
    workspaceId: "workspace_oauth",
    expiresAt: Date.now() + 60_000,
  });

  const result = await requireAccountsBearer({
    request: bearerRequest(token),
    store,
    scope: "read",
  });

  expect(result.ok).toEqual(true);
  if (result.ok) {
    expect(result.auth).toEqual({
      subject: "tsub_arbitrary_oauth",
      principalSubject: "client-local-principal",
      credential: "oauth-access-token",
      workspaceId: "workspace_oauth",
    });
  }
});

test("requireAccountsBearer resolves an arbitrary-prefix PAT and records use", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.personal-secret.without-a-type-prefix";
  store.savePersonalAccessToken(token, {
    tokenId: "pat_arbitrary",
    tokenPrefix: "display-only",
    subject: "tsub_arbitrary_pat",
    name: "arbitrary PAT",
    scopes: ["read"],
    workspaceId: "workspace_pat",
    createdAt: Date.now(),
  });

  const result = await requireAccountsBearer({
    request: bearerRequest(token),
    store,
    scope: "read",
  });

  expect(result.ok).toEqual(true);
  if (result.ok) {
    expect(result.auth).toEqual({
      subject: "tsub_arbitrary_pat",
      credential: "personal-access-token",
      workspaceId: "workspace_pat",
    });
  }
  expect(store.findPersonalAccessToken(token)?.lastUsedAt).toBeNumber();
});

test("requireAccountsBearer rejects Interface OAuth on account routes", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.interface-invocation-secret";
  store.saveAccessToken(token, {
    clientId: "client_interface",
    audience: "https://capsule.example.test/mcp",
    scope: "mcp.invoke",
    subject: "principal_interface",
    takosumiSubject: "tsub_interface",
    workspaceId: "workspace_interface",
    role: "interface-runtime",
    interfaceId: "interface_mcp",
    interfaceBindingId: "binding_mcp",
    interfaceResolvedRevision: 3,
    expiresAt: Date.now() + 60_000,
  });

  const result = await requireAccountsBearer({
    request: bearerRequest(token),
    store,
    scope: "read",
  });

  expect(result.ok).toEqual(false);
  if (!result.ok) expect(result.response.status).toEqual(401);
});

test("requireAccountsBearer rejects an active cross-store token collision", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const token = "opaque.colliding-secret";
  store.saveAccount({
    subject: "tsub_collision_session",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: token,
    subject: "tsub_collision_session",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  store.saveAccessToken(token, {
    clientId: "client_collision",
    scope: "capsules:read",
    subject: "principal_collision",
    takosumiSubject: "tsub_collision_oauth",
    expiresAt: now + 60_000,
  });
  store.savePersonalAccessToken(token, {
    tokenId: "pat_collision",
    tokenPrefix: "display-only",
    subject: "tsub_collision_pat",
    name: "collision PAT",
    scopes: ["read"],
    createdAt: now,
  });

  const result = await requireAccountsBearer({
    request: bearerRequest(token),
    store,
    scope: "read",
  });

  expect(result.ok).toEqual(false);
  if (!result.ok) expect(result.response.status).toEqual(401);
  expect(store.findPersonalAccessToken(token)?.lastUsedAt).toEqual(undefined);
});

test("requireAccountsBearer keeps Authorization precedence over a session cookie", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const cookieToken = "opaque.cookie-session";
  const headerToken = "opaque.header-pat";
  store.saveAccount({
    subject: "tsub_cookie",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: cookieToken,
    subject: "tsub_cookie",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  store.savePersonalAccessToken(headerToken, {
    tokenId: "pat_header",
    tokenPrefix: "display-only",
    subject: "tsub_header",
    name: "header PAT",
    scopes: ["read"],
    createdAt: now,
  });

  const result = await requireAccountsBearer({
    request: new Request("https://accounts.example.test/v1/control", {
      headers: {
        authorization: `Bearer ${headerToken}`,
        cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${cookieToken}`,
      },
    }),
    store,
    scope: "read",
  });

  expect(result.ok).toEqual(true);
  if (result.ok) expect(result.auth.subject).toEqual("tsub_header");
});

function bearerRequest(token: string): Request {
  return new Request("https://accounts.example.test/v1/control", {
    headers: { authorization: `Bearer ${token}` },
  });
}
