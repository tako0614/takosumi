import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type {
  ApplyRun,
  InstallConfig,
  ProviderConnection,
  StateVersion,
} from "@takosumi/internal/deploy-control-api";
import type { Dependency } from "takosumi-contract/dependencies";
import type { Output, OutputShare } from "takosumi-contract/outputs";
import type { Project } from "takosumi-contract/projects";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import {
  CapsuleStateVersionGuardConflict,
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import {
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const TS = "2026-06-06T00:00:00.000Z";
const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace_a",
    handle: "workspace-a",
    displayName: "Workspace A",
    type: "personal",
    ownerUserId: "user_a",
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function workspaceMember(
  workspaceId: string,
  overrides: Partial<WorkspaceMember> = {},
): WorkspaceMember {
  return {
    id: `member_${workspaceId}`,
    workspaceId,
    accountId: "account_many",
    roles: ["owner"],
    status: "active",
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project_a",
    workspaceId: "workspace_a",
    name: "Project A",
    slug: "project-a",
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function installConfig(
  id: string,
  workspaceId?: string,
  sequence = 0,
): InstallConfig {
  const timestamp = `2026-06-06T00:00:00.${String(sequence).padStart(3, "0")}Z`;
  return {
    id,
    ...(workspaceId ? { workspaceId } : {}),
    name: id,
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function stateVersion(
  capsuleId: string,
  overrides: Partial<StateVersion> = {},
): StateVersion {
  const generation = overrides.generation ?? 1;
  return {
    id: `state_${generation}`,
    workspaceId: "workspace_test",
    capsuleId,
    environment: "production",
    generation,
    stateRef: `opaque-state-${generation}`,
    digest: `sha256:state-${generation}`,
    createdByRunId: `run_apply_${generation}`,
    createdAt: TS,
    ...overrides,
  };
}

function output(capsuleId: string, overrides: Partial<Output> = {}): Output {
  const stateGeneration = overrides.stateGeneration ?? 1;
  return {
    id: `output_${stateGeneration}`,
    workspaceId: "workspace_test",
    capsuleId,
    stateGeneration,
    rawArtifactRef: `opaque-output-${stateGeneration}`,
    publicOutputs: { url: "https://example.com" },
    workspaceOutputs: {
      url: "https://example.com",
      bucket_name: "assets",
    },
    outputDigest: `sha256:output-${stateGeneration}`,
    createdAt: TS,
    ...overrides,
  };
}

function applyRunForSafety(input: {
  readonly id: string;
  readonly capsuleId: string;
  readonly operation: "update" | "destroy";
  readonly status: "queued" | "succeeded" | "failed";
  readonly effectAt: number;
  readonly auditEvents?: ApplyRun["auditEvents"];
  readonly diagnostics?: ApplyRun["diagnostics"];
}): ApplyRun {
  const planRunId = `plan_${input.id}`;
  return {
    id: input.id,
    planRunId,
    workspaceId: "workspace_runtime_safety",
    capsuleId: input.capsuleId,
    operation: input.operation,
    runnerProfileId: "opentofu-default",
    status: input.status,
    expected: {
      planRunId,
      capsuleId: input.capsuleId,
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:plan",
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: input.auditEvents ?? [],
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    createdAt: input.effectAt - 10,
    updatedAt: input.effectAt,
    ...(input.status === "queued"
      ? { startedAt: input.effectAt - 5 }
      : { startedAt: input.effectAt - 5, finishedAt: input.effectAt }),
  };
}

function resourceActivity(
  id: string,
  createdAt: string,
  targetId = "tkrn:workspace_a:ObjectBucket:assets",
): ActivityEvent {
  return {
    id,
    workspaceId: "workspace_a",
    action: "resource.apply.succeeded",
    targetType: "resource",
    targetId,
    metadata: {},
    createdAt,
  };
}

test("Activity target keyset paging is symmetric across memory, Postgres, and D1", async () => {
  for (const [label, store] of await stores()) {
    await store.putActivityEvent(
      resourceActivity("act_1", "2026-06-06T00:00:01.000Z"),
    );
    await store.putActivityEvent(
      resourceActivity("act_2", "2026-06-06T00:00:02.000Z"),
    );
    await store.putActivityEvent(
      resourceActivity("act_3", "2026-06-06T00:00:03.000Z"),
    );
    await store.putActivityEvent(
      resourceActivity(
        "act_other",
        "2026-06-06T00:00:04.000Z",
        "tkrn:workspace_a:KVStore:cache",
      ),
    );

    const first = await store.listActivityEventsForTargetPage(
      "workspace_a",
      "resource",
      "tkrn:workspace_a:ObjectBucket:assets",
      { limit: 2 },
    );
    expect(
      first.items.map((event) => event.id),
      label,
    ).toEqual(["act_3", "act_2"]);
    expect(first.nextCursor, label).toBeDefined();
    const second = await store.listActivityEventsForTargetPage(
      "workspace_a",
      "resource",
      "tkrn:workspace_a:ObjectBucket:assets",
      { limit: 2, cursor: first.nextCursor! },
    );
    expect(
      second.items.map((event) => event.id),
      label,
    ).toEqual(["act_1"]);
    expect(second.nextCursor, label).toBeUndefined();
  }
});

test("Workspace and Project stores expose only canonical ownership fields", async () => {
  for (const [label, store] of await stores()) {
    const first = workspace();
    const second = workspace({
      id: "workspace_b",
      handle: "workspace-b",
      displayName: "Workspace B",
      ownerUserId: "user_b",
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    await store.putWorkspace(first);
    await store.putWorkspace(second);
    await store.putProject(project());

    expect(await store.getWorkspace(first.id), label).toEqual(first);
    expect((await store.getWorkspaceByHandle(second.handle))?.id, label).toBe(
      second.id,
    );
    expect(
      (await store.listWorkspacesByIds([second.id, first.id])).map(
        (item) => item.id,
      ),
      label,
    ).toEqual([second.id, first.id]);
    expect(
      (await store.listWorkspacesByOwner(first.ownerUserId)).map(
        (item) => item.id,
      ),
      label,
    ).toEqual([first.id]);
    expect(
      (await store.listProjectsByWorkspace(first.id)).map((item) => item.id),
      label,
    ).toEqual(["project_a"]);
    expect(
      (await store.getProjectBySlug(first.id, "project-a"))?.id,
      label,
    ).toBe("project_a");
  }
});

test("personal Workspace bootstrap claims converge across memory, Postgres, and D1 stores", async () => {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const memory = new InMemoryOpenTofuControlStore();
  const d1 = new SqliteFakeD1();
  const pairs: readonly [string, OpenTofuControlStore, OpenTofuControlStore][] =
    [
      ["memory", memory, memory],
      [
        "postgres",
        new SqlOpenTofuControlStore({ client: pgClient }),
        new SqlOpenTofuControlStore({ client: pgClient }),
      ],
      [
        "d1",
        new CloudflareD1OpenTofuControlStore(d1),
        new CloudflareD1OpenTofuControlStore(d1),
      ],
    ];

  for (const [label, firstStore, secondStore] of pairs) {
    // Initialize independently constructed durable adapters before racing only
    // the owner claim itself.
    await firstStore.listWorkspaces();
    await secondStore.listWorkspaces();
    let firstId = 0;
    let secondId = 0;
    const first = new WorkspacesService({
      store: firstStore,
      newId: (prefix) => `${prefix}_${label}_first_${(firstId += 1)}`,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    });
    const second = new WorkspacesService({
      store: secondStore,
      newId: (prefix) => `${prefix}_${label}_second_${(secondId += 1)}`,
      now: () => new Date("2026-06-06T00:00:01.000Z"),
    });
    const owner = `owner_bootstrap_${label}`;

    const created = await Promise.all([
      first.ensurePersonalWorkspace(owner, `${label}-first`),
      second.ensurePersonalWorkspace(owner, `${label}-second`),
    ]);

    expect(new Set(created.map((row) => row.id)).size, label).toBe(1);
    expect(
      (await firstStore.listWorkspacesByOwner(owner)).filter(
        (row) => row.type === "personal",
      ),
      label,
    ).toHaveLength(1);

    const samePresentationOwner = `owner_bootstrap_same_${label}`;
    const samePresentation = await Promise.all([
      first.ensurePersonalWorkspace(
        samePresentationOwner,
        `${label}-same-presentation`,
      ),
      second.ensurePersonalWorkspace(
        samePresentationOwner,
        `${label}-same-presentation`,
      ),
    ]);
    expect(new Set(samePresentation.map((row) => row.id)).size, label).toBe(1);
    expect(
      (await firstStore.listWorkspacesByOwner(samePresentationOwner)).filter(
        (row) => row.type === "personal",
      ),
      label,
    ).toHaveLength(1);

    const adoptionOwner = `owner_adoption_${label}`;
    const oldest = await first.createWorkspace({
      handle: `${label}-existing-oldest`,
      displayName: `${label} existing oldest`,
      type: "personal",
      ownerUserId: adoptionOwner,
    });
    await first.createWorkspace({
      handle: `${label}-existing-newer`,
      displayName: `${label} existing newer`,
      type: "personal",
      ownerUserId: adoptionOwner,
    });

    const adopted = await Promise.all([
      first.ensurePersonalWorkspace(adoptionOwner, `${label}-presentation-a`),
      second.ensurePersonalWorkspace(adoptionOwner, `${label}-presentation-b`),
    ]);

    expect(
      adopted.map((row) => row.id),
      label,
    ).toEqual([oldest.id, oldest.id]);
    expect(
      await firstStore.listWorkspacesByOwner(adoptionOwner),
      label,
    ).toHaveLength(2);

    const squattedHandle = `${label}-foreign-preference`;
    const foreign = await first.createWorkspace({
      handle: squattedHandle,
      displayName: `${label} foreign preference`,
      type: "organization",
      ownerUserId: `owner_foreign_${label}`,
    });
    const isolated = await second.ensurePersonalWorkspace(
      `owner_requesting_${label}`,
      squattedHandle,
    );
    expect(isolated.id, label).not.toBe(foreign.id);
    expect(isolated.ownerUserId, label).toBe(`owner_requesting_${label}`);
  }
});

test("D1 personal Workspace bootstrap lookup and adoption use exact indexes", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putWorkspace(
    workspace({
      id: "workspace_bootstrap_plan",
      handle: "bootstrap-plan",
      ownerUserId: "owner_bootstrap_plan",
    }),
  );

  const exact = await db
    .prepare(
      `explain query plan
       select record_json from workspaces
       where personal_bootstrap_owner_id = ?
       limit 1`,
    )
    .bind("owner_bootstrap_plan")
    .all<{ readonly detail: string }>();
  const adoption = await db
    .prepare(
      `explain query plan
       select id from workspaces
       where owner_user_id = ?
         and workspace_type = 'personal'
         and personal_bootstrap_owner_id is null
       order by created_at, id
       limit 1`,
    )
    .bind("owner_bootstrap_plan")
    .all<{ readonly detail: string }>();

  expect(exact.results.map((row) => row.detail).join("\n")).toContain(
    "workspaces_personal_bootstrap_owner_unique",
  );
  expect(adoption.results.map((row) => row.detail).join("\n")).toContain(
    "workspaces_owner_type_created_idx",
  );
});

test("InstallConfig stores preserve global enumeration and expose exact bounded scopes", async () => {
  for (const [label, store] of await stores()) {
    const shared = Array.from({ length: 12 }, (_, index) =>
      installConfig(
        `config_shared_${String(index).padStart(2, "0")}`,
        undefined,
        index,
      ),
    );
    const scoped = Array.from({ length: 13 }, (_, index) =>
      installConfig(
        `config_scoped_${String(index).padStart(2, "0")}`,
        "workspace_a",
        index + 20,
      ),
    );
    const other = installConfig("config_other", "workspace_b", 40);
    for (const config of [...shared, ...scoped, other]) {
      await store.putInstallConfig(config);
    }

    expect((await store.listInstallConfigs()).length, label).toBe(26);
    expect(
      (await store.listSharedInstallConfigs()).map((row) => row.id),
      label,
    ).toEqual(shared.map((row) => row.id));
    expect(
      (await store.listInstallConfigs("workspace_a")).map((row) => row.id),
      label,
    ).toEqual(scoped.map((row) => row.id));

    const sharedFirst = await store.listSharedInstallConfigsPage({ limit: 5 });
    expect(
      sharedFirst.items.map((row) => row.id),
      label,
    ).toEqual(shared.slice(0, 5).map((row) => row.id));
    expect(sharedFirst.nextCursor, label).toBeDefined();
    const sharedSecond = await store.listSharedInstallConfigsPage({
      limit: 5,
      cursor: sharedFirst.nextCursor,
    });
    expect(
      sharedSecond.items.map((row) => row.id),
      label,
    ).toEqual(shared.slice(5, 10).map((row) => row.id));

    expect(
      (
        await store.getInstallConfigsByIds([
          scoped[12]!.id,
          "config_missing",
          shared[0]!.id,
        ])
      ).map((row) => row.id),
      label,
    ).toEqual([scoped[12]!.id, shared[0]!.id]);
  }
});

test("D1 InstallConfig id lookup chunks past the runtime variable limit", async () => {
  const store = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());
  const configs = Array.from({ length: 205 }, (_, index) =>
    installConfig(
      `config_batch_${String(index).padStart(3, "0")}`,
      undefined,
      index,
    ),
  );
  for (const config of configs) await store.putInstallConfig(config);
  expect(
    (await store.getInstallConfigsByIds(configs.map((row) => row.id))).map(
      (row) => row.id,
    ),
  ).toEqual(configs.map((row) => row.id));
});

test("D1 exact InstallConfig pages use the scope-created-id covering index", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putInstallConfig(installConfig("config_shared", undefined, 1));
  await store.putInstallConfig(
    installConfig("config_scoped", "workspace_a", 2),
  );

  const sharedPlan = await db
    .prepare(
      `explain query plan
       select record_json from install_configs
       where space_id is null
       order by created_at asc, id asc
       limit ?`,
    )
    .bind(6)
    .all<{ readonly detail: string }>();
  const scopedPlan = await db
    .prepare(
      `explain query plan
       select record_json from install_configs
       where space_id = ?
       order by created_at asc, id asc
       limit ?`,
    )
    .bind("workspace_a", 6)
    .all<{ readonly detail: string }>();

  for (const plan of [sharedPlan, scopedPlan]) {
    expect(plan.results.map((row) => row.detail).join("\n")).toContain(
      "install_configs_space_created_id_idx",
    );
  }
});

test("D1 Workspace id lookup chunks large membership sets without changing order", async () => {
  const store = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());
  const seeded = Array.from({ length: 205 }, (_, index) =>
    workspace({
      id: `workspace_chunk_${String(index).padStart(3, "0")}`,
      handle: `workspace-chunk-${String(index).padStart(3, "0")}`,
      displayName: `Workspace Chunk ${index}`,
    }),
  );
  for (const item of seeded) await store.putWorkspace(item);

  const requestedIds = [
    ...seeded.map((item) => item.id).reverse(),
    seeded[0]!.id,
    "workspace_missing",
  ];
  expect(
    (await store.listWorkspacesByIds(requestedIds)).map((item) => item.id),
  ).toEqual([...seeded.map((item) => item.id).reverse(), seeded[0]!.id]);
});

test("Capsule compatibility reports persist the analyzed module path on every store", async () => {
  const report = {
    id: "caprep_module_path",
    sourceId: "source_module_path",
    capsuleId: "capsule_module_path",
    sourceSnapshotId: "snapshot_module_path",
    modulePath: "deploy/opentofu",
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: TS,
  } satisfies CapsuleCompatibilityReport;

  for (const [label, store] of await stores()) {
    await store.putCapsuleCompatibilityReport(report);
    expect(
      await store.getCapsuleCompatibilityReport(report.id),
      label,
    ).toMatchObject(report);
    expect(
      await store.getLatestCapsuleCompatibilityReportForSourceSnapshot(
        report.sourceSnapshotId,
        { sourceId: report.sourceId, capsuleId: report.capsuleId },
      ),
      label,
    ).toMatchObject(report);
  }
});

test("account Workspace pages push active/archive/order/limit/cursor into every store", async () => {
  for (const [label, store] of await stores()) {
    const seeded = Array.from({ length: 177 }, (_, index) => {
      const sequence = String(index).padStart(3, "0");
      const timestamp = new Date(
        Date.UTC(2026, 5, 20, 0, index, 0),
      ).toISOString();
      return workspace({
        id: `workspace_many_${sequence}`,
        handle: `workspace-many-${sequence}`,
        displayName: `Workspace Many ${sequence}`,
        ownerUserId: "account_many",
        ...(index < 169 ? { archivedAt: timestamp } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    });
    for (const item of seeded) {
      await store.putWorkspace(item);
      await store.putWorkspaceMember(
        workspaceMember(item.id, {
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        }),
      );
    }

    const suspended = workspace({
      id: "workspace_many_suspended",
      handle: "workspace-many-suspended",
      ownerUserId: "account_many",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    await store.putWorkspace(suspended);
    await store.putWorkspaceMember(
      workspaceMember(suspended.id, { status: "suspended" }),
    );
    const other = workspace({
      id: "workspace_other_account",
      handle: "workspace-other-account",
      ownerUserId: "account_other",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    await store.putWorkspace(other);
    await store.putWorkspaceMember(
      workspaceMember(other.id, {
        accountId: "account_other",
        createdAt: other.createdAt,
        updatedAt: other.updatedAt,
      }),
    );

    const activeFirst = await store.listWorkspacesForAccountPage(
      "account_many",
      { includeArchived: false, order: "updated_desc", limit: 3 },
    );
    expect(activeFirst.total, label).toBe(8);
    expect(
      activeFirst.items.map((item) => item.id),
      label,
    ).toEqual([
      "workspace_many_176",
      "workspace_many_175",
      "workspace_many_174",
    ]);
    expect(activeFirst.nextCursor, label).toBeDefined();
    const hotRead = await store.listWorkspacesForAccountPage("account_many", {
      includeArchived: false,
      includeTotal: false,
      order: "updated_desc",
      limit: 3,
    });
    expect(hotRead.total, label).toBeUndefined();
    expect(hotRead.items, label).toEqual(activeFirst.items);
    const activeSecond = await store.listWorkspacesForAccountPage(
      "account_many",
      {
        includeArchived: false,
        order: "updated_desc",
        limit: 3,
        cursor: activeFirst.nextCursor,
      },
    );
    expect(
      activeSecond.items.map((item) => item.id),
      label,
    ).toEqual([
      "workspace_many_173",
      "workspace_many_172",
      "workspace_many_171",
    ]);

    const allIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listWorkspacesForAccountPage("account_many", {
        includeArchived: true,
        order: "created_asc",
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.total, label).toBe(177);
      allIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(allIds, label).toEqual(seeded.map((item) => item.id));
    expect(new Set(allIds).size, label).toBe(177);
    expect(allIds, label).not.toContain(suspended.id);
    expect(allIds, label).not.toContain(other.id);
  }
}, 60_000);

test("Capsule store is keyed by Project, name, and environment", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_capsules",
      capsuleId: "capsule_a",
      name: "app",
    });
    await seedCapsuleModel(store, {
      workspaceId: "workspace_capsules",
      sourceId: "source_staging",
      snapshotId: "snapshot_staging",
      installConfigId: "config_staging",
      capsuleId: "capsule_staging",
      name: "app",
      environment: "staging",
    });

    expect((await store.getCapsule("capsule_a"))?.projectId, label).toBe(
      seeded.project.id,
    );
    expect(
      (await store.getCapsuleByName(seeded.project.id, "app", "production"))
        ?.id,
      label,
    ).toBe("capsule_a");
    expect(
      (await store.listCapsules(seeded.workspace.id)).map((item) => item.id),
      label,
    ).toEqual(["capsule_a", "capsule_staging"]);

    const patched = await store.patchCapsule("capsule_a", {
      status: "active",
      updatedAt: "2026-06-08T00:00:00.000Z",
    });
    expect(patched?.status, label).toBe("active");
  }
});

test("ProviderConnection and ProviderBinding use Workspace and Capsule ids", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_connections",
      capsuleId: "capsule_connections",
    });
    await seedProviderConnections(store, seeded.capsule);

    const connections = await store.listConnections(seeded.workspace.id);
    expect(connections, label).toHaveLength(1);
    const connection = connections[0] as ProviderConnection;
    expect(connection.workspaceId, label).toBe(seeded.workspace.id);
    expect(connection.provider, label).toBe(
      "registry.opentofu.org/cloudflare/cloudflare",
    );

    const binding = await store.getProviderBindingSetByCapsule(
      seeded.capsule.id,
      seeded.capsule.environment,
    );
    expect(binding?.workspaceId, label).toBe(seeded.workspace.id);
    expect(binding?.capsuleId, label).toBe(seeded.capsule.id);
    expect(binding?.bindings[0]?.connectionId, label).toBe(connection.id);
  }
});

test("ProviderConnection reconcile create and compare-and-swap are atomic on every store backend", async () => {
  for (const [label, store] of await stores()) {
    const original: ProviderConnection = {
      id: `conn_reconcile_${label}`,
      provider: "registry.example/operator/extension",
      providerSource: "registry.example/operator/extension",
      scope: "operator",
      status: "pending",
      materialization: "legacy-managed",
      envNames: ["EXTENSION_RUN_TOKEN"],
      createdAt: TS,
      updatedAt: TS,
    };
    expect(await store.createConnectionIfAbsent(original), label).toBe(true);
    expect(
      await store.createConnectionIfAbsent({
        ...original,
        status: "verified",
      }),
      label,
    ).toBe(false);
    expect(await store.getConnection(original.id), label).toEqual(original);

    const staleExpected = {
      ...original,
      updatedAt: "2026-06-06T00:00:00.001Z",
    };
    const replacement: ProviderConnection = {
      ...original,
      status: "verified",
      materialization: "run-issued",
      updatedAt: "2026-06-06T00:00:00.002Z",
    };
    expect(
      await store.replaceConnectionIfUnchanged(staleExpected, replacement),
      label,
    ).toBe(false);
    expect(
      await store.replaceConnectionIfUnchanged(original, replacement),
      label,
    ).toBe(true);
    expect(await store.getConnection(original.id), label).toEqual(replacement);
    expect(
      await store.replaceConnectionIfUnchanged(original, replacement),
      label,
    ).toBe(false);
    expect(
      await store.replaceConnectionIfUnchanged(replacement, {
        ...replacement,
        id: `${replacement.id}_other`,
      }),
      label,
    ).toBe(false);
  }
});

test("Source snapshots retain canonical Workspace and Source ownership", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_sources",
      sourceId: "source_a",
      snapshotId: "snapshot_a",
      capsuleId: "capsule_sources",
    });

    expect((await store.getSource("source_a"))?.workspaceId, label).toBe(
      seeded.workspace.id,
    );
    const legacySnapshot = await store.getSourceSnapshot("snapshot_a");
    expect(legacySnapshot?.sourceId, label).toBe(seeded.source.id);
    // Rows persisted before install UX observation remain readable.
    expect(legacySnapshot?.repositoryManifest, label).toBeUndefined();
    const installUxDigest = `sha256:${"e".repeat(64)}`;
    await store.putSourceSnapshot({
      ...legacySnapshot!,
      repositoryManifest: {
        status: "present",
        digest: installUxDigest,
        document: {
          apiVersion: "takosumi.com/v1",
          kind: "Repository",
          install: { modules: { ".": { inputs: [] } } },
        },
      },
    });
    expect(
      (await store.getSourceSnapshot("snapshot_a"))?.repositoryManifest,
      label,
    ).toEqual({
      status: "present",
      digest: installUxDigest,
      document: {
        apiVersion: "takosumi.com/v1",
        kind: "Repository",
        install: { modules: { ".": { inputs: [] } } },
      },
    });
    expect(
      (await store.listSourceSnapshots(seeded.source.id)).map(
        (item) => item.id,
      ),
      label,
    ).toEqual(["snapshot_a"]);
  }
});

test("StateVersion and Output stores are Capsule keyed", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_test",
      capsuleId: "capsule_state",
    });
    const firstState = stateVersion(seeded.capsule.id);
    const secondState = stateVersion(seeded.capsule.id, {
      id: "state_2",
      generation: 2,
      createdAt: "2026-06-07T00:00:00.000Z",
    });
    const firstOutput = output(seeded.capsule.id);
    const secondOutput = output(seeded.capsule.id, {
      id: "output_2",
      stateGeneration: 2,
      createdAt: "2026-06-07T00:00:00.000Z",
    });

    await store.putStateVersion(firstState);
    await store.putStateVersion(secondState);
    await store.putOutput(firstOutput);
    await store.putOutput(secondOutput);

    expect(
      (
        await store.getLatestStateVersion(
          seeded.capsule.id,
          seeded.capsule.environment,
        )
      )?.id,
      label,
    ).toBe(secondState.id);
    expect((await store.getLatestOutput(seeded.capsule.id))?.id, label).toBe(
      secondOutput.id,
    );
    expect(
      (await store.listStateVersionsByWorkspace(seeded.workspace.id)).map(
        (item) => item.id,
      ),
      label,
    ).toEqual([firstState.id, secondState.id]);
    expect(
      (await store.listOutputsByWorkspace(seeded.workspace.id)).map(
        (item) => item.id,
      ),
      label,
    ).toEqual([firstOutput.id, secondOutput.id]);
  }
});

