import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { d1AccountResourceReader, sqlAccountResourceReader } from "../../../../core/domains/account-resources/read.ts";
import type { SqlClient } from "../../../../core/adapters/storage/sql.ts";
import { completeConnectionOAuth, handleConnections } from "../../../../accounts/service/src/control/connections.ts";
import { handleInstallPlans } from "../../../../accounts/service/src/control/install-plans.ts";
import { handleUsage } from "../../../../accounts/service/src/control/usage.ts";
import { personalResourceNamespace } from "../../../../accounts/service/src/control/personal-resources.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

test("D1 account resource reader filters physical owners and payers before paging", async () => {
  const db = new SqliteFakeD1();
  await db.exec(`
    create table connections (
      id text primary key, owner_account_id text, connection_json text not null, created_at text not null
    );
    create table usage_events (
      id text primary key, workspace_id text not null, capsule_id text, run_id text,
      payer_account_id text, meter_id text, resource_family text, resource_id text,
      operation text, resource_metadata_json text, kind text not null,
      quantity real not null, usd_micros integer not null, rating_status text not null,
      source text not null, idempotency_key text not null, created_at text not null
    );
  `);
  for (const [id, owner, when] of [
    ["conn_a1", "account_a", "2026-01-01T00:00:00.000Z"],
    ["conn_b", "account_b", "2026-01-02T00:00:00.000Z"],
    ["conn_a2", "account_a", "2026-01-03T00:00:00.000Z"],
  ] as const) {
    await db.prepare("insert into connections(id,owner_account_id,connection_json,created_at) values(?1,?2,?3,?4)")
      .bind(id, owner, JSON.stringify({ id, ownerAccountId: owner, scope: "personal", createdAt: when }), when).run();
  }
  for (const [id, payer, when] of [
    ["usage_a1", "account_a", "2026-01-01T00:00:00.000Z"],
    ["usage_b", "account_b", "2026-01-02T00:00:00.000Z"],
    ["usage_a2", "account_a", "2026-01-03T00:00:00.000Z"],
  ] as const) {
    await db.prepare(`insert into usage_events
      (id,workspace_id,payer_account_id,kind,quantity,usd_micros,rating_status,source,idempotency_key,created_at)
      values(?1,'ws',?2,'run',1,100,'rated','test',?1,?3)`)
      .bind(id, payer, when).run();
  }
  const reader = d1AccountResourceReader(db);
  const firstConnections = await reader.listConnections("account_a", { limit: 1 });
  expect(firstConnections.items.map((item) => item.id)).toEqual(["conn_a1"]);
  expect(firstConnections.nextCursor).toBeDefined();
  expect((await reader.listConnections("account_a", { limit: 1, cursor: firstConnections.nextCursor })).items.map((item) => item.id)).toEqual(["conn_a2"]);
  const firstUsage = await reader.listUsage("account_a", { limit: 1 });
  expect(firstUsage.items.map((item) => item.id)).toEqual(["usage_a1"]);
  expect(firstUsage.nextCursor).toBeDefined();
  expect((await reader.listUsage("account_a", { limit: 1, cursor: firstUsage.nextCursor })).items.map((item) => item.id)).toEqual(["usage_a2"]);

  await db.prepare("update connections set connection_json = ?1 where id = 'conn_a1'")
    .bind(JSON.stringify({ id: "conn_a1", ownerAccountId: "account_b", scope: "personal" })).run();
  expect((await reader.listConnections("account_a", {})).items[0]?.ownerAccountId).toBe("account_a");
  await db.prepare("update connections set owner_account_id = null where id = 'conn_a2'").run();
  expect((await reader.listConnections("account_a", {})).items.map((item) => item.id)).toEqual(["conn_a1", "conn_a2"]);
});

