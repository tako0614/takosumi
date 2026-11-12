import { expect, spyOn, test } from "bun:test";
import { TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH } from "@takosjp/takosumi-accounts-contract";
import { createEphemeralAccountsHandler } from "../../../../accounts/service/src/mod.ts";
import {
  applyHostedAccountSessionCookiePolicy,
  extractAccountSessionId,
  handleAccountSessionMeDelete,
  handleHostedGlobalLogout,
  requireAccountSession,
  requireAccountsBearer,
  rotateAccountSession,
} from "../../../../accounts/service/src/account-session.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const issuer = "https://issuer.example.test";
const subject = "tsub_cookie_fixture";

test("Hosted cookie policy refuses a sole legacy carrier while keeping the actual Request", () => {
  const request = new Request(issuer, { headers: { cookie: "takosumi_session=unused" } });
  const selected = applyHostedAccountSessionCookiePolicy(request);
  expect(extractAccountSessionId(selected)).toBeNull();
  expect(selected === request).toBe(true);
  expect(request.headers.get("cookie")?.includes("takosumi_session")).toBe(true);
});

for (const source of ["bearer", "session-header", "host-cookie", "other-authorization", "no-header"] as const) {
  test(`Hosted policy keeps the actual Request for a selected ${source}`, () => {
    const headers = new Headers({ cookie: `takosumi_session=unused${source === "host-cookie" ? "; __Host-takosumi_session=sess_fixture" : ""}` });
    if (source === "bearer") headers.set("authorization", "Bearer fixture-credential");
    if (source === "session-header") headers.set("x-takosumi-account-session", "sess_fixture");
    if (source === "other-authorization") headers.set("authorization", "Basic Zml4dHVyZTphdXRo");
    const request = new Request(issuer, { headers });
    expect(applyHostedAccountSessionCookiePolicy(request) === request).toBe(true);
  });
}

for (const [kind, cookie] of [
  ["duplicate legacy", "takosumi_session=first; takosumi_session=second"],
  ["malformed Host", "__Host-takosumi_session=%; takosumi_session=unused"],
  ["empty Host", "__Host-takosumi_session=; takosumi_session=unused"],
] as const) {
  test(`Invalid selected session cookie cannot fall back to another carrier: ${kind}`, () => {
    expect(extractAccountSessionId(new Request(issuer, { headers: { cookie } }))).toBeNull();
  });
}

test("Unrelated duplicate cookies do not override the selected Host session cookie", () => {
  const request = new Request(issuer, { headers: { cookie: "binding=a; binding=b; __Host-takosumi_session=sess_fixture; takosumi_session=unused; takosumi_session=other" } });
  expect(extractAccountSessionId(request) === "sess_fixture").toBe(true);
});

for (const binding of [false, true]) {
  test(`Hosted cookie policy preserves transport while refusing the legacy credential: binding=${binding}`, async () => {
    const request = new Request(`${issuer}/callback?state=fixture`, {
      method: "POST",
      headers: { cookie: `takosumi_session=unused${binding ? "; binding=fixture" : ""}`, "content-type": "application/x-www-form-urlencoded", "x-fixture": "retained" },
      body: "code=fixture",
    });
    const selected = applyHostedAccountSessionCookiePolicy(request);
    expect(extractAccountSessionId(selected)).toBeNull();
    expect(selected.headers.get("cookie")?.includes("binding=fixture") ?? false).toBe(binding);
    expect(request.headers.get("cookie")?.includes("takosumi_session")).toBe(true);
    expect(selected.url).toBe(request.url);
    expect(selected.method).toBe("POST");
    expect(selected.headers.get("x-fixture")).toBe("retained");
    expect(await selected.text()).toBe("code=fixture");
  });
}

async function fixture(hosted = true, hostedHandler = hosted) {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  await store.saveAccount({ subject, email: "fixture@example.test", emailVerified: true, createdAt: now, updatedAt: now });
  const session = await rotateAccountSession({
    store, subject, now, ttlMs: 60_000, hostedPolicy: hosted,
    freshlyAuthenticatedAt: Math.floor(now / 1000),
  });
  const handler = await createEphemeralAccountsHandler({
    issuer, store, clients: [], hostedSessionPolicy: hostedHandler,
    allowEphemeralKeyOnHttpsIssuer: true,
  });
  return { store, session, handler };
}

