import { expect, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";

import {
  TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH,
  takosumiAccountsNotificationPusherPath,
} from "@takosjp/takosumi-accounts-contract";
import { D1AccountsStore, InMemoryAccountsStore } from "../../../accounts/service/src/mod.ts";
import type { AccountsStore } from "../../../accounts/service/src/store.ts";
import platformWorker, {
  type CloudflareWorkerEnv,
  handlePlatformSharedAuthNotificationPushersRequest,
} from "../../../deploy/platform/worker.ts";
import { createOwnNotificationDispatcher } from "../../../core/domains/notifications/compose.ts";
import { base64UrlEncode } from "../../../core/domains/notifications/web_push/bytes.ts";
import type { SharedAuthIdentity } from "../../../worker/src/shared_auth_rpc.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import { createTestUserAgent, decryptWebPushBody } from "../../helpers/web_push_receiver.ts";

// Shared-account profile (Hosted, ADR 0025): the product host serves the
// account's Takosumi Mobile pushers with the private RP session, stores them
// in this Worker's Accounts store, and the notification dispatcher reads the
// same store.

const origin = "https://hosted.staging.example.test";
const relay = "https://relay.example.test";
const cookie = "__Host-takosumi_hosted_session=opaque-rp-session";
const account = "tsub_canonical";

function sharedEnv(options: {
  readonly db?: SqliteFakeD1;
  readonly identity?: () => Promise<SharedAuthIdentity>;
  readonly relayOrigins?: string;
} = {}): CloudflareWorkerEnv {
  return {
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
    TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_ACCOUNTS_ISSUER: origin,
    TAKOSUMI_SECRET_STORE_PASSPHRASE: "fixture-only-secret-store-passphrase-0123456789",
    TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: options.relayOrigins ?? JSON.stringify([relay]),
    ...(options.db ? { TAKOSUMI_ACCOUNTS_DB: options.db } : {}),
    HOSTED: {
      fetchSharedAuth: async () => new Response(null, { status: 204 }),
      authenticateSharedAuth: options.identity ??
        (async () => ({ kind: "authenticated", accountId: account })),
      resolveSharedAuthWorkspace: async () => ({ kind: "forbidden" }),
    },
  } as unknown as CloudflareWorkerEnv;
}

function call(
  method: string,
  path: string = TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH,
  init: { body?: unknown; headers?: Record<string, string>; base?: string } = {},
): Request {
  return new Request(`${init.base ?? origin}${path}`, {
    method,
    headers: {
      cookie,
      ...(method !== "GET" ? { origin } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function registration() {
  const agent = await createTestUserAgent();
  return {
    agent,
    body: {
      kind: "webpush",
      app_id: "com.takosumi",
      pushkey: base64UrlEncode(agent.p256dh),
      data: { url: `${relay}/push/${crypto.randomUUID()}`, auth: base64UrlEncode(agent.auth) },
      device_display_name: "Pixel 9",
      lang: "ja-JP",
    },
  };
}

test("the product host serves the account's pushers through the platform Worker, not a 404", async () => {
  const db = new SqliteFakeD1();
  const env = sharedEnv({ db });
  const listed = await platformWorker.fetch(call("GET"), env);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const empty = await listed.json() as Record<string, unknown>;
  expect(empty.pushers).toEqual([]);
  expect(empty.web_push_public_key).toEqual(expect.any(String));
  expect(empty.web_push_unavailable_reason).toBeNull();

  const { body } = await registration();
  const created = await platformWorker.fetch(call("POST", undefined, { body }), env);
  expect(created.status).toBe(201);
  const pusher = (await created.json() as { pusher: { id: string } }).pusher;
  const after = await (await platformWorker.fetch(call("GET"), env)).json() as { pushers: Array<{ id: string }> };
  expect(after.pushers.map((entry) => entry.id)).toEqual([pusher.id]);

  // Every other local account route stays unmounted on the product host.
  expect((await platformWorker.fetch(call("GET", "/api/v1/account/tokens"), env)).status).toBe(404);
  // Alternate URLs of the same Worker never serve it.
  expect((await platformWorker.fetch(call("GET", undefined, { base: "https://alias.example.workers.dev" }), env)).status).toBe(404);

  const removed = await platformWorker.fetch(call("DELETE", takosumiAccountsNotificationPusherPath(pusher.id)), env);
  expect(removed.status).toBe(204);
  expect((await platformWorker.fetch(call("DELETE", takosumiAccountsNotificationPusherPath(pusher.id)), env)).status).toBe(404);
});

for (const storeCase of [
  { name: "memory", open: async (): Promise<AccountsStore> => new InMemoryAccountsStore() },
  {
    name: "D1 (SQLite)",
    open: async (): Promise<AccountsStore> => {
      const store = new D1AccountsStore(new SqliteFakeD1());
      await store.initialize();
      return store;
    },
  },
]) {
  test(`only the RP session of the account itself is accepted (${storeCase.name})`, async () => {
    const store = await storeCase.open();
    const handle = (request: Request, env = sharedEnv()) =>
      handlePlatformSharedAuthNotificationPushersRequest(request, env, { store });
    const { body } = await registration();

    // An explicit credential never falls back to the RP cookie, as on every
    // shared-account control route: humans arrive only through the RP.
    for (const headers of [
      { authorization: "Bearer takpat_any" },
      { "x-takosumi-account-session": "sess_any" },
    ]) {
      const response = await handle(call("GET", undefined, { headers }));
      expect(response?.status).toBe(401);
    }
    expect((await handle(call("GET"), sharedEnv({ identity: async () => ({ kind: "unauthenticated" }) })))?.status).toBe(401);
    expect((await handle(call("GET"), sharedEnv({ identity: async () => ({ kind: "unavailable" }) })))?.status).toBe(503);
    expect((await handle(call("GET"), sharedEnv({
      identity: async () => ({ kind: "authenticated", accountId: "acct_not_a_subject" }),
    })))?.status).toBe(401);

    // A browser write must come from the product origin.
    const crossSite = await handle(call("POST", undefined, { body, headers: { origin: "https://evil.example.test" } }));
    expect(crossSite?.status).toBe(403);
    expect(await crossSite?.json()).toEqual({ error: "csrf_failed" });

    // A malformed relay allowlist fails closed.
    expect((await handle(call("GET"), sharedEnv({ relayOrigins: "not json" })))?.status).toBe(503);

    const created = await handle(call("POST", undefined, { body }));
    expect(created?.status).toBe(201);
    const id = (await created!.json() as { pusher: { id: string } }).pusher.id;
    expect((await store.listNotificationPushersForSubject!(account)).map((entry) => entry.pusherId)).toEqual([id]);
    // Another account's session sees and removes nothing of it.
    const other = sharedEnv({ identity: async () => ({ kind: "authenticated", accountId: "tsub_other" }) });
    expect(await (await handle(call("GET"), other))!.json()).toMatchObject({ pushers: [] });
    expect((await handle(call("DELETE", takosumiAccountsNotificationPusherPath(id)), other))?.status).toBe(404);
    expect((await handle(call("DELETE", takosumiAccountsNotificationPusherPath(id))))?.status).toBe(204);

    // Without the shared-account profile the Accounts handler keeps the path.
    expect(await handlePlatformSharedAuthNotificationPushersRequest(call("GET"), {
      TAKOSUMI_ACCOUNTS_ISSUER: origin,
    } as unknown as CloudflareWorkerEnv, { store })).toBeUndefined();
  });
}

test("a pusher registered on the product host is the one the dispatcher delivers to", async () => {
  const db = new SqliteFakeD1();
  const env = sharedEnv({ db });
  const { agent, body } = await registration();
  expect((await platformWorker.fetch(call("POST", undefined, { body }), env)).status).toBe(201);

  // The dispatcher's store, as the platform Worker builds it for the
  // scheduled and the immediate path: the same Accounts database.
  const sent: Request[] = [];
  const dispatcher = createOwnNotificationDispatcher({
    operations: {
      activity: { listAfter: async () => [], get: async () => undefined },
      appOwnership: { getOwnership: async () => ({ ownerAccountId: account }) },
      controller: { getRun: async () => ({ createdBy: account }) },
      capsules: { getCapsule: async () => ({ name: "yurucommu" }) },
    },
    store: new D1AccountsStore(db),
    env: env as unknown as Readonly<Record<string, unknown>>,
    issuer: origin,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input, init));
      return new Response(null, { status: 201 });
    }) as typeof fetch,
  });
  const event: ActivityEvent = {
    id: "act_shared", workspaceId: "ws", action: "run.approval_required", targetType: "run",
    targetId: "run_shared", runId: "run_shared", metadata: { capsuleId: "cap_1", operation: "update" },
    createdAt: new Date().toISOString(),
  };
  expect(await dispatcher!.deliverEvent(event)).toMatchObject({ enqueued: 1, delivered: 1 });
  expect(sent.map((request) => request.url)).toEqual([body.data.url]);
  const payload = JSON.parse(new TextDecoder().decode(
    await decryptWebPushBody(new Uint8Array(await sent[0]!.arrayBuffer()), agent),
  )) as { notification: { navigate: string } };
  expect(payload.notification.navigate).toBe(`${origin}/runs/run_shared`);
});
