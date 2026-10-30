import { expect, test } from "bun:test";

import {
  TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH,
  takosumiAccountsNotificationPusherPath,
} from "@takosjp/takosumi-accounts-contract";
import {
  type AccountsStore,
  createAccountsHandler,
  handleNotificationPusherRequest,
  InMemoryAccountsStore,
  type NotificationPusherAuthenticator,
  notificationPusherRouteOptionsFromEnv,
} from "../../../../accounts/service/src/mod.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { NOTIFICATION_PUSHERS_PER_ACCOUNT } from "../../../../accounts/service/src/notification-pushers-store.ts";
import { base64UrlEncode } from "../../../../core/domains/notifications/web_push/bytes.ts";
import { deriveVapidKeyPair } from "../../../../core/domains/notifications/web_push/vapid.ts";
import { createTestUserAgent } from "../../../helpers/web_push_receiver.ts";

const ORIGIN = "https://accounts.example.test";
const RELAY = "https://relay.example.test";
const SUBJECT = "tsub_pusher_route" as const;
const OTHER = "tsub_pusher_route_other" as const;
const SESSION = "sess_pusher_route";
const OTHER_SESSION = "sess_pusher_route_other";
const PAT_READ = "takpat_pusher_route_read";
const PAT_WRITE_ONLY = "takpat_pusher_route_write_only";
const PAT_APP_FENCED = "takpat_pusher_route_app";
const OAUTH_MOBILE = "oauth_pusher_route_mobile";
const OAUTH_WORKSPACE = "oauth_pusher_route_workspace";
const OAUTH_OPENID_ONLY = "oauth_pusher_route_openid";
const VAPID_PUBLIC = "BFixturePublicKeyNotUsedForSigning";

function seededStore(): InMemoryAccountsStore {
  const store = new InMemoryAccountsStore();
  for (const subject of [SUBJECT, OTHER]) {
    store.saveAccount({ subject, createdAt: 1, updatedAt: 1 });
  }
  store.saveAccountSession({ sessionId: SESSION, subject: SUBJECT, createdAt: 1, expiresAt: Date.now() + 60_000 });
  store.saveAccountSession({ sessionId: OTHER_SESSION, subject: OTHER, createdAt: 1, expiresAt: Date.now() + 60_000 });
  store.savePersonalAccessToken(PAT_READ, {
    tokenId: "pat_pusher_read", tokenPrefix: "takpat_pusher", subject: SUBJECT,
    name: "read", scopes: ["read"], createdAt: 1,
  });
  store.savePersonalAccessToken(PAT_WRITE_ONLY, {
    tokenId: "pat_pusher_write", tokenPrefix: "takpat_pusher", subject: SUBJECT,
    name: "write", scopes: ["write"], createdAt: 1,
  });
  store.savePersonalAccessToken(PAT_APP_FENCED, {
    tokenId: "pat_pusher_app", tokenPrefix: "takpat_pusher", subject: SUBJECT,
    name: "app", scopes: ["read"], appIds: ["cap_one"], createdAt: 1,
  });
  store.saveAccessToken(OAUTH_MOBILE, {
    clientId: "takosumi-mobile", scope: "openid offline_access capsules:read capsules:write",
    subject: "mobile-principal", takosumiSubject: SUBJECT, expiresAt: Date.now() + 60_000,
  });
  store.saveAccessToken(OAUTH_WORKSPACE, {
    clientId: "client_workspace", scope: "capsules:read",
    subject: "workspace-principal", takosumiSubject: SUBJECT, workspaceId: "ws_one",
    expiresAt: Date.now() + 60_000,
  });
  store.saveAccessToken(OAUTH_OPENID_ONLY, {
    clientId: "client_openid", scope: "openid",
    subject: "openid-principal", takosumiSubject: SUBJECT, expiresAt: Date.now() + 60_000,
  });
  return store;
}

function handlerFor(store: AccountsStore, options: "configured" | "none" = "configured") {
  return createAccountsHandler({
    issuer: ORIGIN,
    store,
    ...(options === "configured"
      ? {
          notificationPushers: {
            webPushPublicKey: async () => VAPID_PUBLIC,
            relayOrigins: [RELAY],
            instanceOriginUsable: true,
          },
        }
      : {}),
  });
}

