import { expect, test } from "bun:test";

import {
  type AccountsStore,
  createAccountsHandler,
  InMemoryAccountsStore,
  type PatWorkspaceMembership,
  type PatWorkspaceMembershipReader,
} from "../../../../accounts/service/src/mod.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";

const ORIGIN = "https://accounts.example.test";

function privateCacheIsDisabled(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

function seedSession(
  store: InMemoryAccountsStore,
  sessionId: string,
  subject = "tsub_session",
): void {
  const now = Date.now();
  store.saveAccount({ subject, createdAt: now, updatedAt: now });
  store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
}

function activeMember(
  patch: Partial<PatWorkspaceMembership> = {},
): PatWorkspaceMembership {
  return {
    workspaceId: "ws_current",
    accountId: "tsub_current_workspace",
    roles: ["owner"],
    status: "active",
    ...patch,
  };
}

test("a generic PAT reads its closed current authority without mutating usage", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.current.generic";
  store.savePersonalAccessToken(token, {
    tokenId: "pat_current_generic",
    tokenPrefix: "display-only",
    subject: "tsub_current_generic",
    name: "Generic automation",
    scopes: ["write", "read"],
    createdAt: Date.now() - 1_000,
    lastUsedAt: 1_000,
  });
  const writes: string[] = [];
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store: observeAccountsWrites(store, writes),
  });

  const response = await handler(
    new Request(`${ORIGIN}/v1/account/tokens/current`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

  expect(response.status).toBe(200);
  privateCacheIsDisabled(response);
  expect(await response.json()).toEqual({
    kind: "takosumi.account-pat-authority@v1",
    token_id: "pat_current_generic",
    subject: "tsub_current_generic",
    scopes: ["read", "write"],
    workspace_id: null,
    expires_at: null,
    workspace_role: null,
  });
  expect(store.findPersonalAccessToken(token)?.lastUsedAt).toBe(1_000);
  expect(writes).toEqual([]);
});

