/**
 * TASK-0118 P9.1-e: the operator-control MCP works without Workspace routes.
 * It installs through `POST /api/v1/install-plans`, lists through
 * `GET /api/v1/apps` and acts on `/capsules/:id/*`, `/install-plans/:id/*`
 * and `/runs/:id`, for the current owner of the MCP's own app and only on
 * that owner's own apps. A Workspace the token still carries narrows that
 * further and never grants. Coordinator, Source, Capsule, ownership and
 * ledger operations use their production implementations on each backend.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { Capsule } from "takosumi-contract/install-configs";
import type { ControlPlaneOperations } from "../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
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
import { handleOperatorControlMcpRequest } from "../../../deploy/operator-control-mcp.ts";
import { createOperatorControlMcpAuthority } from "../../../deploy/platform/operator-control-mcp-authority.ts";
import { PGliteSqlClient } from "../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(120_000);

const OWNER = "tsub_mcp_owner";
const OTHER = "tsub_other_account";
/** The MCP's own app, owned by OWNER in OWNER's personal namespace. */
const MCP_APP = "cap_operator_mcp";
/** OWNER's app in the same namespace. */
const OWN_APP = "cap_owner_app";
/** OWNER's app in OWNER's other (legacy) Workspace. */
const OWN_APP_ELSEWHERE = "cap_owner_app_elsewhere";
/** OTHER's app in OWNER's namespace; OWNER is its member. */
const OTHERS_APP_HERE = "cap_others_app_here";
/** OTHER's app in OTHER's namespace; OWNER is its member. */
const OTHERS_APP = "cap_others_app";
/** An MCP app now owned by OTHER (as after a transfer). */
const TRANSFERRED_MCP_APP = "cap_transferred_mcp";
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
  // OWNER's personal namespace (where POST /install-plans installs and where
  // the MCP app lives), a second legacy Workspace of OWNER, and OTHER's.
  const ownerNamespace = await operations.workspaces.createWorkspace!({
    handle: `mcp-owner-${backend}`, displayName: "MCP owner", type: "personal", ownerUserId: OWNER,
  });
  const ownerElsewhere = await operations.workspaces.createWorkspace!({
    handle: `mcp-owner-org-${backend}`, displayName: "MCP owner org", type: "organization", ownerUserId: OWNER,
  });
  const otherNamespace = await operations.workspaces.createWorkspace!({
    handle: `other-${backend}`, displayName: "Other", type: "personal", ownerUserId: OTHER,
  });
  const at = new Date().toISOString();
  const apps = new Map<string, { owner: string; workspaceId: string }>([
    [MCP_APP, { owner: OWNER, workspaceId: ownerNamespace.id }],
    [OWN_APP, { owner: OWNER, workspaceId: ownerNamespace.id }],
    [OWN_APP_ELSEWHERE, { owner: OWNER, workspaceId: ownerElsewhere.id }],
    [OTHERS_APP_HERE, { owner: OTHER, workspaceId: ownerNamespace.id }],
    [OTHERS_APP, { owner: OTHER, workspaceId: otherNamespace.id }],
    [TRANSFERRED_MCP_APP, { owner: OTHER, workspaceId: ownerNamespace.id }],
  ]);
  for (const [id, app] of apps) {
    const capsule: Capsule = {
      id,
      workspaceId: app.workspaceId,
      projectId: defaultProjectId(app.workspaceId),
      name: id.replaceAll("_", "-"),
      slug: id.replaceAll("_", "-"),
      environment: "production",
      sourceId: `src_${id}`,
      installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
      installingPrincipalId: app.owner,
      currentStateGeneration: 1,
      status: "active",
      createdAt: at,
      updatedAt: at,
    };
    await deployStore.putCapsule(capsule);
    expect(await operations.appOwnership!.initializeOwnershipIfMissing({
      capsuleId: id, ownerAccountId: app.owner, ownershipEpoch: 0, managementState: "active",
      managementEpoch: 0, storageRoot: `apps/${id}`,
    })).toBe(true);
  }
  for (const capsuleId of [OTHERS_APP_HERE, OTHERS_APP, TRANSFERRED_MCP_APP]) {
    expect(await operations.appOwnership!.putMember({
      capsuleId, accountId: OWNER, status: "active", createdAt: at, updatedAt: at,
    })).toBe(true);
  }
  const accounts = new InMemoryAccountsStore();
  const now = Date.now();
  for (const subject of [OWNER, OTHER]) {
    accounts.saveAccount({ subject: subject as never, email: `${subject}@example.test`, displayName: subject, createdAt: now, updatedAt: now });
  }
  const dispatched: string[] = [];
  /** One MCP tool call with a token naming `capsuleId` and, optionally, a Workspace. */
  async function tool(
    name: string,
    args: Record<string, unknown>,
    token: { readonly capsuleId?: string; readonly workspaceId?: string | null } = {},
  ) {
    const workspaceId = token.workspaceId === undefined ? ownerNamespace.id : token.workspaceId;
    const base = createOperatorControlMcpAuthority({
      operations,
      store: accounts,
      session: {
        subject: OWNER,
        capsuleId: token.capsuleId ?? MCP_APP,
        ...(workspaceId === null ? {} : { workspaceId }),
      },
      requestUrl: "https://app.takosumi.test/mcp/operator-control/v1",
    });
    const response = await handleOperatorControlMcpRequest(
      new Request("https://app.takosumi.test/mcp/operator-control/v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      {
        ...base,
        dispatchPublicControl: async (request) => {
          dispatched.push(`${request.method} ${new URL(request.url).pathname}`);
          return await base.dispatchPublicControl(request);
        },
      },
    );
    // deno-lint-ignore no-explicit-any
    const result = (await response.json()).result as any;
    return result.structuredContent as { status: number; body: any };
  }
  return { backend, operations, ownerNamespace, ownerElsewhere, tool, dispatched };
}

