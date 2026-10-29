import { expect, test } from "bun:test";
import type { AppAccess, AppAccessResolver } from "takosumi-contract/app-access";
import type { Workspace } from "takosumi-contract/workspaces";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { canAccessWorkspace } from "../../../../accounts/service/src/control/shared.ts";
import type { AppAccessShadowDiagnostic, RequestPhaseObserver } from "../../../../accounts/service/src/request-phase-diagnostics.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

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
  const appAccess: AppAccessResolver = {
    async resolveAppAccess(_accountId, _capsuleId) {
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
        accountId: memberId,
        roles: [input.workspaceRole],
        status: "active",
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      } : undefined,
    },
  } as unknown as ControlPlaneOperations;
  const session = {
    subject: memberId,
    ...(input.workspaceScope ? { workspaceId: input.workspaceScope } : {}),
    requiredAccess: "read" as const,
  };
  return {
    observed,
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
  const f = setup({ appAccess: access("member"), workspaceRole: "member" });
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
  const denied = setup({ appAccess: undefined, workspaceRole: "member" });
  expect(await denied.run()).toBe(true);
  await expect(denied.observed).resolves.toMatchObject({
    workspaceAllowed: true, appAllowed: false, roleDiff: "workspace_only",
  });

  const mismatch = setup({ appAccess: access("owner"), workspaceRole: "member" });
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
  const resolverFailure = setup({ resolverThrows: true, workspaceRole: "member" });
  expect(await resolverFailure.run()).toBe(true);
  await expect(resolverFailure.observed).resolves.toMatchObject({
    resolverAvailable: true, resolverSucceeded: false, workspaceAllowed: true, roleDiff: "unavailable",
  });

  const diagnosticFailure = setup({ appAccess: access("member"), workspaceRole: "member", diagnosticsThrows: true });
  expect(await diagnosticFailure.run()).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const valueFree = setup({ appAccess: access("member"), workspaceRole: "member" });
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
