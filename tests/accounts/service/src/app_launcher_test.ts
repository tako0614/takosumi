/**
 * Account-level launcher `GET /api/v1/ui-surfaces` (TASK-0118 9.1): UI
 * surfaces of the apps the caller owns or is a member of, still requiring the
 * caller's exact Principal Binding, without a Workspace.
 */
import { describe, expect, test } from "bun:test";
import { listAuthorizedUiSurfaces } from "../../../../dashboard/src/lib/ui-surface-interfaces.ts";
import type { Interface } from "takosumi-contract";
import { decodeCursor, encodeCursor } from "takosumi-contract/pagination";
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

async function fixture(options: { readonly delegate?: boolean; readonly endlessAppPages?: boolean; readonly extraOwnSurfaces?: number } = {}) {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, {
    workspaceId: WORKSPACE, capsuleId: MINE, sourceId: "src_launcher", snapshotId: "snap_launcher", installConfigId: "cfg_launcher",
  });
  for (const [id, status] of [[MINE, "active"], [SHARED, "stale"], [THEIRS, "active"], [STOPPED, "disabled"]] as const) {
    await ledger.putCapsule({ ...seeded.capsule, id, name: id, slug: id, status, currentStateGeneration: 1, updatedAt: NOW });
  }
  const { operations: core } = await createTakosumiService({
    authorizeInterfaceBearer: () => undefined,
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
  const extraSurfaces: string[] = [];
  for (let index = 0; index < (options.extraOwnSurfaces ?? 0); index++) {
    const iface = await core.interfaces.create({
      workspaceId: WORKSPACE,
      name: `additional-launcher-${index}`,
      ownerRef: { kind: "Capsule", id: MINE },
      spec: {
        type: "interface.ui.surface", version: "1", document: { launcher: true },
        inputs: { url: { source: "literal", value: `https://additional-${index}.example.test` } },
        access: { visibility: "workspace" },
      },
    });
    extraSurfaces.push(iface.metadata.id);
    await core.interfaces.createBinding(iface.metadata.id, {
      subjectRef: { kind: "Principal", id: OWNER }, permissions: ["ui.open"], delivery: { type: "none" },
    });
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
      ids: (body.interfaces ?? []).map((iface) => iface.metadata.id),
      nextCursor: body.nextCursor,
      incomplete: body.incomplete,
    };
  }
  async function readResponse(credential: Record<string, string>, path: string): Promise<Response> {
    const url = new URL(path, ORIGIN);
    const response = await handleControlRoute({
      request: new Request(url, { headers: credential }), url, store: accounts, operations,
      ...(delegationSources ? { installedAppDelegationSources: delegationSources } : {}),
    });
    return response!;
  }
  return { headers, list, readResponse, surfaces, extraSurfaces, core, ledger };
}

