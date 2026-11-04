import { expect, test } from "bun:test";
import { handlePlatformSharedAuthControlRequest } from "../../../deploy/platform/worker.ts";
import { handleAuthenticatedControlRoute } from "../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { CapsulesService } from "../../../core/domains/capsules/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../core/domains/workspaces/mod.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";

const origin = "https://hosted.staging.example.test";
const subject = "tsub_shared_uninstall_owner";

async function appliedApp() {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store);
  await store.putWorkspace({ ...seeded.workspace, ownerUserId: subject });
  const member = {
    id: "wsm_shared_uninstall", workspaceId: seeded.workspace.id, accountId: subject,
    roles: ["owner" as const], status: "active" as const,
    createdAt: seeded.workspace.createdAt, updatedAt: seeded.workspace.updatedAt,
  };
  await store.putWorkspaceMember(member);
  await store.putCapsule({ ...seeded.capsule, status: "active", currentStateGeneration: 1 });
  const accounts = new InMemoryAccountsStore();
  const operations = {
    capsules: new CapsulesService({ store }),
    workspaces: new WorkspacesService({ store }),
    members: {
      listMembers: (id: string) => store.listWorkspaceMembers(id),
      getMember: (id: string, account: string) => store.getWorkspaceMember(id, account),
    },
  } as unknown as ControlPlaneOperations;
  const env = {
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
    TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    TAKOSUMI_ENVIRONMENT: "staging",
    HOSTED: {
      fetchSharedAuth: async () => new Response(null, { status: 204 }),
      authenticateSharedAuth: async () => ({ kind: "authenticated" as const, accountId: subject }),
      resolveSharedAuthWorkspace: async (_request: Request, workspaceId: string) => ({
        kind: "authorized" as const, accountId: subject, workspaceId, role: "owner" as const,
      }),
    },
  };
  const dependencies = { store: accounts, resolveOperations: async () => operations };
  return { store, accounts, seeded, member, operations, env, dependencies };
}

for (const path of ["", "?immediate=false", "/uninstall"]) {
  test(`shared RP session binds the authenticated uninstall requester through ${path || "DELETE"}`, async () => {
    const h = await appliedApp();
    const request = new Request(`${origin}/api/v1/capsules/${h.seeded.capsule.id}${path}`, {
      method: path === "/uninstall" ? "POST" : "DELETE",
      headers: { cookie: "__Host-takosumi_hosted_session=synthetic-cookie", origin,
        "x-takosumi-requester": "tsub_forged" },
    });
    const response = await handlePlatformSharedAuthControlRequest(request, h.env, h.dependencies);
    expect(response?.status).toBe(202);
    const body = await response!.json();
    expect(body).toMatchObject({ capsule: { status: "uninstalled" }, graceDays: 7 });
    expect(body.capsule.uninstall).not.toHaveProperty("requester");
    expect((await h.store.getCapsule(h.seeded.capsule.id))?.uninstall?.requester).toEqual({
      subject, managementAuthority: "workspace",
    });
  });
}

test("a trusted subject without an authenticated session cannot manufacture a requester from HTTP", async () => {
  const h = await appliedApp();
  const url = new URL(`${origin}/api/v1/capsules/${h.seeded.capsule.id}`);
  const response = await handleAuthenticatedControlRoute({
    request: new Request(url, { method: "DELETE", headers: {
      "content-type": "application/json", "x-takosumi-requester": subject,
    }, body: JSON.stringify({ credential: "session", uninstallRequester: { subject } }) }),
    url, store: h.accounts, operations: h.operations, subject,
  });
  expect(response?.status).toBe(403);
  expect(await response!.json()).toMatchObject({
    error: { details: { reason: "capsule_uninstall_requester_unavailable" } },
  });
  expect((await h.store.getCapsule(h.seeded.capsule.id))?.uninstall).toBeUndefined();
});

test("a shared RP session still requires current membership before it can schedule uninstall", async () => {
  const h = await appliedApp();
  await h.store.putWorkspaceMember({ ...h.member, status: "suspended" });
  const response = await handlePlatformSharedAuthControlRequest(new Request(
    `${origin}/api/v1/capsules/${h.seeded.capsule.id}`, {
      method: "DELETE", headers: { cookie: "__Host-takosumi_hosted_session=synthetic-cookie", origin },
    },
  ), h.env, h.dependencies);
  expect(response?.status).toBe(403);
  expect((await h.store.getCapsule(h.seeded.capsule.id))?.uninstall).toBeUndefined();
});

test("shared session CSRF refusal leaves the uninstall requester and reservation absent", async () => {
  const h = await appliedApp();
  const response = await handlePlatformSharedAuthControlRequest(new Request(
    `${origin}/api/v1/capsules/${h.seeded.capsule.id}`, {
      method: "DELETE", headers: { cookie: "__Host-takosumi_hosted_session=synthetic-cookie", origin: "https://foreign.example.test" },
    },
  ), h.env, h.dependencies);
  expect(response?.status).toBe(403);
  expect((await h.store.getCapsule(h.seeded.capsule.id))?.uninstall).toBeUndefined();
});