test("commitRunState atomically advances Capsule, StateVersion, and Output", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_test",
      capsuleId: "capsule_commit",
    });
    const nextState = stateVersion(seeded.capsule.id, { id: "state_commit" });
    const nextOutput = output(seeded.capsule.id, { id: "output_commit" });

    const committed = await store.commitRunState({
      stateVersion: nextState,
      output: nextOutput,
      capsulePatch: {
        id: seeded.capsule.id,
        patch: {
          currentStateVersionId: nextState.id,
          currentStateGeneration: nextState.generation,
          currentOutputId: nextOutput.id,
          status: "active",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
        guard: { currentStateVersionId: undefined, status: "pending" },
      },
    });

    expect(committed.capsule?.currentStateVersionId, label).toBe(nextState.id);
    expect(committed.capsule?.currentOutputId, label).toBe(nextOutput.id);
    expect((await store.getStateVersion(nextState.id))?.capsuleId, label).toBe(
      seeded.capsule.id,
    );
    expect((await store.getOutput(nextOutput.id))?.capsuleId, label).toBe(
      seeded.capsule.id,
    );
  }
});

test("commitRunState records a failed provider apply without inventing state", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_test",
      capsuleId: "capsule_failed_apply_no_state",
    });
    const currentState = stateVersion(seeded.capsule.id, {
      id: "state_before_failed_apply",
    });
    const currentOutput = output(seeded.capsule.id, {
      id: "output_before_failed_apply",
    });
    await store.commitRunState({
      stateVersion: currentState,
      output: currentOutput,
      capsulePatch: {
        id: seeded.capsule.id,
        patch: {
          currentStateVersionId: currentState.id,
          currentStateGeneration: currentState.generation,
          currentOutputId: currentOutput.id,
          status: "active",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
        guard: { currentStateVersionId: undefined, status: "pending" },
      },
    });

    const committed = await store.commitRunState({
      capsulePatch: {
        id: seeded.capsule.id,
        patch: {
          currentOutputId: undefined,
          status: "error",
          updatedAt: "2026-06-08T00:00:00.000Z",
        },
        guard: {
          currentStateVersionId: currentState.id,
          status: "active",
        },
      },
    });

    expect(committed.capsule, label).toMatchObject({
      currentStateVersionId: currentState.id,
      currentStateGeneration: currentState.generation,
      status: "error",
    });
    expect(committed.capsule?.currentOutputId, label).toBeUndefined();
    expect(
      (
        await store.getLatestStateVersion(
          seeded.capsule.id,
          seeded.capsule.environment,
        )
      )?.id,
      label,
    ).toBe(currentState.id);
  }
});

