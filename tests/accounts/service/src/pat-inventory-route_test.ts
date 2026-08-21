import { expect, test } from "bun:test";

import {
  createAccountsHandler,
  InMemoryAccountsStore,
  type AccountsStore,
} from "../../../../accounts/service/src/mod.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { base64UrlEncodeJson } from "../../../../accounts/service/src/encoding.ts";

const ORIGIN = "https://accounts.example.test";
const INVENTORY_PATH = "/api/v1/account/tokens/inventory.v1";
const SUBJECT = "tsub_inventory_route" as const;
const SESSION_ID = "sess_inventory_route";

test("the versioned owner inventory is closed, complete, canonical, and write-free", async () => {
  const store = seededStore();
  const writes: string[] = [];
  const observedStore = observeWrites(store, writes);
  let controlResolverCalls = 0;
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store: observedStore,
    resolveControlPlaneOperations: async () => {
      controlResolverCalls += 1;
      throw new Error("PAT inventory must not initialize Control");
    },
  });

  const first = await handler(
    inventoryRequest("?limit=2", {
      authorization: `Bearer ${SESSION_ID}`,
      cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${SESSION_ID}`,
    }),
  );
  const firstBody = await first.json();
  expect(first.status).toBe(200);
  expectPrivateNoStore(first);
  expect(first.headers.get("x-takosumi-version-id")).toBeNull();
  expect(Object.keys(firstBody)).toEqual([
    "kind",
    "tokens",
    "total",
    "returned",
    "limit",
    "truncated",
    "next_cursor",
  ]);
  expect(firstBody).toEqual({
    kind: "takosumi.account-pat-inventory@v1",
    tokens: [
      {
        token_id: "pat_inventory_route_a",
        subject: SUBJECT,
        name: "A",
        prefix: "takpat_route_a",
        scopes: ["read"],
        workspace_id: null,
        created_at: new Date(1_000).toISOString(),
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
      },
      {
        token_id: "pat_inventory_route_b",
        subject: SUBJECT,
        name: "B",
        prefix: "takpat_route_b",
        scopes: ["read", "write"],
        workspace_id: "ws_inventory_route",
        created_at: new Date(1_000).toISOString(),
        expires_at: new Date(9_000).toISOString(),
        revoked_at: new Date(3_000).toISOString(),
        last_used_at: new Date(2_000).toISOString(),
      },
    ],
    total: 3,
    returned: 2,
    limit: 2,
    truncated: true,
    next_cursor: expect.any(String),
  });
  expect(JSON.stringify(firstBody)).not.toContain("route_secret");

  const second = await handler(
    inventoryRequest(
      `?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
      { authorization: `Bearer ${SESSION_ID}` },
    ),
  );
  const secondBody = await second.json();
  expect(second.status).toBe(200);
  expectPrivateNoStore(second);
  expect(secondBody).toEqual({
    kind: "takosumi.account-pat-inventory@v1",
    tokens: [
      {
        token_id: "pat_inventory_route_c",
        subject: SUBJECT,
        name: "C",
        prefix: "takpat_route_c",
        scopes: ["admin"],
        workspace_id: null,
        created_at: new Date(2_000).toISOString(),
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
      },
    ],
    total: 3,
    returned: 1,
    limit: 2,
    truncated: false,
    next_cursor: null,
  });
  expect([
    ...firstBody.tokens.map((token: { token_id: string }) => token.token_id),
    ...secondBody.tokens.map((token: { token_id: string }) => token.token_id),
  ]).toEqual([
    "pat_inventory_route_a",
    "pat_inventory_route_b",
    "pat_inventory_route_c",
  ]);
  expect(firstBody.returned + secondBody.returned).toBe(firstBody.total);
  expect(writes).toEqual([]);
  expect(controlResolverCalls).toBe(0);
});

