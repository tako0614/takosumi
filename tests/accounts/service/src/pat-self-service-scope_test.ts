import { describe, expect, test } from "bun:test";

import {
  createAccountsHandler,
  InMemoryAccountsStore,
  requireAccountsBearer,
  type ControlPlaneOperations,
  type AccountsStore,
} from "../../../../accounts/service/src/mod.ts";
import { bearerAppAllows, bearerWorkspaceAllows, resolveBearerAppAccess } from "../../../../accounts/service/src/account-session.ts";
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

test("app-bound PATs are minted only for live accessible apps and preserve their fence", async () => {
  const store = seededStore();
  const accessible = new Set(["cap_one"]);
  const operations = {
    appAccess: {
      resolveAppAccess: async (subject: string, id: string) =>
        accessible.has(id) ? { capsuleId: id, role: "member", ownerAccountId: "tsub_owner", ownershipEpoch: 0 } : undefined,
    },
  } as unknown as ControlPlaneOperations;

  const denied = await handleCreatePersonalAccessToken({
    request: createRequest({ name: "Automation", scopes: ["read", "write"], appIds: ["cap_one", "cap_two"] }),
    store,
    operations,
  });
  expect(denied.status).toBe(403);
  expect(store.listPersonalAccessTokensForSubject(SUBJECT)).toHaveLength(0);

  accessible.add("cap_two");
  const created = await handleCreatePersonalAccessToken({
    request: createRequest({ name: "Automation", scopes: ["read", "write"], appIds: ["cap_one", "cap_two"] }),
    store,
    operations,
  });
  expect(created.status).toBe(201);
  const body = await created.json() as { token: string; token_record: { appIds: string[]; app_ids: string[] } };
  expect(body.token_record.appIds).toEqual(["cap_one", "cap_two"]);
  expect(body.token_record.app_ids).toEqual(["cap_one", "cap_two"]);
  const bearer = await requireAccountsBearer({
    request: new Request(`${ORIGIN}/api/v1/apps`, { headers: { authorization: `Bearer ${body.token}` } }),
    store,
    scope: "write",
  });
  expect(bearer.ok).toBe(true);
  if (bearer.ok) {
    expect(bearer.auth.appIds).toEqual(["cap_one", "cap_two"]);
    expect(bearerAppAllows(bearer.auth, "cap_one")).toBe(true);
    expect(bearerAppAllows(bearer.auth, "cap_other")).toBe(false);
    expect(await resolveBearerAppAccess({
      auth: bearer.auth, capsuleId: "cap_one", action: "change_settings", resolver: operations.appAccess,
    })).toMatchObject({ role: "member" });
    expect(await resolveBearerAppAccess({
      auth: bearer.auth, capsuleId: "cap_one", action: "manage_members", resolver: operations.appAccess,
    })).toBeUndefined();
    accessible.delete("cap_one");
    expect(await resolveBearerAppAccess({
      auth: bearer.auth, capsuleId: "cap_one", action: "change_settings", resolver: operations.appAccess,
    })).toBeUndefined();
    expect(await resolveBearerAppAccess({
      auth: { ...bearer.auth, workspaceId: "ws_old" }, capsuleId: "cap_two",
      action: "change_settings", resolver: operations.appAccess, capsuleWorkspaceId: "ws_other",
    })).toBeUndefined();
  }
  const malformed = await handleCreatePersonalAccessToken({
    request: createRequest({ name: "Malformed", scopes: ["read"], app_ids: ["cap_one", "cap_one"] }),
    store,
    operations,
  });
  expect(malformed.status).toBe(400);
  const conflicting = await handleCreatePersonalAccessToken({
    request: createRequest({ name: "Conflicting", scopes: ["read"], appIds: ["cap_one"], app_ids: ["cap_two"] }),
    store,
    operations,
  });
  expect(conflicting.status).toBe(400);
});

test("resources:read PAT creation is explicit and exact; a legacy Workspace binding still works", async () => {
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

test("workspace PAT creation uses the bounded membership reader without initializing Control", async () => {
  const store = seededStore();
  let controlInitializations = 0;
  const handler = createAccountsHandler({
    issuer: ORIGIN,
    store,
    resolveControlPlaneOperations: async () => {
      controlInitializations += 1;
      return await new Promise(() => undefined);
    },
    patWorkspaceMembershipReader: {
      getMember: async (workspaceId, subject) => ({
        workspaceId,
        accountId: subject,
        roles: ["owner"],
        status: "active",
      }),
    },
  });

  const response = await handler(
    createRequest({
      name: "Agent runtime",
      scopes: ["read", "write"],
      workspace_id: "ws_inventory",
    }),
  );

  expect(response.status).toBe(201);
  expect(controlInitializations).toBe(0);
  expect(store.listPersonalAccessTokensForSubject(SUBJECT)).toHaveLength(1);
});

test("Cloud AI PAT scopes are explicit, legacy-Workspace-bindable, and cataloged", async () => {
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
        workspaceBinding: "optional",
      }),
    );
  }
});

