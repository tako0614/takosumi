import { expect, test } from "bun:test";
import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH as tokensPath,
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH as scopesPath,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import {
  D1AccountsStore,
  createPersonalAccessTokenCreationRateLimiter,
} from "../../../accounts/service/src/mod.ts";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import {
  handleSharedAuthApiKeyRequest,
  matchSharedAuthApiKeyRoute,
} from "../../../deploy/platform/shared-auth-api-keys.ts";
import type { SharedAuthIdentity } from "../../../worker/src/shared_auth_rpc.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const origin = "https://shared.staging.example.test";
const rpCookie = "__Host-takosumi_hosted_session=fixture";
const alice = "tsub_alice";
const bob = "tsub_bob";

async function fixture() {
  const db = new SqliteFakeD1();
  const store = new D1AccountsStore(db);
  await store.initialize();
  const now = Date.now();
  for (const subject of [alice, bob]) {
    await store.saveAccount({ subject, createdAt: now, updatedAt: now });
  }
  const state = {
    subject: alice as string,
    authenticationCalls: 0,
    csrfCalls: 0,
    unavailable: false,
    appAccess: true,
  };
  const appChecks: [string, string][] = [];
  const workspaceChecks: [string, TakosumiSubject][] = [];
  const operations = {
    appAccess: {
      async resolveAppAccess(subject, capsuleId) {
        appChecks.push([subject, capsuleId]);
        return state.appAccess && subject === alice && capsuleId === "cap_allowed"
          ? { capsuleId, role: "member", ownerAccountId: bob, ownershipEpoch: 1 }
          : undefined;
      },
      async listAccessibleApps() { return { apps: [] }; },
    },
  } satisfies Pick<ControlPlaneOperations, "appAccess">;
  const dependencies = {
    origin,
    store,
    authenticate: async (request: Request): Promise<SharedAuthIdentity> => {
      state.authenticationCalls++;
      if (state.unavailable) return { kind: "unavailable" };
      if (request.headers.get("cookie") !== rpCookie) return { kind: "unauthenticated" };
      return { kind: "authenticated", accountId: state.subject };
    },
    writeCsrfFailure: (request: Request) => {
      state.csrfCalls++;
      return request.headers.get("origin") === origin
        ? undefined : Response.json({ error: "csrf_failed" }, { status: 403 });
    },
    creationLimiter: createPersonalAccessTokenCreationRateLimiter(),
    async resolveOperations() { return operations as unknown as ControlPlaneOperations; },
    membershipReader: {
      async getMember(workspaceId: string, subject: TakosumiSubject) {
        workspaceChecks.push([workspaceId, subject]);
        return workspaceId === "ws_allowed" && subject === alice
          ? { workspaceId, accountId: subject, status: "active", roles: ["member"] }
          : undefined;
      },
    },
  };
  const request = (method: string, path = tokensPath, options: {
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    readonly base?: string;
    readonly noCookie?: true;
  } = {}) => new Request((options.base ?? origin) + path, {
    method,
    headers: {
      ...(options.noCookie ? {} : { cookie: rpCookie }),
      ...(method === "POST" ? { origin } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return {
    db, store, state, appChecks, workspaceChecks, request,
    async call(...args: Parameters<typeof request>) {
      const response = await handleSharedAuthApiKeyRequest(request(...args), dependencies);
      if (!response) throw new Error("expected an owned API key route");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      return response;
    },
  };
}

test("Hosted browser PAT routing owns only exact management paths and rejects wrong ingress before authentication", async () => {
  const f = await fixture();
  expect(matchSharedAuthApiKeyRoute(tokensPath)).toEqual({ kind: "tokens" });
  expect(matchSharedAuthApiKeyRoute(scopesPath)).toEqual({ kind: "scopes" });
  expect(matchSharedAuthApiKeyRoute(`${tokensPath}/pat_id/revoke`)).toEqual({ kind: "revoke", tokenId: "pat_id" });
  for (const path of [
    `${tokensPath}/`, `${tokensPath}/current`, `${tokensPath}/inventory.v1`,
    `${tokensPath}/pat_id`, `${tokensPath}//revoke`, `${tokensPath}/pat_id/revoke/extra`,
    "/api/v1/account/tokens-elsewhere",
  ]) {
    expect(matchSharedAuthApiKeyRoute(path)).toBeUndefined();
  }
  const unsupported = await f.call("POST", scopesPath);
  expect(unsupported.status).toBe(405);
  expect(unsupported.headers.get("allow")).toBe("GET");
  expect((await f.call("GET", tokensPath, { base: "https://other.example.test" })).status).toBe(404);
  for (const name of ["authorization", "proxy-authorization", "x-takosumi-account-session", "x-takosumi-platform-subject", "x-auth-key"]) {
    expect((await f.call("GET", tokensPath, { headers: { [name]: "" } })).status).toBe(401);
  }
  expect((await f.call("POST", tokensPath, { headers: { origin: "https://other.example.test" } })).status).toBe(403);
  expect((await f.call("POST", `${tokensPath}/pat_id/revoke`, { headers: { origin: "null" } })).status).toBe(403);
  expect(f.state.authenticationCalls).toBe(0);
  expect(f.state.csrfCalls).toBe(2);
});

test("Hosted API key mint, list, and revoke use the same Accounts D1 and exact subject", async () => {
  const f = await fixture();
  const catalog = await (await f.call("GET", scopesPath)).json() as { scopes: { scope: string; selfService: boolean }[] };
  expect(catalog.scopes.filter(({ selfService }) => selfService).map(({ scope }) => scope)).toEqual(["read", "write"]);
  const issued = await f.call("POST", tokensPath, {
    body: { name: " CI key ", scopes: ["read", "write"], workspace_id: "ws_allowed", appIds: ["cap_allowed"], subject: bob },
  });
  expect(issued.status).toBe(201);
  const created = await issued.json() as { token: string; token_record: { id: string } };
  expect(created.token_record).toMatchObject({
    subject: alice, name: "CI key", scopes: ["read", "write"], workspace_id: "ws_allowed", appIds: ["cap_allowed"],
  });
  expect(await f.store.findPersonalAccessToken(created.token)).toMatchObject({
    subject: alice, tokenId: created.token_record.id, appIds: ["cap_allowed"],
  });
  expect(f.appChecks).toEqual([[alice, "cap_allowed"]]);
  expect(f.workspaceChecks).toEqual([["ws_allowed", alice]]);

  const denial = await f.call("POST", tokensPath, { body: { name: "other", scopes: ["read"], workspace_id: "ws_other" } });
  expect(denial.status).toBe(404);
  f.state.appAccess = false;
  const staleApp = await f.call("POST", tokensPath, { body: { name: "other", scopes: ["read"], appIds: ["cap_allowed"] } });
  expect(staleApp.status).toBe(403);

  const revoke = `${tokensPath}/${created.token_record.id}/revoke`;
  f.state.subject = bob;
  expect(await (await f.call("GET")).json()).toEqual({ tokens: [], next_cursor: null });
  expect((await f.call("POST", revoke)).status).toBe(404);
  f.state.subject = alice;
  const list = await (await f.call("GET")).json() as { tokens: unknown[] };
  expect(list.tokens).toEqual([created.token_record]);
  expect(JSON.stringify(list).includes(created.token)).toBe(false);
  expect((await f.call("POST", revoke)).status).toBe(200);
  expect((await f.store.findPersonalAccessToken(created.token))?.revokedAt).toBeNumber();
});

test("unavailable, unknown, remapped, and fenced RP principals cannot manage keys", async () => {
  const f = await fixture();
  const create = () => f.call("POST", tokensPath, { body: { name: "Fixture", scopes: ["read"] } });
  expect((await f.call("GET", tokensPath, { noCookie: true })).status).toBe(401);
  f.state.unavailable = true;
  expect((await create()).status).toBe(503);
  f.state.unavailable = false;
  f.state.subject = "tsub_unregistered";
  expect((await create()).status).toBe(401);

  const insert = (bucket: string, subject: string, document: object) => f.db
    .prepare("INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)")
    .bind(bucket, subject, JSON.stringify(document), Date.now()).run();
  f.state.subject = bob;
  await insert("canonical_accounts", bob, { targetSubject: alice });
  expect((await create()).status).toBe(401);
  f.state.subject = alice;
  await insert("identity_merge_locks", alice, { operationId: "fixture-staged-merge" });
  expect((await f.call("GET", scopesPath)).status).toBe(401);
  expect((await create()).status).toBe(401);
  expect(await f.store.listPersonalAccessTokensForSubject(alice)).toEqual([]);
});

test("Hosted API key mint preserves Accounts validation and the issuer's ten-per-minute rate limit", async () => {
  const f = await fixture();
  expect((await f.call("POST", tokensPath, { body: { name: "fixture", scopes: ["admin"] } })).status).toBe(403);
  expect((await f.call("POST", tokensPath, { body: { name: "fixture", scopes: ["ai.chat"] } })).status).toBe(403);
  expect((await f.call("POST", tokensPath, {
    body: { name: "malformed", scopes: ["read"] },
    headers: { "content-length": "1048577" },
  })).status).toBe(413);
  for (let i = 3; i < 10; i++) {
    expect((await f.call("POST", tokensPath, { body: {} })).status).toBe(400);
  }
  expect(f.state.authenticationCalls).toBe(10);
  const limited = await f.call("POST", tokensPath, { body: { name: "fixture", scopes: ["read"] } });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(f.state.authenticationCalls).toBe(10);
  expect(await f.store.listPersonalAccessTokensForSubject(alice)).toEqual([]);
});