function call(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function registration(overrides: Record<string, unknown> = {}) {
  const agent = await createTestUserAgent();
  return {
    kind: "webpush",
    app_id: "com.takosumi",
    pushkey: base64UrlEncode(agent.p256dh),
    data: { url: `${RELAY}/push/${crypto.randomUUID()}`, auth: base64UrlEncode(agent.auth) },
    device_display_name: "Pixel 9",
    lang: "ja-JP",
    ...overrides,
  };
}

test("register, update, list and delete a Takosumi Mobile pusher", async () => {
  const store = seededStore();
  const handler = handlerFor(store);

  const empty = await handler(call("GET", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION));
  expect(empty.status).toBe(200);
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.json()).toEqual({ pushers: [], web_push_public_key: VAPID_PUBLIC, web_push_unavailable_reason: null });

  const body = await registration();
  const created = await handler(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, OAUTH_MOBILE, body));
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  expect(createdBody).toEqual({
    pusher: {
      id: expect.stringMatching(/^npsh_[A-Za-z0-9_-]{32}$/),
      kind: "webpush",
      app_id: "com.takosumi",
      pushkey: body.pushkey,
      data: { url: body.data.url },
      device_display_name: "Pixel 9",
      lang: "ja-JP",
      created_at: expect.any(String),
      updated_at: expect.any(String),
      last_success_at: null,
      last_failure_at: null,
      last_failure_status: null,
      failing: false,
    },
  });
  expect(JSON.stringify(createdBody)).not.toContain(body.data.auth);
  const id = createdBody.pusher.id as string;

  // The same (account, app_id, pushkey) updates in place.
  const updated = await handler(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, PAT_READ, {
    ...body,
    device_display_name: "  Pixel 10  ",
    lang: "en-US",
  }));
  expect(updated.status).toBe(200);
  expect((await updated.json()).pusher).toMatchObject({ id, device_display_name: "Pixel 10", lang: "en-US" });

  await store.recordNotificationPusherOutcome({ pusherId: id, endpoint: body.data.url, pushkey: body.pushkey, at: Date.UTC(2026, 9, 30), outcome: "failed", status: 403 });
  const listed = await handler(call("GET", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, OAUTH_MOBILE));
  const listedBody = await listed.json();
  expect(listedBody.pushers).toHaveLength(1);
  expect(listedBody.pushers[0]).toMatchObject({
    id,
    failing: true,
    last_failure_status: 403,
    last_failure_at: new Date(Date.UTC(2026, 9, 30)).toISOString(),
  });
  expect(JSON.stringify(listedBody)).not.toContain(body.data.auth);

  // Another account sees nothing and cannot delete it.
  const otherList = await handler(call("GET", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, OTHER_SESSION));
  expect((await otherList.json()).pushers).toEqual([]);
  const stolen = await handler(call("DELETE", takosumiAccountsNotificationPusherPath(id), OTHER_SESSION));
  expect(stolen.status).toBe(404);

  const deleted = await handler(call("DELETE", takosumiAccountsNotificationPusherPath(id), SESSION));
  expect(deleted.status).toBe(204);
  expect((await handler(call("DELETE", takosumiAccountsNotificationPusherPath(id), SESSION))).status).toBe(404);
  expect((await handler(call("DELETE", `${TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH}/not-an-id`, SESSION))).status).toBe(404);
  expect(await store.listNotificationPushersForSubject(SUBJECT)).toEqual([]);
});

