import { expect, test } from "bun:test";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import {
  createSharedAccountWorkspaceDirectory,
  handleSharedAccountWorkspaceRoute,
  SHARED_ACCOUNT_WORKSPACES_PATH,
  type SharedHostedSessionContext,
  type SharedWorkspaceBillingResolver,
} from "../../../../accounts/service/src/shared-account-workspace.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";

const subject: TakosumiSubject = "tsub_shared";
const other: TakosumiSubject = "tsub_other";
const session = { subject };

function fixture(resolveWorkspaceBilling?: SharedWorkspaceBillingResolver, workspaceMutationsFrozen?: boolean) {
  const store = new InMemoryAccountsStore();
  store.saveAccount({ subject, email: "shared@example.test", displayName: "Shared", createdAt: 1, updatedAt: 1 });
  store.saveAccount({ subject: other, createdAt: 1, updatedAt: 1 });
  const control = new InMemoryOpenTofuControlStore();
  let id = 0;
  const service = new WorkspacesService({ store: control, newId: (prefix) => `${prefix}_shared_${++id}` });
  const operations: Pick<ControlPlaneOperations, "workspaces" | "members"> = {
    workspaces: {
      ensurePersonalWorkspace: service.ensurePersonalWorkspace.bind(service),
      ensurePersonalWorkspaceForSharedAccount: service.ensurePersonalWorkspaceForSharedAccount.bind(service),
      listWorkspaces: service.listWorkspaces.bind(service),
      listWorkspacesByOwner: service.listWorkspacesByOwner.bind(service),
      listWorkspacesForAccount: service.listWorkspacesForAccount.bind(service),
      listWorkspacesForAccountPage: service.listWorkspacesForAccountPage.bind(service),
      getWorkspaceForAccount: service.getWorkspaceForAccount.bind(service),
      getWorkspace: service.getWorkspace.bind(service),
      captureManagementAuthority: service.captureManagementAuthority.bind(service),
      createWorkspace: service.createWorkspace.bind(service),
      createWorkspaceForSharedAccount: service.createWorkspaceForSharedAccount.bind(service),
      updateWorkspace: service.updateWorkspace.bind(service),
      updateWorkspaceForAccount: service.updateWorkspaceForAccount.bind(service),
      deleteWorkspaceForAccount: service.deleteWorkspaceForAccount.bind(service),
    },
    members: {
      getMember: control.getWorkspaceMember.bind(control),
      listMembers: control.listWorkspaceMembers.bind(control),
      upsertMember: async () => { throw new Error("Directory cannot reconcile membership."); },
    },
  };
  return { store, control, service, operations, directory: createSharedAccountWorkspaceDirectory({ store, operations, resolveWorkspaceBilling,
    ...(workspaceMutationsFrozen === undefined ? {} : { workspaceMutationsFrozen }) }) };
}

async function member(f: ReturnType<typeof fixture>, workspace: Workspace, patch: Partial<WorkspaceMember> = {}) {
  const row = await f.control.getWorkspaceMember(workspace.id, workspace.ownerUserId);
  await f.control.putWorkspaceMember({ ...row!, ...patch });
}

test("first Google/GitHub/Takoserver/Hosted logins share one durable personal Workspace across service instances", async () => {
  const f = fixture();
  let id = 0;
  const replica = new WorkspacesService({ store: f.control, newId: (prefix) => `${prefix}_replica_${++id}` });
  const otherDirectory = createSharedAccountWorkspaceDirectory({
    store: f.store,
    operations: { ...f.operations, workspaces: { ...f.operations.workspaces, ensurePersonalWorkspaceForSharedAccount: replica.ensurePersonalWorkspaceForSharedAccount.bind(replica) } },
  });
  const result = await Promise.all([
    f.directory.bootstrap(session), otherDirectory.bootstrap(session),
    otherDirectory.bootstrap(session), f.directory.bootstrap(session),
  ]);
  expect(new Set(result.map((row) => row.id)).size).toBe(1);
  expect(await f.control.listWorkspacesByOwner(subject)).toHaveLength(1);
  expect(await f.control.getWorkspaceMember(result[0]!.id, subject)).toMatchObject({ status: "active", roles: ["owner"] });
  expect((await f.directory.menu(session)).activeWorkspace?.id).toBe(result[0]!.id);
});

test("bootstrap fails closed for unknown, alias and fenced canonical accounts", async () => {
  const f = fixture();
  await expect(f.directory.bootstrap({ subject: "tsub_unknown" })).rejects.toMatchObject({ status: 401 });
  f.store.findCanonicalAccount = async (id) => id === other ? f.store.findAccount(subject) : f.store.findAccount(id);
  await expect(f.directory.bootstrap({ subject: other })).rejects.toMatchObject({ status: 401 });
  f.store.isAccountAuthenticationFenced = async () => true;
  await expect(f.directory.bootstrap(session)).rejects.toMatchObject({ status: 401 });
  expect(await f.control.listWorkspaces()).toHaveLength(0);
});