test("commitRunState writes nothing when the Capsule guard loses", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_test",
      capsuleId: "capsule_guard",
    });
    await store.patchCapsule(seeded.capsule.id, {
      currentStateVersionId: "state_current",
      currentStateGeneration: 1,
      status: "active",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    const rejectedState = stateVersion(seeded.capsule.id, {
      id: "state_rejected",
      generation: 2,
    });
    const rejectedOutput = output(seeded.capsule.id, {
      id: "output_rejected",
      stateGeneration: 2,
    });

    await expect(
      store.commitRunState({
        stateVersion: rejectedState,
        output: rejectedOutput,
        capsulePatch: {
          id: seeded.capsule.id,
          patch: {
            currentStateVersionId: rejectedState.id,
            currentStateGeneration: 2,
            currentOutputId: rejectedOutput.id,
            updatedAt: "2026-06-08T00:00:00.000Z",
          },
          guard: { currentStateVersionId: undefined },
        },
      }),
      label,
    ).rejects.toBeInstanceOf(CapsuleStateVersionGuardConflict);
    expect(
      await store.getStateVersion(rejectedState.id),
      label,
    ).toBeUndefined();
    expect(await store.getOutput(rejectedOutput.id), label).toBeUndefined();
  }
});

test("commitRestoredState persists the rebased Output with terminal restore state across stores", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_test",
      capsuleId: "capsule_restore_commit",
    });
    const queued = {
      id: "restore_commit",
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      type: "restore" as const,
      status: "queued" as const,
      backupId: "backup_restore_commit",
      restoreStateGeneration: 0,
      createdBy: "operator",
      createdAt: TS,
    };
    await store.putBackupRun(queued);
    const running = {
      ...queued,
      status: "running" as const,
      startedAt: TS,
    };
    const claim = await store.transitionRun({
      id: queued.id,
      kind: "restore",
      expectFrom: ["queued"],
      run: running,
      setLeaseToken: "restore_commit_lease",
      heartbeatAt: 1,
    });
    expect(claim.won, label).toBe(true);

    const restoredState = stateVersion(seeded.capsule.id, {
      id: "state_restore_commit",
      createdByRunId: queued.id,
    });
    const restoredOutput = output(seeded.capsule.id, {
      id: "output_restore_commit",
    });
    const committed = await store.commitRestoredState({
      stateVersion: restoredState,
      output: restoredOutput,
      capsulePatch: {
        id: seeded.capsule.id,
        patch: {
          currentStateVersionId: restoredState.id,
          currentStateGeneration: restoredState.generation,
          currentOutputId: restoredOutput.id,
          status: "stale",
          updatedAt: TS,
        },
        guard: {
          currentStateGeneration: seeded.capsule.currentStateGeneration,
          status: seeded.capsule.status,
        },
      },
      restoreRunTerminal: {
        ...running,
        status: "succeeded",
        restoredStateVersionId: restoredState.id,
        finishedAt: TS,
      },
      restoreRunLeaseToken: "restore_commit_lease",
    });

    expect(committed.capsule?.currentStateVersionId, label).toBe(
      restoredState.id,
    );
    expect(committed.capsule?.currentOutputId, label).toBe(restoredOutput.id);
    expect(
      (await store.getStateVersion(restoredState.id))?.generation,
      label,
    ).toBe(restoredState.generation);
    expect(
      (await store.getOutput(restoredOutput.id))?.stateGeneration,
      label,
    ).toBe(restoredOutput.stateGeneration);
    expect((await store.getBackupRun(queued.id))?.status, label).toBe(
      "succeeded",
    );
  }
});

