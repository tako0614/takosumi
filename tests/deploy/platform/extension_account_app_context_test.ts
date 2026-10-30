/**
 * TASK-0118 P9.1-e: platform extensions are decided by account and app.
 *
 * - A route may declare `appContext`: the `capsuleId` it names is bound to
 *   the caller's live owner/member role, and the handler receives the app and
 *   the role. A credential bound to one app names only that app.
 * - Account sessions and personal access tokens carry their account.
 * - The compatibility Workspace context (Hosted, until 9B) is decided by the
 *   account in-process: only the Workspace's owner may name it.
 *
 * The decisions read production stores (memory, Postgres, SQLite-D1).
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { Capsule } from "takosumi-contract/install-configs";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { D1AppOwnershipStore } from "../../../core/domains/app-ownership/store.ts";
import { DEFAULT_CAPSULE_INSTALL_CONFIG_ID } from "../../../core/domains/capsules/default_install_config.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../core/domains/deploy-control/store_sql.ts";
import type { OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
import { D1GitInstallPlanStore } from "../../../core/domains/install-plans/d1_store.ts";
import { InMemoryGitInstallPlanStore } from "../../../core/domains/install-plans/store.ts";
import { createD1InterfaceStores } from "../../../core/domains/interfaces/d1_stores.ts";
import { createSqlInterfaceStores } from "../../../core/domains/interfaces/sql_stores.ts";
import { defaultProjectId } from "../../../core/domains/projects/mod.ts";
import {
  createCloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
import {
  handlePlatformExtensionRouteRequest,
  platformExtensionAccountAppRole,
  platformExtensionAccountWorkspaceRole,
  platformExtensionCatalog,
  platformExtensionRoutes,
  verifyPlatformExtensionBearerToken,
  type PlatformExtensionAppAccess,
  type PlatformExtensionSessionContext,
} from "../../../deploy/platform/worker.ts";
import { PGliteSqlClient } from "../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(120_000);

const ORIGIN = "https://app.takosumi.test";
const OWNER = "tsub_app_owner";
const MEMBER = "tsub_app_member";
const STRANGER = "tsub_unrelated";
const APP = "cap_extension_app";
const OTHER_APP = "cap_other_app";

const ROUTE = {
  basePath: "/extensions/app",
  handlerKey: "APP_EXTENSION",
  appContext: "query-required",
} as const;

function sessionOf(
  overrides: Partial<PlatformExtensionSessionContext> = {},
): () => Promise<PlatformExtensionSessionContext> {
  return async () => ({
    authenticated: true,
    authKind: "session",
    subject: OWNER,
    ...overrides,
  });
}

/** Records forwarded headers or the typed context, and every app decision. */
function harness(roles: Readonly<Record<string, string | false>> = { [OWNER]: "owner", [MEMBER]: "member" }) {
  const forwarded: Record<string, string | null>[] = [];
  const contexts: unknown[] = [];
  const decided: string[] = [];
  const env = {
    APP_EXTENSION: {
      fetch: async (request: Request) => {
        forwarded.push(Object.fromEntries([
          "x-takosumi-platform-subject",
          "x-takosumi-platform-account-id",
          "x-takosumi-platform-capsule-id",
          "x-takosumi-platform-app-role",
          "x-takosumi-platform-workspace-id",
          "authorization",
        ].map((name) => [name, request.headers.get(name)])));
        return Response.json({ ok: true });
      },
      fetchAuthenticated: async (_request: Request, context: unknown) => {
        contexts.push(context);
        return Response.json({ ok: true });
      },
    },
  } as never;
  const appAccess: PlatformExtensionAppAccess = async (_request, _env, capsuleId, session) => {
    decided.push(`${session.subject}:${capsuleId}`);
    if (capsuleId !== APP) return false;
    const role = roles[session.subject ?? ""];
    return role === "owner" || role === "member" ? role : false;
  };
  return { env, appAccess, forwarded, contexts, decided };
}

async function call(
  h: ReturnType<typeof harness>,
  path: string,
  session: () => Promise<PlatformExtensionSessionContext>,
  route: Parameters<typeof handlePlatformExtensionRouteRequest>[2] = ROUTE,
  init: RequestInit = {},
) {
  return await handlePlatformExtensionRouteRequest(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        authorization: "Bearer raw",
        "x-takosumi-platform-app-role": "owner",
        "x-takosumi-platform-account-id": "tsub_forged",
        "x-takosumi-platform-capsule-id": "cap_forged",
        ...(init.headers ?? {}),
      },
    }),
    h.env,
    route,
    session,
    async () => false,
    h.appAccess,
  );
}