test("missing canonical account and bootstrap capabilities refuse instead of creating a local identity", async () => {
  const f = fixture();
  f.store.findCanonicalAccount = undefined as never;
  await expect(f.directory.menu(session)).rejects.toMatchObject({ status: 503 });
  const noBootstrap = createSharedAccountWorkspaceDirectory({
    store: new InMemoryAccountsStore(), operations: { ...f.operations, workspaces: { ...f.operations.workspaces, ensurePersonalWorkspaceForSharedAccount: undefined } },
    workspaceMutationsFrozen: false,
  });
  const store = new InMemoryAccountsStore();
  store.saveAccount({ subject, createdAt: 1, updatedAt: 1 });
  const bootstrap = createSharedAccountWorkspaceDirectory({ store, operations: { ...f.operations, workspaces: { ...f.operations.workspaces, ensurePersonalWorkspaceForSharedAccount: undefined } }, workspaceMutationsFrozen: false });
  await expect(bootstrap.bootstrap(session)).rejects.toMatchObject({ status: 503 });
  await expect(noBootstrap.bootstrap(session)).rejects.toMatchObject({ status: 401 });
});

test("frozen bootstrap preserves an existing personal Workspace and creates the first singleton", async () => {
  const existing = fixture();
  const workspace = await existing.directory.bootstrap(session);
  const frozen = createSharedAccountWorkspaceDirectory({
    store: existing.store,
    operations: existing.operations,
    workspaceMutationsFrozen: true,
  });
  expect(await frozen.bootstrap(session)).toEqual(workspace);
  await expect(frozen.create(session, {
    handle: "frozen-team", displayName: "Frozen team", type: "organization",
  })).rejects.toMatchObject({ code: "workspace_frozen", status: 409 });

  const fresh = fixture(undefined, true);
  const created = await fresh.directory.bootstrap(session);
  expect(created).toMatchObject({ type: "personal", ownerUserId: subject });
  expect(await fresh.directory.bootstrap(session)).toEqual(created);
  expect(await fresh.control.listWorkspaces()).toEqual([created]);
});