test("runtime safety treats lifecycle-only mutation evidence identically in memory, Postgres, and D1", async () => {
  for (const [label, store] of await stores()) {
    const mutationCapsule = `capsule_lifecycle_mutation_${label}`;
    await store.putApplyRun(
      applyRunForSafety({
        id: `apply_safe_${label}`,
        capsuleId: mutationCapsule,
        operation: "update",
        status: "succeeded",
        effectAt: 100,
      }),
    );
    await store.putApplyRun(
      applyRunForSafety({
        id: `apply_lifecycle_failed_${label}`,
        capsuleId: mutationCapsule,
        operation: "destroy",
        status: "failed",
        effectAt: 200,
        auditEvents: [
          {
            id: `audit_lifecycle_failed_${label}`,
            type: "destroy.failed",
            at: 200,
            data: {
              providerDispatched: false,
              lifecycleActionDispatched: true,
              lifecycleActionPhase: "pre_destroy",
            },
          },
        ],
      }),
    );

    expect(await store.getCapsuleRuntimeSafety(mutationCapsule), label).toEqual(
      {
        phase: "unknown",
        runId: `apply_lifecycle_failed_${label}`,
        runType: "destroy_apply",
      },
    );

    const noMutationCapsule = `capsule_no_mutation_${label}`;
    await store.putApplyRun(
      applyRunForSafety({
        id: `apply_safe_control_${label}`,
        capsuleId: noMutationCapsule,
        operation: "update",
        status: "succeeded",
        effectAt: 100,
      }),
    );
    await store.putApplyRun(
      applyRunForSafety({
        id: `apply_failed_control_${label}`,
        capsuleId: noMutationCapsule,
        operation: "destroy",
        status: "failed",
        effectAt: 200,
        auditEvents: [
          {
            id: `audit_no_mutation_${label}`,
            type: "destroy.failed",
            at: 200,
            data: {
              providerDispatched: false,
              lifecycleActionDispatched: false,
            },
          },
        ],
      }),
    );
    expect(
      await store.getCapsuleRuntimeSafety(noMutationCapsule),
      label,
    ).toEqual({
      phase: "safe",
      runId: `apply_safe_control_${label}`,
      runType: "apply",
    });
  }
});

