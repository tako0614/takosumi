import { expect, test } from "bun:test";

import {
  createAccountsHandler,
  InMemoryAccountsStore,
  requireAccountsBearer,
  type ControlPlaneOperations,
  type AccountsStore,
} from "../../../../accounts/service/src/mod.ts";
import { bearerWorkspaceAllows } from "../../../../accounts/service/src/account-session.ts";
import { handleCreatePersonalAccessToken } from "../../../../accounts/service/src/pat-routes.ts";

const ORIGIN = "https://accounts.example.test";
const SUBJECT = "tsub_scope_catalog" as const;
const SESSION = "sess_scope_catalog";

function seededStore(): InMemoryAccountsStore {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({ subject: SUBJECT, createdAt: now, updatedAt: now });
  store.saveAccountSession({
    sessionId: SESSION,
    subject: SUBJECT,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return store;
}

function createRequest(body: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}/api/v1/account/tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SESSION}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("resources:read PAT creation is explicit, workspace-bound, and exact", async () => {
  const store = seededStore();
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
    personalAccessTokenSelfServiceScopes: ["resources:read"],
    controlPlaneOperations: {
      workspaces: {
        getWorkspaceForAccount: async () => ({ id: "ws_inventory" }),
      },
    } as unknown as ControlPlaneOperations,
  });

  const missingWorkspace = await handler(
    createRequest({ name: "Inventory", scopes: ["resources:read"] }),
  );
  expect(missingWorkspace.status).toBe(400);
  expect(await missingWorkspace.json()).toMatchObject({
    error: { code: "invalid_request" },
  });

  const created = await handler(
    createRequest({
      name: "Inventory",
      scopes: ["resources:read"],
      workspace_id: "ws_inventory",
    }),
  );
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(body.token).toMatch(/^takpat_/u);
  expect(body.token_record).not.toHaveProperty("secret");
  expect(body.token_record).toMatchObject({
    scopes: ["resources:read"],
    workspace_id: "ws_inventory",
  });
  expect(store.listPersonalAccessTokensForSubject(SUBJECT)).toHaveLength(1);
});

test("resources:read PAT creation rejects a workspace outside the account fence", async () => {
  const store = seededStore();
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
    personalAccessTokenSelfServiceScopes: ["resources:read"],
    controlPlaneOperations: {
      workspaces: {
        getWorkspaceForAccount: async (_subject, workspaceId) =>
          workspaceId === "ws_owned" ? { id: workspaceId } : undefined,
      },
    } as unknown as ControlPlaneOperations,
  });

  const response = await handler(
    createRequest({
      name: "Inventory",
      scopes: ["resources:read"],
      workspace_id: "ws_other",
    }),
  );
  expect(response.status).toBe(404);
  expect(store.listPersonalAccessTokensForSubject(SUBJECT)).toHaveLength(0);
});

test("workspace PAT creation times out before minting when Control authority stalls", async () => {
  const store = seededStore();
  const response = await handleCreatePersonalAccessToken({
    request: createRequest({
      name: "Agent runtime",
      scopes: ["read", "write"],
      workspace_id: "ws_inventory",
    }),
    store,
    resolveOperations: () => new Promise(() => undefined),
    workspaceAuthorityTimeoutMs: 10,
  });

  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(await response.json()).toMatchObject({
    error: { code: "workspace_authority_unavailable" },
  });
  expect(store.listPersonalAccessTokensForSubject(SUBJECT)).toHaveLength(0);
});

