/**
 * TASK-0118 P9.1-b: an operator-designated delegate app (Takos) installs an
 * app for its user through the Workspace-less `POST /api/v1/install-plans`,
 * and the new app is owned by that user. Coordinator, Source, Capsule,
 * ownership and ledger operations use their production implementations on
 * each backend; only the delegate app's own deployed revision (Source, applied
 * revision, snapshot ref) is fixed, because delegation reads it.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { Capsule } from "takosumi-contract/install-configs";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
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
  // member of the Takos app, with no Workspace of their own yet.
  const takosWorkspace = await core.workspaces.createWorkspace!({
    handle: `takos-operator-${backend}`,
    displayName: "Takos operator",
    type: "personal",
    ownerUserId: OPERATOR,
  });
  const at = new Date().toISOString();
  for (const id of [TAKOS, THIRD_PARTY]) {
    const capsule: Capsule = {
      id,
      workspaceId: takosWorkspace.id,
      projectId: defaultProjectId(takosWorkspace.id),
      name: id.replaceAll("_", "-"),
      slug: id.replaceAll("_", "-"),
      environment: "production",
      sourceId: id === TAKOS ? TAKOS_SOURCE : `src_${id}`,
      installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
      installingPrincipalId: OPERATOR,
      currentStateGeneration: 1,
      status: "active",
      createdAt: at,
      updatedAt: at,
    };
    await deployStore.putCapsule(capsule);
    expect(await core.appOwnership!.initializeOwnershipIfMissing({
      capsuleId: id, ownerAccountId: OPERATOR, ownershipEpoch: 0, managementState: "active",
      managementEpoch: 0, storageRoot: `apps/${id}`,
    })).toBe(true);
    expect(await core.appOwnership!.putMember({ capsuleId: id, accountId: USER, status: "active", createdAt: at, updatedAt: at }))
      .toBe(true);
  }
  // The two existing apps' deployed revisions: each has its own Source and an
  // applied snapshot the runner resolved to `refs/heads/main`. Only Takos's
  // Source is a designated delegate repository.
  const deployed = new Map([
    [TAKOS, { sourceId: TAKOS_SOURCE, snapshotId: TAKOS_SNAPSHOT, url: DELEGATE_SOURCE.url }],
    [THIRD_PARTY, { sourceId: `src_${THIRD_PARTY}`, snapshotId: `snap_${THIRD_PARTY}`, url: "https://git.example.test/someone/app" }],
  ]);
  const deployedBy = <K extends "sourceId" | "snapshotId">(key: K, value: string) =>
    [...deployed.entries()].find(([, revision]) => revision[key] === value);
  const getSource = core.getSource.bind(core);
  const getSourceSnapshot = core.getSourceSnapshot.bind(core);
  const getAdopted = core.getCapsuleAdoptedSourceRevision.bind(core);
  const operations = {
    ...core,
    getSource: async (id: string) => {
      const app = deployedBy("sourceId", id);
      return app
        ? {
            source: {
              id, workspaceId: takosWorkspace.id, ownerCapsuleId: app[0], name: app[0], url: app[1].url,
              defaultRef: "main", defaultPath: ".", status: "active", autoSync: false, createdAt: at, updatedAt: at,
            },
          }
        : await getSource(id);
    },
    getSourceSnapshot: async (id: string) => {
      const app = deployedBy("snapshotId", id);
      return app
        ? { id, sourceId: app[1].sourceId, workspaceId: takosWorkspace.id, resolvedRef: "refs/heads/main" }
        : await getSourceSnapshot(id);
    },
    getCapsuleAdoptedSourceRevision: async (capsuleId: string) => {
      const revision = deployed.get(capsuleId);
      return revision
        ? { sourceSnapshotId: revision.snapshotId, ref: "main", path: ".", resolvedCommit: "c".repeat(40) }
        : await getAdopted(capsuleId);
    },
  } as unknown as ControlPlaneOperations;

  const accounts = new InMemoryAccountsStore();
  const now = Date.now();
  for (const subject of [OPERATOR, USER, STRANGER]) {
    accounts.saveAccount({ subject, email: `${subject}@example.test`, displayName: subject, createdAt: now, updatedAt: now });
  }
  /** An installed app's own OAuth token for `subject`; `workspaceId` only when the live grant bound one. */
  function appToken(capsuleId: string, subject: string, workspaceId?: string): string {
    const token = `fixture-oauth-${backend}-${capsuleId}-${subject}-${workspaceId ?? "none"}`;
    accounts.saveAccessToken(token, {
      clientId: `client_${capsuleId}`, scope: "openid capsules:read capsules:write",
      subject: `pairwise_${capsuleId}_${subject}`, takosumiSubject: subject as never, capsuleId,
      ...(workspaceId ? { workspaceId } : {}),
      expiresAt: now + 10 * 60_000,
    });
    return token;
  }
  const paths: string[] = [];
  async function route(token: string, method: string, path: string, body?: unknown, key?: string) {
    paths.push(path);
    const url = new URL(`https://app.takosumi.test${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      url,
      store: accounts,
      operations,
      installedAppDelegationSources: [DELEGATE_SOURCE],
    });
    expect(response).toBeDefined();
    return response!;
  }
  return { backend, deployStore, core, operations, takosWorkspace, appToken, route, paths };
}

type Fixture = Awaited<ReturnType<typeof compose>>;

const ATTEMPT = {
  mode: "attempt",
  source: { url: "https://github.com/takos/example.git", ref: "main" },
  capsule: { name: "delegated-example" },
} as const;

/** Runs a delegated attempt to its first Plan; returns the plan record. */
async function installThroughDelegate(fixture: Fixture, token: string, key: string) {
  const created = await fixture.route(token, "POST", "/api/v1/install-plans", ATTEMPT, key);
  expect(created.status).toBe(201);
  // deno-lint-ignore no-explicit-any
  let plan: any = (await created.json()).installPlan;
  expect(plan).toMatchObject({ mode: "attempt", createdBy: USER });
  for (let step = 0; step < 8 && plan.phase !== "awaiting_input"; step += 1) {
    const advanced = await fixture.route(token, "POST", `/api/v1/install-plans/${plan.id}/reconcile`);
    expect(advanced.status).toBe(200);
    plan = (await advanced.json()).installPlan;
  }
  expect(plan.phase).toBe("awaiting_input");
  const read = await fixture.route(token, "GET", `/api/v1/install-plans/${plan.id}`);
  expect(read.status).toBe(200);
  const confirmed = await fixture.route(token, "PATCH", `/api/v1/install-plans/${plan.id}`, {
    expectedGeneration: plan.generation,
    continue: true,
  });
  expect(confirmed.status).toBe(200);
  plan = (await confirmed.json()).installPlan;
  for (let step = 0; step < 6 && plan.phase !== "planning"; step += 1) {
    const advanced = await fixture.route(token, "POST", `/api/v1/install-plans/${plan.id}/reconcile`);
    expect(advanced.status).toBe(200);
    plan = (await advanced.json()).installPlan;
  }
  expect(plan.phase).toBe("planning");
  expect(plan.capsuleId).toBeString();
  return plan;
}

for (const backend of BACKENDS) {
  test(`[${backend}] a delegate token installs an app owned by its user without any Workspace route`, async () => {
    const fixture = await compose(backend);
    // The user holds no Workspace membership: the live grant bound no Workspace.
    const token = fixture.appToken(TAKOS, USER);
    const plan = await installThroughDelegate(fixture, token, "delegated-install");

    const capsule = await fixture.core.capsules.getCapsule(plan.capsuleId);
    expect(capsule).toMatchObject({ installingPrincipalId: USER, workspaceId: plan.workspaceId });
    expect((await fixture.core.appOwnership!.getOwnership(capsule.id))?.ownerAccountId).toBe(USER);
    // The retained Workspace column is the user's own namespace, not Takos's.
    expect(plan.workspaceId).not.toBe(fixture.takosWorkspace.id);
    expect((await fixture.core.workspaces.getWorkspace(plan.workspaceId)).ownerUserId).toBe(USER);
    expect(fixture.paths.every((path) => path.startsWith("/api/v1/install-plans"))).toBe(true);

    // The installed app is the user's: the delegate keeps managing it under the
    // user's owner role, while the user's namespace stays closed to the token.
    expect((await fixture.route(token, "GET", `/api/v1/install-plans/${plan.id}`)).status).toBe(200);
    expect((await fixture.route(token, "GET", `/api/v1/capsules/${capsule.id}`)).status).toBe(200);
    expect((await fixture.route(token, "GET", `/api/v1/workspaces/${plan.workspaceId}/capsules`)).status).toBe(403);
  });

  test(`[${backend}] a delegate token still bound to the delegate's Workspace installs for its user too`, async () => {
    const fixture = await compose(backend);
    // A legacy token: the user is also a member of Takos's Workspace, so the
    // live grant bound that Workspace. It fences only Workspace routes.
    const joinedAt = new Date().toISOString();
    await fixture.deployStore.putWorkspaceMember({
      id: `wsm_${backend}_user`, workspaceId: fixture.takosWorkspace.id, accountId: USER, roles: ["member"],
      status: "active", createdAt: joinedAt, updatedAt: joinedAt,
    });
    const token = fixture.appToken(TAKOS, USER, fixture.takosWorkspace.id);
    const plan = await installThroughDelegate(fixture, token, "delegated-install-bound");
    expect(plan.workspaceId).not.toBe(fixture.takosWorkspace.id);
    expect((await fixture.core.appOwnership!.getOwnership(plan.capsuleId))?.ownerAccountId).toBe(USER);
    expect((await fixture.route(token, "GET", `/api/v1/capsules/${plan.capsuleId}`)).status).toBe(200);
  });

  test(`[${backend}] tokens that are not a delegate for their user stay refused`, async () => {
    const fixture = await compose(backend);
    // An ordinary installed app's own token.
    const thirdParty = await fixture.route(fixture.appToken(THIRD_PARTY, USER), "POST", "/api/v1/install-plans", ATTEMPT, "third-party");
    expect(thirdParty.status).toBe(403);
    // A designated delegate, but its user holds no role on that delegate app.
    const stranger = await fixture.route(fixture.appToken(TAKOS, STRANGER), "POST", "/api/v1/install-plans", ATTEMPT, "stranger");
    expect(stranger.status).toBe(403);
    // A user removed from the delegate app loses delegation at once.
    const token = fixture.appToken(TAKOS, USER);
    expect(await fixture.core.appOwnership!.deleteMember(TAKOS, USER)).toBe(true);
    const removed = await fixture.route(token, "POST", "/api/v1/install-plans", ATTEMPT, "removed");
    expect(removed.status).toBe(403);
    // No plan and no namespace were created for any refused request.
    expect(await fixture.core.workspaces.listWorkspacesByOwner(USER)).toEqual([]);
    expect(await fixture.core.workspaces.listWorkspacesByOwner(STRANGER)).toEqual([]);
  });
}

test("a delegate token cannot reach another account's capsule-less attempt", async () => {
  const fixture = await compose("memory");
  const plan = await (async () => {
    const created = await fixture.route(fixture.appToken(TAKOS, USER), "POST", "/api/v1/install-plans", ATTEMPT, "own");
    expect(created.status).toBe(201);
    return (await created.json()).installPlan;
  })();
  // The operator owns Takos and may delegate through it, but the attempt is
  // the user's: the operator's delegate token is refused.
  const operatorToken = fixture.appToken(TAKOS, OPERATOR);
  expect((await fixture.route(operatorToken, "GET", `/api/v1/install-plans/${plan.id}`)).status).toBe(403);
  expect((await fixture.route(operatorToken, "PATCH", `/api/v1/install-plans/${plan.id}`, { expectedGeneration: plan.generation })).status)
    .toBe(403);
  expect((await fixture.route(operatorToken, "POST", `/api/v1/install-plans/${plan.id}/reconcile`)).status).toBe(403);
  // A non-delegate app token of the same user is refused too.
  expect((await fixture.route(fixture.appToken(THIRD_PARTY, USER), "GET", `/api/v1/install-plans/${plan.id}`)).status).toBe(403);
});