describe("account launcher", () => {
  test("aggregate completion follows the actual route to all screens without a sticky warning on reload", async () => {
    const h = await fixture({ extraOwnSurfaces: 5 });
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) =>
      await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId);
    const credential = h.headers.session(OWNER);
    let calls = 0;
    let warned = 0;
    const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("include");
      calls++;
      return await h.readResponse(credential, String(input));
    }, { preconnect() {} });
    for (let attempt = 0; attempt < 2; attempt++) {
      const surfaces = await listAuthorizedUiSurfaces(WORKSPACE, {
        capsuleId: MINE, fetch: transport, onIncomplete: () => { warned++; },
      });
      expect(surfaces).toHaveLength(6);
      expect(new Set(surfaces.map((item) => item.interfaceId)).size).toBe(6);
      expect(surfaces.every((item) => item.capsuleId === MINE && item.url.startsWith("https://"))).toBe(true);
      expect(warned).toBe(0);
    }
    expect(calls).toBe(4); // Two opaque pages for each read/reload; no retry or extra lookup.
  });

  test("aggregate completion retains an old serving flag through later complete pages", async () => {
    const h = await fixture({ extraOwnSurfaces: 5 });
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) =>
      await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId);
    const credential = h.headers.session(OWNER);
    let calls = 0;
    let warned = 0;
    const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
      const response = await h.readResponse(credential, String(input));
      if (++calls !== 1) return response;
      // Old serving's conservative flag, on the same actual authorized route data.
      const body = await response.json() as Record<string, unknown>;
      return Response.json({ ...body, incomplete: true });
    }, { preconnect() {} });
    const surfaces = await listAuthorizedUiSurfaces(WORKSPACE, {
      capsuleId: MINE, fetch: transport, onIncomplete: () => { warned++; },
    });
    expect(surfaces).toHaveLength(6);
    expect(calls).toBe(2);
    expect(warned).toBe(1);
  });

  test("aggregate completion preserves the hard account enumeration warning after all screen pages", async () => {
    const h = await fixture({ extraOwnSurfaces: 5, endlessAppPages: true });
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) =>
      await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId);
    let warned = 0;
    let calls = 0;
    const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
      calls++;
      return await h.readResponse(h.headers.session(OWNER), String(input));
    }, { preconnect() {} });
    expect(await listAuthorizedUiSurfaces(WORKSPACE, { capsuleId: MINE, fetch: transport, onIncomplete: () => { warned++; } })).toHaveLength(6);
    expect([calls, warned]).toEqual([2, 1]);
  });

  for (const mode of ["empty", "repeated", "malformed"] as const) {
    test(`aggregate completion preserves ${mode} inner-cursor loss`, async () => {
      const h = await fixture({ extraOwnSurfaces: 1 });
      const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
      let reads = 0;
      h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) => {
        reads++;
        // Keep the real current Binding projection; inject only the broken store continuation.
        const page = await read(filter, subject, permission, { limit: 1 }, capsuleId);
        return { ...page, nextCursor: mode === "empty" ? "" : mode === "repeated" ? page.nextCursor : `bad-store-cursor-${reads}` };
      };
      let warned = 0;
      let calls = 0;
      const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
        calls++;
        return await h.readResponse(h.headers.session(OWNER), String(input));
      }, { preconnect() {} });
      const surfaces = await listAuthorizedUiSurfaces(WORKSPACE, { capsuleId: MINE, fetch: transport, onIncomplete: () => { warned++; } });
      expect(surfaces.length).toBeGreaterThan(0);
      expect(surfaces.every((item) => item.capsuleId === MINE && item.url.startsWith("https://"))).toBe(true);
      expect([calls, warned, reads]).toEqual([1, 1, mode === "empty" ? 1 : mode === "repeated" ? 2 : 5]);
    });
  }

  for (const status of [403, 404, 503]) {
    test(`aggregate completion rejects a later ${status} without fallback or an incomplete-success callback`, async () => {
      const h = await fixture({ extraOwnSurfaces: 5 });
      const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
      h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) =>
        await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId);
      const paths: string[] = [];
      let warned = 0;
      const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL) => {
        const path = String(input); paths.push(path);
        return paths.length === 1 ? await h.readResponse(h.headers.session(OWNER), path) : Response.json({ error: "fixture transport failure" }, { status });
      }, { preconnect() {} });
      await expect(listAuthorizedUiSurfaces(WORKSPACE, { capsuleId: MINE, fetch: transport, onIncomplete: () => { warned++; } })).rejects.toThrow(`Interface API request failed (${status})`);
      expect(paths).toHaveLength(2);
      expect(paths.every((path) => path.startsWith("/api/v1/ui-surfaces?"))).toBe(true);
      expect(warned).toBe(0);
    });
  }

  test("inner resume keeps a sixth page reachable without redelivering completed apps", async () => {
    const h = await fixture({ extraOwnSurfaces: 5 });
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    let reads = 0;
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) => {
      expect(subject).toBe(OWNER);
      expect(permission).toBe("ui.open");
      reads++;
      // Exercise the real store keyset and current Binding join with six small pages.
      return await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId);
    };
    const credential = h.headers.session(OWNER);
    const first = await h.list(credential, "?limit=2");
    expect(first.status).toBe(200);
    expect(first.ids).toHaveLength(6);
    expect(first.owners).toEqual([...Array(5).fill(MINE), SHARED]);
    expect(first.incomplete).toBeUndefined();
    expect(reads).toBe(6); // Five pages for MINE; the reserved first read for SHARED.
    expect(first.nextCursor).toBeString();
    reads = 0;
    const second = await h.list(credential, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.status).toBe(200);
    expect(second.owners).toEqual([MINE]);
    expect(second.incomplete).toBeUndefined();
    expect(second.nextCursor).toBeUndefined();
    expect(reads).toBe(1);
    const delivered = [...first.ids, ...second.ids];
    expect(new Set(delivered).size).toBe(7);
    expect([...delivered].sort()).toEqual([h.surfaces[MINE]!, ...h.extraSurfaces, h.surfaces[SHARED]!].sort());
  });

  test("inner resume round-trips fifty app keysets through normal GET and a changed page limit", async () => {
    const h = await fixture();
    const base = await h.ledger.getCapsule(MINE);
    const appIds = [MINE, SHARED];
    for (let index = 0; index < 48; index++) {
      const id = `cap_${String(index).padStart(20, "0")}`;
      appIds.push(id);
      await h.ledger.putCapsule({ ...base!, id, name: id, slug: id });
      expect(await h.core.appOwnership.initializeOwnershipIfMissing({
        capsuleId: id, ownerAccountId: OWNER, ownershipEpoch: 0, managementState: "active", managementEpoch: 0, storageRoot: `apps/${id}`,
      })).toBe(true);
    }
    for (const [index, capsuleId] of appIds.entries()) {
      for (let ordinal = 0; ordinal < (index < 2 ? 1 : 2); ordinal++) {
        const iface = await h.core.interfaces.create({
          workspaceId: WORKSPACE, name: `resume-${index}-${ordinal}`, ownerRef: { kind: "Capsule", id: capsuleId },
          spec: {
            type: "interface.ui.surface", version: "1", document: { launcher: true },
            inputs: { url: { source: "literal", value: `https://resume-${index}-${ordinal}.example.test` } },
            access: { visibility: "workspace" },
          },
        });
        await h.core.interfaces.createBinding(iface.metadata.id, {
          subjectRef: { kind: "Principal", id: OWNER }, permissions: ["ui.open"], delivery: { type: "none" },
        });
      }
    }
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    let reads = 0;
    let active = 0;
    let peak = 0;
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) => {
      reads++;
      peak = Math.max(peak, ++active);
      try { return await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId); }
      finally { active--; }
    };
    const credential = h.headers.session(OWNER);
    const first = await h.list(credential, "?limit=50");
    expect([first.status, reads, first.ids.length, new Set(first.owners).size]).toEqual([200, 50, 50, 50]);
    expect(first.incomplete).toBeUndefined();
    expect(first.nextCursor).toBeString();
    const payload = JSON.parse(decodeCursor(first.nextCursor)!.id) as { pending: unknown[] };
    expect(payload.pending).toHaveLength(50);
    console.info(JSON.stringify({ observation: "launcher-inner-resume", apps: 50, cursorBytes: new TextEncoder().encode(first.nextCursor!).byteLength }));
    reads = 0;
    const second = await h.list(credential, `?limit=1&cursor=${first.nextCursor}`);
    expect([second.status, reads, second.ids.length]).toEqual([200, 1, 1]);
    expect(second.nextCursor).toBeString();
    reads = 0;
    const third = await h.list(credential, `?limit=50&cursor=${second.nextCursor}`);
    expect([third.status, reads, third.ids.length]).toEqual([200, 49, 49]);
    expect(third.nextCursor).toBeUndefined();
    expect(third.incomplete).toBeUndefined();
    const delivered = [...first.ids, ...second.ids, ...third.ids];
    expect(delivered).toHaveLength(100);
    expect(new Set(delivered).size).toBe(100);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  test("inner resume joins its pending keyset back to the outer app cursor", async () => {
    const h = await fixture({ extraOwnSurfaces: 5 });
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) =>
      await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId);
    const credential = h.headers.session(OWNER);
    const first = await h.list(credential, "?limit=1");
    expect(first.ids).toHaveLength(5);
    expect(first.nextCursor).toBeString();
    const second = await h.list(credential, `?limit=1&cursor=${first.nextCursor}`);
    expect(second.owners).toEqual([MINE]);
    expect(second.nextCursor).toBeString();
    const third = await h.list(credential, `?limit=1&cursor=${second.nextCursor}`);
    expect(third.owners).toEqual([SHARED]);
    expect(third.nextCursor).toBeUndefined();
    expect(new Set([...first.ids, ...second.ids, ...third.ids]).size).toBe(7);
  });

  test("inner resume rechecks the current Principal Binding and current app scope", async () => {
    const h = await fixture({ extraOwnSurfaces: 5 });
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    const subjects: string[] = [];
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) => {
      subjects.push(subject);
      return await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId);
    };
    const query = `?capsuleId=${MINE}&limit=1`;
    const first = await h.list(h.headers.session(OWNER), query);
    expect(first.nextCursor).toBeString();
    const remaining = [h.surfaces[MINE]!, ...h.extraSurfaces].find((id) => !first.ids.includes(id))!;
    const bindings = await h.core.interfaces.listBindings(remaining);
    const binding = bindings.find((item) => item.spec.subjectRef.id === OWNER)!;
    await h.core.interfaces.revokeBinding(remaining, binding.metadata.id);
    const continuation = `${query}&cursor=${first.nextCursor}`;
    const second = await h.list(h.headers.session(OWNER), continuation);
    expect(second.status).toBe(200);
    expect(second.ids).toEqual([]);
    expect(second.nextCursor).toBeUndefined();
    // Replaying a position cannot supply app scope to another Principal or PAT.
    subjects.length = 0;
    expect((await h.list(h.headers.session(STRANGER), continuation)).ids).toEqual([]);
    expect((await h.list(h.headers.pat(OWNER, { appIds: [SHARED] }), continuation)).ids).toEqual([]);
    expect(subjects).toEqual([]);
    const denied = await h.list(h.headers.pat(OWNER, { workspaceId: WORKSPACE }), continuation);
    expect([denied.status, denied.code]).toEqual([403, "app_access_denied"]);
    const capsule = await h.ledger.getCapsule(MINE);
    await h.ledger.putCapsule({ ...capsule!, status: "disabled" });
    expect((await h.list(h.headers.session(OWNER), continuation)).ids).toEqual([]);
    expect(subjects).toEqual([]);
  });

  test("inner resume rejects malformed store positions and changed filter without candidate reads", async () => {
    const h = await fixture({ extraOwnSurfaces: 5 });
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    let reads = 0;
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) => {
      reads++;
      return await read(filter, subject, permission, { ...params, limit: 1 }, capsuleId);
    };
    const credential = h.headers.session(OWNER);
    const first = await h.list(credential, `?capsuleId=${MINE}&limit=1`);
    expect(first.nextCursor).toBeString();
    const decoded = decodeCursor(first.nextCursor)!;
    const payload = JSON.parse(decoded.id) as { after: string; pending: [string, string][]; capsuleId: string | null };
    reads = 0;
    const badPayloads = [null, {}, { ...payload, after: "" }, { ...payload, pending: [] },
      { ...payload, pending: [["", payload.pending[0]![1]]] },
      { ...payload, pending: [[MINE, "not-a-keyset"]] },
      { ...payload, pending: [[MINE, encodeCursor({ createdAt: "", id: "" })]] },
      { ...payload, pending: [payload.pending[0], payload.pending[0]] },
      { ...payload, pending: Array(51).fill(payload.pending[0]) }];
    for (const value of badPayloads) {
      const cursor = encodeCursor({ createdAt: decoded.createdAt, id: JSON.stringify(value) });
      expect((await h.list(credential, `?capsuleId=${MINE}&cursor=${cursor}`)).status).toBe(400);
    }
    expect((await h.list(credential, `?cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await h.list(credential, `?capsuleId=${SHARED}&cursor=${first.nextCursor}`)).status).toBe(400);
    expect(reads).toBe(0);
  });

  test("launcher candidate pages keep a covered app's later authorized screen reachable", async () => {
    const h = await fixture({ extraOwnSurfaces: 50 });
    const query = `?capsuleId=${MINE}&limit=1`;
    const owner = await h.list(h.headers.session(OWNER), query);
    expect(owner.status).toBe(200);
    expect(owner.ids).toHaveLength(51);
    expect(new Set(owner.ids).size).toBe(51);
    expect(owner.ids).toContain(h.extraSurfaces[49]!);
    expect(owner.nextCursor).toBeUndefined();
    expect(owner.incomplete).toBeUndefined();
    // App membership cannot substitute for the exact Principal Binding.
    expect((await h.list(h.headers.session(MEMBER), query)).ids).toEqual([h.surfaces[MINE]!]);
  });

  for (const mode of ["repeated", "endless"] as const) {
    test(`launcher candidate pages bound ${mode} continuation and report partial data`, async () => {
      const h = await fixture();
      const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
      let reads = 0;
      h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (filter, subject, permission, params, capsuleId) => {
        expect([filter.workspaceId, subject, permission, capsuleId]).toEqual([WORKSPACE, OWNER, "ui.open", MINE]);
        reads++;
        const page = await read(filter, subject, permission, { limit: params.limit }, capsuleId);
        return { ...page, nextCursor: mode === "repeated" ? "repeated-fixture-cursor" : `fixture-page-${reads}` };
      };
      const result = await h.list(h.headers.session(OWNER), `?capsuleId=${MINE}&limit=1`);
      expect(result.status).toBe(200);
      expect(result.incomplete).toBe(true);
      expect(result.ids).toEqual([h.surfaces[MINE]!]);
      expect(reads).toBe(mode === "repeated" ? 2 : 5);
    });
  }

  test("launcher candidate pages reserve every covered app's first page within the old request bound", async () => {
    const h = await fixture({ extraOwnSurfaces: 50 });
    const base = await h.ledger.getCapsule(MINE);
    expect(base).toBeDefined();
    for (let index = 0; index < 48; index++) {
      const id = `cap_launcher_window_${index}`;
      await h.ledger.putCapsule({ ...base!, id, name: id, slug: id });
      expect(await h.core.appOwnership.initializeOwnershipIfMissing({
        capsuleId: id, ownerAccountId: OWNER, ownershipEpoch: 0, managementState: "active", managementEpoch: 0, storageRoot: `apps/${id}`,
      })).toBe(true);
      const iface = await h.core.interfaces.create({
        workspaceId: WORKSPACE, name: `window-launcher-${index}`, ownerRef: { kind: "Capsule", id },
        spec: {
          type: "interface.ui.surface", version: "1", document: { launcher: true },
          inputs: { url: { source: "literal", value: `https://window-${index}.example.test` } },
          access: { visibility: "workspace" },
        },
      });
      await h.core.interfaces.createBinding(iface.metadata.id, {
        subjectRef: { kind: "Principal", id: OWNER }, permissions: ["ui.open"], delivery: { type: "none" },
      });
    }
    const read = h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage.bind(h.core.interfaces);
    let reads = 0;
    h.core.interfaces.listAuthorizedUiSurfaceCandidatesForPrincipalPage = async (...args) => { reads++; return await read(...args); };
    const result = await h.list(h.headers.session(OWNER), "?limit=50");
    expect(result.status).toBe(200);
    expect(new Set(result.owners).size).toBe(50);
    expect(reads).toBe(50);
    expect(result.incomplete).toBeUndefined();
  });

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
