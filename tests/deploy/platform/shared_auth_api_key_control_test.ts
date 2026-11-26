import { expect, spyOn, test } from "bun:test";
import { D1AccountsStore } from "../../../accounts/service/src/mod.ts";
import {
  applyD1AccountsMigrationBatch,
  loadD1AccountsMigrationCatalog,
} from "../../../accounts/service/src/d1-migrations.ts";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import { requestDeployControlApi } from "../../../cli/src/cli-deploy-control-api.ts";
import platform, {
  handlePlatformSharedAuthControlRequest,
  type CloudflareWorkerEnv,
} from "../../../deploy/platform/worker.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const origin = "https://app-staging.takosumi.com";
const subject = "tsub_key_qa";
const workspaceId = "ws_key_qa";
const salt = "shared-api-key-test-salt";
const cookie = "__Host-takosumi_hosted_session=synthetic-rp-cookie";
const tokensPath = "/api/v1/account/tokens";
const runsPath = "/api/v1/capsules/cap_own/runs";

async function fixture() {
  const database = new SqliteFakeD1();
  for (const migration of (await loadD1AccountsMigrationCatalog()).migrations) {
    await applyD1AccountsMigrationBatch(database, migration, 1_000 + migration.version);
  }
  const store = new D1AccountsStore(database, { schemaMode: "predeployed", sessionHashSalt: salt });
  const now = Date.now();
  await store.saveAccount({ subject, createdAt: now, updatedAt: now });
  let authenticateCalls = 0;
  let memberStatus: "active" | "suspended" = "active";
  let appRole: "owner" | undefined = "owner";
  const env = {
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
    TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    TAKOSUMI_ACCOUNTS_ISSUER: origin,
    TAKOSUMI_SHARED_AUTH_API_KEYS: "enabled",
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_ACCOUNTS_DB: database,
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: salt,
    HOSTED: {
      fetchSharedAuth: async () => new Response(null, { status: 204 }),
      authenticateSharedAuth: async (request: Request) => {
        authenticateCalls++;
        return request.headers.get("cookie") === cookie
          ? { kind: "authenticated", accountId: subject }
          : { kind: "unauthenticated" };
      },
      resolveSharedAuthWorkspace: async () => ({ kind: "forbidden" }),
    },
  } as unknown as CloudflareWorkerEnv;
  const ownershipFor = (capsuleId: string) => ({ capsuleId, ownerAccountId: subject, ownershipEpoch: 1 });
  const operations = {
    capsules: {
      getCapsule: async (id: string) => ({ id, workspaceId, status: "active", name: id }),
      getCapsulesByIds: async (ids: readonly string[]) =>
        ids.map((id) => ({ id, workspaceId, status: "active", name: id })),
    },
    appOwnership: { getOwnership: async (id: string) => ownershipFor(id) },
    appAccess: {
      resolveAppAccess: async (account: string, id: string) =>
        account === subject && appRole ? { ...ownershipFor(id), role: appRole } : undefined,
    },
    appAuthorization: {
      listMembers: async () => ({ ownerAccountId: subject, ownershipEpoch: 1, members: [] }),
      listTransfers: async () => [{
        transferId: "transfer_qa", capsuleId: "cap_own", fromAccountId: "tsub_sender",
        state: "pending", toAccountId: subject,
      }],
      getTransfer: async () => ({
        transferId: "transfer_qa", capsuleId: "cap_own", fromAccountId: "tsub_sender",
        state: "pending", toAccountId: subject,
      }),
      addMember: async () => { throw new Error("A suspended account cannot reach the member writer"); },
      acceptTransfer: async () => { throw new Error("A suspended account cannot reach the transfer writer"); },
    },
    workspaces: { getWorkspace: async () => ({ id: workspaceId, ownerUserId: subject }) },
    members: { getMember: async () => ({ workspaceId, accountId: subject, status: memberStatus, roles: ["owner"] }) },
    listCapsuleRunsPage: async () => ({ runs: [] }),
  } as unknown as ControlPlaneOperations;

  return {
    store, env, now,
    setMemberStatus: (status: typeof memberStatus) => { memberStatus = status; },
    removeAppRole: () => { appRole = undefined; },
    browserCalls: () => authenticateCalls,
    control: (request: Request, selected = env) => handlePlatformSharedAuthControlRequest(
      request,
      selected,
      { resolveOperations: async () => operations },
    ),
  };
}

const bearer = (token: string): HeadersInit => ({ authorization: `Bearer ${token}` });

