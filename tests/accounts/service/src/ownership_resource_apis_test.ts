import { expect, test } from "bun:test";
import { handleConnections, completeConnectionOAuth } from "../../../../accounts/service/src/control/connections.ts";
import { handleInstallPlans } from "../../../../accounts/service/src/control/install-plans.ts";
import { personalResourceNamespace } from "../../../../accounts/service/src/control/personal-resources.ts";
import { handleSourceRefResolutions } from "../../../../accounts/service/src/control/source-ref-resolutions.ts";
import type { ControlDispatchContext, ControlSession } from "../../../../accounts/service/src/control/shared.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import type { ProviderConnection } from "takosumi-contract/connections";
import { pageSorted, type PageParams } from "takosumi-contract/pagination";

const store = new InMemoryAccountsStore();
function context(path: string, operations: ControlPlaneOperations, subject = "member", method = "GET", body?: unknown): ControlDispatchContext {
  const request = new Request(`https://app.example.test/api/v1/${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { request, url: new URL(request.url), operations, store, session: { subject } };
}

function labelConnection(id: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return { id, ownerAccountId: "owner", scope: "personal", status: "verified", provider: "registry.example/cloud", providerSource: "registry.example/cloud", materialization: "provider", displayName: `Label ${id}`, credentialRecipe: { id: "recipe", authMode: "token", secretPartition: "secret", envNames: ["SECRET"] }, envNames: ["SECRET"], scopeHints: { accountId: "private" }, createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides };
}

function byKeyset(left: ProviderConnection, right: ProviderConnection): number {
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function operatorConnection(id: string, overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return labelConnection(id, { scope: "operator", ownerAccountId: undefined, credentialRecipe: {
    id: "operator-run", authMode: "capsule-run", runIssuance: { context: "capsule-run.v1", operatorConnection: "workspace-bindable", storedMaterial: "none", audience: "extension.example.v1", scopes: ["extension:invoke"] },
  }, ...overrides });
}

function connectionLabelFixture(boundIds: readonly string[], rows: readonly ProviderConnection[] = [], releaseOwned: readonly ProviderConnection[] = []) {
  const connectionReads: string[] = [];
  const ownerPages: { readonly accountId: string; readonly page: PageParams }[] = [];
  const releaseOwnedReads: (string | undefined)[] = [];
  const capsule = { id: "cap_ok", workspaceId: "ws_app", environment: "production" };
  let bindingSet: unknown = { ...capsule, id: "bindings_app", capsuleId: capsule.id, bindings: boundIds.map((connectionId) => ({ provider: "registry.example/cloud", connectionId })) };
  const operations = {
    appAccess: { resolveAppAccess: async (_subject: string, capsuleId: string) => capsuleId === "cap_ok" ? { capsuleId, role: "member", ownerAccountId: "owner", ownershipEpoch: 4 } : undefined },
    capsules: { getCapsule: async () => capsule, getProviderBindingSetByCapsule: async (capsuleId: string, environment: string) => { expect([capsuleId, environment]).toEqual([capsule.id, capsule.environment]); return bindingSet; } },
    // Mirrors the owner-keyed indexed reader: every status, only that account's rows.
    accountResources: { listConnections: async (accountId: string, page: PageParams) => {
      ownerPages.push({ accountId, page });
      return pageSorted(rows.filter((row) => row.scope !== "operator" && row.ownerAccountId === accountId).sort(byKeyset), page);
    } },
    listOperatorConnections: async () => { throw new Error("Must not scan every account's unscoped connection rows"); },
    workspaces: { listWorkspacesByOwner: async () => { throw new Error("Must not scan Workspaces when the owner index exists"); } },
    connections: {
      listReleaseOwnedProviderConnections: async (workspaceId?: string) => { releaseOwnedReads.push(workspaceId); return releaseOwned; },
      listProviderConnections: async () => { throw new Error("Must not list Workspace connections when the owner index exists"); },
      getProviderConnection: async (id: string) => {
        connectionReads.push(id);
        const connection = [...rows, ...releaseOwned].find((row) => row.id === id);
        if (!connection) throw new OpenTofuControllerError("not_found", "missing");
        return connection;
      },
    },
  } as unknown as ControlPlaneOperations;
  return { operations, connectionReads, ownerPages, releaseOwnedReads, setBindingSet: (value: unknown) => { bindingSet = value; } };
}

async function readLabels(operations: ControlPlaneOperations, query = "", session: ControlSession = { subject: "member", credential: "session" }) {
  const ctx = context(`connections?capsuleId=cap_ok&projection=labels${query}`, operations);
  const response = await handleConnections({ ...ctx, session }, ["connections"], "GET");
  return { response, body: await response?.json() as { connections: Record<string, unknown>[]; nextCursor?: string } };
}

test("member chooses among the connections the app can bind, as labels only", async () => {
  const { operations, connectionReads, ownerPages, releaseOwnedReads } = connectionLabelFixture(["conn_bound_operator", "conn_other", "conn_good", "conn_pending"], [
    labelConnection("conn_good"), labelConnection("conn_unbound"), labelConnection("conn_nameless", { displayName: undefined }),
    labelConnection("conn_legacy", { scope: "workspace", workspaceId: "ws_legacy" }),
    labelConnection("conn_pending", { status: "pending" }), labelConnection("conn_revoked", { status: "revoked" }),
    labelConnection("conn_git", { kind: "source_git_https_token" }),
    labelConnection("conn_other", { ownerAccountId: "other" }), labelConnection("conn_other_unbound", { ownerAccountId: "other" }),
    // Durable operator rows outside the release-owned set are refused by binding.
    operatorConnection("conn_bound_operator"),
  ], [operatorConnection("conn_operator"), labelConnection("conn_not_bindable", { scope: "operator", ownerAccountId: undefined })]);
  const { response, body } = await readLabels(operations);
  expect(response?.status).toBe(200);
  expect(body).toEqual({ connections: [
    { id: "conn_good", provider: "registry.example/cloud", displayName: "Label conn_good" },
    { id: "conn_legacy", provider: "registry.example/cloud", displayName: "Label conn_legacy" },
    { id: "conn_nameless", provider: "registry.example/cloud" },
    { id: "conn_operator", provider: "registry.example/cloud", displayName: "Label conn_operator" },
    // The current binding stays visible although not verified.
    { id: "conn_pending", provider: "registry.example/cloud", displayName: "Label conn_pending" },
    { id: "conn_unbound", provider: "registry.example/cloud", displayName: "Label conn_unbound" },
  ] });
  for (const row of body.connections) expect(Object.keys(row).every((key) => ["id", "provider", "displayName"].includes(key))).toBe(true);
  expect(JSON.stringify(body)).not.toMatch(/scope|ownerAccountId|status|createdAt|credentialRecipe|envNames|private|ws_legacy/u);
  // One bounded owner page; no other account's rows, Workspaces or durable operator scan.
  expect(ownerPages).toEqual([{ accountId: "owner", page: { limit: 100 } }]);
  expect(releaseOwnedReads).toEqual(["ws_app"]);
  expect(connectionReads).toEqual(["conn_bound_operator", "conn_other", "conn_good", "conn_pending"]);
  expect(response?.headers.get("cache-control")).toBe("no-store");
});

test("a member's personal access token, app-scoped or not, sees the same choices", async () => {
  const { operations } = connectionLabelFixture(["conn_good"], [labelConnection("conn_good"), labelConnection("conn_unbound")]);
  for (const session of [
    { subject: "member", credential: "personal-access-token" as const },
    { subject: "member", credential: "personal-access-token" as const, appIds: ["cap_ok"] },
  ]) {
    const { body } = await readLabels(operations, "", session);
    expect(body.connections.map((row) => row.id)).toEqual(["conn_good", "conn_unbound"]);
  }
});

test("an installed app's OAuth token sees only the app's current bindings", async () => {
  const { operations, ownerPages, releaseOwnedReads } = connectionLabelFixture(["conn_bound_operator", "conn_good", "conn_pending", "conn_other"], [
    labelConnection("conn_good"), labelConnection("conn_unbound"), labelConnection("conn_pending", { status: "pending" }),
    labelConnection("conn_other", { ownerAccountId: "other" }), operatorConnection("conn_bound_operator"),
  ], [operatorConnection("conn_operator")]);
  // An unknown credential kind fails closed to the same bound-only answer.
  for (const session of [{ subject: "member", credential: "oauth-access-token" as const, appIds: ["cap_ok"] }, { subject: "member" }]) {
    const { response, body } = await readLabels(operations, "", session);
    expect(response?.status).toBe(200);
    expect(body).toEqual({ connections: [
      { id: "conn_bound_operator", provider: "registry.example/cloud", displayName: "Label conn_bound_operator" },
      { id: "conn_good", provider: "registry.example/cloud", displayName: "Label conn_good" },
    ] });
    expect(response?.headers.get("cache-control")).toBe("no-store");
  }
  expect([ownerPages, releaseOwnedReads]).toEqual([[], []]);
});

test("non-members cannot read an app's connection labels", async () => {
  const { operations, connectionReads, ownerPages, releaseOwnedReads } = connectionLabelFixture(["conn_good"], [labelConnection("conn_good")]);
  const ctx = context("connections?capsuleId=cap_other&projection=labels", operations, "stranger");
  const response = await handleConnections({ ...ctx, session: { subject: "stranger", credential: "session" } }, ["connections"], "GET");
  expect(response?.status).toBe(403);
  expect(await response?.json()).toMatchObject({ error: { code: "app_access_denied" } });
  expect([connectionReads, ownerPages, releaseOwnedReads]).toEqual([[], [], []]);
});

test("connection labels page through the owner's connections one bounded page per request", async () => {
  const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const rows: ProviderConnection[] = [];
  for (let minute = 0; minute < 12; minute++) {
    // Every third owner row cannot be chosen and must be skipped, not counted.
    rows.push(labelConnection(`conn_${String(minute).padStart(2, "0")}`, { createdAt: at(minute), ...(minute % 3 === 2 ? { status: "pending" as const } : {}) }));
  }
  rows.push(labelConnection("conn_other", { ownerAccountId: "other", createdAt: at(5) }));
  const releaseOwned = [operatorConnection("conn_op_early", { createdAt: at(1) }), operatorConnection("conn_op_late", { createdAt: at(30) })];
  const { operations, ownerPages } = connectionLabelFixture([], rows, releaseOwned);
  const expected = [...rows.filter((row) => row.ownerAccountId === "owner" && row.status === "verified"), ...releaseOwned].sort(byKeyset).map((row) => row.id);
  const seen: string[] = [];
  let cursor: string | undefined;
  let requests = 0;
  do {
    const { response, body } = await readLabels(operations, `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(response?.status).toBe(200);
    expect(body.connections.length).toBeLessThanOrEqual(2);
    seen.push(...body.connections.map((row) => row.id as string));
    cursor = body.nextCursor;
    expect(++requests).toBeLessThan(20);
  } while (cursor);
  expect(seen).toEqual(expected);
  // The owner page size is fixed, whatever the client's limit.
  expect(ownerPages).toHaveLength(requests);
  expect(ownerPages.every((call) => call.accountId === "owner" && call.page.limit === 100)).toBe(true);
});

