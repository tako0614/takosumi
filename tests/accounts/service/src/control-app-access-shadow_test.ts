import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AppAccess, AppAccessResolver } from "takosumi-contract/app-access";
import type { Workspace } from "takosumi-contract/workspaces";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { canAccessWorkspace } from "../../../../accounts/service/src/control/shared.ts";
import type { AppAccessShadowDiagnostic, RequestPhaseObserver } from "../../../../accounts/service/src/request-phase-diagnostics.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

let restoreSampling: (() => void) | undefined;
beforeEach(() => {
  const sampling = spyOn(Math, "random").mockReturnValue(0);
  restoreSampling = () => sampling.mockRestore();
});
afterEach(() => restoreSampling?.());

const capsuleId = "cap_shadow_private";
const workspaceId = "ws_shadow_private";
const memberId = "tsub_shadow_private";
const workspace: Workspace = {
  id: workspaceId,
  handle: "shadow-workspace",
  displayName: "Private Workspace Name",
  type: "personal",
  ownerUserId: "tsub_workspace_owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function setup(input: {
  readonly appAccess?: AppAccess | undefined;
  readonly resolverThrows?: boolean;
  readonly diagnosticsThrows?: boolean;
  readonly workspaceRole?: "owner" | "admin" | "member" | "viewer" | null;
  readonly workspaceScope?: string;
  readonly accountId?: string;
  readonly membershipStatus?: "active" | "invited" | "suspended";
  readonly requireCurrentMembership?: boolean;
} = {}) {
  let resolveDiagnostic!: (value: AppAccessShadowDiagnostic) => void;
  const observed = new Promise<AppAccessShadowDiagnostic>((resolve) => { resolveDiagnostic = resolve; });
  const diagnostics: RequestPhaseObserver = {
    async measure<T>(_phase, operation) { return await operation(); },
    observeAppAccessShadow(value) {
      if (input.diagnosticsThrows) throw new Error("diagnostic failure");
      resolveDiagnostic(value);
    },
  };
  let resolverCalls = 0;
  const appAccess: AppAccessResolver = {
    async resolveAppAccess(_accountId, _capsuleId) {
      resolverCalls++;
      if (input.resolverThrows) throw new Error("resolver failure");
      return input.appAccess;
    },
    async listAccessibleApps() { return { apps: [] }; },
  };
  const operations = {
    appAccess,
    workspaces: { getWorkspace: async () => workspace },
    members: {
      getMember: async () => input.workspaceRole ? {
        id: "membership_private",
        workspaceId,
        accountId: input.accountId ?? memberId,
        roles: [input.workspaceRole],
        status: input.membershipStatus ?? "active",
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      } : undefined,
    },
  } as unknown as ControlPlaneOperations;
  const session = {
    subject: input.accountId ?? memberId,
    ...(input.requireCurrentMembership ? { requireCurrentMembership: true } : {}),
    ...(input.workspaceScope ? { workspaceId: input.workspaceScope } : {}),
    requiredAccess: "read" as const,
  };
  return {
    observed,
    resolverCalls: () => resolverCalls,
    run: () => canAccessWorkspace({
      operations,
      store: new InMemoryAccountsStore(),
      session,
      workspaceId,
      workspace,
      capsuleId,
      diagnostics,
    }),
  };
}

function access(role: "owner" | "member"): AppAccess {
  return { capsuleId, role, ownerAccountId: "owner_private", ownershipEpoch: 0 };
}

test("AppAccess shadow success records same role without changing legacy authorization", async () => {
  const f = setup({ appAccess: access("member"), workspaceRole: "admin" });
  expect(await f.run()).toBe(true);
  await expect(f.observed).resolves.toMatchObject({
    resolverAvailable: true,
    resolverSucceeded: true,
    bearerWorkspaceAllowed: true,
    workspaceAllowed: true,
    appAllowed: true,
    workspaceRole: "member",
    appRole: "member",
    roleDiff: "same",
  });
});