for (const mode of ["host-cookie", "bearer", "session-header", "non-hosted-legacy"] as const) {
  test(`Accounts session keeps the selected valid credential: ${mode}`, async () => {
    const f = await fixture(mode !== "non-hosted-legacy");
    const headers = new Headers({
      cookie: mode === "host-cookie"
        ? `takosumi_session=unused; __Host-takosumi_session=${f.session.sessionId}`
        : mode === "non-hosted-legacy"
        ? `takosumi_session=${f.session.sessionId}`
        : "takosumi_session=unused; takosumi_session=other",
    });
    if (mode === "bearer") headers.set("authorization", `Bearer ${f.session.sessionId}`);
    if (mode === "session-header") headers.set("x-takosumi-account-session", f.session.sessionId);
    const response = await f.handler(new Request(`${issuer}/api/v1/account/session/me`, { headers }));
    expect(response.status).toBe(200);
    expect((await response.json()).subject === subject).toBe(true);
  });
}

for (const mode of ["legacy", "duplicate-host", "duplicate-host-same-value"] as const) {
  test(`Hosted session refuses ambiguous or legacy browser credentials without effects: ${mode}`, async () => {
    const f = await fixture();
    const cookie = mode === "legacy"
      ? `takosumi_session=${f.session.sessionId}`
      : `__Host-takosumi_session=${f.session.sessionId}; __Host-takosumi_session=${mode === "duplicate-host" ? "unused" : f.session.sessionId}`;
    const before = JSON.stringify(await f.store.findAccountSession(f.session.sessionId));
    const touch = spyOn(f.store, "touchHostedAccountSession");
    const remove = spyOn(f.store, "deleteAccountSession");
    const revoke = spyOn(f.store, "revokeHostedOidcSessionGrants");
    try {
      const response = await f.handler(new Request(`${issuer}/api/v1/account/session/me`, { headers: { cookie } }));
      expect(response.status).toBe(200);
      expect((await response.json()).session === null).toBe(true);
      expect(touch.mock.calls.length).toBe(0);
      expect(remove.mock.calls.length).toBe(0);
      expect(revoke.mock.calls.length).toBe(0);
      expect(JSON.stringify(await f.store.findAccountSession(f.session.sessionId)) === before).toBe(true);
    } finally {
      touch.mockRestore(); remove.mockRestore(); revoke.mockRestore();
    }
  });
}

test("Hosted legacy cookie cannot revoke the server-side session", async () => {
  const f = await fixture();
  const before = JSON.stringify(await f.store.findAccountSession(f.session.sessionId));
  const remove = spyOn(f.store, "deleteAccountSession");
  const revoke = spyOn(f.store, "revokeHostedOidcSessionGrants");
  try {
    const response = await f.handler(new Request(`${issuer}/api/v1/account/session/me`, {
      method: "DELETE", headers: { origin: issuer, cookie: `takosumi_session=${f.session.sessionId}` },
    }));
    expect(response.status).toBe(204);
    expect(remove.mock.calls.length).toBe(0);
    expect(revoke.mock.calls.length).toBe(0);
    expect(JSON.stringify(await f.store.findAccountSession(f.session.sessionId)) === before).toBe(true);
  } finally {
    remove.mockRestore(); revoke.mockRestore();
  }
});

test("Hosted handler excludes legacy cookies even for an older non-hosted record", async () => {
  const f = await fixture(false, true);
  const response = await f.handler(new Request(`${issuer}/api/v1/account/session/me`, {
    headers: { cookie: `takosumi_session=${f.session.sessionId}` },
  }));
  expect(response.status).toBe(200);
  expect((await response.json()).session === null).toBe(true);
  expect(Boolean(await f.store.findAccountSession(f.session.sessionId))).toBe(true);
});

test("Hosted privacy guard keeps the request policy before any private record read", async () => {
  const f = await fixture(false, true);
  const list = spyOn(f.store, "listPrivacyRequestsForSubject");
  try {
    const response = await f.handler(new Request(`${issuer}${TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH}`, {
      headers: { cookie: `takosumi_session=${f.session.sessionId}` },
    }));
    expect(response.status).toBe(401);
    expect(list.mock.calls.length).toBe(0);
    expect(Boolean(await f.store.findAccountSession(f.session.sessionId))).toBe(true);
  } finally {
    list.mockRestore();
  }
});