test("Cloud AI PAT scopes are explicit, workspace-bound, and cataloged", async () => {
  const store = seededStore();
  const aiScopes = ["ai.models.read", "ai.chat", "ai.embeddings"] as const;
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
    personalAccessTokenSelfServiceScopes: aiScopes,
    controlPlaneOperations: {
      workspaces: {
        getWorkspaceForAccount: async (_subject, workspaceId) =>
          workspaceId === "ws_ai" ? { id: workspaceId } : undefined,
      },
    } as unknown as ControlPlaneOperations,
  });

  const missingWorkspace = await handler(
    createRequest({ name: "AI", scopes: ["ai.chat"] }),
  );
  expect(missingWorkspace.status).toBe(400);

  const created = await handler(
    createRequest({
      name: "AI",
      scopes: aiScopes,
      workspace_id: "ws_ai",
    }),
  );
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({
    token_record: { scopes: aiScopes, workspace_id: "ws_ai" },
  });

  const catalog = await handler(
    new Request(`${ORIGIN}/api/v1/account/tokens/scopes`, {
      headers: { authorization: `Bearer ${SESSION}` },
    }),
  );
  expect(catalog.status).toBe(200);
  const body = await catalog.json();
  for (const scope of aiScopes) {
    expect(body.scopes).toContainEqual(
      expect.objectContaining({
        scope,
        selfService: true,
        workspaceBinding: "required",
      }),
    );
  }
});

test("resources:read is not inferred from route metadata or legacy write", async () => {
  const store = seededStore();
  const handler = createAccountsHandler({ issuer: ORIGIN, store });
  const response = await handler(
    createRequest({
      name: "Inventory",
      scopes: ["resources:read"],
      workspace_id: "ws_inventory",
    }),
  );
  expect(response.status).toBe(403);

  const legacy = await handler(
    createRequest({
      name: "Legacy",
      scopes: ["write"],
    }),
  );
  expect(legacy.status).toBe(201);
});

test("self-service PAT scope catalog is authenticated, safe, and session-only", async () => {
  const store = seededStore();
  const observed = observeSessionReads(store);
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store: observed,
    personalAccessTokenSelfServiceScopes: ["resources:read"],
  });
  const response = await handler(
    new Request(`${ORIGIN}/api/v1/account/tokens/scopes`, {
      headers: { authorization: `Bearer ${SESSION}` },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    kind: "takosumi.account-pat-scope-catalog@v1",
    scopes: [
      {
        scope: "read",
        label: { ja: "読み取り", en: "Read" },
        description: {
          ja: "読み取り専用の既存アカウント API にアクセスします。",
          en: "Read-only access to legacy account APIs.",
        },
        selfService: true,
        workspaceBinding: "optional",
      },
      {
        scope: "write",
        label: { ja: "書き込み", en: "Write" },
        description: {
          ja: "既存アカウント API の読み取りと書き込みにアクセスします。",
          en: "Read and write access to legacy account APIs.",
        },
        selfService: true,
        workspaceBinding: "optional",
      },
      {
        scope: "admin",
        label: { ja: "管理者", en: "Administrator" },
        description: {
          ja: "オペレーター発行の管理者権限です。セルフサービスでは付与できません。",
          en: "Operator-issued administrator authority; unavailable to self-service PATs.",
        },
        selfService: false,
        workspaceBinding: "optional",
      },
      {
        scope: "resources:read",
        label: { ja: "ホストリソースの読み取り", en: "Hosted resource read" },
        description: {
          ja: "指定した Workspace のホストリソース一覧を読み取ります。",
          en: "Read hosted-resource inventory for one bound Workspace.",
        },
        selfService: true,
        workspaceBinding: "required",
      },
      {
        scope: "ai.models.read",
        label: { ja: "AIモデルの読み取り", en: "AI model read" },
        description: {
          ja: "指定した Workspace で利用できる AI モデルを読み取ります。",
          en: "Read AI models available to one bound Workspace.",
        },
        selfService: false,
        workspaceBinding: "required",
      },
      {
        scope: "ai.chat",
        label: { ja: "AIチャット", en: "AI chat" },
        description: {
          ja: "指定した Workspace の課金枠で AI チャットを実行します。",
          en: "Run AI chat against the billing authority of one bound Workspace.",
        },
        selfService: false,
        workspaceBinding: "required",
      },
      {
        scope: "ai.embeddings",
        label: { ja: "AI埋め込み", en: "AI embeddings" },
        description: {
          ja: "指定した Workspace の課金枠で AI 埋め込みを生成します。",
          en: "Generate AI embeddings against the billing authority of one bound Workspace.",
        },
        selfService: false,
        workspaceBinding: "required",
      },
    ],
  });
  expect(observed.sessionWrites).toBe(0);
  expect(store.findAccountSession(SESSION)?.subject).toBe(SUBJECT);

  const anonymous = await handler(
    new Request(`${ORIGIN}/api/v1/account/tokens/scopes`),
  );
  expect(anonymous.status).toBe(401);
});