test("runtime safety ignores a later structured pre-provider runner failure across every store", async () => {
  for (const [label, store] of await stores()) {
    const capsuleId = `capsule_pre_provider_failure_${label}`;
    await store.putApplyRun(
      applyRunForSafety({
        id: `apply_partial_${label}`,
        capsuleId,
        operation: "update",
        status: "failed",
        effectAt: 100,
        auditEvents: [
          {
            id: `audit_partial_${label}`,
            type: "apply.failed",
            at: 100,
            data: {
              providerDispatched: true,
              providerApplySucceeded: false,
              statePersistence: "persisted",
            },
          },
        ],
      }),
    );
    await store.putApplyRun(
      applyRunForSafety({
        id: `apply_init_failed_${label}`,
        capsuleId,
        operation: "update",
        status: "failed",
        effectAt: 200,
        auditEvents: [
          {
            id: `audit_init_failed_${label}`,
            type: "apply.failed",
            at: 200,
            data: { providerDispatched: true },
          },
        ],
        diagnostics: [
          {
            severity: "error",
            code: "opentofu_init_failed",
            message: "runner failure (opentofu_init_failed)",
          },
        ],
      }),
    );

    expect(await store.getCapsuleRuntimeSafety(capsuleId), label).toEqual({
      phase: "unknown",
      runId: `apply_partial_${label}`,
      runType: "apply",
    });
  }
});

