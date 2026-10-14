import { expect, test } from "bun:test";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "../../../../accounts/service/src/control-route-inventory.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const NOW = Date.now();

async function service() {
  const ledger = new InMemoryOpenTofuControlStore();
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const operations = { ...core } as unknown as ControlPlaneOperations;
  return { ledger, operations };
}

function accountsWithSession(subject: string, token: string): InMemoryAccountsStore {
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({ subject, createdAt: NOW, updatedAt: NOW });
  accounts.saveAccountSession({
    sessionId: token,
    subject,
    createdAt: NOW,
    expiresAt: NOW + 60_000,
  });
  return accounts;
}

async function request(
  operations: ControlPlaneOperations,
  accounts: InMemoryAccountsStore,
  method: string,
  path: string,
  token: string,
): Promise<Response> {
  const url = new URL(`https://app.example.test${path}`);
  const response = await handleControlRoute({
    request: new Request(url, {
      method,
      headers: { authorization: `Bearer ${token}` },
    }),
    url,
    store: accounts,
    operations,
  });
  expect(response).toBeDefined();
  return response!;
}

async function memberSession(
  ledger: InMemoryOpenTofuControlStore,
  workspaceId: string,
  accountId: string,
  roles: readonly ["admin" | "member"],
): Promise<{ accounts: InMemoryAccountsStore; token: string }> {
  const nowIso = new Date(NOW).toISOString();
  await ledger.putWorkspaceMember({
    id: `wsm_${accountId}`,
    workspaceId,
    accountId,
    roles: [...roles],
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const token = `session_${accountId}`;
  return { accounts: accountsWithSession(accountId, token), token };
}

test("Source DELETE removes an unreferenced Source, invalidates the webhook, and records one value-free activity", async () => {
  const { ledger, operations } = await service();
  const accounts = accountsWithSession("user_test", "owner455-session");
  await ledger.putWorkspace({
    id: "ws_del455",
    handle: "ws-del455",
    displayName: "Del455",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const created = await operations.createSource({
    workspaceId: "ws_del455",
    name: "fixture source",
    url: "https://github.com/example/del455.git",
  });
  const sourceId = created.source.id;
  const hookSecret = (created as { hookSecret: string }).hookSecret;
  expect(hookSecret).toMatch(/^whk_/u);

  const response = await request(operations, accounts, "DELETE", `/api/v1/sources/${sourceId}`, "owner455-session");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.deleted).toBe(true);
  expect(body.source.id).toBe(sourceId);
  expect(JSON.stringify(body)).not.toContain("hookSecret");

  const get = await request(operations, accounts, "GET", `/api/v1/sources/${sourceId}`, "owner455-session");
  expect(get.status).toBe(404);

  const again = await request(operations, accounts, "DELETE", `/api/v1/sources/${sourceId}`, "owner455-session");
  expect(again.status).toBe(404);

  expect(await operations.verifySourceHookSecret(sourceId, hookSecret)).toBe(false);

  const events = await ledger.listActivityEvents("ws_del455");
  const deleted = events.filter((event) => event.action === "source.deleted");
  expect(deleted).toHaveLength(1);
  expect(deleted[0]).toMatchObject({
    workspaceId: "ws_del455",
    actorId: "user_test",
    targetType: "source",
    targetId: sourceId,
    metadata: {},
  });
  expect(JSON.stringify(events)).not.toContain(hookSecret);
});

test("Source DELETE authorizes owner and admin, rejects member/stranger/read PAT with no state change", async () => {
  const { ledger, operations } = await service();
  await ledger.putWorkspace({
    id: "ws_del455_auth",
    handle: "ws-del455-auth",
    displayName: "Del455 Auth",
    type: "organization",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const ownerAccounts = accountsWithSession("user_test", "owner455-auth");
  const { accounts: adminAccounts, token: adminToken } = await memberSession(ledger, "ws_del455_auth", "admin455", ["admin"]);
  const { accounts: memberAccounts, token: memberToken } = await memberSession(ledger, "ws_del455_auth", "member455", ["member"]);
  const strangerAccounts = accountsWithSession("stranger455", "stranger455-session");

  const authCases: ReadonlyArray<
    readonly [
      string,
      InMemoryAccountsStore,
      string,
      200 | 403,
    ]
  > = [
    ["admin", adminAccounts, adminToken, 200],
    ["member", memberAccounts, memberToken, 403],
    ["stranger", strangerAccounts, "stranger455-session", 403],
  ];
  for (const [label, authAccounts, token, status] of authCases) {
    const created = await operations.createSource({
      workspaceId: "ws_del455_auth",
      name: `auth source ${label}`,
      url: "https://github.com/example/del455.git",
    });
    const response = await request(operations, authAccounts, "DELETE", `/api/v1/sources/${created.source.id}`, token);
    expect(response.status, label).toBe(status);
    if (status === 200) {
      expect((await response.json()).deleted).toBe(true);
    } else {
      const stillThere = await request(operations, ownerAccounts, "GET", `/api/v1/sources/${created.source.id}`, "owner455-auth");
      expect(stillThere.status, label).toBe(200);
    }
  }

  const readAccounts = accountsWithSession("user_test", "read455-unused");
  readAccounts.savePersonalAccessToken("pat_read455", {
    tokenId: "pat_read455",
    tokenPrefix: "display",
    subject: "user_test",
    name: "read only",
    scopes: ["read"],
    createdAt: NOW,
  });
  const created = await operations.createSource({
    workspaceId: "ws_del455_auth",
    name: "read pat source",
    url: "https://github.com/example/del455.git",
  });
  const readResponse = await request(operations, readAccounts, "DELETE", `/api/v1/sources/${created.source.id}`, "pat_read455");
  expect(readResponse.status).toBe(403);
});

test("Source DELETE refuses a Capsule-tracked Source with 409 and a reason", async () => {
  const { ledger, operations } = await service();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: "ws_del455_capsule",
    capsuleId: "cap_del455",
    sourceId: "src_del455",
  });
  await ledger.putWorkspaceMember({
    id: "wsm_owner_del455_capsule",
    workspaceId: seeded.workspace.id,
    accountId: seeded.workspace.ownerUserId,
    roles: ["owner"],
    status: "active",
    createdAt: seeded.workspace.createdAt,
    updatedAt: seeded.workspace.updatedAt,
  });
  const accounts = accountsWithSession(seeded.workspace.ownerUserId, "owner455-capsule");
  const response = await request(operations, accounts, "DELETE", `/api/v1/sources/${seeded.source.id}`, "owner455-capsule");
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.error.details.reason).toBe("source_referenced_by_capsule");
  const get = await request(operations, accounts, "GET", `/api/v1/sources/${seeded.source.id}`, "owner455-capsule");
  expect(get.status).toBe(200);
  expect(await ledger.listActivityEvents(seeded.workspace.id)).toHaveLength(0);
});

test("Source DELETE refuses while a source_sync Run is in flight", async () => {
  const { ledger, operations } = await service();
  await ledger.putWorkspace({
    id: "ws_del455_run",
    handle: "ws-del455-run",
    displayName: "Del455 Run",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const created = await operations.createSource({
    workspaceId: "ws_del455_run",
    name: "syncing source",
    url: "https://github.com/example/del455.git",
  });
  // The dev composition drives a created sync to terminal immediately, so
  // fixture the queued row directly: only queued/running Runs must block.
  const nowIso = new Date(NOW).toISOString();
  await ledger.putSourceSyncRun({
    id: "ssr_del455_inflight",
    kind: "source_sync",
    workspaceId: "ws_del455_run",
    sourceId: created.source.id,
    url: "https://github.com/example/del455.git",
    ref: "HEAD",
    path: ".",
    archiveRef: "workspaces/ws_del455_run/sources/ssr_del455_inflight/source.tar.zst",
    intent: "observe",
    status: "queued",
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const accounts = accountsWithSession("user_test", "owner455-run");
  const response = await request(operations, accounts, "DELETE", `/api/v1/sources/${created.source.id}`, "owner455-run");
  expect(response.status).toBe(409);
  expect((await response.json()).error.details.reason).toBe("source_has_in_flight_run");
});

test("Workspace DELETE removes an empty Workspace as owner; second delete is 404", async () => {
  const { ledger, operations } = await service();
  await ledger.putWorkspace({
    id: "ws_del455_empty",
    handle: "ws-del455-empty",
    displayName: "Del455 Empty",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const accounts = accountsWithSession("user_test", "owner455-empty");
  const response = await request(operations, accounts, "DELETE", "/api/v1/workspaces/ws_del455_empty", "owner455-empty");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ deleted: true, workspace: { id: "ws_del455_empty" } });

  const get = await request(operations, accounts, "GET", "/api/v1/workspaces/ws_del455_empty", "owner455-empty");
  expect(get.status).toBe(404);

  const again = await request(operations, accounts, "DELETE", "/api/v1/workspaces/ws_del455_empty", "owner455-empty");
  expect(again.status).toBe(404);
});

test("Workspace DELETE is owner-only and refuses non-empty Workspaces with reasons", async () => {
  const { ledger, operations } = await service();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: "ws_del455_full",
    capsuleId: "cap_del455_full",
    sourceId: "src_del455_full",
  });
  const ownerAccounts = accountsWithSession(seeded.workspace.ownerUserId, "owner455-full");
  const { accounts: adminAccounts, token: adminToken } = await memberSession(ledger, seeded.workspace.id, "admin455full", ["admin"]);

  const adminDelete = await request(operations, adminAccounts, "DELETE", `/api/v1/workspaces/${seeded.workspace.id}`, adminToken);
  expect(adminDelete.status).toBe(403);

  const ownerDelete = await request(operations, ownerAccounts, "DELETE", `/api/v1/workspaces/${seeded.workspace.id}`, "owner455-full");
  expect(ownerDelete.status).toBe(409);
  const body = await ownerDelete.json();
  expect(body.error.details.reason).toBe("workspace_not_empty");
  expect(body.error.details.blockers).toEqual(expect.arrayContaining(["capsule_exists", "source_exists"]));

  const stillThere = await request(operations, ownerAccounts, "GET", `/api/v1/workspaces/${seeded.workspace.id}`, "owner455-full");
  expect(stillThere.status).toBe(200);
});

test("Workspace DELETE refuses while a Run is in flight or usage evidence exists", async () => {
  const { ledger, operations } = await service();
  await ledger.putWorkspace({
    id: "ws_del455_busy",
    handle: "ws-del455-busy",
    displayName: "Del455 Busy",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const created = await operations.createSource({
    workspaceId: "ws_del455_busy",
    name: "busy source",
    url: "https://github.com/example/del455.git",
  });
  const busyIso = new Date(NOW).toISOString();
  await ledger.putSourceSyncRun({
    id: "ssr_del455_busy",
    kind: "source_sync",
    workspaceId: "ws_del455_busy",
    sourceId: created.source.id,
    url: "https://github.com/example/del455.git",
    ref: "HEAD",
    path: ".",
    archiveRef: "workspaces/ws_del455_busy/sources/ssr_del455_busy/source.tar.zst",
    intent: "observe",
    status: "running",
    createdAt: busyIso,
    updatedAt: busyIso,
    startedAt: busyIso,
  });
  const accounts = accountsWithSession("user_test", "owner455-busy");
  const busy = await request(operations, accounts, "DELETE", "/api/v1/workspaces/ws_del455_busy", "owner455-busy");
  expect(busy.status).toBe(409);
  expect((await busy.json()).error.details.blockers).toEqual(
    expect.arrayContaining(["source_exists", "run_in_flight"]),
  );

  await ledger.putWorkspace({
    id: "ws_del455_usage",
    handle: "ws-del455-usage",
    displayName: "Del455 Usage",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  await ledger.putUsageEvent({
    id: "usage_del455",
    workspaceId: "ws_del455_usage",
    kind: "opentofu.apply",
    quantity: 1,
    usdMicros: 0,
    ratingStatus: "unrated",
    source: "runner",
    idempotencyKey: "usage_del455:opentofu.apply",
    createdAt: new Date(NOW).toISOString(),
  });
  const usageDelete = await request(operations, accounts, "DELETE", "/api/v1/workspaces/ws_del455_usage", "owner455-busy");
  expect(usageDelete.status).toBe(409);
  expect((await usageDelete.json()).error.details.blockers).toEqual(
    expect.arrayContaining(["usage_exists"]),
  );
});

test("Workspace DELETE refuses a retained backup with backup_exists", async () => {
  const { ledger, operations } = await service();
  await ledger.putWorkspace({
    id: "ws_del455_backup",
    handle: "ws-del455-backup",
    displayName: "Del455 Backup",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  await ledger.putBackupRecord({
    id: "bkp_del455",
    workspaceId: "ws_del455_backup",
    ref: "workspaces/ws_del455_backup/backups/bkp_del455/control.json.zst.enc",
    digest: "sha256:abc",
    sizeBytes: 10,
    createdAt: new Date(NOW).toISOString(),
  });
  const accounts = accountsWithSession("user_test", "owner455-backup");
  const response = await request(operations, accounts, "DELETE", "/api/v1/workspaces/ws_del455_backup", "owner455-backup");
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.error.details.reason).toBe("workspace_not_empty");
  expect(body.error.details.blockers).toEqual(expect.arrayContaining(["backup_exists"]));
  const get = await request(operations, accounts, "GET", "/api/v1/workspaces/ws_del455_backup", "owner455-backup");
  expect(get.status).toBe(200);
});

test("Workspace DELETE removes member rows", async () => {
  const { ledger, operations } = await service();
  await ledger.putWorkspace({
    id: "ws_del455_members",
    handle: "ws-del455-members",
    displayName: "Del455 Members",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const nowIso = new Date(NOW).toISOString();
  await ledger.putWorkspaceMember({
    id: "wsm_del455_member",
    workspaceId: "ws_del455_members",
    accountId: "member_pii",
    roles: ["member"],
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const accounts = accountsWithSession("user_test", "owner455-members");
  const response = await request(operations, accounts, "DELETE", "/api/v1/workspaces/ws_del455_members", "owner455-members");
  expect(response.status).toBe(200);
  expect(await ledger.listWorkspaceMembers("ws_del455_members")).toHaveLength(0);
  expect(await ledger.getWorkspaceMember("ws_del455_members", "member_pii")).toBeUndefined();
});

test("Source and Workspace item routes advertise DELETE and the inventory publishes both", async () => {
  const { ledger, operations } = await service();
  const accounts = accountsWithSession("user_test", "owner455-allow");
  await ledger.putWorkspace({
    id: "ws_del455_allow",
    handle: "ws-del455-allow",
    displayName: "Del455 Allow",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const created = await operations.createSource({
    workspaceId: "ws_del455_allow",
    name: "allow source",
    url: "https://github.com/example/del455.git",
  });
  const sourcePut = await request(operations, accounts, "PUT", `/api/v1/sources/${created.source.id}`, "owner455-allow");
  expect(sourcePut.status).toBe(405);
  expect(sourcePut.headers.get("allow")).toContain("DELETE");
  const workspacePost = await request(operations, accounts, "POST", "/api/v1/workspaces/ws_del455_allow", "owner455-allow");
  expect(workspacePost.status).toBe(405);
  expect(workspacePost.headers.get("allow")).toContain("DELETE");

  const deletions = PUBLIC_SESSION_CONTROL_ENDPOINTS.filter((endpoint) => endpoint.method === "DELETE").map(
    (endpoint) => endpoint.path,
  );
  expect(deletions).toContain("/api/v1/sources/{sourceId}");
  expect(deletions).toContain("/api/v1/workspaces/{workspaceId}");
});