test("routes may declare appContext; handler-auth routes and unknown modes are refused; the catalog shows it", () => {
  const routes = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      { basePath: "/extensions/app", handlerKey: "APP_EXTENSION", appContext: "query-optional" },
    ]),
  });
  expect(routes[0]?.appContext).toBe("query-optional");
  for (const descriptor of [
    { basePath: "/extensions/app", handlerKey: "APP_EXTENSION", appContext: "query-required", authMode: "handler" },
    { basePath: "/extensions/app", handlerKey: "APP_EXTENSION", appContext: "header" },
  ]) {
    expect(() => platformExtensionRoutes({ TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([descriptor]) })).toThrow();
  }
  expect(() => platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      { basePath: "/extensions/app", handlerKey: "APP_EXTENSION", appContext: "query-required" },
      { basePath: "/extensions/app", handlerKey: "APP_EXTENSION" },
    ]),
  })).toThrow("multiple owners");
  const catalog = platformExtensionCatalog({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      { basePath: "/extensions/app", handlerKey: "APP_EXTENSION", appContext: "query-required" },
    ]),
    APP_EXTENSION: { fetch: () => new Response(null) },
  } as never, ORIGIN);
  expect(catalog.extensions[0]?.appContext).toBe("query-required");
});

test("an owner or member names the app and the handler receives the app, the live role and the account", async () => {
  const h = harness();
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, sessionOf())).status).toBe(200);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, sessionOf({ subject: MEMBER }))).status).toBe(200);
  expect(h.forwarded).toEqual([
    {
      "x-takosumi-platform-subject": OWNER,
      "x-takosumi-platform-account-id": OWNER,
      "x-takosumi-platform-capsule-id": APP,
      "x-takosumi-platform-app-role": "owner",
      "x-takosumi-platform-workspace-id": null,
      authorization: null,
    },
    {
      "x-takosumi-platform-subject": MEMBER,
      "x-takosumi-platform-account-id": MEMBER,
      "x-takosumi-platform-capsule-id": APP,
      "x-takosumi-platform-app-role": "member",
      "x-takosumi-platform-workspace-id": null,
      authorization: null,
    },
  ]);

  // The typed context seam carries the same facts.
  const contextRoute = { ...ROUTE, authDelivery: "context" as const };
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, sessionOf({ subject: MEMBER }), contextRoute)).status)
    .toBe(200);
  expect(h.contexts).toEqual([{
    authKind: "session",
    subject: MEMBER,
    accountId: MEMBER,
    capsuleId: APP,
    appRole: "member",
  }]);
});

