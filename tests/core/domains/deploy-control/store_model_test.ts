import { afterAll, expect, setDefaultTimeout, test } from "bun:test";

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
import {
  CapsuleStateVersionGuardConflict,
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import {
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const TS = "2026-06-06T00:00:00.000Z";
const pgClients: PGliteSqlClient[] = [];

afterAll(async () => {
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
    expect((await store.getSourceSnapshot("snapshot_a"))?.sourceId, label).toBe(
      seeded.source.id,
    );
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