test("ApplyRun begin is insert-or-adopt and never resets an existing running or terminal row", async () => {
  for (const [label, store] of await stores()) {
    for (const status of ["running", "succeeded"] as const) {
      const id = `apply_begin_${status}_${label}`;
      const candidate = applyRunForSafety({
        id,
        capsuleId: `capsule_${id}`,
        operation: "update",
        status: "queued",
        effectAt: 100,
      });
      expect(
        await store.beginApplyRun(candidate),
        `${label}:${status}`,
      ).toEqual({ status: "created", run: candidate });
      const advanced: ApplyRun = {
        ...candidate,
        status,
        startedAt: 110,
        updatedAt: 120,
        ...(status === "succeeded" ? { finishedAt: 130 } : {}),
      };
      await store.putApplyRun(advanced);

      const adopted = await store.beginApplyRun(candidate);
      expect(adopted.status, `${label}:${status}`).toBe("existing");
      expect(adopted.run, `${label}:${status}`).toEqual(advanced);
      expect(await store.getApplyRun(id), `${label}:${status}`).toEqual(
        advanced,
      );
    }
  }
});

test("ApplyRun begin adopts an existing queued row unchanged on every store backend", async () => {
  for (const [label, store] of await stores()) {
    const id = `apply_begin_queued_${label}`;
    const queued = applyRunForSafety({
      id,
      capsuleId: `capsule_${id}`,
      operation: "update",
      status: "queued",
      effectAt: 100,
      auditEvents: [
        {
          id: `audit_${id}`,
          type: "apply.queued",
          at: 100,
        },
      ],
    });
    expect(await store.beginApplyRun(queued), label).toEqual({
      status: "created",
      run: queued,
    });

    const candidate = { ...queued, updatedAt: 200, auditEvents: [] };
    expect(await store.beginApplyRun(candidate), label).toEqual({
      status: "existing",
      run: queued,
    });
    expect(await store.getApplyRun(id), label).toEqual(queued);
  }
});