test("an unrelated account, another app, a missing or malformed capsuleId and an unavailable decision are refused before dispatch", async () => {
  const h = harness();
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, sessionOf({ subject: STRANGER }))).status).toBe(403);
  expect((await call(h, `/extensions/app/items?capsuleId=${OTHER_APP}`, sessionOf())).status).toBe(403);
  expect((await call(h, "/extensions/app/items", sessionOf())).status).toBe(400);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}&capsuleId=${APP}`, sessionOf())).status).toBe(400);
  expect((await call(h, "/extensions/app/items?capsuleId=cap%20bad", sessionOf())).status).toBe(400);
  const unavailable = await handlePlatformExtensionRouteRequest(
    new Request(`${ORIGIN}/extensions/app/items?capsuleId=${APP}`),
    h.env,
    ROUTE,
    sessionOf(),
    async () => false,
    async () => ({ kind: "unavailable" }),
  );
  expect(unavailable.status).toBe(503);
  expect(h.forwarded).toEqual([]);
  // An optional context dispatches without an app when none is named.
  expect((await call(h, "/extensions/app/items", sessionOf(), { ...ROUTE, appContext: "query-optional" })).status)
    .toBe(200);
  expect(h.forwarded).toEqual([{
    "x-takosumi-platform-subject": OWNER,
    "x-takosumi-platform-account-id": OWNER,
    "x-takosumi-platform-capsule-id": null,
    "x-takosumi-platform-app-role": null,
    "x-takosumi-platform-workspace-id": null,
    authorization: null,
  }]);
});

test("a personal access token restricted to apps names only its apps; an account-wide one gets the account's role", async () => {
  const h = harness();
  const pat = (appIds?: readonly string[], extra: Partial<PlatformExtensionSessionContext> = {}) => sessionOf({
    authKind: "personal-access-token",
    scopes: ["read"],
    ...(appIds ? { appIds } : {}),
    ...extra,
  });
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat([OTHER_APP]))).status).toBe(403);
  // An empty list is a deny-all snapshot, never "unrestricted".
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat([]))).status).toBe(403);
  expect(h.decided).toEqual([]);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat([APP]))).status).toBe(200);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat())).status).toBe(200);
  // A Workspace-bound token (introspected binding) keeps its restriction.
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat(undefined, { workspaceId: "ws_bound" }))).status)
    .toBe(200);
  expect(h.forwarded.map((headers) => headers["x-takosumi-platform-app-role"])).toEqual(["owner", "owner", "owner"]);
  // Only the unrestricted token carries the account.
  expect(h.forwarded.map((headers) => headers["x-takosumi-platform-account-id"])).toEqual([null, OWNER, null]);
});

test("a personal access token gets an app role only with the core scope Accounts requires for the method", async () => {
  const h = harness();
  const pat = (scopes: readonly string[]) => sessionOf({ authKind: "personal-access-token", scopes });
  // The route itself requires no scope, so only the app decision can refuse.
  const post = { method: "POST", body: "{}" };
  const route = { ...ROUTE, requiredScopes: [] as string[] };
  // Extension-only and read-only scopes never confer a role for a change.
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat(["ai.chat"]), route, post)).status).toBe(403);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat(["read"]), route, post)).status).toBe(403);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat(["ai.chat"]), route)).status).toBe(403);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat(["write"]), route)).status).toBe(403);
  expect(h.decided).toEqual([]);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat(["write"]), route, post)).status).toBe(200);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat(["admin"]), route, post)).status).toBe(200);
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, pat(["read"]), route)).status).toBe(200);
  expect(h.forwarded.map((headers) => headers["x-takosumi-platform-app-role"])).toEqual(["owner", "owner", "owner"]);
  // A browser session has no scopes and is decided by its role alone (its
  // change still needs the issuer Origin, as before).
  expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, sessionOf({ subject: MEMBER }), route, {
    ...post, headers: { origin: ORIGIN },
  })).status).toBe(200);
});

test("app-bound credentials (installed app, delegate, Interface, Run) name only their own app and gain no role or account", async () => {
  const h = harness();
  for (const session of [
    sessionOf({ authKind: "oauth-access-token", subject: "pairwise_app", capsuleId: APP, scopes: ["capsules:read"] }),
    // A designated delegate app's token (Takos) is still one app's token here.
    sessionOf({ authKind: "oauth-access-token", subject: "pairwise_takos", capsuleId: "cap_takos", scopes: ["capsules:read"] }),
    sessionOf({ authKind: "interface-oauth-token", subject: "pairwise_iface", capsuleId: APP }),
    sessionOf({ authKind: "run-credential", subject: OWNER, capsuleId: APP, workspaceId: "ws_run" }),
  ]) {
    await call(h, `/extensions/app/items?capsuleId=${APP}`, session);
    expect((await call(h, `/extensions/app/items?capsuleId=${OTHER_APP}`, session)).status).toBe(403);
  }
  expect(h.decided).toEqual([]);
  // The delegate's request for another app was refused; the others reached
  // the handler with their bound app only.
  expect(h.forwarded.map((headers) => [
    headers["x-takosumi-platform-capsule-id"],
    headers["x-takosumi-platform-app-role"],
    headers["x-takosumi-platform-account-id"],
  ])).toEqual([[APP, null, null], [APP, null, null], [APP, null, null]]);
  // Operator service tokens and unbound OAuth tokens cannot name an app.
  for (const session of [
    sessionOf({ authKind: "service-token", subject: "takosumi:deploy-control", scopes: ["admin"] }),
    sessionOf({ authKind: "oauth-access-token", subject: OWNER, scopes: ["capsules:read"] }),
  ]) {
    expect((await call(h, `/extensions/app/items?capsuleId=${APP}`, session)).status).toBe(403);
  }
});

test("a personal access token's app restriction survives introspection; a malformed list refuses the token", async () => {
  const introspected = (body: Record<string, unknown>) =>
    verifyPlatformExtensionBearerToken(
      new Request(`${ORIGIN}/extensions/app`),
      { TAKOSUMI_ACCOUNTS_CLIENT_ID: "client", TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "secret" } as never,
      "opaque",
      undefined,
      async () => Response.json({ active: true, token_use: "personal_access", scope: "read", sub: OWNER, ...body }),
    );
  expect(await introspected({ app_ids: [APP] })).toEqual({
    authenticated: true, authKind: "personal-access-token", subject: OWNER, appIds: [APP], scopes: ["read"],
  });
  expect(await introspected({ app_ids: [] })).toEqual({
    authenticated: true, authKind: "personal-access-token", subject: OWNER, appIds: [], scopes: ["read"],
  });
  expect(await introspected({})).toEqual({
    authenticated: true, authKind: "personal-access-token", subject: OWNER, scopes: ["read"],
  });
  // Up to the stored PAT limit is accepted; only malformed values refuse.
  const many = Array.from({ length: 10_000 }, (_, i) => `cap_${i}`);
  expect((await introspected({ app_ids: many })).appIds).toHaveLength(10_000);
  // An id up to the stored length (256) is accepted, longer than other ids.
  const long = `cap_${"a".repeat(252)}`;
  expect((await introspected({ app_ids: [long] })).appIds).toEqual([long]);
  for (const appIds of ["cap_one", [1], [""], ["cap bad"], [`${long}a`], [...many, "cap_extra"]]) {
    expect(await introspected({ app_ids: appIds })).toEqual({ authenticated: false });
  }
});

test("an app context is not a legacy Workspace use; a Workspace the same route selects is still counted", async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  const h = harness();
  const route = { ...ROUTE, appContext: "query-optional" as const, workspaceContext: "query-optional" as const };
  try {
    const appOnly = await handlePlatformExtensionRouteRequest(
      new Request(`${ORIGIN}/extensions/app/items?capsuleId=${APP}`),
      h.env, route, sessionOf(), async () => "owner", h.appAccess,
    );
    expect(appOnly.status).toBe(200);
    expect(appOnly.headers.get("Deprecation")).toBeNull();
    const both = await handlePlatformExtensionRouteRequest(
      new Request(`${ORIGIN}/extensions/app/items?capsuleId=${APP}&workspaceId=ws_owner`),
      h.env, route, sessionOf(), async () => "owner", h.appAccess,
    );
    expect(both.status).toBe(200);
    expect(both.headers.get("Deprecation")).not.toBeNull();
  } finally {
    console.info = original;
  }
  const events = lines.filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event === "legacy_workspace_route");
  expect(events).toEqual([expect.objectContaining({
    surface: "platform_extension_workspace", selector: "query", status: 200, credential: "session",
  })]);
  expect(lines.join("\n")).not.toContain(APP);
  expect(h.forwarded.map((headers) => headers["x-takosumi-platform-workspace-id"])).toEqual([null, "ws_owner"]);
});

const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const runner: OpenTofuRunner = {
  plan: async () => { throw new Error("outside this test"); },
  apply: async () => { throw new Error("outside this test"); },
  sourceSync: async () => { throw new Error("outside this test"); },
  readCapsuleSourceFiles: async () => [],
};

async function compose(backend: "memory" | "postgres" | "d1") {
  const common = {
    role: "takosumi-api" as const,
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuRunner: runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  };
  let deployStore: OpenTofuControlStore;
  let operations: ControlPlaneOperations;
  if (backend === "memory") {
    const memory = new InMemoryOpenTofuControlStore();
    const gitInstallPlanStore = new InMemoryGitInstallPlanStore(memory);
    memory.attachGitInstallPlanStore(gitInstallPlanStore);
    deployStore = memory;
    operations = (await createTakosumiService({ ...common, opentofuControlStore: memory, gitInstallPlanStore }))
      .operations as unknown as ControlPlaneOperations;
  } else if (backend === "postgres") {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    deployStore = new SqlOpenTofuControlStore({ client });
    operations = (await createTakosumiService({
      ...common, sqlClient: client, opentofuControlStore: deployStore, interfaceStores: createSqlInterfaceStores(client),
    })).operations as unknown as ControlPlaneOperations;
  } else {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    deployStore = createCloudflareD1OpenTofuControlStore(db);
    operations = (await createTakosumiService({
      ...common,
      opentofuControlStore: deployStore,
      appOwnershipStore: new D1AppOwnershipStore(db, deployStore),
      gitInstallPlanStore: new D1GitInstallPlanStore(db),
      interfaceStores: createD1InterfaceStores(db),
    })).operations as unknown as ControlPlaneOperations;
  }
  // OWNER's Workspace, where MEMBER is also a legacy Workspace admin.
  const workspace = await operations.workspaces.createWorkspace!({
    handle: `extension-owner-${backend}`, displayName: "Owner", type: "personal", ownerUserId: OWNER,
  });
  const otherWorkspace = await operations.workspaces.createWorkspace!({
    handle: `extension-other-${backend}`, displayName: "Other", type: "personal", ownerUserId: STRANGER,
  });
  const at = new Date().toISOString();
  await deployStore.putWorkspaceMember({
    id: `wsm_extension_${backend}`, workspaceId: workspace.id, accountId: MEMBER, roles: ["admin"],
    status: "active", createdAt: at, updatedAt: at,
  });
  for (const [id, workspaceId, owned] of [
    [APP, workspace.id, true],
    [OTHER_APP, otherWorkspace.id, true],
    ["cap_unowned", workspace.id, false],
  ] as const) {
    const capsule: Capsule = {
      id, workspaceId, projectId: defaultProjectId(workspaceId), name: id.replaceAll("_", "-"),
      slug: id.replaceAll("_", "-"), environment: "production", sourceId: `src_${id}`,
      installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID, installingPrincipalId: OWNER,
      currentStateGeneration: 1, status: "active", createdAt: at, updatedAt: at,
    };
    await deployStore.putCapsule(capsule);
    if (owned) {
      expect(await operations.appOwnership!.initializeOwnershipIfMissing({
        capsuleId: id, ownerAccountId: id === APP ? OWNER : STRANGER, ownershipEpoch: 0,
        managementState: "active", managementEpoch: 0, storageRoot: `apps/${id}`,
      })).toBe(true);
    }
  }
  expect(await operations.appOwnership!.putMember({
    capsuleId: APP, accountId: MEMBER, status: "active", createdAt: at, updatedAt: at,
  })).toBe(true);
  return { operations, workspace, otherWorkspace };
}

for (const backend of ["memory", "postgres", "d1"] as const) {
  test(`[${backend}] the app decision is the live per-app role, narrowed by a bound Workspace`, async () => {
    const { operations, workspace, otherWorkspace } = await compose(backend);
    const role = (subject: string, capsuleId: string, extra: Partial<PlatformExtensionSessionContext> = {}) =>
      platformExtensionAccountAppRole(capsuleId, { authenticated: true, authKind: "session", subject, ...extra }, operations);
    expect(await role(OWNER, APP)).toBe("owner");
    expect(await role(MEMBER, APP)).toBe("member");
    expect(await role(STRANGER, APP)).toBe(false);
    expect(await role(OWNER, OTHER_APP)).toBe(false);
    // An app without an ownership row keeps the resolver's rollout fallback,
    // as Accounts' own per-app decision does: its Workspace owner is owner.
    expect(await role(OWNER, "cap_unowned")).toBe("owner");
    expect(await role(STRANGER, "cap_unowned")).toBe(false);
    expect(await role(OWNER, "cap_missing")).toBe(false);
    // A Workspace-bound credential reaches only apps in its Workspace.
    expect(await role(OWNER, APP, { workspaceId: workspace.id })).toBe("owner");
    expect(await role(OWNER, APP, { workspaceId: otherWorkspace.id })).toBe(false);
    // A shared-account session must also pass the shared-auth app view.
    const views: unknown[] = [];
    const shared = (allowed: boolean) =>
      platformExtensionAccountAppRole(
        APP,
        { authenticated: true, authKind: "session", subject: MEMBER, sharedAccount: true },
        operations,
        async (_request, _env, capsuleId, options) => {
          views.push([capsuleId, options?.sharedAccount]);
          return allowed ? workspace.id : undefined;
        },
      );
    expect(await shared(false)).toBe(false);
    expect(await shared(true)).toBe("member");
    expect(views).toEqual([[APP, true], [APP, true]]);
  });

  test(`[${backend}] the compatibility Workspace is decided by its owner account; membership no longer grants it`, async () => {
    const { operations, workspace } = await compose(backend);
    const decide = (session: Partial<PlatformExtensionSessionContext>) =>
      platformExtensionAccountWorkspaceRole(workspace.id, { authenticated: true, authKind: "session", ...session }, operations);
    expect(await decide({ subject: OWNER })).toBe("owner");
    // MEMBER is an active Workspace admin and an app member: still refused.
    expect(await decide({ subject: MEMBER })).toBe(false);
    expect(await decide({ subject: STRANGER })).toBe(false);
    // The Accounts route's credential gates are kept for tokens.
    expect(await decide({ subject: OWNER, authKind: "personal-access-token", scopes: ["read"] })).toBe("owner");
    expect(await decide({ subject: OWNER, authKind: "personal-access-token", scopes: ["admin"] })).toBe("owner");
    expect(await decide({ subject: OWNER, authKind: "personal-access-token", scopes: ["ai.chat"] })).toBe(false);
    expect(await decide({ subject: OWNER, authKind: "personal-access-token", scopes: ["read"], appIds: [APP] })).toBe(false);
    expect(await decide({ subject: OWNER, authKind: "oauth-access-token", scopes: ["capsules:read"] })).toBe(false);
    expect(await platformExtensionAccountWorkspaceRole(
      "ws_missing", { authenticated: true, authKind: "session", subject: OWNER }, operations,
    )).toBe(false);
  });
}