describe("hosted-resource and AI PATs without a Workspace (TASK-0118 9.1)", () => {
  const scopeSets = [["resources:read"], ["ai.models.read", "ai.chat", "ai.embeddings"]] as const;
  function appOperations(accessible: ReadonlySet<string>) {
    return {
      appAccess: {
        resolveAppAccess: async (_subject: string, id: string) =>
          accessible.has(id) ? { capsuleId: id, role: "member", ownerAccountId: "tsub_owner", ownershipEpoch: 0 } : undefined,
      },
      workspaces: {
        // A Workspace read here would mean the app path still consults Workspaces.
        getWorkspaceForAccount: async () => { throw new Error("Workspace authority must not be read"); },
      },
    } as unknown as ControlPlaneOperations;
  }
  for (const scopes of scopeSets) {
    test(`${scopes.join(" ")} can be limited to apps the caller owns or is a member of`, async () => {
      const store = seededStore();
      const handler = createAccountsHandler({
        issuer: ORIGIN, store, personalAccessTokenSelfServiceScopes: scopes,
        controlPlaneOperations: appOperations(new Set(["cap_mine"])),
      });
      const created = await handler(createRequest({ name: "App key", scopes, appIds: ["cap_mine"] }));
      expect(created.status).toBe(201);
      const body = await created.json() as { token: string; token_record: Record<string, unknown> };
      expect(body.token_record).toMatchObject({ scopes: [...scopes], appIds: ["cap_mine"] });
      expect(body.token_record.workspace_id ?? null).toBeNull();
      const bearer = await requireAccountsBearer({
        request: new Request(`${ORIGIN}/v1/cloud/resource-instances`, { headers: { authorization: `Bearer ${body.token}` } }),
        store,
        scope: scopes[0],
      });
      expect(bearer.ok).toBe(true);
      if (bearer.ok) {
        expect(bearer.auth.appIds).toEqual(["cap_mine"]);
        expect(bearer.auth.workspaceId).toBeUndefined();
        expect(bearerAppAllows(bearer.auth, "cap_other")).toBe(false);
      }

      const denied = await handler(createRequest({ name: "Not mine", scopes, appIds: ["cap_mine", "cap_other"] }));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { code: "app_access_denied" } });
      expect(store.listPersonalAccessTokensForSubject(SUBJECT)).toHaveLength(1);
    });

    test(`${scopes.join(" ")} can be issued at account scope`, async () => {
      const store = seededStore();
      const handler = createAccountsHandler({
        issuer: ORIGIN, store, personalAccessTokenSelfServiceScopes: scopes,
        controlPlaneOperations: appOperations(new Set()),
      });
      const created = await handler(createRequest({ name: "Account key", scopes }));
      expect(created.status).toBe(201);
      const body = await created.json() as { token: string; token_record: Record<string, unknown> };
      expect(body.token_record).toMatchObject({ scopes: [...scopes] });
      expect(body.token_record.workspace_id ?? null).toBeNull();
      expect(body.token_record).not.toHaveProperty("appIds");
      const bearer = await requireAccountsBearer({
        request: new Request(`${ORIGIN}/v1/cloud/resource-instances`, { headers: { authorization: `Bearer ${body.token}` } }),
        store,
        scope: scopes[0],
      });
      expect(bearer.ok).toBe(true);
      if (bearer.ok) {
        expect(bearer.auth.workspaceId).toBeUndefined();
        expect(bearer.auth.appIds).toBeUndefined();
      }
      // The scope never widens to the legacy account APIs.
      expect((await requireAccountsBearer({
        request: new Request(`${ORIGIN}/api/v1/apps`, { headers: { authorization: `Bearer ${body.token}` } }),
        store,
        scope: "read",
      })).ok).toBe(false);
    });
  }

  test("an extension scope is still not self-service unless the owning route declares it", async () => {
    const store = seededStore();
    const handler = createAccountsHandler({ issuer: ORIGIN, store, controlPlaneOperations: appOperations(new Set(["cap_mine"])) });
    const response = await handler(createRequest({ name: "Undeclared", scopes: ["resources:read"], appIds: ["cap_mine"] }));
    expect(response.status).toBe(403);
    expect(store.listPersonalAccessTokensForSubject(SUBJECT)).toHaveLength(0);
  });
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
          ja: "ホストリソースの一覧を読み取ります。アプリを指定すると、そのアプリに限ります。",
          en: "Read hosted-resource inventory; limited to the listed apps when appIds is set.",
        },
        selfService: true,
        workspaceBinding: "optional",
      },
      {
        scope: "ai.models.read",
        label: { ja: "AIモデルの読み取り", en: "AI model read" },
        description: {
          ja: "利用できる AI モデルを読み取ります。アプリを指定すると、そのアプリに限ります。",
          en: "Read available AI models; limited to the listed apps when appIds is set.",
        },
        selfService: false,
        workspaceBinding: "optional",
      },
      {
        scope: "ai.chat",
        label: { ja: "AIチャット", en: "AI chat" },
        description: {
          ja: "AI チャットを実行します。アプリを指定すると、そのアプリに限ります。",
          en: "Run AI chat; limited to the listed apps when appIds is set.",
        },
        selfService: false,
        workspaceBinding: "optional",
      },
      {
        scope: "ai.embeddings",
        label: { ja: "AI埋め込み", en: "AI embeddings" },
        description: {
          ja: "AI 埋め込みを生成します。アプリを指定すると、そのアプリに限ります。",
          en: "Generate AI embeddings; limited to the listed apps when appIds is set.",
        },
        selfService: false,
        workspaceBinding: "optional",
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