test("run transition startedAt fencing rejects a started requeue in memory, Postgres, and D1", async () => {
  for (const [label, store] of await stores()) {
    const seeded = applyRunForSafety({
      id: `apply_started_fence_${label}`,
      capsuleId: `capsule_started_fence_${label}`,
      operation: "destroy",
      status: "queued",
      effectAt: 10,
    });
    const { startedAt: _seededStartedAt, ...neverStarted } = seeded;
    await store.putApplyRun(neverStarted);

    // Model a runner that claimed the row after cancellation's read, then hit a
    // retryable infrastructure failure and parked the same run back at queued.
    await store.putApplyRun({
      ...neverStarted,
      status: "queued",
      startedAt: 11,
      updatedAt: 12,
    });
    const result = await store.transitionRun({
      id: neverStarted.id,
      kind: "apply",
      expectFrom: ["queued"],
      expectStartedAt: null,
      run: {
        ...neverStarted,
        status: "cancelled",
        updatedAt: 13,
        finishedAt: 13,
      },
      clearLeaseToken: true,
    });

    expect(result.won, label).toBe(false);
    expect(result.run, label).toMatchObject({
      status: "queued",
      startedAt: 11,
      updatedAt: 12,
    });
    expect(await store.getApplyRun(neverStarted.id), label).toMatchObject({
      status: "queued",
      startedAt: 11,
      updatedAt: 12,
    });
  }
});

