/**
 * TASK-0118 P9.1-b, from the independent authority review's probe: a Takos
 * member (added without consent) gets nothing through the Takos token, the
 * owner's token reaches no unmarked app outside its own Workspace rules, a
 * client can never write the delegate mark, and another account's delegate
 * cannot read a user's plan. Production services on every backend.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { Capsule } from "takosumi-contract/install-configs";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { requireAppAccess } from "../../../../accounts/service/src/control/app-authorization.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import type { InstalledAppDelegationSource } from "../../../../accounts/service/src/installed-app-delegation.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { D1AppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { DEFAULT_CAPSULE_INSTALL_CONFIG_ID } from "../../../../core/domains/capsules/default_install_config.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import type { OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import { D1GitInstallPlanStore } from "../../../../core/domains/install-plans/d1_store.ts";
import { InMemoryGitInstallPlanStore } from "../../../../core/domains/install-plans/store.ts";
import { createD1InterfaceStores } from "../../../../core/domains/interfaces/d1_stores.ts";
import { createSqlInterfaceStores } from "../../../../core/domains/interfaces/sql_stores.ts";
import { defaultProjectId } from "../../../../core/domains/projects/mod.ts";
import {
  createCloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(120_000);

const OPERATOR = "user_takos_operator";
const USER = "user_delegated_installer";
const STRANGER = "user_no_takos_role";
const TAKOS = "cap_takos_delegate";
const THIRD_PARTY = "cap_third_party_app";
const USER_APP = "cap_user_own_app";
const OPERATOR_ORG_APP = "cap_operator_org_app";
const TAKOS_SOURCE = "src_takos_delegate";
const TAKOS_SNAPSHOT = "snap_takos_delegate";
const DELEGATE_SOURCE: InstalledAppDelegationSource = {
  url: "https://git.example.test/first-party/takos", path: ".", refs: ["refs/heads/main"],
};
const BACKENDS = ["memory", "postgres", "d1"] as const;
type Backend = (typeof BACKENDS)[number];

const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const runner: OpenTofuRunner = {
  plan: async () => { throw new Error("Plan execution is outside this test"); },
  apply: async () => { throw new Error("Apply execution is outside this test"); },
  sourceSync: async () => ({
    resolvedCommit: "a".repeat(40),
    archiveDigest: `sha256:${"b".repeat(64)}`,
    archiveSizeBytes: 64,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
    },
  }),
  readCapsuleSourceFiles: async () => [{
    path: "main.tf",
    text: "output \"ready\" { value = \"yes\" }\n",
  }],
};

async function compose(backend: Backend) {
  const common = {
    role: "takosumi-api" as const,
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuRunner: runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  };
  let deployStore: OpenTofuControlStore;
  let core: ControlPlaneOperations;
  if (backend === "memory") {
    const memory = new InMemoryOpenTofuControlStore();
    const gitInstallPlanStore = new InMemoryGitInstallPlanStore(memory);
    memory.attachGitInstallPlanStore(gitInstallPlanStore);
    deployStore = memory;
    core = (await createTakosumiService({ ...common, opentofuControlStore: memory, gitInstallPlanStore }))
      .operations as unknown as ControlPlaneOperations;
  } else if (backend === "postgres") {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    deployStore = new SqlOpenTofuControlStore({ client });
    core = (await createTakosumiService({
      ...common,
      sqlClient: client,
      opentofuControlStore: deployStore,
      interfaceStores: createSqlInterfaceStores(client),
    })).operations as unknown as ControlPlaneOperations;
  } else {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    deployStore = createCloudflareD1OpenTofuControlStore(db);
    core = (await createTakosumiService({
      ...common,
      opentofuControlStore: deployStore,
      appOwnershipStore: new D1AppOwnershipStore(db, deployStore),
      gitInstallPlanStore: new D1GitInstallPlanStore(db),
      interfaceStores: createD1InterfaceStores(db),
    })).operations as unknown as ControlPlaneOperations;
  }
  // Takos lives in its operator's Workspace; the installing user is only a
  const takosWorkspace = await core.workspaces.createWorkspace!({
    handle: `takos-operator-${backend}`,
    displayName: "Takos operator",
    type: "personal",
    ownerUserId: OPERATOR,
  });
  // The member's own personal Workspace and an org Workspace owned by someone else.
  const userWorkspace = await core.workspaces.createWorkspace!({
    handle: `user-personal-${backend}`, displayName: "User", type: "personal", ownerUserId: USER,
  });
  const orgWorkspace = await core.workspaces.createWorkspace!({
    handle: `org-${backend}`, displayName: "Org", type: "personal", ownerUserId: STRANGER,
  });
  const at = new Date().toISOString();
  const put = async (id: string, workspaceId: string, owner: string, sourceId: string) => {
    const capsule: Capsule = {
      id, workspaceId, projectId: defaultProjectId(workspaceId), name: id.replaceAll("_", "-"), slug: id.replaceAll("_", "-"),
      environment: "production", sourceId, installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID, installingPrincipalId: owner,
      currentStateGeneration: 1, status: "active", createdAt: at, updatedAt: at,
    };
    await deployStore.putCapsule(capsule);
    expect(await core.appOwnership!.initializeOwnershipIfMissing({
      capsuleId: id, ownerAccountId: owner, ownershipEpoch: 0, managementState: "active", managementEpoch: 0, storageRoot: `apps/${id}`,
    })).toBe(true);
  };
  // Takos: owned by the operator, USER silently added as member (addMember needs no acceptance).
  await put(TAKOS, takosWorkspace.id, OPERATOR, TAKOS_SOURCE);
  expect(await core.appOwnership!.putMember({ capsuleId: TAKOS, accountId: USER, status: "active", createdAt: at, updatedAt: at })).toBe(true);
  // USER's own app, installed directly by USER in USER's own namespace (never through Takos).
  await put(USER_APP, userWorkspace.id, USER, "src_user_app");
  // The operator's own app living in another (org) Workspace.
  await put(OPERATOR_ORG_APP, orgWorkspace.id, OPERATOR, "src_operator_org_app");
  const getSource = core.getSource.bind(core);
  const getSourceSnapshot = core.getSourceSnapshot.bind(core);
  const getAdopted = core.getCapsuleAdoptedSourceRevision.bind(core);
  const operations = {
    ...core,
    getSource: async (id: string) => id === TAKOS_SOURCE
      ? { source: { id, workspaceId: takosWorkspace.id, ownerCapsuleId: TAKOS, name: "takos", url: DELEGATE_SOURCE.url,
          defaultRef: "main", defaultPath: ".", status: "active", autoSync: false, createdAt: at, updatedAt: at } }
      : await getSource(id),
    getSourceSnapshot: async (id: string) => id === TAKOS_SNAPSHOT
      ? { id, sourceId: TAKOS_SOURCE, workspaceId: takosWorkspace.id, resolvedRef: "refs/heads/main" }
      : await getSourceSnapshot(id),
    getCapsuleAdoptedSourceRevision: async (capsuleId: string) => capsuleId === TAKOS
      ? { sourceSnapshotId: TAKOS_SNAPSHOT, ref: "main", path: ".", resolvedCommit: "c".repeat(40) }
      : await getAdopted(capsuleId),
  } as unknown as ControlPlaneOperations;
  const accounts = new InMemoryAccountsStore();
  const now = Date.now();
  for (const subject of [OPERATOR, USER, STRANGER]) {
    accounts.saveAccount({ subject, email: `${subject}@example.test`, displayName: subject, createdAt: now, updatedAt: now });
  }
  function appToken(capsuleId: string, subject: string, workspaceId?: string): string {
    const token = `probe-${backend}-${capsuleId}-${subject}-${workspaceId ?? "none"}`;
    accounts.saveAccessToken(token, {
      clientId: `client_${capsuleId}`, scope: "openid capsules:read capsules:write",
      subject: `pairwise_${capsuleId}_${subject}`, takosumiSubject: subject as never, capsuleId,
      ...(workspaceId ? { workspaceId } : {}), expiresAt: now + 10 * 60_000,
    });
    return token;
  }
  function accountToken(subject: string): string {
    const token = `probe-account-${backend}-${subject}`;
    accounts.saveAccessToken(token, {
      clientId: "client_first_party", scope: "openid capsules:read capsules:write",
      subject, takosumiSubject: subject as never, expiresAt: now + 10 * 60_000,
    });
    return token;
  }
  async function route(token: string, method: string, path: string, body?: unknown, key?: string) {
    const url = new URL(`https://app.takosumi.test${path}`);
    const response = await handleControlRoute({
      request: new Request(url, { method, headers: { authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key === undefined ? {} : { "idempotency-key": key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      url, store: accounts, operations, installedAppDelegationSources: [DELEGATE_SOURCE],
    });
    return response!;
  }
  const session = (subject: string, workspaceId?: string) => ({
    subject, credential: "oauth-access-token", appIds: [TAKOS], installedAppDelegationSources: [DELEGATE_SOURCE],
    requiredAccess: "write", ...(workspaceId ? { workspaceId } : {}),
  }) as never;
  const decide = async (subject: string, capsuleId: string, workspaceId: string, action: string, tokenWorkspace?: string) =>
    (await requireAppAccess({ operations, store: accounts, session: session(subject, tokenWorkspace), capsuleId, workspaceId, action: action as never })).ok;
  return { takosWorkspace, userWorkspace, orgWorkspace, appToken, accountToken, route, decide, core };
}

const ATTEMPT = { mode: "attempt", source: { url: "https://github.com/takos/example.git", ref: "main" }, capsule: { name: "probe-app" } };

for (const backend of BACKENDS) {
  test(`[${backend}] a Takos member's token reaches neither the member's own app nor Takos itself`, async () => {
    const f = await compose(backend);
    const token = f.appToken(TAKOS, USER); // the live grant bound no Workspace
    expect((await f.route(token, "GET", `/api/v1/capsules/${USER_APP}`)).status).toBe(403);
    for (const action of ["view", "change_settings", "apply", "uninstall"]) {
      expect(await f.decide(USER, USER_APP, f.userWorkspace.id, action), action).toBe(false);
    }
    expect((await f.route(token, "GET", `/api/v1/capsules/${TAKOS}`)).status).toBe(403);
  });

  test(`[${backend}] the owner's Takos token reaches no unmarked app outside its own Workspace`, async () => {
    const f = await compose(backend);
    const token = f.appToken(TAKOS, OPERATOR, f.takosWorkspace.id);
    expect((await f.route(token, "GET", `/api/v1/capsules/${OPERATOR_ORG_APP}`)).status).toBe(403);
    expect(await f.decide(OPERATOR, OPERATOR_ORG_APP, f.orgWorkspace.id, "uninstall", f.takosWorkspace.id)).toBe(false);
    // Another user's app in that user's own namespace: no role, no reach.
    expect((await f.route(token, "GET", `/api/v1/capsules/${USER_APP}`)).status).toBe(403);
  });

  test(`[${backend}] a member's Takos token cannot install`, async () => {
    const f = await compose(backend);
    expect((await f.route(f.appToken(TAKOS, USER), "POST", "/api/v1/install-plans", ATTEMPT, "victim-install")).status).toBe(403);
  });

  test(`[${backend}] a client can never write the delegate mark, and another account's delegate cannot read the plan`, async () => {
    const f = await compose(backend);
    const account = f.accountToken(USER);
    expect((await f.route(account, "POST", "/api/v1/install-plans", { ...ATTEMPT, delegateCapsuleId: TAKOS }, "forge-1")).status).toBe(400);
    const clean = await f.route(account, "POST", "/api/v1/install-plans", ATTEMPT, "forge-2");
    expect(clean.status).toBe(201);
    const plan = (await clean.json()).installPlan;
    expect("delegateCapsuleId" in plan).toBe(false);
    expect((await f.core.gitInstallPlans.get(plan.id))?.delegateCapsuleId).toBeUndefined();
    expect((await f.route(account, "PATCH", `/api/v1/install-plans/${plan.id}`, { expectedGeneration: plan.generation, delegateCapsuleId: TAKOS })).status)
      .toBe(400);
    expect((await f.core.gitInstallPlans.get(plan.id))?.delegateCapsuleId).toBeUndefined();
    expect((await f.route(f.appToken(TAKOS, OPERATOR), "GET", `/api/v1/install-plans/${plan.id}`)).status).toBe(403);
  });
}