test("the inventory rejects malformed, stale, and oversized pagination", async () => {
  const store = seededStore();
  const handler = createAccountsHandler({ issuer: ORIGIN, store });
  const authorization = { authorization: `Bearer ${SESSION_ID}` };
  const stale = base64UrlEncodeJson({
    kind: "takosumi.account-pat-inventory-cursor@v1",
    createdAt: 1_000,
    tokenId: "pat_inventory_route_missing",
  });

  for (const query of [
    "?limit=0",
    "?limit=101",
    "?limit=1.5",
    "?limit=2&token=ambient",
    "?limit=2&limit=3",
    "?cursor=not-base64url!",
    `?limit=2&cursor=${stale}`,
  ]) {
    const response = await handler(inventoryRequest(query, authorization));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    expectPrivateNoStore(response);
  }

  const missingSession = await handler(inventoryRequest());
  expect(missingSession.status).toBe(401);
  expectPrivateNoStore(missingSession);

  const wrongMethod = await handler(
    inventoryRequest("", authorization, "POST"),
  );
  expect(wrongMethod.status).toBe(405);
  expectPrivateNoStore(wrongMethod);

  const unversioned = await handler(
    new Request(`${ORIGIN}/v1/account/tokens/inventory`, {
      headers: authorization,
    }),
  );
  expect(unversioned.status).toBe(404);
});

test("the inventory fails closed when its atomic evidence is unavailable or cross-subject", async () => {
  const store = seededStore();
  const authorization = { authorization: `Bearer ${SESSION_ID}` };
  const failures: AccountsStore[] = [
    new Proxy(store, {
      get(target, property) {
        if (property === "listPersonalAccessTokenInventoryPage") {
          return () => Promise.reject(new Error("database unavailable"));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    new Proxy(store, {
      get(target, property) {
        if (property === "listPersonalAccessTokenInventoryPage") {
          return async () => ({
            items: [
              {
                tokenId: "pat_cross_subject",
                tokenPrefix: "takpat_cross",
                subject: "tsub_inventory_route_other",
                name: "Cross subject",
                scopes: ["read"],
                createdAt: 1,
              },
            ],
            total: 1,
            cursorValid: true,
          });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    new Proxy(store, {
      get(target, property) {
        if (property === "listPersonalAccessTokenInventoryPage") {
          return async () => ({
            items: null,
            total: 1,
            cursorValid: true,
          });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AccountsStore,
  ];

  for (const failedStore of failures) {
    const response = await createAccountsHandler({
      issuer: ORIGIN,
      store: failedStore,
    })(inventoryRequest("?limit=100", authorization));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "inventory_unavailable" },
    });
    expectPrivateNoStore(response);
  }
});

function seededStore(): InMemoryAccountsStore {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: SUBJECT,
    createdAt: 1,
    updatedAt: 1,
  });
  store.saveAccountSession({
    sessionId: SESSION_ID,
    subject: SUBJECT,
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  });
  store.savePersonalAccessToken("takpat_route_secret_c", {
    tokenId: "pat_inventory_route_c",
    tokenPrefix: "takpat_route_c",
    subject: SUBJECT,
    name: "C",
    scopes: ["admin"],
    createdAt: 2_000,
  });
  store.savePersonalAccessToken("takpat_route_secret_b", {
    tokenId: "pat_inventory_route_b",
    tokenPrefix: "takpat_route_b",
    subject: SUBJECT,
    name: "B",
    scopes: ["write", "read"],
    workspaceId: "ws_inventory_route",
    createdAt: 1_000,
    expiresAt: 9_000,
    revokedAt: 3_000,
    lastUsedAt: 2_000,
  });
  store.savePersonalAccessToken("takpat_route_secret_a", {
    tokenId: "pat_inventory_route_a",
    tokenPrefix: "takpat_route_a",
    subject: SUBJECT,
    name: "A",
    scopes: ["read"],
    createdAt: 1_000,
  });
  store.savePersonalAccessToken("takpat_route_secret_other", {
    tokenId: "pat_inventory_route_other",
    tokenPrefix: "takpat_route_other",
    subject: "tsub_inventory_route_other",
    name: "Other",
    scopes: ["read"],
    createdAt: 500,
  });
  return store;
}

function observeWrites(
  store: InMemoryAccountsStore,
  writes: string[],
): AccountsStore {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (
          typeof property === "string" &&
          /^(?:add|consume|delete|link|mark|prune|record|replace|revoke|save)/u.test(
            property,
          )
        ) {
          writes.push(property);
        }
        return value.apply(target, args);
      };
    },
  });
}

function inventoryRequest(
  query = "",
  headers: HeadersInit = {},
  method = "GET",
): Request {
  return new Request(`${ORIGIN}${INVENTORY_PATH}${query}`, { method, headers });
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}