const INSTALL = (name: string) => ({
  idempotencyKey: `mcp-install-${name}`,
  source: { name, url: "https://github.com/takos/example.git", ref: "main", path: "." },
  capsule: { name, environment: "production" },
  options: { modulePath: ".", providerBindings: [] },
});

function appIds(body: { apps: { capsuleId: string }[] }): string[] {
  return body.apps.map((app) => app.capsuleId).sort();
}

for (const backend of BACKENDS) {
  test(`[${backend}] the MCP installs through POST /install-plans and continues the install as its owner, without Workspace routes`, async () => {
    const fixture = await compose(backend);
    const created = await fixture.tool("takosumi_install_plan_create", INSTALL("mcp-made"));
    expect(created.status).toBe(201);
    let plan = created.body.installPlan;
    expect(plan).toMatchObject({ createdBy: OWNER, workspaceId: fixture.ownerNamespace.id });
    expect(plan.mode).toBeUndefined();
    for (let step = 0; step < 10 && plan.phase !== "planning" && plan.phase !== "failed"; step += 1) {
      const advanced = await fixture.tool("takosumi_install_plan_reconcile", { installPlanId: plan.id });
      expect(advanced.status).toBe(200);
      plan = advanced.body.installPlan;
    }
    expect(plan.phase).toBe("planning");
    expect((await fixture.operations.appOwnership!.getOwnership(plan.capsuleId))?.ownerAccountId).toBe(OWNER);
    expect((await fixture.tool("takosumi_install_plan_get", { installPlanId: plan.id })).status).toBe(200);
    // The next phase creates the Plan Run: a Run of the owner's new app.
    expect((await fixture.tool("takosumi_install_plan_reconcile", { installPlanId: plan.id })).status).toBe(200);
    const planRunId = (await fixture.operations.gitInstallPlans.get(plan.id))?.planRunId;
    expect(planRunId).toBeString();
    const runRead = await fixture.tool("takosumi_run_get", { runId: planRunId });
    expect(runRead.status).toBe(200);
    expect(runRead.body.run).toMatchObject({ id: planRunId, capsuleId: plan.capsuleId });

    // A replay with the same key returns the same install.
    const replay = await fixture.tool("takosumi_install_plan_create", INSTALL("mcp-made"));
    expect(replay.status).toBe(200);
    expect(replay.body.installPlan.id).toBe(plan.id);

    const listed = await fixture.tool("takosumi_capsules_list", {});
    expect(listed.status).toBe(200);
    expect(appIds(listed.body)).toEqual([MCP_APP, OWN_APP, plan.capsuleId].sort());
    expect(fixture.dispatched.some((entry) => entry.includes("/api/v1/workspaces"))).toBe(false);
  });

  test(`[${backend}] apps the owner is only a member of are never reachable, in or out of the token's Workspace`, async () => {
    const fixture = await compose(backend);
    for (const token of [{}, { workspaceId: null }] as const) {
      for (const capsuleId of [OTHERS_APP_HERE, OTHERS_APP]) {
        expect((await fixture.tool("takosumi_capsule_plan", { capsuleId }, token)).status).toBe(403);
        expect((await fixture.tool("takosumi_capsule_destroy_plan", { capsuleId }, token)).status).toBe(403);
      }
      const listed = await fixture.tool("takosumi_capsules_list", {}, token);
      expect(appIds(listed.body)).not.toContain(OTHERS_APP_HERE);
      expect(appIds(listed.body)).not.toContain(OTHERS_APP);
    }
    // The refusals happened before any public dispatch except the listings.
    expect(fixture.dispatched).toEqual(["GET /api/v1/apps", "GET /api/v1/apps"]);
  });

  test(`[${backend}] a token's Workspace narrows the owner's apps; Capsule evidence alone does not`, async () => {
    const fixture = await compose(backend);
    const bound = await fixture.tool("takosumi_capsules_list", {});
    expect(appIds(bound.body)).toEqual([MCP_APP, OWN_APP].sort());
    expect((await fixture.tool("takosumi_capsule_destroy_plan", { capsuleId: OWN_APP_ELSEWHERE })).status).toBe(403);

    const capsuleOnly = await fixture.tool("takosumi_capsules_list", {}, { workspaceId: null });
    expect(appIds(capsuleOnly.body)).toEqual([MCP_APP, OWN_APP, OWN_APP_ELSEWHERE].sort());
    // The owner's own app elsewhere is reached under the owner's live role.
    const destroyPlan = await fixture.tool("takosumi_capsule_destroy_plan", { capsuleId: OWN_APP_ELSEWHERE }, { workspaceId: null });
    expect(destroyPlan.status).not.toBe(403);
    expect(fixture.dispatched).toContain(`POST /api/v1/capsules/${OWN_APP_ELSEWHERE}/destroy-plan`);

    // A token bound to the other Workspace cannot install where the new app
    // would fall outside it.
    expect((await fixture.tool("takosumi_install_plan_create", INSTALL("outside"), {
      capsuleId: OWN_APP_ELSEWHERE, workspaceId: fixture.ownerElsewhere.id,
    })).status).toBe(403);
  });

  test(`[${backend}] an MCP whose app its subject no longer owns does nothing`, async () => {
    const fixture = await compose(backend);
    for (const workspaceId of [undefined, null] as const) {
      const token = { capsuleId: TRANSFERRED_MCP_APP, ...(workspaceId === null ? { workspaceId } : {}) };
      expect((await fixture.tool("takosumi_capsules_list", {}, token)).status).toBe(403);
      expect((await fixture.tool("takosumi_capsule_plan", { capsuleId: OWN_APP }, token)).status).toBe(403);
      expect((await fixture.tool("takosumi_install_plan_create", INSTALL("after-transfer"), token)).status).toBe(403);
    }
    expect(fixture.dispatched).toEqual([]);
  });
}
