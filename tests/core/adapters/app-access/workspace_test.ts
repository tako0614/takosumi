import { expect, test } from "bun:test";
import { createWorkspaceAppAccessResolver } from "../../../../core/adapters/app-access/workspace.ts";
import type { Capsule } from "takosumi-contract/capsules";
import type { WorkspaceMember } from "takosumi-contract/workspaces";

function fixture() {
  let capsule: Capsule = { id: "cap1", workspaceId: "ws1", projectId: "project1", name: "app", slug: "app", environment: "integration", sourceId: "src1", installConfigId: "config1", currentStateGeneration: 0, status: "pending", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
  let membership: WorkspaceMember | undefined;
  const workspace = { id: "ws1", handle: "owner", displayName: "Owner", type: "personal" as const, ownerUserId: "owner", createdAt: capsule.createdAt, updatedAt: capsule.updatedAt };
  const resolver = createWorkspaceAppAccessResolver({
    getCapsule: async (id) => id === capsule.id ? capsule : undefined,
    getWorkspace: async (id) => id === workspace.id ? workspace : undefined,
    getWorkspaceMember: async () => membership,
    listWorkspacesForAccount: async () => [workspace],
    listCapsules: async () => [capsule],
  });
  return { resolver, setCapsule: (value: Partial<Capsule>) => { capsule = { ...capsule, ...value }; }, member: (role: WorkspaceMember["roles"][number]) => { membership = { workspaceId: "ws1", accountId: "member", roles: [role], status: "active", createdAt: capsule.createdAt, updatedAt: capsule.updatedAt }; } };
}

test("legacy ownership and active admins map to the shared contract without promoting viewers", async () => {
  const f = fixture();
  expect(await f.resolver.resolveAppAccess("owner", "cap1")).toEqual({ capsuleId: "cap1", role: "owner", ownerAccountId: "owner", ownershipEpoch: 0 });
  f.member("admin");
  expect((await f.resolver.resolveAppAccess("member", "cap1"))?.role).toBe("member");
  f.member("member");
  expect(await f.resolver.resolveAppAccess("member", "cap1")).toBeUndefined();
  f.member("viewer");
  expect((await f.resolver.listAccessibleApps("member")).apps).toEqual([]);
});

test("expanded apps never regain legacy Workspace owner or admin access", async () => {
  const f = fixture();
  f.member("admin");
  f.setCapsule({ ownerAccountId: "new-owner", ownershipEpoch: 2, managementState: "active" });
  expect(await f.resolver.resolveAppAccess("owner", "cap1")).toBeUndefined();
  expect(await f.resolver.resolveAppAccess("member", "cap1")).toBeUndefined();
  expect((await f.resolver.listAccessibleApps("owner")).apps).toEqual([]);
});