test("registration validates every field and the relay allowlist", async () => {
  const handler = handlerFor(seededStore());
  const post = (body: unknown) =>
    handler(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION, body));
  const agent = await createTestUserAgent();
  const offCurve = new Uint8Array(agent.p256dh);
  offCurve[64]! ^= 1;
  const cases: Array<[Record<string, unknown>, string, string?]> = [
    [{ kind: "http" }, "unsupported_pusher_kind"],
    [{ app_id: "" }, "invalid_request"],
    [{ app_id: "a".repeat(65) }, "invalid_request"],
    [{ pushkey: base64UrlEncode(offCurve) }, "invalid_request"],
    [{ pushkey: `${base64UrlEncode(agent.p256dh)}=` }, "invalid_request"],
    [{ data: { url: `${RELAY}/push/x`, auth: base64UrlEncode(new Uint8Array(15)) } }, "invalid_request"],
    [{ data: { url: `${RELAY}/push/x`, auth: base64UrlEncode(agent.auth), format: "event_id_only" } }, "invalid_request"],
    [{ data: { url: "https://elsewhere.example.test/push/x", auth: base64UrlEncode(agent.auth) } }, "invalid_pusher_endpoint", "endpoint_origin_not_allowed"],
    [{ data: { url: "http://relay.example.test/push/x", auth: base64UrlEncode(agent.auth) } }, "invalid_pusher_endpoint", "endpoint_not_https"],
    [{ data: { url: "https://relay.example.test:8443/push/x", auth: base64UrlEncode(agent.auth) } }, "invalid_pusher_endpoint", "endpoint_port_not_443"],
    [{ data: { url: "https://u:p@relay.example.test/push/x", auth: base64UrlEncode(agent.auth) } }, "invalid_pusher_endpoint", "endpoint_userinfo"],
    [{ data: { url: `${RELAY}/${"a".repeat(1100)}`, auth: base64UrlEncode(agent.auth) } }, "invalid_pusher_endpoint", "endpoint_too_long"],
    [{ device_display_name: "   " }, "invalid_request"],
    [{ device_display_name: "a\u0007b" }, "invalid_request"],
    [{ device_display_name: "x".repeat(129) }, "invalid_request"],
    [{ lang: "日本語" }, "invalid_request"],
    [{ profile_tag: "x" }, "invalid_request"],
  ];
  for (const [overrides, code, reason] of cases) {
    const response = await post(await registration(overrides));
    expect({ overrides, status: response.status }).toEqual({ overrides, status: 400 });
    const body = await response.json();
    expect(body.error.code).toBe(code);
    if (reason) expect(body.error.details).toEqual({ reason });
  }
  expect((await post([])).status).toBe(400);
});

test("only account-wide credentials with read access may manage pushers", async () => {
  const handler = handlerFor(seededStore());
  const body = await registration();
  const path = TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH;
  expect((await handler(call("GET", path, undefined))).status).toBe(401);
  expect((await handler(call("GET", path, "nonsense"))).status).toBe(401);
  for (const token of [PAT_WRITE_ONLY, OAUTH_OPENID_ONLY]) {
    const response = await handler(call("POST", path, token, body));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("insufficient_scope");
  }
  for (const token of [PAT_APP_FENCED, OAUTH_WORKSPACE]) {
    const response = await handler(call("GET", path, token));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("account_wide_credential_required");
  }
  // A cookie session is browser authority: same-origin writes only.
  const crossSite = await handler(new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${SESSION}`,
      origin: "https://evil.example.test",
    },
    body: JSON.stringify(body),
  }));
  expect(crossSite.status).toBe(403);
  const sameSite = await handler(new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${SESSION}`,
      origin: ORIGIN,
    },
    body: JSON.stringify(body),
  }));
  expect(sameSite.status).toBe(201);
});

test("an account holds at most 20 pushers", async () => {
  const handler = handlerFor(seededStore());
  for (let index = 0; index < NOTIFICATION_PUSHERS_PER_ACCOUNT; index += 1) {
    const response = await handler(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, OAUTH_MOBILE, await registration()));
    expect(response.status).toBe(201);
  }
  const refused = await handler(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, OAUTH_MOBILE, await registration()));
  expect(refused.status).toBe(409);
  expect((await refused.json()).error.code).toBe("notification_pusher_limit_reached");
  // The other account is unaffected.
  expect((await handler(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, OTHER_SESSION, await registration()))).status).toBe(201);
});

test("without Web Push the list says why and registration is refused", async () => {
  const handler = handlerFor(seededStore(), "none");
  const listed = await handler(call("GET", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION));
  expect(await listed.json()).toEqual({ pushers: [], web_push_public_key: null, web_push_unavailable_reason: "secret_not_configured" });
  const refused = await handler(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION, await registration()));
  expect(refused.status).toBe(503);
  expect((await refused.json()).error.code).toBe("web_push_unavailable");

  const passphrase = "fixture-only-secret-store-passphrase-0123456789";
  const cases: Array<[Record<string, unknown>, string | undefined, string, string]> = [
    [{}, undefined, "secret_not_configured", "web_push_unavailable"],
    // No relay configured: there is no built-in default relay.
    [{ TAKOSUMI_SECRET_STORE_PASSPHRASE: passphrase }, ORIGIN, "relay_not_configured", "notification_relay_not_configured"],
    [{ TAKOSUMI_SECRET_STORE_PASSPHRASE: passphrase, TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: "[]" }, ORIGIN, "relay_not_configured", "notification_relay_not_configured"],
    // The VAPID subject must be the instance's https origin.
    [{ TAKOSUMI_SECRET_STORE_PASSPHRASE: passphrase, TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: JSON.stringify([RELAY]) }, "http://takosumi.example.test", "issuer_not_https", "notification_issuer_not_https"],
  ];
  for (const [env, issuer, reason, code] of cases) {
    const configured = createAccountsHandler({
      issuer: ORIGIN,
      store: seededStore(),
      notificationPushers: notificationPusherRouteOptionsFromEnv(env, issuer),
    });
    const list = await configured(call("GET", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION));
    expect({ reason, body: await list.json() }).toEqual({ reason, body: { pushers: [], web_push_public_key: null, web_push_unavailable_reason: reason } });
    const post = await configured(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION, await registration()));
    expect({ code, status: post.status, error: (await post.json()).error.code }).toEqual({ code, status: code === "web_push_unavailable" ? 503 : 409, error: code });
  }
});

