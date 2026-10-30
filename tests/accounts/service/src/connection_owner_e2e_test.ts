/**
 * TASK-0118 P9.1-d: a Workspace-scoped Provider Connection is its owner's
 * connection. Workspace membership (even admin) neither lists, tests, revokes
 * nor lends it, and a Source that no app owns may use only its caller's own
 * connection. Routes, the Connection vault and the Control store use their
 * production implementations on each backend.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { D1AppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";
import {
  createCloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(120_000);

const OWNER = "user_connection_owner";
const ADMIN = "user_workspace_admin";
const BACKENDS = ["memory", "postgres", "d1"] as const;
type Backend = (typeof BACKENDS)[number];

const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function compose(backend: Backend) {
  let deployStore: OpenTofuControlStore;
  let sqlClient: PGliteSqlClient | undefined;
  let db: SqliteFakeD1 | undefined;
  if (backend === "memory") {
    deployStore = new InMemoryOpenTofuControlStore();
  } else if (backend === "postgres") {
    sqlClient = await PGliteSqlClient.create();
    clients.push(sqlClient);
    deployStore = new SqlOpenTofuControlStore({ client: sqlClient });
  } else {
    db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    deployStore = createCloudflareD1OpenTofuControlStore(db);
  }
  let next = 0;
  const vault = new StaticSecretConnectionVault({
    store: deployStore,
    crypto: new PartitionedSecretBoundaryCrypto({ globalPassphrase: `connection-owner-${backend}-passphrase-0123456789` }),
    newId: () => `conn_owner_e2e_${backend}_${++next}`,
    credentialRecipeResolver: (id) =>
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find((recipe) => recipe.id === id),
    credentialDrivers: REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
    sourceCredentialDrivers: REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.sourceCredentialDrivers,
  });
  const operations = (await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuConnectionVault: vault,
    ...(sqlClient ? { sqlClient } : {}),
    ...(db ? { appOwnershipStore: new D1AppOwnershipStore(db, deployStore) } : {}),
    ...REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
  })).operations as unknown as ControlPlaneOperations;
  const workspace = await operations.workspaces.createWorkspace!({
    handle: `connection-owner-${backend}`,
    displayName: "Connection owner",
    type: "personal",
    ownerUserId: OWNER,
  });
  const at = new Date().toISOString();
  await deployStore.putWorkspaceMember({
    id: `wsm_connection_owner_${backend}`, workspaceId: workspace.id, accountId: ADMIN, roles: ["admin"],
    status: "active", createdAt: at, updatedAt: at,
  });
  const accounts = new InMemoryAccountsStore();
  const now = Date.now();
  for (const subject of [OWNER, ADMIN]) {
    accounts.saveAccount({ subject: subject as never, email: `${subject}@example.test`, displayName: subject, createdAt: now, updatedAt: now });
    accounts.saveAccountSession({ sessionId: `sess_${backend}_${subject}`, subject: subject as never, createdAt: now, expiresAt: now + 10 * 60_000 });
  }
  async function route(subject: string, method: string, path: string, body?: unknown) {
    const url = new URL(`https://app.takosumi.test${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=sess_${backend}_${subject}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accounts,
      operations,
    });
    expect(response).toBeDefined();
    const text = await response!.text();
    // deno-lint-ignore no-explicit-any
    let json: any = undefined;
    try { json = JSON.parse(text); } catch { /* empty body */ }
    return { status: response!.status, json };
  }
  return { deployStore, operations, workspaceId: workspace.id, route };
}

const PROVIDER_CONNECTION = (workspaceId: string) => ({
  workspaceId,
  provider: "registry.opentofu.org/vercel/vercel",
  credentialRecipe: { id: "generic-env", authMode: "env", secretPartition: "provider-credentials" },
  displayName: "Owner's Vercel",
  values: { VERCEL_API_TOKEN: "owner-provider-token-fixture" },
});
const GIT_CONNECTION = (workspaceId: string) => ({
  workspaceId,
  kind: "source_git_https_token",
  displayName: "Owner's Git",
  scopeHints: { providerSettings: { repositoryUrl: "https://github.com/takos/example.git" } },
  values: { GIT_HTTPS_TOKEN: "owner-git-token-fixture" },
});

