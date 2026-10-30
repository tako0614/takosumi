/**
 * Account-level launcher `GET /api/v1/ui-surfaces` (TASK-0118 9.1): UI
 * surfaces of the apps the caller owns or is a member of, still requiring the
 * caller's exact Principal Binding, without a Workspace.
 */
import { describe, expect, test } from "bun:test";
import type { Interface } from "takosumi-contract";
import { decodeCursor } from "takosumi-contract/pagination";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
const WORKSPACE = "ws_launcher";
const MINE = "cap_launcher_mine";
const SHARED = "cap_launcher_shared";
const THEIRS = "cap_launcher_theirs";
const STOPPED = "cap_launcher_stopped";
const OWNER = "user_test";
const MEMBER = "acct_launcher_member";
const OTHER = "acct_launcher_other";
const STRANGER = "acct_launcher_stranger";
const NOW = "2026-10-30T00:00:00.000Z";

async function fixture(options: { readonly delegate?: boolean; readonly endlessAppPages?: boolean } = {}) {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: WORKSPACE, capsuleId: MINE, sourceId: "src_launcher", snapshotId: "snap_launcher", installConfigId: "cfg_launcher",
  });
  for (const [id, status] of [[MINE, "active"], [SHARED, "stale"], [THEIRS, "active"], [STOPPED, "disabled"]] as const) {
    await ledger.putCapsule({ ...seeded.capsule, id, name: id, slug: id, status, currentStateGeneration: 1, updatedAt: NOW });
  }
  const { operations: core } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger,
    interfaceStores: createInMemoryInterfaceStores({ workspaceManagementAuthority: ledger }),
  });
  for (const [capsuleId, owner] of [[MINE, OWNER], [SHARED, OTHER], [THEIRS, OTHER], [STOPPED, OWNER]] as const) {
    expect(await core.appOwnership.initializeOwnershipIfMissing({
      capsuleId, ownerAccountId: owner, ownershipEpoch: 0, managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsuleId}`,
    })).toBe(true);
  }
  for (const [capsuleId, accountId] of [[MINE, MEMBER], [SHARED, OWNER], [SHARED, MEMBER]] as const) {
    expect(await core.appOwnership.putMember({ capsuleId, accountId, status: "active", addedBy: "x", createdAt: NOW, updatedAt: NOW })).toBe(true);
  }
  const surfaces: Record<string, string> = {};
  for (const capsuleId of [MINE, SHARED, THEIRS, STOPPED]) {
    const iface = await core.interfaces.create({
      workspaceId: WORKSPACE,
      name: `${capsuleId.replaceAll("_", "-")}-ui`,
      ownerRef: { kind: "Capsule", id: capsuleId },
      spec: {
        type: "interface.ui.surface",
        version: "1",
        document: { launcher: true },
        inputs: { url: { source: "literal", value: `https://${capsuleId.replaceAll("_", "-")}.example.test` } },
        access: { visibility: "workspace" },
      },
    });
    surfaces[capsuleId] = iface.metadata.id;
    // Bindings decide who may open each surface (the dashboard creates them for people).
    for (const subject of [OWNER, MEMBER, OTHER, STRANGER]) {
      await core.interfaces.createBinding(iface.metadata.id, {
        subjectRef: { kind: "Principal", id: subject },
        permissions: ["ui.open"],
        delivery: { type: "none" },
      });
    }
  }
  const baseOperations = core as unknown as ControlPlaneOperations;
  // An account with more apps than one account read enumerates.
  const coreOperations = options.endlessAppPages
    ? {
      ...baseOperations,
      appAccess: {
        resolveAppAccess: (accountId: string, capsuleId: string) => core.appAccess.resolveAppAccess(accountId, capsuleId),
        listAccessibleApps: async (accountId: string, page?: { cursor?: string; limit?: number }) => {
          const real = page?.cursor ? { apps: [] } : await core.appAccess.listAccessibleApps(accountId, { limit: 100 });
          return { apps: real.apps, nextCursor: `${page?.cursor ?? ""}x` };
        },
      },
    } as unknown as ControlPlaneOperations
    : baseOperations;
  // A Takos-like delegate: MINE is applied from a designated repository ref.
  const operations = options.delegate
    ? {
      ...coreOperations,
      getCapsuleAdoptedSourceRevision: async (capsuleId: string) => capsuleId === MINE
        ? { sourceSnapshotId: "snap_delegate", ref: "main", path: ".", resolvedCommit: "0".repeat(40) }
        : undefined,
      getSourceSnapshot: async (id: string) => ({ id, sourceId: seeded.source.id, workspaceId: WORKSPACE, resolvedRef: "refs/heads/main" }),
    } as unknown as ControlPlaneOperations
    : coreOperations;
  const delegationSources = options.delegate
    ? [{ url: seeded.source.url, path: ".", refs: ["refs/heads/main"] }]
    : undefined;
  const accounts = new InMemoryAccountsStore();
  for (const subject of [OWNER, MEMBER, OTHER, STRANGER]) accounts.saveAccount({ subject, createdAt: Date.now(), updatedAt: Date.now() });
  const headers = {
    session(subject: string): Record<string, string> {
      const sessionId = `sess_${subject}`;
      accounts.saveAccountSession({ sessionId, subject, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
      return { cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}` };
    },
    pat(subject: string, restriction: { readonly appIds?: readonly string[]; readonly workspaceId?: string } = {}): Record<string, string> {
      const token = `fixture-pat-${subject}-${restriction.appIds?.join("-") ?? restriction.workspaceId ?? "account"}`;
      accounts.savePersonalAccessToken(token, {
        tokenId: `pat_${token}`, tokenPrefix: "fixture", subject, name: "launcher", scopes: ["read"],
        ...(restriction.appIds ? { appIds: [...restriction.appIds] } : {}),
        ...(restriction.workspaceId ? { workspaceId: restriction.workspaceId } : {}),
        createdAt: Date.now(),
      });
      return { authorization: `Bearer ${token}` };
    },
    oauth(subject: string, capsuleId: string): Record<string, string> {
      const token = `fixture-oauth-${subject}-${capsuleId}`;
      accounts.saveAccessToken(token, {
        clientId: `client_${capsuleId}`, scope: "openid capsules:read",
        subject: `pairwise_${subject}`, takosumiSubject: subject, capsuleId, workspaceId: WORKSPACE, expiresAt: Date.now() + 60_000,
      });
      return { authorization: `Bearer ${token}` };
    },
  };
  async function list(credential: Record<string, string>, query = "") {
    const url = new URL(`${ORIGIN}/api/v1/ui-surfaces${query}`);
    const response = await handleControlRoute({
      request: new Request(url, { headers: credential }), url, store: accounts, operations,
      ...(delegationSources ? { installedAppDelegationSources: delegationSources } : {}),
    });
    const body = await response!.json() as { interfaces?: Interface[]; nextCursor?: string; incomplete?: boolean; error?: { code?: string } };
    return {
      status: response!.status,
      code: body.error?.code,
      owners: (body.interfaces ?? []).map((iface) => iface.metadata.ownerRef.id).sort(),
      nextCursor: body.nextCursor,
      incomplete: body.incomplete,
    };
  }
  return { headers, list, surfaces, core };
}

describe("account launcher", () => {
  const cases: readonly { readonly name: string; readonly credential: (h: Awaited<ReturnType<typeof fixture>>) => Record<string, string>; readonly expected: readonly string[] | "deny" }[] = [
    // Disabled apps are not launchable; apps the caller does not manage are never listed.
    { name: "app owner and member of another app", credential: (h) => h.headers.session(OWNER), expected: [MINE, SHARED].sort() },
    { name: "app member", credential: (h) => h.headers.session(MEMBER), expected: [MINE, SHARED].sort() },
    { name: "owner of other apps", credential: (h) => h.headers.session(OTHER), expected: [SHARED, THEIRS].sort() },
    { name: "unrelated account with bindings but no app role", credential: (h) => h.headers.session(STRANGER), expected: [] },
    { name: "PAT with appIds", credential: (h) => h.headers.pat(OWNER, { appIds: [SHARED] }), expected: [SHARED] },
    { name: "installed-app token sees only its own app", credential: (h) => h.headers.oauth(OWNER, MINE), expected: [MINE] },
    { name: "legacy Workspace-scoped PAT", credential: (h) => h.headers.pat(OWNER, { workspaceId: WORKSPACE }), expected: "deny" },
  ];
  for (const item of cases) {
    test(item.name, async () => {
      const h = await fixture();
      const result = await h.list(item.credential(h));
      if (item.expected === "deny") {
        expect([result.status, result.code]).toEqual([403, "app_access_denied"]);
        return;
      }
      expect(result.status).toBe(200);
      expect(result.owners).toEqual([...item.expected]);
    });
  }

  test("a designated delegate app's token lists its user's apps under the per-app decision", async () => {
    const h = await fixture({ delegate: true });
    expect((await h.list(h.headers.oauth(OWNER, MINE))).owners).toEqual([MINE, SHARED].sort());
    // Its own-app limit still applies to a non-designated app's token.
    expect((await h.list(h.headers.oauth(OWNER, SHARED))).owners).toEqual([SHARED]);
  });

  test("a launcher over more apps than one account read enumerates says so", async () => {
    const h = await fixture({ endlessAppPages: true });
    const result = await h.list(h.headers.session(OWNER));
    expect(result.owners).toEqual([MINE, SHARED].sort());
    expect(result.incomplete).toBe(true);
    expect((await (await fixture()).list(h.headers.session(OWNER))).incomplete).toBeUndefined();
  });

  test("pages walk the apps in id order and capsuleId narrows to one app", async () => {
    const h = await fixture();
    const first = await h.list(h.headers.session(OWNER), "?limit=1");
    expect(first.owners).toEqual([MINE]);
    expect(decodeCursor(first.nextCursor)).toBeDefined();
    const second = await h.list(h.headers.session(OWNER), `?limit=1&cursor=${first.nextCursor}`);
    expect(second.owners).toEqual([SHARED]);
    expect(second.nextCursor).toBeUndefined();
    expect((await h.list(h.headers.session(OWNER), `?capsuleId=${SHARED}`)).owners).toEqual([SHARED]);
    expect((await h.list(h.headers.session(OWNER), `?capsuleId=${THEIRS}`)).owners).toEqual([]);
    expect((await h.list(h.headers.session(OWNER), "?capsuleId=")).status).toBe(400);
    // A keyset cursor from another list is not a launcher cursor.
    expect((await h.list(h.headers.session(OWNER), "?cursor=eyJjIjoiMjAyNiIsImkiOiJ4In0")).status).toBe(400);
  });

  test("the caller's exact binding is still required", async () => {
    const h = await fixture();
    // Revoke the owner's binding on MINE: the app role alone does not launch it.
    const bindings = await h.core.interfaces.listBindings(h.surfaces[MINE]!);
    const ownerBinding = bindings.find((binding) => binding.spec.subjectRef.id === OWNER)!;
    await h.core.interfaces.revokeBinding(h.surfaces[MINE]!, ownerBinding.metadata.id);
    expect((await h.list(h.headers.session(OWNER))).owners).toEqual([SHARED]);
    expect((await h.list(h.headers.session(MEMBER))).owners).toEqual([MINE, SHARED].sort());
  });
});