for (const guard of ["session", "bearer"] as const) {
  test(`Hosted session rejects a legacy carrier at the shared ${guard} guard`, async () => {
    const f = await fixture();
    const request = new Request(issuer, { headers: { cookie: `takosumi_session=${f.session.sessionId}` } });
    const touch = spyOn(f.store, "touchHostedAccountSession");
    const remove = spyOn(f.store, "deleteAccountSession");
    try {
      const result = guard === "session"
        ? await requireAccountSession({ request, store: f.store })
        : await requireAccountsBearer({ request, store: f.store, scope: "capsules:read" });
      expect(result.ok).toBe(false);
      expect(touch.mock.calls.length).toBe(0);
      expect(remove.mock.calls.length).toBe(0);
    } finally {
      touch.mockRestore(); remove.mockRestore();
    }
  });
}

test("Hosted global logout ignores the legacy carrier without revoking grants", async () => {
  const f = await fixture();
  const revoke = spyOn(f.store, "revokeHostedOidcSessionGrants");
  const remove = spyOn(f.store, "deleteAccountSession");
  try {
    const response = await handleHostedGlobalLogout({
      request: new Request(`${issuer}/api/v1/account/session/global-logout`, {
        method: "POST", headers: { origin: issuer, cookie: `takosumi_session=${f.session.sessionId}` },
      }),
      issuer, store: f.store,
    });
    expect(response.status).toBe(204);
    expect(revoke.mock.calls.length).toBe(0);
    expect(remove.mock.calls.length).toBe(0);
    expect(Boolean(await f.store.findAccountSession(f.session.sessionId))).toBe(true);
  } finally {
    revoke.mockRestore(); remove.mockRestore();
  }
});

for (const storedHosted of [true, false]) {
  test(`Direct session DELETE enforces Hosted policy without changing state: storedHosted=${storedHosted}`, async () => {
    const f = await fixture(storedHosted);
    const remove = spyOn(f.store, "deleteAccountSession");
    const revoke = spyOn(f.store, "revokeHostedOidcSessionGrants");
    try {
      const response = await handleAccountSessionMeDelete({
        request: new Request(`${issuer}/api/v1/account/session/me`, { method: "DELETE", headers: { cookie: `takosumi_session=${f.session.sessionId}` } }),
        store: f.store, secureCookie: true,
        ...(storedHosted ? {} : { hostedPolicy: true }),
      });
      expect(response.status).toBe(204);
      expect(remove.mock.calls.length).toBe(0);
      expect(revoke.mock.calls.length).toBe(0);
      expect(Boolean(await f.store.findAccountSession(f.session.sessionId))).toBe(true);
    } finally {
      remove.mockRestore(); revoke.mockRestore();
    }
  });
}

for (const source of ["legacy", "host-cookie", "bearer", "session-header"] as const) {
  test(`Retired Hosted anchor DELETE respects the actual carrier: ${source}`, async () => {
    const f = await fixture();
    const priorId = f.session.sessionId;
    const current = await rotateAccountSession({
      store: f.store, subject, oldSessionId: priorId,
      now: Date.now(), ttlMs: 60_000, hostedPolicy: true,
    });
    const currentRecord = await f.store.findAccountSession(current.sessionId);
    const anchor = await f.store.findHostedAccountSessionAnchor(priorId);
    expect(await f.store.findAccountSession(priorId)).toBeUndefined();
    expect(Boolean(anchor) && anchor === currentRecord?.issuerSessionId).toBe(true);
    const before = JSON.stringify(currentRecord);
    const headers = new Headers({ origin: issuer });
    if (source === "legacy") headers.set("cookie", `takosumi_session=${priorId}`);
    if (source === "host-cookie") headers.set("cookie", `__Host-takosumi_session=${priorId}`);
    if (source === "bearer") headers.set("authorization", `Bearer ${priorId}`);
    if (source === "session-header") headers.set("x-takosumi-account-session", priorId);
    const remove = spyOn(f.store, "deleteAccountSession");
    const revoke = spyOn(f.store, "revokeHostedOidcSessionGrants");
    try {
      const response = await handleAccountSessionMeDelete({
        request: new Request(`${issuer}/api/v1/account/session/me`, { method: "DELETE", headers }),
        store: f.store, secureCookie: true,
      });
      expect(response.status).toBe(204);
      expect(revoke.mock.calls.length).toBe(source === "legacy" ? 0 : 1);
      if (source === "legacy") {
        expect(remove.mock.calls.length).toBe(0);
        expect(JSON.stringify(await f.store.findAccountSession(current.sessionId)) === before).toBe(true);
      }
      const nextAuth = await requireAccountSession({
        request: new Request(issuer, { headers: { authorization: `Bearer ${current.sessionId}` } }),
        store: f.store,
      });
      expect(nextAuth.ok).toBe(source === "legacy");
    } finally {
      remove.mockRestore(); revoke.mockRestore();
    }
  });
}