test("connection labels read at most one owner page per request", async () => {
  const rows = Array.from({ length: 250 }, (_, index) => labelConnection(`conn_${String(index).padStart(3, "0")}`));
  const { operations, ownerPages } = connectionLabelFixture([], rows);
  const { body } = await readLabels(operations, "&limit=1");
  expect(body.connections).toHaveLength(1);
  expect(typeof body.nextCursor).toBe("string");
  expect(ownerPages).toEqual([{ accountId: "owner", page: { limit: 100 } }]);
});

test("a page of only unchoosable owner rows still advances the cursor", async () => {
  const rows = [
    ...Array.from({ length: 100 }, (_, index) => labelConnection(`conn_a${String(index).padStart(3, "0")}`, { status: index % 2 ? "revoked" as const : "pending" as const })),
    labelConnection("conn_b"),
  ];
  const { operations } = connectionLabelFixture([], rows);
  const first = await readLabels(operations, "&limit=2");
  expect(first.body.connections).toEqual([]);
  expect(typeof first.body.nextCursor).toBe("string");
  const second = await readLabels(operations, `&limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
  expect(second.body).toEqual({ connections: [{ id: "conn_b", provider: "registry.example/cloud", displayName: "Label conn_b" }] });
});

test("Connection labels fail closed if app ownership changes during the read", async () => {
  let reads = 0;
  const { operations } = connectionLabelFixture(["conn_good"], [labelConnection("conn_good")]);
  operations.appAccess!.resolveAppAccess = async () => ({ capsuleId: "cap_ok", role: "member", ownerAccountId: ++reads === 1 ? "owner" : "new_owner", ownershipEpoch: reads });
  const { response } = await readLabels(operations);
  expect(response?.status).toBe(403);
  expect(reads).toBe(2);
});

test("Connection labels list owner choices without an app binding set", async () => {
  const { operations, connectionReads, setBindingSet } = connectionLabelFixture([], [labelConnection("conn_good")]);
  setBindingSet(undefined);
  const { response, body } = await readLabels(operations);
  expect(response?.status).toBe(200);
  expect(body).toEqual({ connections: [{ id: "conn_good", provider: "registry.example/cloud", displayName: "Label conn_good" }] });
  expect(connectionReads).toEqual([]);
});

test("Connection labels retain bearer and Workspace attenuation", async () => {
  const { operations, connectionReads, ownerPages } = connectionLabelFixture(["conn_good"], [labelConnection("conn_good")]);
  for (const session of [
    { subject: "member", credential: "personal-access-token" as const, appIds: ["cap_other"] },
    { subject: "member", credential: "personal-access-token" as const, workspaceId: "ws_other" },
  ]) {
    expect((await readLabels(operations, "", session)).response?.status).toBe(403);
  }
  expect([connectionReads, ownerPages]).toEqual([[], []]);
  expect((await readLabels(operations, "", { subject: "member", credential: "personal-access-token", reauthorizeBearer: async () => false })).response?.status).toBe(403);
  expect(connectionReads).toEqual(["conn_good"]);
  expect(ownerPages).toHaveLength(1);
});

test("Connection labels refuse a binding set for another app before reading connections", async () => {
  const { operations, connectionReads, ownerPages, setBindingSet } = connectionLabelFixture([]);
  setBindingSet({ id: "bindings_other", capsuleId: "cap_other", workspaceId: "ws_app", environment: "production", bindings: [{ connectionId: "conn_private" }] });
  const { response } = await readLabels(operations);
  expect(response?.status).toBe(503);
  expect([connectionReads, ownerPages]).toEqual([[], []]);
});

test("Connection labels reject a point lookup returning a different connection identity", async () => {
  const { operations } = connectionLabelFixture(["conn_bound"]);
  operations.connections.getProviderConnection = async () => labelConnection("conn_unbound");
  const { response } = await readLabels(operations);
  expect(response?.status).toBe(503);
});

test("Connection labels retain the exact point lookup on the legacy connection facade", async () => {
  const fixture = connectionLabelFixture(["conn_bound"]);
  const reads: string[] = [];
  const operations = { ...fixture.operations,
    connections: { ...fixture.operations.connections, getProviderConnection: undefined },
    getConnection: async (id: string) => { reads.push(id); return labelConnection(id); },
  } as unknown as ControlPlaneOperations;
  const { response, body } = await readLabels(operations);
  expect(response?.status).toBe(200);
  expect(body).toEqual({ connections: [{ id: "conn_bound", provider: "registry.example/cloud", displayName: "Label conn_bound" }] });
  expect(reads).toEqual(["conn_bound"]);
});

test("Connection labels are unavailable before the owner column exists", async () => {
  const { operations } = connectionLabelFixture([]);
  (operations as { accountResources: unknown }).accountResources = { listConnections: async () => { throw new Error("D1_ERROR: no such column: owner_account_id"); } };
  const { response } = await readLabels(operations);
  expect(response?.status).toBe(503);
});

function readerlessOperations(fixture: ReturnType<typeof connectionLabelFixture>, owned?: readonly ProviderConnection[]) {
  const listed: string[] = [];
  const operations = { ...fixture.operations,
    accountResources: undefined,
    listOperatorConnections: async () => ({ connections: [] }),
    workspaces: { listWorkspacesByOwner: async (owner: string) => {
      expect(["owner", "member"]).toContain(owner);
      return [{ id: "ws_owner", ownerUserId: owner }, { id: "ws_archived", ownerUserId: owner, archivedAt: "2026-01-02" }, { id: "ws_foreign", ownerUserId: "other" }];
    } },
    connections: { ...fixture.operations.connections,
      listProviderConnections: async (workspaceId: string) => {
        listed.push(workspaceId);
        return [labelConnection("conn_ws", { scope: "workspace", workspaceId }), labelConnection("conn_ws_other", { scope: "workspace", workspaceId, ownerAccountId: "other" }),
          labelConnection("conn_misplaced", { scope: "workspace", workspaceId: "ws_elsewhere" })];
      },
      ...(owned ? { listOwnedConnections: async (owner: string) => owned.filter((row) => row.ownerAccountId === owner) } : {}),
    },
  } as unknown as ControlPlaneOperations;
  return { operations, listed };
}

test("Connection labels without an account reader read only the owner's Workspaces", async () => {
  const { operations, listed } = readerlessOperations(connectionLabelFixture([]));
  const { response, body } = await readLabels(operations);
  expect(response?.status).toBe(200);
  expect(body).toEqual({ connections: [{ id: "conn_ws", provider: "registry.example/cloud", displayName: "Label conn_ws" }] });
  expect(listed).toEqual(["ws_owner"]);
});

test("Connection labels without an account reader include the owner's personal connections", async () => {
  const { operations } = readerlessOperations(connectionLabelFixture([]), [
    labelConnection("conn_personal"), labelConnection("conn_personal_pending", { status: "pending" }),
    labelConnection("conn_personal_other", { ownerAccountId: "other" }),
  ]);
  const { body } = await readLabels(operations);
  expect(body.connections.map((row) => row.id)).toEqual(["conn_personal", "conn_ws"]);
});

test("the account's own connection list without an account reader includes personal connections", async () => {
  const { operations } = readerlessOperations(connectionLabelFixture([]), [
    labelConnection("conn_mine", { ownerAccountId: "member" }), labelConnection("conn_theirs", { ownerAccountId: "other" }),
  ]);
  const response = await handleConnections({ ...context("connections", operations), session: { subject: "member", credential: "session" } }, ["connections"], "GET");
  expect(response?.status).toBe(200);
  expect(((await response!.json()) as { connections: { id: string }[] }).connections.map((row) => row.id).sort()).toEqual(["conn_mine"]);
});

test("personal OAuth start and callback bind the signed owner without Workspace authority", async () => {
  store.saveAccount({ subject: "owner" as never, createdAt: Date.now(), updatedAt: Date.now() });
  let started: unknown;
  let minted: unknown;
  const operations = {
    connectionOAuth: { helper: {
      start: async (input: unknown) => { started = input; return { authorizationUrl: "https://provider.test/auth", state: "signed" }; },
      complete: async () => ({ subject: "owner", request: { scope: "personal", ownerAccountId: "owner", provider: "registry.example/cloud", values: { TOKEN: "secret" } } }),
    } },
    createConnection: async (request: unknown, authority: unknown, actor: unknown) => { minted = { request, authority, actor }; return { connection: { id: "conn_personal" } }; },
    testConnection: async () => ({ status: "verified" }),
  } as unknown as ControlPlaneOperations;
  const ctx = context("connections/oauth/helper/start", operations, "owner", "POST", {});
  expect((await handleConnections(ctx, ["connections", "oauth", "helper", "start"], "POST"))?.status).toBe(200);
  expect(started).toMatchObject({ subject: "owner", scope: "personal", ownerAccountId: "owner" });
  expect((started as Record<string, unknown>).workspaceId).toBeUndefined();
  const callback = await completeConnectionOAuth(operations, store, new URL("https://app.example.test/api/v1/connections/oauth/helper/callback?state=signed&code=code"), "helper");
  expect(callback.status).toBe(303);
  expect(minted).toMatchObject({ request: { scope: "personal", ownerAccountId: "owner" }, actor: "owner" });
  expect((minted as Record<string, unknown>).authority).toBeUndefined();
});

test("workspace-less source ref GET requires account scope and delegates resolution", async () => {
  let resolved: string | undefined;
  const operations = { resolveStableSourceTag: async (url: string) => { resolved = url; return { tag: "v1.2.3" }; } } as unknown as ControlPlaneOperations;
  const ctx = context("source-ref-resolutions?url=https%3A%2F%2Fgit.example%2Fa.git", operations);
  expect(await (await handleSourceRefResolutions(ctx, ["source-ref-resolutions"], "GET"))?.json()).toEqual({ tag: "v1.2.3" });
  expect(resolved).toBe("https://git.example/a.git");
  expect((await handleSourceRefResolutions({ ...ctx, session: { subject: "member", appIds: ["cap_1"] } }, ["source-ref-resolutions"], "GET"))?.status).toBe(403);
});

test("workspace-less install uses only canonical personal bootstrap during the freeze", async () => {
  let creates = 0;
  const personal = { id: "ws_bootstrap", type: "personal", ownerUserId: "owner", createdAt: "2026-01-01" };
  const operations = { workspaces: {
    listWorkspacesByOwner: async () => [],
    ensurePersonalWorkspace: async (subject: string) => { expect(subject).toBe("owner"); creates++; return personal; },
    createWorkspace: async () => { throw new Error("General Workspace creation stays frozen"); },
  } } as unknown as ControlPlaneOperations;
  const ctx = context("install-plans", operations, "owner", "POST", { mode: "attempt" });
  const response = await handleInstallPlans({ ...ctx, workspaceMutationsFrozen: true }, ["install-plans"], "POST");
  expect(response?.status).toBe(400);
  expect(await response?.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
  expect(creates).toBe(1);
});

test("read-only namespace lookup still reuses an existing owner-owned personal Workspace", async () => {
  let creates = 0;
  const existing = { id: "ws_existing", type: "personal", ownerUserId: "owner", createdAt: "2026-01-01" };
  const operations = { workspaces: { listWorkspacesByOwner: async () => [existing], ensurePersonalWorkspace: async () => { creates++; return {}; } } } as unknown as ControlPlaneOperations;
  expect(await personalResourceNamespace(operations, store, { subject: "owner" }, false)).toEqual(existing);
  expect(creates).toBe(0);
});