test("scope catalog does not leak or admit admin", async () => {
  const store = seededStore();
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
    personalAccessTokenSelfServiceScopes: ["resources:read"],
  });
  const response = await handler(
    createRequest({
      name: "Admin",
      scopes: ["admin"],
    }),
  );
  expect(response.status).toBe(403);
  const catalog = await handler(
    new Request(`${ORIGIN}/api/v1/account/tokens/scopes`, {
      headers: { authorization: `Bearer ${SESSION}` },
    }),
  );
  const catalogBody = await catalog.json();
  expect(catalogBody.scopes).toContainEqual(
    expect.objectContaining({ scope: "admin", selfService: false }),
  );
});

test("alternate Accounts compositions cannot widen self-service PAT scopes", () => {
  for (const scope of ["admin", "read", "write", "unknown:read"]) {
    expect(() =>
      createAccountsHandler({
        issuer: ORIGIN,
        store: seededStore(),
        personalAccessTokenSelfServiceScopes: [scope] as never,
      }),
    ).toThrow(/unsupported self-service PAT scope/u);
  }
});

test("resource inventory bearer authorization is exact and workspace-fenced", async () => {
  const store = seededStore();
  store.savePersonalAccessToken("pat_write_only", {
    tokenId: "pat_write_only",
    tokenPrefix: "takpat_write",
    subject: SUBJECT,
    name: "Legacy write",
    scopes: ["write"],
    workspaceId: "ws_inventory",
    createdAt: Date.now(),
  });
  const writeOnly = await requireAccountsBearer({
    request: new Request(`${ORIGIN}/v1/cloud/resource-instances`, {
      headers: { authorization: "Bearer pat_write_only" },
    }),
    store,
    scope: "resources:read",
  });
  expect(writeOnly.ok).toBe(false);

  store.savePersonalAccessToken("pat_resource_read", {
    tokenId: "pat_resource_read",
    tokenPrefix: "takpat_resour",
    subject: SUBJECT,
    name: "Inventory read",
    scopes: ["resources:read"],
    workspaceId: "ws_inventory",
    createdAt: Date.now(),
  });
  const exact = await requireAccountsBearer({
    request: new Request(`${ORIGIN}/v1/cloud/resource-instances`, {
      headers: { authorization: "Bearer pat_resource_read" },
    }),
    store,
    scope: "resources:read",
  });
  expect(exact.ok).toBe(true);
  if (exact.ok) {
    expect(exact.auth.workspaceId).toBe("ws_inventory");
    expect(bearerWorkspaceAllows(exact.auth, "ws_inventory")).toBe(true);
    expect(bearerWorkspaceAllows(exact.auth, "ws_other")).toBe(false);
  }
});

function observeSessionReads(store: InMemoryAccountsStore): AccountsStore & {
  sessionWrites: number;
} {
  let sessionWrites = 0;
  return new Proxy(store as AccountsStore & { sessionWrites: number }, {
    get(target, property, receiver) {
      if (property === "sessionWrites") return sessionWrites;
      if (
        property === "saveAccountSession" ||
        property === "deleteAccountSession"
      ) {
        return (...args: unknown[]) => {
          sessionWrites += 1;
          return Reflect.get(target, property, target)!(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AccountsStore & { sessionWrites: number };
}