test("AppAccess shadow denial and role mismatch do not replace legacy allow or deny", async () => {
  const denied = setup({ appAccess: undefined, workspaceRole: "admin" });
  expect(await denied.run()).toBe(true);
  await expect(denied.observed).resolves.toMatchObject({
    workspaceAllowed: true, appAllowed: false, roleDiff: "workspace_only",
  });

  const mismatch = setup({ appAccess: access("owner"), workspaceRole: "admin" });
  expect(await mismatch.run()).toBe(true);
  await expect(mismatch.observed).resolves.toMatchObject({
    workspaceAllowed: true, appAllowed: true, workspaceRole: "member", appRole: "owner", roleDiff: "role_mismatch",
  });

  const noMismatch = setup({ appAccess: undefined, workspaceRole: null });
  expect(await noMismatch.run()).toBe(false);
  await expect(noMismatch.observed).resolves.toMatchObject({
    workspaceAllowed: false, appAllowed: false, roleDiff: "same",
  });
});

test("bearer Workspace restriction participates in shadow comparison", async () => {
  const f = setup({ appAccess: access("owner"), workspaceRole: "owner", workspaceScope: "ws_other_scope" });
  expect(await f.run()).toBe(false);
  await expect(f.observed).resolves.toMatchObject({
    bearerWorkspaceAllowed: false,
    workspaceAllowed: false,
    appAllowed: false,
  });
});

test("resolver and diagnostic failures never change legacy authorization and event contains no IDs or names", async () => {
  const resolverFailure = setup({ resolverThrows: true, workspaceRole: "admin" });
  expect(await resolverFailure.run()).toBe(true);
  await expect(resolverFailure.observed).resolves.toMatchObject({
    resolverAvailable: true, resolverSucceeded: false, workspaceAllowed: true, roleDiff: "unavailable",
  });

  const diagnosticFailure = setup({ appAccess: access("member"), workspaceRole: "admin", diagnosticsThrows: true });
  expect(await diagnosticFailure.run()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const valueFree = setup({ appAccess: access("member"), workspaceRole: "admin" });
  expect(await valueFree.run()).toBe(true);
  const event = await valueFree.observed;
  expect(JSON.stringify(event)).not.toContain(capsuleId);
  expect(JSON.stringify(event)).not.toContain(workspaceId);
  expect(JSON.stringify(event)).not.toContain("Private Workspace Name");
  expect(Object.keys(event).sort()).toEqual([
    "appAllowed", "appRole", "bearerWorkspaceAllowed", "resolverAvailable", "resolverSucceeded",
    "roleDiff", "workspaceAllowed", "workspaceRole",
  ]);
});


for (const role of ["owner", "admin", "member", "viewer"] as const) {
  test(`shadow maps active Workspace ${role} to the app management contract`, async () => {
    const expected = role === "owner" || role === "admin" ? "member" : null;
    const f = setup({ workspaceRole: role, appAccess: expected ? access(expected) : undefined });
    expect(await f.run()).toBe(true);
    await expect(f.observed).resolves.toMatchObject({ workspaceRole: expected, appRole: expected, roleDiff: "same" });
  });
}

for (const membershipStatus of ["invited", "suspended"] as const) {
  test(`shadow excludes ${membershipStatus} Workspace admins`, async () => {
    const f = setup({ workspaceRole: "admin", membershipStatus });
    expect(await f.run()).toBe(false);
    await expect(f.observed).resolves.toMatchObject({ workspaceRole: null, appRole: null, roleDiff: "same" });
  });
}

test("shadow owner truth is ownerUserId even when strict legacy membership denies", async () => {
  const f = setup({ accountId: workspace.ownerUserId, requireCurrentMembership: true, appAccess: access("owner") });
  expect(await f.run()).toBe(false);
  await expect(f.observed).resolves.toMatchObject({ workspaceRole: "owner", appRole: "owner", roleDiff: "same" });
});

test("unsampled authorization does no AppAccess shadow reads", async () => {
  spyOn(Math, "random").mockReturnValue(0.5);
  const f = setup({ workspaceRole: "admin", resolverThrows: true });
  expect(await f.run()).toBe(true);
  expect(f.resolverCalls()).toBe(0);
});