test("terminal billing-finalization markers are recoverable on every store backend", async () => {
  for (const [label, store] of await stores()) {
    const pending = applyRunForSafety({
      id: `apply_billing_pending_${label}`,
      capsuleId: `capsule_billing_pending_${label}`,
      operation: "update",
      status: "succeeded",
      effectAt: 100,
      auditEvents: [
        {
          id: `audit_billing_pending_${label}`,
          type: "billing.capture.pending",
          at: 100,
          data: { providerMutationCommitted: true },
        },
      ],
    });
    await store.putApplyRun(pending);

    expect(
      (
        await store.listRecoverableOpenTofuRuns({
          staleQueuedBeforeMs: 200,
          staleRunningBeforeMs: 200,
        })
      ).map((run) => run.id),
      label,
    ).toContain(pending.id);

    await store.putApplyRun({
      ...pending,
      auditEvents: [
        ...pending.auditEvents,
        {
          id: `audit_billing_completed_${label}`,
          type: "billing.capture.completed",
          at: 150,
        },
      ],
    });
    expect(
      (
        await store.listRecoverableOpenTofuRuns({
          staleQueuedBeforeMs: 200,
          staleRunningBeforeMs: 200,
        })
      ).map((run) => run.id),
      label,
    ).not.toContain(pending.id);
  }
});

test("Dependency and OutputShare use Capsule and Workspace vocabulary", async () => {
  for (const [label, store] of await stores()) {
    const dependency: Dependency = {
      id: "dependency_a",
      workspaceId: "workspace_a",
      producerCapsuleId: "capsule_producer",
      consumerCapsuleId: "capsule_consumer",
      mode: "variable_injection",
      outputs: {
        bucket_name: {
          from: "bucket_name",
          to: "bucket",
          required: true,
        },
      },
      visibility: "workspace",
      createdAt: TS,
    };
    const share: OutputShare = {
      id: "share_a",
      fromWorkspaceId: "workspace_a",
      toWorkspaceId: "workspace_b",
      producerCapsuleId: "capsule_producer",
      outputs: [{ name: "bucket_name", alias: "bucket", sensitive: false }],
      status: "active",
      createdAt: TS,
    };

    await store.putDependency(dependency);
    await store.putOutputShare(share);

    expect(
      (await store.listDependenciesForProducer("capsule_producer"))[0],
      label,
    ).toEqual(dependency);
    expect(
      (await store.listDependenciesForConsumer("capsule_consumer"))[0],
      label,
    ).toEqual(dependency);
    expect(
      (await store.listOutputSharesFromWorkspace("workspace_a"))[0],
      label,
    ).toEqual(share);
    expect(
      (await store.listOutputSharesToWorkspace("workspace_b"))[0],
      label,
    ).toEqual(share);
  }
});