test("shared Workspace HTTP routes default to frozen while preserving existing personal bootstrap", async () => {
  const f = fixture();
  const workspace = await f.directory.bootstrap(session);
  f.store.saveAccountSession({ sessionId: "sess_frozen_directory", subject, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
  const call = async (path: string, method: string, body: Record<string, unknown>) => {
    const request = new Request(`https://issuer.example.test${SHARED_ACCOUNT_WORKSPACES_PATH}${path}`, {
      method,
      headers: { authorization: "Bearer sess_frozen_directory", origin: "https://issuer.example.test", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await handleSharedAccountWorkspaceRoute({ request, url: new URL(request.url), store: f.store, directory: f.directory });
  };
  const bootstrap = await call("/bootstrap", "POST", {});
  expect(bootstrap?.status).toBe(200);
  expect(await bootstrap?.json()).toMatchObject({ workspace: { id: workspace.id } });
  const create = await call("", "POST", { handle: "blocked-team", displayName: "Blocked", type: "organization" });
  expect(create?.status).toBe(409);
  expect(await create?.json()).toMatchObject({ error: { code: "workspace_frozen", requestId: expect.any(String) } });
  expect(await f.control.listWorkspaces()).toEqual([workspace]);
});

test("directory reads current membership and never repairs suspended owner rows", async () => {
  const f = fixture();
  const workspace = await f.directory.bootstrap(session);
  await member(f, workspace, { status: "suspended" });
  const menu = await f.directory.menu(session);
  expect(menu.choices).toEqual([]);
  expect(menu.activeWorkspace).toBeUndefined();
  await expect(f.directory.choose(session, workspace.id)).rejects.toMatchObject({ status: 403 });
  await expect(f.directory.bootstrap(session)).rejects.toMatchObject({ status: 403 });
  expect(await f.control.getWorkspaceMember(workspace.id, subject)).toMatchObject({ status: "suspended" });
});

test("owner field and stale membership page do not authorize missing/revoked membership", async () => {
  const f = fixture();
  const workspace = await f.directory.bootstrap(session);
  await member(f, workspace, { status: "suspended" });
  f.operations.workspaces.listWorkspacesForAccountPage = async () => ({ items: [workspace] });
  f.operations.workspaces.getWorkspaceForAccount = async () => workspace;
  expect((await f.directory.menu(session)).choices).toEqual([]);
  await expect(f.directory.choose(session, workspace.id)).rejects.toMatchObject({ status: 403 });
});

test("menu exposes bounded live choices and authorized off-page selection", async () => {
  const f = fixture(undefined, false);
  const personal = await f.directory.bootstrap(session);
  const additional = await f.directory.create(session, { handle: "additional-work", displayName: "Additional", type: "organization" });
  const menu = await f.directory.menu(session, { limit: 1, selectedWorkspaceId: additional.id });
  expect(menu.activeWorkspace).toEqual(additional);
  expect(menu.choices.map((row) => row.id)).toEqual([additional.id, personal.id]);
  expect(menu.nextCursor).toBeString();
  await member(f, personal, { roles: ["viewer"] });
  expect((await f.directory.choose(session, personal.id)).roles).toEqual(["viewer"]);
  await expect(f.directory.menu(session, { limit: 101 })).rejects.toMatchObject({ status: 400 });
});

test("explicit creation uses canonical owner and rejects duplicate personal bootstrap", async () => {
  const f = fixture(undefined, false);
  await f.directory.bootstrap(session);
  const created = await f.directory.create(session, { handle: "purpose-work", displayName: "Purpose", type: "organization" });
  expect(await f.control.getWorkspace(created.id)).toMatchObject({ ownerUserId: subject, type: "organization" });
  await expect(f.directory.create(session, { handle: "second-personal", displayName: "Second", type: "personal" as never })).rejects.toMatchObject({ status: 400 });
  expect((await f.control.listWorkspaces()).filter((row) => row.type === "personal")).toHaveLength(1);
});

test("billing resolves only authorized Workspace UID and retains owner resource and money references", async () => {
  const calls: unknown[] = [];
  const pins = new Map<string, { workspaceId: string; workspaceRef: string; organizationId: string }>();
  const f = fixture(async (input) => { calls.push(input); return pins.get(input.workspaceId) ?? null; });
  const workspace = await f.directory.bootstrap(session);
  const oldPin = { workspaceId: workspace.id, workspaceRef: "wrk_old_retained_opaque", organizationId: "org_existing_ledger" };
  pins.set(workspace.id, oldPin);
  const before = await f.control.getWorkspace(workspace.id);
  expect(await f.directory.billingOrganization(session, workspace.id)).toEqual(oldPin);
  expect(calls).toEqual([expect.objectContaining({ workspaceId: workspace.id, canonicalAccountId: subject, assertCurrentGrant: expect.any(Function) })]);
  expect(await f.control.getWorkspace(workspace.id)).toEqual(before);
  expect(pins.get(workspace.id)).toBe(oldPin);
  await expect(f.directory.billingOrganization({ subject: other }, workspace.id)).rejects.toMatchObject({ status: 403 });
  expect(calls).toHaveLength(1);
});

test("no billing resolver, pending binding or different Workspace readback fails closed", async () => {
  const f = fixture();
  const workspace = await f.directory.bootstrap(session);
  await expect(f.directory.billingOrganization(session, workspace.id)).rejects.toMatchObject({ status: 503, code: "capability_unavailable" });
  for (const result of [null, { workspaceId: "ws_wrong", workspaceRef: "wrk_existing_ref", organizationId: "org_wrong" }]) {
    const directory = createSharedAccountWorkspaceDirectory({ store: f.store, operations: f.operations, resolveWorkspaceBilling: async () => result });
    await expect(directory.billingOrganization(session, workspace.id)).rejects.toMatchObject({ status: 503, code: "binding_unavailable" });
  }
});

test("billing membership revocation during resolver wait prevents returning authorization", async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const f = fixture(async ({ workspaceId }) => {
    started(); await blocked;
    return { workspaceId, workspaceRef: "wrk_existing_retained", organizationId: "org_retained" };
  });
  const workspace = await f.directory.bootstrap(session);
  const pending = f.directory.billingOrganization(session, workspace.id);
  await entered;
  await member(f, workspace, { status: "suspended" });
  release();
  await expect(pending).rejects.toMatchObject({ status: 403 });
});

test("trusted RP context checks grant before and after owner resolver, preserving distinct existing Workspaces", async () => {
  let healthy = true;
  const f = fixture(async ({ workspaceId }) => {
    healthy = false;
    return { workspaceId, workspaceRef: "wrk_existing_retained", organizationId: "org_retained" };
  });
  const personal = await f.directory.bootstrap(session);
  const existing = await f.service.createWorkspace({ handle: "retained-source", displayName: "Old resources", type: "personal", ownerUserId: other });
  const hosted: SharedHostedSessionContext = { kind: "shared-hosted-session", canonicalAccountId: subject, activeWorkspaceId: personal.id, assertCurrentGrant: async () => healthy };
  expect((await f.directory.menu(hosted)).activeWorkspace?.id).toBe(personal.id);
  await expect(f.directory.choose(hosted, existing.id)).rejects.toMatchObject({ status: 403 });
  await expect(f.directory.billingOrganization(hosted, personal.id)).rejects.toMatchObject({ status: 401 });
  expect(await f.control.getWorkspace(existing.id)).toEqual(existing);
  expect(await f.control.listWorkspaces()).toHaveLength(2);
});

test("reviewed access to retained source personal Workspace does not replace canonical personal fallback", async () => {
  const f = fixture();
  const source = await f.service.createWorkspace({ handle: "old-source-personal", displayName: "Retained", type: "personal", ownerUserId: other });
  const personal = await f.directory.bootstrap(session);
  // Synthetic owner-reviewed reconciliation: the directory does not perform
  // this mutation or infer it from a token/email/account alias.
  const oldMember = await f.control.getWorkspaceMember(source.id, other);
  await f.control.putWorkspaceMember({ ...oldMember!, id: "wsm_reviewed_target", accountId: subject });
  const menu = await f.directory.menu(session);
  expect(menu.choices.map((row) => row.id)).toEqual([source.id, personal.id]);
  expect(menu.personalWorkspaceId).toBe(personal.id);
  expect(menu.activeWorkspace?.id).toBe(personal.id);
  expect((await f.directory.bootstrap(session)).id).toBe(personal.id);
  expect(await f.control.getWorkspace(source.id)).toEqual(source);
});

test("HTTP route accepts actual Accounts session, no caller account/Org scope, and protects mutations with Origin", async () => {
  const f = fixture(async ({ workspaceId }) => ({ workspaceId, workspaceRef: "wrk_owner_existing", organizationId: "org_owner" }));
  const workspace = await f.directory.bootstrap(session);
  f.store.saveAccountSession({ sessionId: "sess_directory", subject, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
  const call = async (path: string, init: RequestInit = {}) => {
    const request = new Request(`https://issuer.example.test${SHARED_ACCOUNT_WORKSPACES_PATH}${path}`, init);
    return await handleSharedAccountWorkspaceRoute({ request, url: new URL(request.url), store: f.store, directory: f.directory, workspaceMutationsFrozen: false });
  };
  expect((await call("", { headers: { authorization: "Bearer id_token_not_session" } }))?.status).toBe(401);
  const headers = { authorization: "Bearer sess_directory", origin: "https://issuer.example.test", "content-type": "application/json" };
  const menu = await call("", { headers });
  expect(menu?.status).toBe(200);
  expect(menu?.headers.get("cache-control")).toBe("no-store");
  expect((await call("/bootstrap", { method: "POST", headers: { ...headers, origin: "https://other.example.test" }, body: "{}" }))?.status).toBe(403);
  expect((await call("", { method: "POST", headers, body: JSON.stringify({ handle: "injected-account", displayName: "Injected", type: "organization", ownerUserId: other }) }))?.status).toBe(400);
  const billing = await call(`/${workspace.id}/billing-organization?organizationId=org_attacker`, { headers });
  expect(billing?.status).toBe(400);
  const normal = await call(`/${workspace.id}/billing-organization`, { headers });
  expect(await normal?.json()).toEqual({ workspaceId: workspace.id, workspaceRef: "wrk_owner_existing", organizationId: "org_owner" });
});

test("protocol-owned directory bearer callback creates trusted local context with current grant rechecks", async () => {
  const f = fixture();
  let healthy = true;
  const request = new Request(`https://issuer.example.test${SHARED_ACCOUNT_WORKSPACES_PATH}/bootstrap`, {
    method: "POST", headers: { authorization: "Bearer profile_directory_only", "content-type": "application/json" }, body: "{}",
  });
  const context: SharedHostedSessionContext = {
    kind: "shared-hosted-session", canonicalAccountId: subject, assertCurrentGrant: async () => healthy,
  };
  // Token/client/protocol validation belongs to the injected owner adapter;
  // the directory still independently checks grant health and common account.
  const response = await handleSharedAccountWorkspaceRoute({
    request, url: new URL(request.url), store: f.store, directory: f.directory,
    workspaceMutationsFrozen: false,
    authenticate: async () => ({ ok: true, session: context }),
  });
  expect(response?.status).toBe(200);
  const body = await response?.json() as { workspace: Workspace };
  healthy = false;
  const revokedRequest = new Request(`https://issuer.example.test${SHARED_ACCOUNT_WORKSPACES_PATH}/${body.workspace.id}/select`, {
    method: "POST", headers: { authorization: "Bearer profile_directory_only", "content-type": "application/json" }, body: "{}",
  });
  const revoked = await handleSharedAccountWorkspaceRoute({
    request: revokedRequest, url: new URL(revokedRequest.url), store: f.store, directory: f.directory,
    workspaceMutationsFrozen: false,
    authenticate: async () => ({ ok: true, session: context }),
  });
  expect(revoked?.status).toBe(401);
  expect(revoked?.headers.get("cache-control")).toBe("no-store");
});