test("a store without pusher records answers 503, and methods are fixed per path", async () => {
  const store = seededStore();
  const hidden = new Set(["saveNotificationPusher", "listNotificationPushersForSubject"]);
  const legacy = new Proxy(store, {
    get(target, property) {
      if (typeof property === "string" && hidden.has(property)) return undefined;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AccountsStore;
  const handler = handlerFor(legacy);
  const unavailable = await handler(call("GET", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION));
  expect(unavailable.status).toBe(503);
  expect((await unavailable.json()).error.code).toBe("notification_pushers_unavailable");

  const normal = handlerFor(seededStore());
  const put = await normal(call("PUT", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION, {}));
  expect(put.status).toBe(405);
  expect(put.headers.get("allow")).toBe("GET, POST");
  const getItem = await normal(call("GET", `${TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH}/npsh_x`, SESSION));
  expect(getItem.status).toBe(405);
  expect(getItem.headers.get("allow")).toBe("DELETE");
});

test("the composition derives web_push_public_key from the secret-store passphrase", async () => {
  const passphrase = "fixture-only-secret-store-passphrase-0123456789";
  const options = notificationPusherRouteOptionsFromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: passphrase,
    TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: JSON.stringify([RELAY]),
  }, ORIGIN);
  expect(options.relayOrigins).toEqual([RELAY]);
  expect(options.instanceOriginUsable).toBe(true);
  expect(notificationPusherRouteOptionsFromEnv({}, "http://localhost:8787").instanceOriginUsable).toBe(true);
  expect(notificationPusherRouteOptionsFromEnv({}, undefined).instanceOriginUsable).toBe(false);
  expect(await options.webPushPublicKey()).toBe(
    (await deriveVapidKeyPair(new TextEncoder().encode(passphrase))).publicKeyBase64Url,
  );
  expect(() => notificationPusherRouteOptionsFromEnv({
    TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: "https://relay.example.test",
  }, ORIGIN)).toThrow("TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS");
});

test("a host's own authenticator replaces the Accounts credentials and keeps the account-wide rule", async () => {
  const store = seededStore();
  const options = { webPushPublicKey: async () => VAPID_PUBLIC, relayOrigins: [RELAY], instanceOriginUsable: true };
  const limiter = { consume: () => undefined };
  const route = (request: Request, authenticate: NotificationPusherAuthenticator) =>
    handleNotificationPusherRequest({ request, url: new URL(request.url), store, options, limiter, authenticate });
  // No Accounts credential at all: the host vouched for the account.
  const asAccount: NotificationPusherAuthenticator = async () => ({ ok: true, subject: SUBJECT });
  const created = await route(call("POST", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, undefined, await registration()), asAccount);
  expect(created?.status).toBe(201);
  expect(await store.listNotificationPushersForSubject(SUBJECT)).toHaveLength(1);
  // A credential fenced to apps or a Workspace is still refused.
  for (const fence of [{ appIds: ["cap_one"] }, { workspaceId: "ws_one" }]) {
    const fenced = await route(call("GET", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, undefined),
      async () => ({ ok: true, subject: SUBJECT, ...fence }));
    expect(fenced?.status).toBe(403);
  }
  // The host's refusal is returned as is; an Accounts session does not override it.
  const refused = await route(call("GET", TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH, SESSION),
    async () => ({ ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401 }) }));
  expect(refused?.status).toBe(401);
  // Paths outside the routes are not claimed.
  expect(await route(call("GET", "/api/v1/account/tokens", SESSION), asAccount)).toBeUndefined();
});