test("Postgres account resource reader preserves physical owner and payer filters", async () => {
  const db = new PGlite();
  await db.exec(`
    create table takosumi_connections (
      id text primary key, owner_account_id text, connection_json jsonb not null, created_at text not null
    );
    create table takosumi_usage_events (
      id text primary key, workspace_id text not null, capsule_id text, run_id text,
      payer_account_id text, meter_id text, resource_family text, resource_id text,
      operation text, resource_metadata_json jsonb, kind text not null,
      quantity double precision not null, usd_micros bigint not null, rating_status text not null,
      source text not null, idempotency_key text not null, created_at text not null
    );
    insert into takosumi_connections values
      ('conn_a','account_a','{"id":"conn_a","ownerAccountId":"account_a","scope":"personal","createdAt":"2026-01-01T00:00:00.000Z"}','2026-01-01T00:00:00.000Z'),
      ('conn_b','account_b','{"id":"conn_b","ownerAccountId":"account_b","scope":"personal","createdAt":"2026-01-02T00:00:00.000Z"}','2026-01-02T00:00:00.000Z');
    insert into takosumi_usage_events
      (id,workspace_id,payer_account_id,kind,quantity,usd_micros,rating_status,source,idempotency_key,created_at)
    values ('usage_a','ws','account_a','run',1,100,'rated','test','usage_a','2026-01-01T00:00:00.000Z'),
      ('usage_b','ws','account_b','run',1,200,'rated','test','usage_b','2026-01-02T00:00:00.000Z');
  `);
  const client = {
    query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
      const result = await db.query<Row>(sql, [...parameters]);
      return { rows: result.rows, rowCount: result.rows.length };
    },
  } as unknown as SqlClient;
  const reader = sqlAccountResourceReader(client);
  expect((await reader.listConnections("account_a", {})).items.map((item) => item.id)).toEqual(["conn_a"]);
  await db.exec(`update takosumi_connections set owner_account_id=null where id='conn_a'`);
  expect((await reader.listConnections("account_a", {})).items.map((item) => item.id)).toEqual(["conn_a"]);
  const usage = (await reader.listUsage("account_a", {})).items;
  expect(usage.map((item) => item.id)).toEqual(["usage_a"]);
  expect(usage[0]?.usdMicros).toBe(100);
  await db.close();
});

test("OAuth callback never mints from a Workspace named in the signed state (TASK-0118 P9.1-d)", async () => {
  // States no longer carry a Workspace. One that still does (started before
  // the change) is refused for everyone, the Workspace's admin and its owner.
  for (const subject of ["account_admin", "account_owner"]) {
    let minted = 0;
    const operations = {
      connectionOAuth: { helper: { complete: async () => ({
        request: { workspaceId: "ws_owner", scope: "workspace", ownerAccountId: subject },
        subject,
        expectedWorkspaceManagementAuthority: {
          workspaceId: "ws_owner", managementState: "active", managementEpoch: 1,
        },
      }) } },
      workspaces: { getWorkspace: async () => ({ id: "ws_owner", ownerUserId: "account_owner" }) },
      members: { getMember: async () => ({
        workspaceId: "ws_owner", accountId: "account_admin", roles: ["admin"], status: "active",
      }) },
      createConnection: async () => {
        minted++;
        return { connection: { id: "conn_admin" } };
      },
      testConnection: async () => ({ status: "verified" }),
    } as unknown as ControlPlaneOperations;
    const url = new URL("https://app.example.test/api/v1/connections/oauth/helper/callback?code=proof&state=signed");
    const store = new InMemoryAccountsStore();
    store.saveAccount({ subject: subject as never, createdAt: Date.now(), updatedAt: Date.now() });
    const response = await completeConnectionOAuth(operations, store, url, "helper");
    expect(response.status).toBe(303);
    expect(response.headers.get("location"), subject).toContain("connection_error=oauth_failed");
    expect(minted).toBe(0);
  }
});