for (const backend of BACKENDS) {
  test(`[${backend}] a Workspace connection is its owner's: a Workspace admin cannot list, test, revoke or create one`, async () => {
    const fixture = await compose(backend);
    const created = await fixture.route(OWNER, "POST", "/api/v1/connections", PROVIDER_CONNECTION(fixture.workspaceId));
    expect(created.status).toBe(201);
    const connectionId = created.json.connection.id as string;
    expect(created.json.connection).toMatchObject({ scope: "workspace", ownerAccountId: OWNER, workspaceId: fixture.workspaceId });

    // Lists: each person sees only their own connections recording this Workspace.
    const ownerList = await fixture.route(OWNER, "GET", `/api/v1/connections?workspaceId=${fixture.workspaceId}`);
    expect(ownerList.status).toBe(200);
    expect((ownerList.json.connections as { id: string }[]).map((row) => row.id)).toEqual([connectionId]);
    const adminList = await fixture.route(ADMIN, "GET", `/api/v1/connections?workspaceId=${fixture.workspaceId}`);
    expect(adminList.status).toBe(200);
    expect(adminList.json.connections).toEqual([]);
    const adminInventory = await fixture.route(ADMIN, "GET", `/api/v1/provider-connections?workspaceId=${fixture.workspaceId}`);
    expect(adminInventory.status).toBe(200);
    expect((adminInventory.json.providerConnections as { id: string }[]).some((row) => row.id === connectionId)).toBe(false);
    const ownerInventory = await fixture.route(OWNER, "GET", `/api/v1/provider-connections?workspaceId=${fixture.workspaceId}`);
    expect((ownerInventory.json.providerConnections as { id: string }[]).map((row) => row.id)).toContain(connectionId);

    // Test and revoke: only the owner; anyone else gets the non-disclosing 404.
    for (const op of ["test", "revoke"] as const) {
      expect(await fixture.route(ADMIN, "POST", `/api/v1/connections/${connectionId}/${op}`))
        .toMatchObject({ status: 404, json: { error: { code: "connection_not_found" } } });
    }
    expect(await fixture.deployStore.getConnection(connectionId)).toBeDefined();
    expect(await fixture.route(OWNER, "POST", `/api/v1/connections/${connectionId}/test`)).toMatchObject({ status: 200 });

    // The vault records the Workspace owner as a Workspace row's owner, so an
    // admin creating one would hand its credential to someone else: refused.
    expect((await fixture.route(ADMIN, "POST", "/api/v1/connections", PROVIDER_CONNECTION(fixture.workspaceId))).status).toBe(403);

    expect((await fixture.route(OWNER, "POST", `/api/v1/connections/${connectionId}/revoke`)).status).toBe(204);
    expect(await fixture.deployStore.getConnection(connectionId)).toBeUndefined();
  });

  test(`[${backend}] a Source that no app owns uses only its caller's own connection`, async () => {
    const fixture = await compose(backend);
    const git = await fixture.route(OWNER, "POST", "/api/v1/connections", GIT_CONNECTION(fixture.workspaceId));
    expect(git.status, JSON.stringify(git.json)).toBe(201);
    const gitConnectionId = git.json.connection.id as string;
    const source = (body: Record<string, unknown>) => ({
      workspaceId: fixture.workspaceId, name: "example", url: "https://github.com/takos/example.git", ...body,
    });
    // An admin of the Workspace cannot attach the owner's credential.
    expect(await fixture.route(ADMIN, "POST", "/api/v1/sources", source({ authConnectionId: gitConnectionId })))
      .toMatchObject({ status: 400, json: { error: { message: "authConnectionId must be one of your own connections." } } });
    const created = await fixture.route(ADMIN, "POST", "/api/v1/sources", source({}));
    expect(created.status).toBe(201);
    const sourceId = created.json.source.id as string;
    expect(await fixture.route(ADMIN, "PATCH", `/api/v1/sources/${sourceId}`, { authConnectionId: gitConnectionId }))
      .toMatchObject({ status: 400, json: { error: { message: "authConnectionId must be one of your own connections." } } });
    expect((await fixture.operations.getSource(sourceId)).source.authConnectionId).toBeUndefined();
    // Its owner can.
    const patched = await fixture.route(OWNER, "PATCH", `/api/v1/sources/${sourceId}`, { authConnectionId: gitConnectionId });
    expect(patched.status).toBe(200);
    expect(patched.json.source.authConnectionId).toBe(gitConnectionId);
    const ownerCreated = await fixture.route(OWNER, "POST", "/api/v1/sources", source({ name: "owner-example", authConnectionId: gitConnectionId }));
    expect(ownerCreated.status).toBe(201);
    // Clearing the connection is not lending a credential.
    expect((await fixture.route(ADMIN, "PATCH", `/api/v1/sources/${sourceId}`, { authConnectionId: null })).status).toBe(200);
  });
}