function browserWrite(path: string, body?: unknown): Request {
  return new Request(origin + path, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("shared browser issues an Accounts key the real CLI HTTP client can use, then revokes it", async () => {
  const h = await fixture();
  const scopes = await platform.fetch(new Request(origin + tokensPath + "/scopes", { headers: { cookie } }), h.env);
  expect(scopes.status).toBe(200);
  expect(await scopes.json()).toMatchObject({ scopes: expect.any(Array) });
  const issued = await platform.fetch(browserWrite(tokensPath, { name: "CLI QA", scopes: ["read"] }), h.env);
  expect(issued.status).toBe(201);
  expect(issued.headers.get("cache-control")).toMatch(/no-store/u);
  const { token, token_record } = await issued.json() as { token: string; token_record: { id: string } };
  expect(token).toBeString();
  const list = await platform.fetch(new Request(origin + tokensPath + "?limit=200", { headers: { cookie } }), h.env);
  expect(await list.json()).toMatchObject({ tokens: [{ id: token_record.id }] });

  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const incoming = new Request(input, init);
    expect(incoming.headers.get("takosumi-client")).toBe("takosumi-cli");
    return await h.control(incoming) ?? new Response(null, { status: 404 });
  });
  const requestRuns = () => requestDeployControlApi({
    auth: "accounts", path: runsPath, options: { url: origin, token },
  });
  try {
    const browserCalls = h.browserCalls();
    expect(await requestRuns()).toEqual({ runs: [] });
    expect(h.browserCalls()).toBe(browserCalls);
    const revoked = await platform.fetch(browserWrite(`${tokensPath}/${token_record.id}/revoke`), h.env);
    expect(revoked.status).toBe(200);
    await expect(requestRuns()).rejects.toMatchObject({ status: 401 });
  } finally {
    fetch.mockRestore();
  }
});

test("shared Control checks the PAT, its scopes, app fence and current Workspace membership", async () => {
  const h = await fixture();
  const token = "synthetic-shared-app-scoped-key";
  await h.store.savePersonalAccessToken(token, {
    tokenId: "pat_app_qa", tokenPrefix: "fixture", subject, name: "App-scoped fixture",
    scopes: ["read"], appIds: ["cap_own"], createdAt: h.now,
  });
  const request = (path: string, method = "GET", headers = bearer(token), base = origin) =>
    new Request(base + path, { method, headers });
  const off = { ...h.env, TAKOSUMI_SHARED_AUTH_API_KEYS: undefined };
  expect((await h.control(request(runsPath), off))?.status).toBe(401);
  expect((await h.control(request(runsPath, "GET", bearer(token), "https://alias.example.test")))?.status).toBe(401);
  expect((await h.control(request(runsPath, "GET", { ...bearer(token), cookie })))?.status).toBe(401);
  expect((await h.control(request(runsPath, "GET", { ...bearer(token), "x-takosumi-account-session": "synthetic" })))?.status).toBe(401);
  expect((await h.control(request(runsPath, "POST")))?.status).toBe(403);
  expect((await h.control(request("/api/v1/capsules/cap_other/runs")))?.status).toBe(403);
  expect((await h.control(request(runsPath)))?.status).toBe(200);
  h.setMemberStatus("suspended");
  expect((await h.control(request(runsPath)))?.status).toBe(403);
  expect((await h.control(request("/api/v1/capsules/cap_own/members")))?.status).toBe(403);
  h.setMemberStatus("active");
  expect((await h.control(request("/api/v1/capsules/cap_own/members")))?.status).toBe(200);
  h.removeAppRole();
  expect((await h.control(request(runsPath)))?.status).toBe(403);
  expect(h.browserCalls()).toBe(0);
});

test("shared PATs cannot use app management or a pending transfer while membership is suspended", async () => {
  const h = await fixture();
  const token = "synthetic-shared-management-key";
  await h.store.savePersonalAccessToken(token, {
    tokenId: "pat_management_qa", tokenPrefix: "fixture", subject, name: "Management fixture",
    scopes: ["read", "write"], createdAt: h.now,
  });
  h.setMemberStatus("suspended");
  const invoke = (path: string, method = "GET") =>
    h.control(new Request(origin + path, { method, headers: bearer(token) }));
  const members = "/api/v1/capsules/cap_own/members";
  expect((await invoke(members))?.status).toBe(403);
  expect((await invoke(members, "POST"))?.status).toBe(403);
  expect(await (await invoke("/api/v1/ownership-transfers"))?.json()).toEqual({ ownershipTransfers: [] });
  expect((await invoke("/api/v1/ownership-transfers/transfer_qa/accept", "POST"))?.status).toBe(403);
});

test("shared Control refuses existing Accounts sessions, OAuth and ambiguous credential records", async () => {
  const h = await fixture();
  const collision = "synthetic-session-collision";
  await h.store.saveAccountSession({
    sessionId: collision, subject, createdAt: h.now, expiresAt: h.now + 60_000,
  });
  for (const value of ["synthetic-oauth-token", collision]) {
    if (value === "synthetic-oauth-token") {
      await h.store.saveAccessToken(value, {
        clientId: "fixture", scope: "capsules:read", subject, takosumiSubject: subject,
        expiresAt: h.now + 60_000,
      });
    }
    expect((await h.control(new Request(origin + runsPath, { headers: bearer(value) })))?.status).toBe(401);
  }
  await h.store.savePersonalAccessToken(collision, {
    tokenId: "pat_collision_qa", tokenPrefix: "fixture", subject, name: "Collision fixture",
    scopes: ["read"], createdAt: h.now,
  });
  expect((await h.control(new Request(origin + runsPath, { headers: bearer(collision) })))?.status).toBe(401);
  expect((await h.store.findPersonalAccessTokenById(subject, "pat_collision_qa"))?.lastUsedAt).toBeUndefined();
  expect(h.browserCalls()).toBe(0);
});