test("appIds-scoped PAT cannot reach account connections, payer usage, or workspace-less install", async () => {
  let accountReads = 0;
  const operations = {
    accountResources: {
      listConnections: async () => { accountReads++; throw new Error("unexpected connections read"); },
      listUsage: async () => { accountReads++; throw new Error("unexpected usage read"); },
    },
    workspaces: { ensurePersonalWorkspace: async () => { accountReads++; throw new Error("unexpected workspace write"); } },
  } as unknown as ControlPlaneOperations;
  const store = new InMemoryAccountsStore();
  const ctx = (path: string, method: string, body?: unknown): ControlDispatchContext => {
    const request = new Request(`https://app.example.test/api/v1/${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { request, url: new URL(request.url), session: { subject: "account_a", appIds: ["cap_a"] }, operations, store } as ControlDispatchContext;
  };
  expect((await handleConnections(ctx("connections", "GET"), ["connections"], "GET"))?.status).toBe(403);
  expect((await handleConnections(ctx("connections", "POST", { provider: "aws" }), ["connections"], "POST"))?.status).toBe(403);
  expect((await handleUsage(ctx("usage", "GET"), ["usage"], "GET"))?.status).toBe(403);
  expect((await handleInstallPlans(ctx("install-plans", "POST", { mode: "attempt" }), ["install-plans"], "POST"))?.status).toBe(403);
  expect(accountReads).toBe(0);
});

test("legacy Workspace connection list shows only the caller's own connections; create needs the future owner", async () => {
  let connectionCalls = 0;
  const row = (id: string, ownerAccountId?: string) => ({
    id, workspaceId: "ws_owner", scope: "workspace", provider: "aws", status: "verified",
    ...(ownerAccountId ? { ownerAccountId } : {}), createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
  });
  const operations = {
    workspaces: {
      getWorkspace: async () => ({ id: "ws_owner", ownerUserId: "account_owner" }),
      captureManagementAuthority: async () => ({
        workspaceId: "ws_owner", managementState: "active", managementEpoch: 1,
      }),
    },
    members: { getMember: async () => ({
      workspaceId: "ws_owner", accountId: "account_admin", roles: ["admin"], status: "active",
    }) },
    // The owner's connection, a legacy row without an owner (the Workspace
    // owner's), and one the admin owns.
    listConnections: async () => ({ connections: [row("conn_owner", "account_owner"), row("conn_legacy"), row("conn_admin", "account_admin")] }),
    createConnection: async () => { connectionCalls++; throw new Error("unexpected mint"); },
  } as unknown as ControlPlaneOperations;
  const store = new InMemoryAccountsStore();
  const ctx = (path: string, method: string, body?: unknown): ControlDispatchContext => {
    const request = new Request(`https://app.example.test/api/v1/${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { request, url: new URL(request.url), session: { subject: "account_admin", requiredAccess: "write" }, operations, store } as ControlDispatchContext;
  };
  const listed = await handleConnections(ctx("connections?workspaceId=ws_owner", "GET"), ["connections"], "GET");
  expect(listed?.status).toBe(200);
  expect(((await listed!.json()).connections as { id: string }[]).map((connection) => connection.id)).toEqual(["conn_admin"]);
  // The Connection vault records the Workspace owner as a Workspace row's
  // owner, so nobody else may create one.
  const created = await handleConnections(ctx("connections", "POST", { workspaceId: "ws_owner" }), ["connections"], "POST");
  expect(created?.status).toBe(403);
  expect(connectionCalls).toBe(0);
});

test("internal personal namespace never adopts another account's Workspace", async () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({ subject: "tsub_account_a", createdAt: Date.now(), updatedAt: Date.now() });
  let ensured = 0;
  const operations = {
    workspaces: {
      listWorkspacesByOwner: async () => [],
      ensurePersonalWorkspace: async () => {
        ensured++;
        return { id: "ws_wrong", type: "personal", ownerUserId: "account_b" };
      },
    },
  } as unknown as ControlPlaneOperations;
  expect(await personalResourceNamespace(operations, store, {
    subject: "tsub_account_a", appIds: ["cap_a"],
  })).toBeUndefined();
  expect(ensured).toBe(0);
  expect(await personalResourceNamespace(operations, store, {
    subject: "tsub_account_a",
  })).toBeUndefined();
  expect(ensured).toBe(1);
});