test("the current authority accepts only the Authorization bearer and never falls back", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.current.header-only";
  const sessionId = "sess_current_cookie";
  seedSession(store, sessionId);
  store.savePersonalAccessToken(token, {
    tokenId: "pat_current_header_only",
    tokenPrefix: "display-only",
    subject: "tsub_current_header_only",
    name: "Header only",
    scopes: ["read"],
    createdAt: Date.now(),
  });
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
    loginEmailAllowlist: { emails: ["kept@example.test"] },
  });
  const ambientHeaders = {
    cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`,
    "x-takosumi-account-session": token,
  };

  for (const request of [
    new Request(`${ORIGIN}/v1/account/tokens/current?token=${token}`, {
      headers: ambientHeaders,
    }),
    new Request(`${ORIGIN}/v1/account/tokens/current`, {
      headers: { ...ambientHeaders, authorization: `Basic ${token}` },
    }),
    new Request(`${ORIGIN}/v1/account/tokens/current`, {
      headers: { ...ambientHeaders, authorization: `Bearer  ${token}` },
    }),
  ]) {
    const response = await handler(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_token" });
    privateCacheIsDisabled(response);
  }

  const selected = await handler(
    new Request(`${ORIGIN}/v1/account/tokens/current`, {
      headers: { ...ambientHeaders, authorization: `Bearer ${token}` },
    }),
  );
  expect(selected.status).toBe(200);
  expect((await selected.json()).token_id).toBe("pat_current_header_only");
  expect(store.findAccountSession(sessionId)).toBeDefined();
});

test("account-session and OAuth bearers are not PAT self authority", async () => {
  const store = new InMemoryAccountsStore();
  const sessionToken = "opaque.current.session";
  const oauthToken = "opaque.current.oauth";
  seedSession(store, sessionToken, "tsub_current_session");
  store.saveAccessToken(oauthToken, {
    clientId: "client_current_oauth",
    scope: "capsules:read capsules:write",
    subject: "client-local-subject",
    takosumiSubject: "tsub_current_oauth",
    expiresAt: Date.now() + 60_000,
  });
  const handler = createAccountsHandler({ issuer: ORIGIN, store });

  for (const token of [sessionToken, oauthToken]) {
    const response = await handler(
      new Request(`${ORIGIN}/v1/account/tokens/current`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_token" });
  }
  expect(store.findAccountSession(sessionToken)).toBeDefined();
});

test("a cross-store opaque credential collision is rejected before PAT selection", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.current.collision";
  seedSession(store, token, "tsub_collision_session");
  store.saveAccessToken(token, {
    clientId: "client_collision",
    scope: "capsules:read",
    subject: "client-collision",
    takosumiSubject: "tsub_collision_oauth",
    expiresAt: Date.now() - 1,
  });
  store.savePersonalAccessToken(token, {
    tokenId: "pat_current_collision",
    tokenPrefix: "display-only",
    subject: "tsub_collision_pat",
    name: "Collision",
    scopes: ["read", "write"],
    createdAt: Date.now(),
    lastUsedAt: 2_000,
  });
  const handler = createAccountsHandler({ issuer: ORIGIN, store });

  const response = await handler(
    new Request(`${ORIGIN}/v1/account/tokens/current`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "invalid_token" });
  expect(store.findAccountSession(token)).toBeDefined();
  expect(store.findPersonalAccessToken(token)?.lastUsedAt).toBe(2_000);
});

test("revoked, expired, and malformed-scope PATs are invalid", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.savePersonalAccessToken("opaque.current.revoked", {
    tokenId: "pat_current_revoked",
    tokenPrefix: "display-only",
    subject: "tsub_current_invalid",
    name: "Revoked",
    scopes: ["read"],
    createdAt: now - 1_000,
    revokedAt: now - 1,
  });
  store.savePersonalAccessToken("opaque.current.expired", {
    tokenId: "pat_current_expired",
    tokenPrefix: "display-only",
    subject: "tsub_current_invalid",
    name: "Expired",
    scopes: ["read"],
    createdAt: now - 1_000,
    expiresAt: now - 1,
  });
  store.savePersonalAccessToken("opaque.current.duplicate-scope", {
    tokenId: "pat_current_duplicate_scope",
    tokenPrefix: "display-only",
    subject: "tsub_current_invalid",
    name: "Duplicate scope",
    scopes: ["read", "read"],
    createdAt: now - 1_000,
  });
  const handler = createAccountsHandler({ issuer: ORIGIN, store });

  for (const token of [
    "opaque.current.revoked",
    "opaque.current.expired",
    "opaque.current.duplicate-scope",
  ]) {
    const response = await handler(
      new Request(`${ORIGIN}/v1/account/tokens/current`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_token" });
  }
});

test("candidate lookup failures and malformed PAT records fail closed", async () => {
  const lookupFailureStore = new InMemoryAccountsStore();
  lookupFailureStore.resolveAccountsBearerCandidates = async () => {
    throw new Error("credential store unavailable");
  };

  const malformedStore = new InMemoryAccountsStore();
  malformedStore.resolveAccountsBearerCandidates = async () => ({
    personalAccessToken: {
      tokenId: "pat_current_malformed",
      tokenPrefix: "display-only",
      subject: "tsub_current_malformed",
      name: "Malformed",
      scopes: null,
      createdAt: Date.now(),
    } as unknown as Awaited<
      ReturnType<NonNullable<AccountsStore["findPersonalAccessToken"]>>
    >,
  });

  const malformedCandidatesStore = new InMemoryAccountsStore();
  malformedCandidatesStore.resolveAccountsBearerCandidates = async () =>
    null as unknown as Awaited<
      ReturnType<
        NonNullable<AccountsStore["resolveAccountsBearerCandidates"]>
      >
    >;

  for (const store of [
    lookupFailureStore,
    malformedStore,
    malformedCandidatesStore,
  ]) {
    const response = await createAccountsHandler({ issuer: ORIGIN, store })(
      new Request(`${ORIGIN}/v1/account/tokens/current`, {
        headers: { authorization: "Bearer opaque.current.fail-closed" },
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_token" });
    privateCacheIsDisabled(response);
  }
});

test("a workspace PAT returns the one live canonical membership role", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.current.workspace";
  const expiresAt = Date.now() + 60_000;
  store.savePersonalAccessToken(token, {
    tokenId: "pat_current_workspace",
    tokenPrefix: "display-only",
    subject: "tsub_current_workspace",
    name: "Workspace automation",
    scopes: ["write", "read"],
    workspaceId: "ws_current",
    createdAt: Date.now(),
    expiresAt,
    lastUsedAt: 3_000,
  });
  const calls: Array<readonly [string, string]> = [];
  const membershipReader: PatWorkspaceMembershipReader = {
    getMember: async (workspaceId, subject) => {
      calls.push([workspaceId, subject]);
      return activeMember({ roles: ["viewer", "owner", "admin"] });
    },
  };
  let controlResolverCalls = 0;
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
    patWorkspaceMembershipReader: membershipReader,
    controlPlaneOperations: new Proxy({} as never, {
      get() {
        throw new Error("generic Control operations must not be read");
      },
    }),
    resolveControlPlaneOperations: async () => {
      controlResolverCalls += 1;
      throw new Error("generic Control bootstrap must not run");
    },
  });

  const response = await handler(
    new Request(`${ORIGIN}/v1/account/tokens/current`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    kind: "takosumi.account-pat-authority@v1",
    token_id: "pat_current_workspace",
    subject: "tsub_current_workspace",
    scopes: ["read", "write"],
    workspace_id: "ws_current",
    expires_at: new Date(expiresAt).toISOString(),
    workspace_role: "owner",
  });
  expect(calls).toEqual([["ws_current", "tsub_current_workspace"]]);
  expect(controlResolverCalls).toBe(0);
  expect(store.findPersonalAccessToken(token)?.lastUsedAt).toBe(3_000);
});

test("generic PAT authority never calls Workspace or generic Control readers", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.current.generic-no-control";
  store.savePersonalAccessToken(token, {
    tokenId: "pat_current_generic_no_control",
    tokenPrefix: "display-only",
    subject: "tsub_current_generic_no_control",
    name: "Generic",
    scopes: ["read"],
    createdAt: Date.now(),
  });
  let membershipReads = 0;
  let controlResolverCalls = 0;
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
    patWorkspaceMembershipReader: {
      getMember: async () => {
        membershipReads += 1;
        throw new Error("generic PAT must not read membership");
      },
    },
    resolveControlPlaneOperations: async () => {
      controlResolverCalls += 1;
      throw new Error("generic Control bootstrap must not run");
    },
  });

  expect(
    (
      await handler(
        new Request(`${ORIGIN}/v1/account/tokens/current`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      )
    ).status,
  ).toBe(200);
  expect(membershipReads).toBe(0);
  expect(controlResolverCalls).toBe(0);
});

test("workspace verification distinguishes unavailable from inactive authority", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque.current.workspace-denied";
  store.savePersonalAccessToken(token, {
    tokenId: "pat_current_workspace_denied",
    tokenPrefix: "display-only",
    subject: "tsub_current_workspace",
    name: "Workspace denied",
    scopes: ["read"],
    workspaceId: "ws_current",
    createdAt: Date.now(),
  });
  const request = () =>
    new Request(`${ORIGIN}/v1/account/tokens/current`, {
      headers: { authorization: `Bearer ${token}` },
    });

  for (const membershipReader of [
    { getMember: async () => undefined },
    { getMember: async () => activeMember({ status: "suspended" }) },
    { getMember: async () => activeMember({ accountId: "tsub_wrong" }) },
    { getMember: async () => activeMember({ workspaceId: "ws_wrong" }) },
    { getMember: async () => activeMember({ roles: [] }) },
  ] satisfies readonly PatWorkspaceMembershipReader[]) {
    const response = await createAccountsHandler({
      issuer: ORIGIN,
      store,
      patWorkspaceMembershipReader: membershipReader,
    })(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "workspace_membership_inactive" },
    });
    privateCacheIsDisabled(response);
  }

  for (const membershipReader of [
    undefined,
    { getMember: async () => Promise.reject(new Error("D1 unavailable")) },
    {
      getMember: async () =>
        activeMember({ roles: null as unknown as readonly string[] }),
    },
    { getMember: async () => activeMember({ roles: ["owner", "unknown"] }) },
  ] satisfies readonly (PatWorkspaceMembershipReader | undefined)[]) {
    const response = await createAccountsHandler({
      issuer: ORIGIN,
      store,
      ...(membershipReader
        ? { patWorkspaceMembershipReader: membershipReader }
        : {}),
    })(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "verification_unavailable" },
    });
    privateCacheIsDisabled(response);
  }
});

test("list, create, revoke, and current PAT responses disable private caching", async () => {
  const store = new InMemoryAccountsStore();
  const sessionId = "sess_pat_cache_headers";
  seedSession(store, sessionId, "tsub_pat_cache_headers");
  const handler = createAccountsHandler({ issuer: ORIGIN, store });
  const authenticated = { authorization: `Bearer ${sessionId}` };

  const list = await handler(
    new Request(`${ORIGIN}/v1/account/tokens`, { headers: authenticated }),
  );
  expect(list.status).toBe(200);
  privateCacheIsDisabled(list);

  const create = await handler(
    new Request(`${ORIGIN}/v1/account/tokens`, {
      method: "POST",
      headers: { ...authenticated, "content-type": "application/json" },
      body: JSON.stringify({ name: "Cache-safe token", scopes: ["read"] }),
    }),
  );
  expect(create.status).toBe(201);
  privateCacheIsDisabled(create);
  const created = await create.json();
  expect(created.token).toStartWith("takpat_");

  const revoke = await handler(
    new Request(
      `${ORIGIN}/v1/account/tokens/${created.token_record.id}/revoke`,
      { method: "POST", headers: authenticated },
    ),
  );
  expect(revoke.status).toBe(200);
  privateCacheIsDisabled(revoke);

  for (const request of [
    new Request(`${ORIGIN}/v1/account/tokens`),
    new Request(`${ORIGIN}/v1/account/tokens`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    }),
    new Request(`${ORIGIN}/v1/account/tokens/pat_unknown/revoke`, {
      method: "POST",
      headers: { origin: ORIGIN },
    }),
    new Request(`${ORIGIN}/v1/account/tokens/current`),
  ]) {
    const response = await handler(request);
    expect(response.status).toBe(401);
    privateCacheIsDisabled(response);
  }
});

function observeAccountsWrites(
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