test("installed-app OAuth bearer cannot use account resources or another app", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({ subject: "tsub_owner", displayName: "Owner", createdAt: now, updatedAt: now });
  store.saveAccessToken("takat_app_user", {
    clientId: "oidc_cap_allowed", scope: "openid capsules:read capsules:write",
    subject: "pairwise-app-user", takosumiSubject: "tsub_owner",
    capsuleId: "cap_allowed", expiresAt: now + 60_000,
  });
  let accountReads = 0;
  let victimReads = 0;
  const appOwnership = {
    resolveAppAccess: async (_subject: string, capsuleId: string) => {
      if (capsuleId === "cap_victim") victimReads++;
      return { capsuleId, role: "owner" as const, ownerAccountId: "tsub_owner", ownershipEpoch: 0 };
    },
    listMembers: async () => ({ ownerAccountId: "tsub_owner", ownershipEpoch: 0, members: [] }),
  };
  const operations = {
    appAccess: appOwnership,
    appAuthorization: appOwnership,
    accountResources: {
      listUsage: async () => { accountReads++; throw new Error("unexpected usage read"); },
      listConnections: async () => { accountReads++; throw new Error("unexpected connection read"); },
    },
  } as unknown as ControlPlaneOperations;
  const call = async (path: string) => {
    const url = new URL(`https://app.example.test/api/v1/${path}`);
    return await handleControlRoute({
      request: new Request(url, { headers: { authorization: "Bearer takat_app_user" } }),
      url, store, operations,
    });
  };
  expect((await call("capsules/cap_allowed/members"))?.status).toBe(403);
  expect((await call("capsules/cap_victim/members"))?.status).toBe(403);
  expect((await call("usage"))?.status).toBe(403);
  expect((await call("connections"))?.status).toBe(403);
  expect(victimReads).toBe(0);
  expect(accountReads).toBe(0);
});

test("app members page the owner's bindable connection labels through the D1 owner reader", async () => {
  const db = new SqliteFakeD1();
  await db.exec("create table connections (id text primary key, owner_account_id text, connection_json text not null, created_at text not null)");
  const rows = [
    ["conn_1", "owner", "verified", "2026-01-01T00:00:00.000Z"],
    ["conn_2", "owner", "pending", "2026-01-02T00:00:00.000Z"],
    ["conn_3", "stranger", "verified", "2026-01-03T00:00:00.000Z"],
    ["conn_4", "owner", "verified", "2026-01-04T00:00:00.000Z"],
    ["conn_5", "owner", "revoked", "2026-01-05T00:00:00.000Z"],
    ["conn_6", "owner", "verified", "2026-01-06T00:00:00.000Z"],
  ] as const;
  for (const [id, owner, status, when] of rows) {
    await db.prepare("insert into connections(id,owner_account_id,connection_json,created_at) values(?1,?2,?3,?4)").bind(id, owner, JSON.stringify({
      id, ownerAccountId: owner, scope: "personal", status, provider: "registry.example/cloud", displayName: `Cloud ${id}`,
      envNames: ["TOKEN"], scopeHints: { accountId: "private" }, createdAt: when, updatedAt: when,
    }), when).run();
  }
  const capsule = { id: "cap_shared", workspaceId: "ws_owner", environment: "production" };
  const operations = {
    appAccess: { resolveAppAccess: async (subject: string, capsuleId: string) =>
      subject === "member" && capsuleId === capsule.id ? { capsuleId, role: "member", ownerAccountId: "owner", ownershipEpoch: 1 } : undefined },
    capsules: { getCapsule: async () => capsule, getProviderBindingSetByCapsule: async () => undefined },
    accountResources: d1AccountResourceReader(db),
    connections: { listReleaseOwnedProviderConnections: async () => [] },
  } as unknown as ControlPlaneOperations;
  const read = async (subject: string, query: string) => {
    const request = new Request(`https://app.example.test/api/v1/connections?capsuleId=cap_shared&projection=labels${query}`);
    return await handleConnections({ request, url: new URL(request.url), operations, store: new InMemoryAccountsStore(), session: { subject, credential: "session" } }, ["connections"], "GET");
  };
  const seen: unknown[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const response = await read("member", `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(response?.status).toBe(200);
    const body = await response!.json() as { connections: unknown[]; nextCursor?: string };
    seen.push(...body.connections);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  expect(cursor).toBeUndefined();
  expect(seen).toEqual(["conn_1", "conn_4", "conn_6"].map((id) => ({ id, provider: "registry.example/cloud", displayName: `Cloud ${id}` })));
  expect((await read("stranger", ""))?.status).toBe(403);
});
