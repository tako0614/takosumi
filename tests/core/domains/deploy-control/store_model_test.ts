import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type {
  ApplyRun,
  InstallConfig,
  PlanRun,
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
  parseStoredCapsuleCompatibilityProviderGraph,
  type OpenTofuControlStore,
  type StoredSecretBlob,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
} from "../../../../worker/src/bindings.ts";
import type { SqlClient } from "../../../../core/adapters/storage/sql.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import {
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import {
  createPublicInputReservationLifecycle,
  decodePublicInputReservationLifecycle,
  publicInputClientIdempotencyKey,
  type PublicInputReservationIntent,
  type PublicInputReservationReceipt,
} from "../../../../core/domains/deploy-control/public_input_reservation.ts";

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

function recordingSqlClient(
  client: SqlClient,
  queries: string[],
): SqlClient {
  return {
    query(sql, parameters) {
      queries.push(sql);
      return client.query(sql, parameters);
    },
    transaction: (fn) => client.transaction(fn),
  };
}

function recordingD1(database: D1Database, queries: string[]): D1Database {
  return {
    prepare(query) {
      queries.push(query);
      const statement = database.prepare(query);
      return {
        bind(...values) {
          return statement.bind(...values);
        },
        first<T>() {
          return statement.first<T>();
        },
        all<T>() {
          return statement.all<T>();
        },
        run<T>() {
          return statement.run<T>();
        },
      } satisfies D1PreparedStatement;
    },
    batch: (statements) => database.batch(statements),
  };
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
  readonly planRunId?: string;
  readonly workspaceId?: string;
  readonly capsuleId: string;
  readonly operation: "update" | "destroy";
  readonly status: "queued" | "succeeded" | "failed";
  readonly effectAt: number;
  readonly auditEvents?: ApplyRun["auditEvents"];
  readonly diagnostics?: ApplyRun["diagnostics"];
}): ApplyRun {
  const planRunId = input.planRunId ?? `plan_${input.id}`;
  return {
    id: input.id,
    planRunId,
    workspaceId: input.workspaceId ?? "workspace_runtime_safety",
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

function planRunForCleanup(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly status: PlanRun["status"];
}): PlanRun {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    capsuleExecutionAuthorityEpoch: 1,
    source: {
      kind: "git",
      url: "https://example.test/app.git",
      ref: "main",
      modulePath: ".",
    },
    sourceSnapshotId: "snapshot_a",
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    capsuleContext: {
      workspaceId: input.workspaceId,
      capsuleId: input.capsuleId,
      environment: "production",
    },
    variablesDigest: "sha256:variables",
    status: input.status,
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 100,
    ...(input.status === "failed" ||
        input.status === "cancelled" ||
        input.status === "expired"
      ? { finishedAt: 100 }
      : {}),
  };
}

async function legacyPublicInputReceipt(input: {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly sourceSnapshotId: string;
  readonly suffix: string;
}): Promise<PublicInputReservationReceipt> {
  const nonce = "00000000-0000-4000-8000-000000000009";
  const core = {
    kind: "takosumi.public-input-reservation-receipt@v1" as const,
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    installConfigId: input.installConfigId,
    capsuleExecutionAuthorityEpoch: 1,
    sourceSnapshotId: input.sourceSnapshotId,
    repositoryInstallUxDigest: `sha256:${"9".repeat(64)}`,
    reservationLifecycleNonce: nonce,
    clientIdempotencyKey: await publicInputClientIdempotencyKey({
      capsuleId: input.capsuleId,
      targetVariable: "app_url",
      subdomainVariable: "project_name",
      requestedSubdomain: "legacy-tree",
      reservationLifecycleNonce: nonce,
    }),
    targetVariable: "app_url",
    subdomainVariable: "project_name",
    requestedSubdomain: "legacy-tree",
    owner: {
      providerSource: "registry.terraform.io/tako0614/takoform",
      connectionId: "conn_legacyReceipt01",
      recipeId: "takoserver-endpoint",
      authMode: "broker",
    },
    reservationRef: `provider/legacy/${input.suffix}`,
    httpEndpointUrl: `https://legacy-tree-${input.suffix}.example.test`,
  };
  return {
    ...core,
    digest: await stableJsonDigest(core),
  };
}

async function legacyPublicInputIntent(input: {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly sourceSnapshotId: string;
  readonly suffix: string;
}): Promise<PublicInputReservationIntent> {
  const receipt = await legacyPublicInputReceipt(input);
  const {
    digest: _digest,
    httpEndpointUrl: _httpEndpointUrl,
    kind: _kind,
    reservationRef: _reservationRef,
    ...authority
  } = receipt;
  void _digest;
  void _httpEndpointUrl;
  void _kind;
  void _reservationRef;
  const core = {
    ...authority,
    kind: "takosumi.public-input-reservation-intent@v1" as const,
  };
  return {
    ...core,
    digest: await stableJsonDigest(core),
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
    providerPackages: [],
    rootProviderRequirements: [],
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

test("compatibility provider graph storage rejects the retired flat array", () => {
  expect(() =>
    parseStoredCapsuleCompatibilityProviderGraph([
      {
        source: "registry.opentofu.org/hashicorp/random",
        moduleLocalName: "random",
        allowed: true,
      },
    ])
  ).toThrow(/must be an object/);
  expect(() =>
    parseStoredCapsuleCompatibilityProviderGraph({
      providerPackages: [],
      rootProviderRequirements: [],
      providers: [],
    })
  ).toThrow(/unsupported field/);
});

test("Postgres and D1 report reads reject a retired flat provider row", async () => {
  const report = {
    id: "caprep_retired_provider_array",
    sourceId: "source_retired_provider_array",
    sourceSnapshotId: "snapshot_retired_provider_array",
    modulePath: ".",
    level: "ready",
    findings: [],
    providerPackages: [],
    rootProviderRequirements: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: TS,
  } satisfies CapsuleCompatibilityReport;
  const retired = JSON.stringify([
    {
      source: "registry.opentofu.org/hashicorp/random",
      moduleLocalName: "random",
      allowed: true,
    },
  ]);

  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const pgStore = new SqlOpenTofuControlStore({ client: pgClient });
  await pgStore.putCapsuleCompatibilityReport(report);
  await pgClient.query(
    "update takosumi_capsule_compatibility_reports set providers_json = $1::json where id = $2",
    [retired, report.id],
  );
  await expect(pgStore.getCapsuleCompatibilityReport(report.id)).rejects.toThrow(
    /must be an object/,
  );

  const d1 = new SqliteFakeD1();
  const d1Store = new CloudflareD1OpenTofuControlStore(d1);
  await d1Store.putCapsuleCompatibilityReport(report);
  await d1.prepare(
    "update capsule_compatibility_reports set providers_json = ? where id = ?",
  ).bind(retired, report.id).run();
  await expect(d1Store.getCapsuleCompatibilityReport(report.id)).rejects.toThrow(
    /must be an object/,
  );
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
          currentStateVersionId: seeded.capsule.currentStateVersionId,
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

test("commitRestoredState fences a same-generation current-pointer change across stores", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_restore_pointer_${label}`,
      capsuleId: `capsule_restore_pointer_${label}`,
    });
    const queued = {
      id: `restore_pointer_${label}`,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      type: "restore" as const,
      status: "queued" as const,
      backupId: `backup_pointer_${label}`,
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
    expect(
      (
        await store.transitionRun({
          id: queued.id,
          kind: "restore",
          expectFrom: ["queued"],
          run: running,
          setLeaseToken: `restore_pointer_lease_${label}`,
          heartbeatAt: 1,
        })
      ).won,
      label,
    ).toBe(true);

    // Deliberately move only the opaque pointer. The generation stays at zero,
    // so a generation-only guard would incorrectly allow the stale Restore to
    // overwrite this newer pointer.
    await store.patchCapsule(seeded.capsule.id, {
      currentStateVersionId: `pointer_only_${label}`,
      updatedAt: "2026-06-07T00:00:00.000Z",
    });
    const restoredState = stateVersion(seeded.capsule.id, {
      id: `state_restore_pointer_${label}`,
      createdByRunId: queued.id,
    });
    const restoredOutput = output(seeded.capsule.id, {
      id: `output_restore_pointer_${label}`,
    });

    await expect(
      store.commitRestoredState({
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
            currentStateVersionId: seeded.capsule.currentStateVersionId,
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
        restoreRunLeaseToken: `restore_pointer_lease_${label}`,
      }),
      label,
    ).rejects.toBeInstanceOf(CapsuleStateVersionGuardConflict);
    expect(
      (await store.getCapsule(seeded.capsule.id))?.currentStateVersionId,
      label,
    ).toBe(`pointer_only_${label}`);
    expect(await store.getStateVersion(restoredState.id), label).toBeUndefined();
    expect(await store.getOutput(restoredOutput.id), label).toBeUndefined();
    expect((await store.getBackupRun(queued.id))?.status, label).toBe("running");
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

test("recoverable run listing applies exact stale predicates before the shared limit", async () => {
  const options = {
    staleQueuedBeforeMs: 200,
    staleRunningBeforeMs: 200,
    limit: 2,
  };
  for (const [label, store] of await stores()) {
    const put = async (
      run: ApplyRun,
    ): Promise<void> => await store.putApplyRun(run);
    const queuedOld = applyRunForSafety({
      id: `recoverable_queued_old_${label}`,
      capsuleId: `capsule_recoverable_old_${label}`,
      operation: "update",
      status: "queued",
      effectAt: 110,
    });
    const queuedTie = {
      ...applyRunForSafety({
        id: `recoverable_queued_tie_${label}`,
        capsuleId: `capsule_recoverable_tie_${label}`,
        operation: "update",
        status: "queued",
        effectAt: 120,
      }),
      createdAt: "120" as unknown as number,
    } as ApplyRun;
    const queuedBoundary = {
      ...applyRunForSafety({
        id: `recoverable_queued_boundary_${label}`,
        capsuleId: `capsule_recoverable_boundary_${label}`,
        operation: "update",
        status: "queued",
        effectAt: 210,
      }),
      createdAt: "200" as unknown as number,
    } as ApplyRun;
    const queuedFresh = {
      ...applyRunForSafety({
        id: `recoverable_queued_fresh_${label}`,
        capsuleId: `capsule_recoverable_fresh_${label}`,
        operation: "update",
        status: "queued",
        effectAt: 300,
      }),
      createdAt: "201" as unknown as number,
    } as ApplyRun;
    const runningFromIso = {
      ...applyRunForSafety({
        id: `recoverable_running_iso_${label}`,
        capsuleId: `capsule_recoverable_running_iso_${label}`,
        operation: "update",
        status: "queued",
        effectAt: 310,
      }),
      status: "running",
      createdAt: 300,
      startedAt: "1970-01-01T00:00:00.150Z",
      heartbeatAt: undefined,
    } as unknown as ApplyRun;
    const runningFreshHeartbeat = {
      ...runningFromIso,
      id: `recoverable_running_fresh_${label}`,
      capsuleId: `capsule_recoverable_running_fresh_${label}`,
      heartbeatAt: 201,
    } as ApplyRun;
    const runningStringHeartbeat = {
      ...runningFromIso,
      id: `recoverable_running_string_heartbeat_${label}`,
      capsuleId: `capsule_recoverable_running_string_heartbeat_${label}`,
      heartbeatAt: "201" as unknown as number,
    } as ApplyRun;
    const malformed = {
      ...queuedOld,
      id: `recoverable_malformed_${label}`,
      capsuleId: `capsule_recoverable_malformed_${label}`,
      createdAt: "not-a-timestamp",
    } as unknown as ApplyRun;
    const billingPending = {
      ...queuedOld,
      id: `recoverable_billing_pending_${label}`,
      capsuleId: `capsule_recoverable_billing_${label}`,
      status: "succeeded",
      createdAt: 100,
      finishedAt: 150,
      auditEvents: [
        {
          id: `billing_pending_${label}`,
          type: "billing.capture.pending",
          at: 150,
        },
      ],
    } as ApplyRun;
    const billingCompletedAfterPending = {
      ...billingPending,
      id: `recoverable_billing_completed_${label}`,
      capsuleId: `capsule_recoverable_billing_completed_${label}`,
      auditEvents: [
        ...billingPending.auditEvents,
        {
          id: `billing_completed_${label}`,
          type: "billing.capture.completed",
          at: 151,
        },
      ],
    } as ApplyRun;
    const billingPendingAfterCompleted = {
      ...billingPending,
      id: `recoverable_billing_retried_${label}`,
      capsuleId: `capsule_recoverable_billing_retried_${label}`,
      createdAt: 130,
      auditEvents: [
        {
          id: `billing_completed_first_${label}`,
          type: "billing.capture.completed",
          at: 149,
        },
        ...billingPending.auditEvents,
      ],
    } as ApplyRun;

    for (const run of [
      queuedFresh,
      runningFreshHeartbeat,
      runningStringHeartbeat,
      malformed,
      queuedBoundary,
      queuedTie,
      queuedOld,
      runningFromIso,
      billingCompletedAfterPending,
      billingPendingAfterCompleted,
      billingPending,
    ]) {
      await put(run);
    }

    expect(
      (await store.listRecoverableOpenTofuRuns(options)).map((run) => run.id),
      label,
    ).toEqual([
      billingPending.id,
      queuedOld.id,
    ]);
    expect(
      (
        await store.listRecoverableOpenTofuRuns({
          ...options,
          limit: 20,
        })
      ).map((run) => run.id),
      label,
    ).toEqual([
      billingPending.id,
      queuedOld.id,
      queuedTie.id,
      billingPendingAfterCompleted.id,
      queuedBoundary.id,
      runningFromIso.id,
      runningStringHeartbeat.id,
    ]);
  }
});

test("recoverable backend SQL pushes staleness, ordering, audit, and limit", async () => {
  const options = {
    staleQueuedBeforeMs: 200,
    staleRunningBeforeMs: 200,
    limit: 2,
  };
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const pgQueries: string[] = [];
  const pgStore = new SqlOpenTofuControlStore({
    client: recordingSqlClient(pgClient, pgQueries),
  });
  await pgStore.listRecoverableOpenTofuRuns(options);
  const pgQuery = pgQueries.find((query) =>
    query.includes('select "run_json" from "takosumi_runs"'),
  );
  expect(pgQuery).toBeDefined();
  expect(pgQuery).toContain("pg_input_is_valid");
  expect(pgQuery).toContain("billing.capture.pending");
  expect(pgQuery).toContain("billing.capture.completed");
  expect(pgQuery).toMatch(/order by[\s\S]*created_at[\s\S]*limit \$\d+/iu);
  expect(pgQuery).toMatch(/created_at[\s\S]*<= \$\d+/iu);

  const d1Queries: string[] = [];
  const d1Store = new CloudflareD1OpenTofuControlStore(
    recordingD1(new SqliteFakeD1(), d1Queries),
  );
  await d1Store.listRecoverableOpenTofuRuns(options);
  const d1Query = d1Queries.find((query) =>
    query.includes('select "run_json" from "runs"'),
  );
  expect(d1Query).toBeDefined();
  expect(d1Query).toContain("json_valid");
  expect(d1Query).toContain("billing.capture.pending");
  expect(d1Query).toContain("billing.capture.completed");
  expect(d1Query).toMatch(/order by[\s\S]*created_at[\s\S]*limit \?/iu);
  expect(d1Query).toMatch(/created_at[\s\S]*<= \?/iu);
});

test("recoverable running age reads JSON heartbeat beyond stale projections", async () => {
  const options = {
    staleQueuedBeforeMs: 500,
    staleRunningBeforeMs: 500,
    limit: 1,
  };
  const fresh = (backend: string): ApplyRun =>
    ({
      ...applyRunForSafety({
        id: `recoverable_projection_fresh_${backend}`,
        capsuleId: `capsule_recoverable_projection_fresh_${backend}`,
        operation: "update",
        status: "queued",
        effectAt: 110,
      }),
      status: "running",
      createdAt: 100,
      startedAt: 100,
      heartbeatAt: 1000,
    } as ApplyRun);
  const stale = (backend: string): ApplyRun =>
    ({
      ...applyRunForSafety({
        id: `recoverable_projection_stale_${backend}`,
        capsuleId: `capsule_recoverable_projection_stale_${backend}`,
        operation: "update",
        status: "queued",
        effectAt: 210,
      }),
      status: "running",
      createdAt: 200,
      startedAt: 200,
      heartbeatAt: 100,
    } as ApplyRun);

  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const pgStore = new SqlOpenTofuControlStore({ client: pgClient });
  const pgFresh = fresh("postgres");
  const pgStale = stale("postgres");
  await pgStore.putApplyRun(pgFresh);
  await pgStore.putApplyRun(pgStale);
  await pgClient.query(
    "update takosumi_runs set heartbeat_at = null where id = $1",
    [pgFresh.id],
  );
  await pgClient.query(
    "update takosumi_runs set heartbeat_at = $1 where id = $2",
    [9999, pgStale.id],
  );
  expect(
    (await pgStore.listRecoverableOpenTofuRuns(options)).map((run) => run.id),
  ).toEqual([pgStale.id]);

  const d1Database = new SqliteFakeD1();
  const d1Store = new CloudflareD1OpenTofuControlStore(d1Database);
  const d1Fresh = fresh("d1");
  const d1Stale = stale("d1");
  await d1Store.putApplyRun(d1Fresh);
  await d1Store.putApplyRun(d1Stale);
  await d1Database
    .prepare("update runs set heartbeat_at = null where id = ?")
    .bind(d1Fresh.id)
    .run();
  await d1Database
    .prepare("update runs set heartbeat_at = ? where id = ?")
    .bind(9999, d1Stale.id)
    .run();
  expect(
    (await d1Store.listRecoverableOpenTofuRuns(options)).map((run) => run.id),
  ).toEqual([d1Stale.id]);
});

test("destroy-tail dispatch claims rotate the real bound without losing concurrent attempts", async () => {
  for (const [label, store] of await stores()) {
    const pending = Array.from({ length: 51 }, (_, index) =>
      applyRunForSafety({
        id: `apply_retirement_fair_${label}_${index}`,
        capsuleId: `capsule_retirement_fair_${label}_${index}`,
        operation: "destroy",
        status: "succeeded",
        effectAt: 100 + index,
        auditEvents: [
          {
            id: `audit_retirement_fair_${label}_${index}`,
            type: "runtime_secret.retirement.pending",
            at: 100 + index,
            data: {
              capsuleId: `capsule_retirement_fair_${label}_${index}`,
              providerDestroyCommitted: true,
            },
          },
        ],
      }),
    );
    for (const run of pending) await store.putApplyRun(run);
    const first = await store.listPendingDestroyTailRuns({
      staleBeforeMs: 300,
      limit: 50,
    });
    expect(first).toHaveLength(50);
    expect(first.map((run) => run.id), label).toEqual(
      pending.slice(0, 50).map((run) => run.id),
    );

    const concurrent = await Promise.all([
      store.claimPendingDestroyTailDispatch({
        runId: first[0]!.id,
        staleBeforeMs: 300,
        attemptedAt: 1_000,
      }),
      store.claimPendingDestroyTailDispatch({
        runId: first[0]!.id,
        staleBeforeMs: 300,
        attemptedAt: 1_000,
      }),
    ]);
    expect(concurrent.filter(Boolean), label).toHaveLength(1);
    for (const run of first.slice(1)) {
      expect(
        await store.claimPendingDestroyTailDispatch({
          runId: run.id,
          staleBeforeMs: 300,
          attemptedAt: 1_000,
        }),
        `${label}:${run.id}`,
      ).toBe(true);
    }

    const second = await store.listPendingDestroyTailRuns({
      staleBeforeMs: 300,
      limit: 50,
    });
    expect(second.map((run) => run.id), label).toEqual([pending[50]!.id]);

    for (const run of first) {
      const claimed = await store.getApplyRun(run.id);
      expect(claimed?.updatedAt, `${label}:${run.id}`).toBe(1_000);
      const deferred = claimed?.auditEvents.filter(
        (event) => event.type === "destroy_tail.dispatch.deferred",
      );
      expect(
        deferred,
        `${label}:${run.id}`,
      ).toHaveLength(1);
      expect(deferred?.[0], `${label}:${run.id}`).toEqual({
        id: expect.any(String),
        type: "destroy_tail.dispatch.deferred",
        at: 1_000,
      });
      expect(
        claimed?.auditEvents.some(
          (event) => event.type === "runtime_secret.retirement.completed",
        ),
        `${label}:${run.id}`,
      ).toBe(false);
    }

    const completed = pending[50]!;
    await store.putApplyRun({
      ...completed,
      updatedAt: 200,
      auditEvents: [
        ...completed.auditEvents,
        {
          id: `audit_retirement_completed_${completed.id}`,
          type: "runtime_secret.retirement.completed",
          at: 200,
        },
      ],
    });
    expect(
      await store.claimPendingDestroyTailDispatch({
        runId: completed.id,
        staleBeforeMs: 300,
        attemptedAt: 1_000,
      }),
      label,
    ).toBe(false);
  }
});

test("terminal runtime-secret retirement markers are recoverable on every store backend", async () => {
  for (const [label, store] of await stores()) {
    const pending = applyRunForSafety({
      id: `apply_runtime_retirement_pending_${label}`,
      capsuleId: `capsule_runtime_retirement_pending_${label}`,
      operation: "destroy",
      status: "succeeded",
      effectAt: 100,
      auditEvents: [
        {
          id: `audit_runtime_retirement_pending_${label}`,
          type: "runtime_secret.retirement.pending",
          at: 100,
          data: {
            capsuleId: `capsule_runtime_retirement_pending_${label}`,
            providerDestroyCommitted: true,
          },
        },
      ],
    });
    await store.putApplyRun(pending);

    expect(
      (
        await store.listPendingDestroyTailRuns({
          staleBeforeMs: 200,
        })
      ).map((run) => run.id),
      label,
    ).toContain(pending.id);

    await store.putApplyRun({
      ...pending,
      auditEvents: [
        ...pending.auditEvents,
        {
          id: `audit_runtime_retirement_completed_${label}`,
          type: "runtime_secret.retirement.completed",
          at: 150,
        },
      ],
    });
    expect(
      (
        await store.listPendingDestroyTailRuns({
          staleBeforeMs: 200,
        })
      ).map((run) => run.id),
      label,
    ).not.toContain(pending.id);
  }
});

test("public-input lifecycle promotion and retirement settlement use exact CAS on every backend", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_public_release_${label}`,
      capsuleId: `capsule_public_release_${label}`,
      installConfigId: `config_public_release_${label}`,
    });
    const receiptCore = {
      kind: "takosumi.public-input-reservation-receipt@v1" as const,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      capsuleExecutionAuthorityEpoch: 1,
      sourceSnapshotId: seeded.snapshot.id,
      repositoryInstallUxDigest: `sha256:${"a".repeat(64)}`,
      reservationLifecycleNonce: "00000000-0000-4000-8000-000000000001",
      clientIdempotencyKey: await publicInputClientIdempotencyKey({
        capsuleId: seeded.capsule.id,
        targetVariable: "app_url",
        subdomainVariable: "project_name",
        requestedSubdomain: "young-tree",
        reservationLifecycleNonce:
          "00000000-0000-4000-8000-000000000001",
      }),
      targetVariable: "app_url",
      subdomainVariable: "project_name",
      requestedSubdomain: "young-tree",
      owner: {
        providerSource: "registry.terraform.io/tako0614/takoform",
        connectionId: "conn_publicRelease01",
        recipeId: "takoserver-endpoint",
        authMode: "broker",
      },
      reservationRef: `provider/reservation/a/${label}`,
      httpEndpointUrl: `https://young-tree-${label}.example.test`,
    };
    const receipt: PublicInputReservationReceipt = {
      ...receiptCore,
      digest: await stableJsonDigest(receiptCore),
    };
    const replacementCore = {
      ...receiptCore,
      reservationLifecycleNonce: "00000000-0000-4000-8000-000000000002",
      clientIdempotencyKey: await publicInputClientIdempotencyKey({
        capsuleId: seeded.capsule.id,
        targetVariable: "app_url",
        subdomainVariable: "project_name",
        requestedSubdomain: "new-tree",
        reservationLifecycleNonce:
          "00000000-0000-4000-8000-000000000002",
      }),
      requestedSubdomain: "new-tree",
      reservationRef: `provider/reservation/b/${label}`,
      httpEndpointUrl: `https://new-tree-${label}.example.test`,
    };
    const replacement: PublicInputReservationReceipt = {
      ...replacementCore,
      digest: await stableJsonDigest(replacementCore),
    };
    const staged = await createPublicInputReservationLifecycle({
      applied: receipt,
      candidate: {
        planRunId: `plan_public_release_${label}`,
        stagedAt: 90,
        requirement: {
          workspaceId: replacement.workspaceId,
          capsuleId: replacement.capsuleId,
          installConfigId: replacement.installConfigId,
          capsuleExecutionAuthorityEpoch:
            replacement.capsuleExecutionAuthorityEpoch,
          sourceSnapshotId: replacement.sourceSnapshotId,
          repositoryInstallUxDigest: replacement.repositoryInstallUxDigest,
          targetVariable: replacement.targetVariable,
          subdomainVariable: replacement.subdomainVariable,
          requestedSubdomain: replacement.requestedSubdomain,
          owner: replacement.owner,
        },
        reservation: replacement,
      },
      retiring: [],
    });
    expect(
      await store.adoptCapsulePublicInputReservationRecord({
        workspaceId: seeded.workspace.id,
        capsuleId: seeded.capsule.id,
        installConfigId: seeded.installConfig.id,
        capsuleExecutionAuthorityEpoch: 1,
        record: staged,
      }),
      label,
    ).toMatchObject({ status: "stored" });
    const applyablePlan = planRunForCleanup({
      id: `plan_public_release_${label}`,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      status: "succeeded",
    });
    await store.putPlanRun(applyablePlan);
    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 200 })
      ).map((run) => run.id),
      `${label}:applyable-candidate-not-cleanable`,
    ).not.toContain(applyablePlan.id);
    const failedCandidatePlan: PlanRun = {
      ...applyablePlan,
      status: "failed",
      finishedAt: 100,
    };
    await store.putPlanRun(failedCandidatePlan);
    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 200 })
      ).map((run) => run.id),
      `${label}:failed-candidate-cleanable`,
    ).toContain(failedCandidatePlan.id);
    await store.putPlanRun(applyablePlan);
    const terminal = applyRunForSafety({
      id: `apply_public_release_${label}`,
      planRunId: applyablePlan.id,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      operation: "destroy",
      status: "succeeded",
      effectAt: 100,
    });
    const promoted = await createPublicInputReservationLifecycle({
      applied: replacement,
      retiring: [{
        cleanupRunId: terminal.id,
        enqueuedAt: 100,
        receipt,
      }],
    });
    const committedState = stateVersion(seeded.capsule.id, {
      id: `state_public_release_${label}`,
      workspaceId: seeded.workspace.id,
      createdByRunId: `apply_public_release_${label}`,
    });
    const committedOutput = output(seeded.capsule.id, {
      id: `output_public_release_${label}`,
      workspaceId: seeded.workspace.id,
    });
    const appliedPlan: PlanRun = {
      ...applyablePlan,
      appliedApplyRunId: terminal.id,
      updatedAt: 100,
    };
    await store.commitRunState({
      stateVersion: committedState,
      output: committedOutput,
      applyRunTerminal: terminal,
      planRunApplied: appliedPlan,
      capsulePatch: {
        id: seeded.capsule.id,
        patch: {
          currentStateVersionId: committedState.id,
          currentStateGeneration: committedState.generation,
          currentOutputId: committedOutput.id,
          status: "active",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
        guard: { currentStateVersionId: undefined, status: "pending" },
      },
      publicInputReservationLifecycle: {
        capsuleId: seeded.capsule.id,
        expectedLifecycleDigest: staged.digest,
        lifecycle: promoted,
      },
    });
    expect(
      await store.getCapsulePublicInputReservationRecord(seeded.capsule.id),
      `${label}:promoted`,
    ).toEqual(promoted);
    expect((await store.getStateVersion(committedState.id))?.id, label).toBe(
      committedState.id,
    );
    expect((await store.getOutput(committedOutput.id))?.id, label).toBe(
      committedOutput.id,
    );
    expect((await store.getApplyRun(terminal.id))?.status, label).toBe(
      "succeeded",
    );
    expect(
      (await store.getPlanRun(applyablePlan.id))?.appliedApplyRunId,
      label,
    ).toBe(terminal.id);
    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 200 })
      ).map((run) => run.id),
      `${label}:pending-visible`,
    ).toContain(terminal.id);
    expect(
      await store.claimPendingDestroyTailDispatch({
        runId: terminal.id,
        staleBeforeMs: 200,
        attemptedAt: 210,
      }),
      `${label}:cleanup-claim`,
    ).toBe(true);
    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 209 })
      ).map((run) => run.id),
      `${label}:claim-rotates-retry`,
    ).not.toContain(terminal.id);

    const settled = await createPublicInputReservationLifecycle({
      applied: replacement,
      retiring: [],
    });
    expect(
      await store.settleCapsulePublicInputReservationLifecycle({
        capsuleId: seeded.capsule.id,
        expectedRecordDigest: `sha256:${"0".repeat(64)}`,
        record: settled,
      }),
      `${label}:wrong-digest`,
    ).toBe(false);
    expect(
      await store.getCapsulePublicInputReservationRecord(seeded.capsule.id),
      `${label}:retirement-retained`,
    ).toEqual(promoted);

    expect(
      await store.settleCapsulePublicInputReservationLifecycle({
        capsuleId: seeded.capsule.id,
        expectedRecordDigest: promoted.digest,
        record: settled,
      }),
      `${label}:complete`,
    ).toBe(true);
    expect(
      await store.getCapsulePublicInputReservationRecord(seeded.capsule.id),
      `${label}:applied-retained`,
    ).toEqual(settled);
    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 200 })
      ).map((run) => run.id),
      `${label}:completed-hidden`,
    ).not.toContain(terminal.id);
    expect(
      await store.settleCapsulePublicInputReservationLifecycle({
        capsuleId: seeded.capsule.id,
        expectedRecordDigest: promoted.digest,
        record: settled,
      }),
      `${label}:stale-replay`,
    ).toBe(false);

    const rejectedState = stateVersion(seeded.capsule.id, {
      id: `state_public_release_rejected_${label}`,
      generation: 2,
      workspaceId: seeded.workspace.id,
      createdByRunId: `apply_public_release_rejected_${label}`,
    });
    const rejectedOutput = output(seeded.capsule.id, {
      id: `output_public_release_rejected_${label}`,
      stateGeneration: 2,
      workspaceId: seeded.workspace.id,
    });
    const rejectedTerminal = applyRunForSafety({
      id: `apply_public_release_rejected_${label}`,
      planRunId: applyablePlan.id,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      operation: "update",
      status: "succeeded",
      effectAt: 120,
    });
    const rejectedAppliedPlan: PlanRun = {
      ...applyablePlan,
      appliedApplyRunId: rejectedTerminal.id,
      updatedAt: 120,
    };
    await expect(
      store.commitRunState({
        stateVersion: rejectedState,
        output: rejectedOutput,
        applyRunTerminal: rejectedTerminal,
        planRunApplied: rejectedAppliedPlan,
        capsulePatch: {
          id: seeded.capsule.id,
          patch: {
            currentStateVersionId: rejectedState.id,
            currentStateGeneration: rejectedState.generation,
            currentOutputId: rejectedOutput.id,
            updatedAt: "2026-06-08T00:00:00.000Z",
          },
          guard: {
            currentStateVersionId: committedState.id,
            status: "active",
          },
        },
        publicInputReservationLifecycle: {
          capsuleId: seeded.capsule.id,
          // The external release settlement won first; a stale Apply commit
          // may not resurrect the retiring receipt or land any ledger writes.
          expectedLifecycleDigest: promoted.digest,
          lifecycle: promoted,
        },
      }),
      `${label}:stale-lifecycle-commit`,
    ).rejects.toThrow("lifecycle guard conflict");
    expect(await store.getStateVersion(rejectedState.id), label).toBeUndefined();
    expect(await store.getOutput(rejectedOutput.id), label).toBeUndefined();
    expect(await store.getApplyRun(rejectedTerminal.id), label).toBeUndefined();
    expect(
      (await store.getPlanRun(applyablePlan.id))?.appliedApplyRunId,
      label,
    ).toBe(terminal.id);
    expect(
      (await store.getCapsule(seeded.capsule.id))?.currentStateVersionId,
      label,
    ).toBe(committedState.id);
    expect(
      await store.getCapsulePublicInputReservationRecord(seeded.capsule.id),
      label,
    ).toEqual(settled);
  }
});

test("legacy v1 intent claims are authority-fenced CAS and remain globally repairable after Workspace archival", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_public_v1_intent_${label}`,
      capsuleId: `capsule_public_v1_intent_${label}`,
      installConfigId: `config_public_v1_intent_${label}`,
    });
    await store.putWorkspace({
      ...seeded.workspace,
      archivedAt: "2026-06-06T00:00:00.000Z",
    });
    const currentIntent = await legacyPublicInputIntent({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      sourceSnapshotId: seeded.snapshot.id,
      suffix: `${label}-current`,
    });
    const currentLifecycle = await decodePublicInputReservationLifecycle(
      currentIntent,
    );
    expect(await store.adoptCapsulePublicInputReservationRecord({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      capsuleExecutionAuthorityEpoch: 1,
      record: currentLifecycle,
    }), `${label}:seed-current`).toMatchObject({ status: "stored" });

    // A protected pre-v2 row may carry adoption coordinates that no longer
    // equal the Capsule. Repair binding fences the current Capsule separately
    // and preserves the old provider request as evidence.
    const legacyIntent = await legacyPublicInputIntent({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: `config_retired_${label}`,
      sourceSnapshotId: `snapshot_retired_${label}`,
      suffix: `${label}-retired`,
    });
    const legacyLifecycle = await decodePublicInputReservationLifecycle(
      legacyIntent,
    );
    expect(await store.settleCapsulePublicInputReservationLifecycle({
      capsuleId: seeded.capsule.id,
      expectedRecordDigest: currentLifecycle.digest,
      record: legacyLifecycle,
    }), `${label}:seed-bare-v1-shape`).toBe(true);

    const repairPlans = ["a", "b"].map((suffix) =>
      planRunForCleanup({
        id: `plan_public_v1_repair_${label}_${suffix}`,
        workspaceId: seeded.workspace.id,
        capsuleId: seeded.capsule.id,
        status: "failed",
      })
    );
    await Promise.all(repairPlans.map((run) => store.putPlanRun(run)));
    const claims = await Promise.all(
      repairPlans.map(async (run) => {
        const record = await createPublicInputReservationLifecycle({
          candidate: {
            planRunId: run.id,
            purpose: "legacy_repair",
            stagedAt: run.updatedAt,
            requirement: legacyLifecycle.candidate!.requirement,
            reservation: legacyIntent,
          },
          retiring: [],
        });
        return await store.claimCapsulePublicInputReservationLegacyCandidate({
          workspaceId: seeded.workspace.id,
          capsuleId: seeded.capsule.id,
          installConfigId: seeded.installConfig.id,
          capsuleExecutionAuthorityEpoch: 1,
          expectedRecordDigest: legacyLifecycle.digest,
          record,
        });
      }),
    );
    expect(claims.filter(({ status }) => status === "stored"), label)
      .toHaveLength(1);
    expect(claims.filter(({ status }) => status === "record_changed"), label)
      .toHaveLength(1);
    const winner = claims.find(({ status }) => status === "stored");
    if (winner?.status !== "stored") throw new Error(`${label}: missing winner`);
    expect(winner.record.candidate?.reservation, label).toEqual(legacyIntent);
    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 200 })
      ).map((run) => run.id),
      `${label}:archived-global-repair`,
    ).toContain(winner.record.candidate?.planRunId);
  }
});

test("in-memory legacy claim loses when Capsule authority changes during decode", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_public_v1_authority_race",
    capsuleId: "capsule_public_v1_authority_race",
    installConfigId: "config_public_v1_authority_race",
  });
  const intent = await legacyPublicInputIntent({
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    installConfigId: seeded.installConfig.id,
    sourceSnapshotId: seeded.snapshot.id,
    suffix: "authority-race",
  });
  const current = await decodePublicInputReservationLifecycle(intent);
  expect(await store.adoptCapsulePublicInputReservationRecord({
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    installConfigId: seeded.installConfig.id,
    capsuleExecutionAuthorityEpoch: 1,
    record: current,
  })).toMatchObject({ status: "stored" });
  const plan = planRunForCleanup({
    id: "plan_public_v1_authority_race",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    status: "failed",
  });
  await store.putPlanRun(plan);
  const claimed = await createPublicInputReservationLifecycle({
    candidate: {
      planRunId: plan.id,
      purpose: "legacy_repair",
      stagedAt: plan.updatedAt,
      requirement: current.candidate!.requirement,
      reservation: intent,
    },
    retiring: [],
  });

  const originalDigest = crypto.subtle.digest;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let digestCalls = 0;
  Object.defineProperty(crypto.subtle, "digest", {
    configurable: true,
    value: async (
      algorithm: AlgorithmIdentifier,
      data: BufferSource,
    ): Promise<ArrayBuffer> => {
      digestCalls += 1;
      if (digestCalls === 3) {
        entered.resolve();
        await release.promise;
      }
      return await originalDigest.call(crypto.subtle, algorithm, data);
    },
  });
  try {
    const pending = store.claimCapsulePublicInputReservationLegacyCandidate({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      capsuleExecutionAuthorityEpoch: 1,
      expectedRecordDigest: current.digest,
      record: claimed,
    });
    await entered.promise;
    await store.putCapsule({ ...seeded.capsule, status: "destroyed" });
    release.resolve();
    expect(await pending).toEqual({ status: "authority_changed" });
    expect(
      (await store.getCapsulePublicInputReservationRecord(seeded.capsule.id))
        ?.candidate?.planRunId,
    ).toBeUndefined();
  } finally {
    release.resolve();
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: originalDigest,
    });
  }
});

test("legacy claims reject lifecycle evidence from another Capsule on every backend", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_public_v1_identity_${label}`,
      capsuleId: `capsule_public_v1_identity_${label}`,
      installConfigId: `config_public_v1_identity_${label}`,
    });
    const validIntent = await legacyPublicInputIntent({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      sourceSnapshotId: seeded.snapshot.id,
      suffix: `${label}-identity-valid`,
    });
    const valid = await decodePublicInputReservationLifecycle(validIntent);
    expect(await store.adoptCapsulePublicInputReservationRecord({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      capsuleExecutionAuthorityEpoch: 1,
      record: valid,
    }), `${label}:seed-valid`).toMatchObject({ status: "stored" });
    const foreignIntent = await legacyPublicInputIntent({
      workspaceId: seeded.workspace.id,
      capsuleId: `capsule_public_v1_foreign_${label}`,
      installConfigId: seeded.installConfig.id,
      sourceSnapshotId: seeded.snapshot.id,
      suffix: `${label}-identity-foreign`,
    });
    const foreign = await decodePublicInputReservationLifecycle(foreignIntent);
    expect(await store.settleCapsulePublicInputReservationLifecycle({
      capsuleId: seeded.capsule.id,
      expectedRecordDigest: valid.digest,
      record: foreign,
    }), `${label}:seed-corrupt-cross-capsule`).toBe(true);
    const claimed = await createPublicInputReservationLifecycle({
      candidate: {
        planRunId: `plan_public_v1_identity_${label}`,
        purpose: "legacy_repair",
        stagedAt: 100,
        requirement: foreign.candidate!.requirement,
        reservation: foreignIntent,
      },
      retiring: [],
    });
    expect(await store.claimCapsulePublicInputReservationLegacyCandidate({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      capsuleExecutionAuthorityEpoch: 1,
      expectedRecordDigest: foreign.digest,
      record: claimed,
    }), `${label}:foreign-claim`).toMatchObject({ status: "record_changed" });
    expect(
      (await store.getCapsulePublicInputReservationRecord(seeded.capsule.id))
        ?.candidate?.planRunId,
      `${label}:foreign-remains-unbound`,
    ).toBeUndefined();
  }
});

test("legacy claim CAS requires every other Plan for the Capsule to be non-applyable", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_public_v1_plan_fence_${label}`,
      capsuleId: `capsule_public_v1_plan_fence_${label}`,
      installConfigId: `config_public_v1_plan_fence_${label}`,
    });
    const intent = await legacyPublicInputIntent({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      sourceSnapshotId: seeded.snapshot.id,
      suffix: `${label}-plan-fence`,
    });
    const current = await decodePublicInputReservationLifecycle(intent);
    expect(await store.adoptCapsulePublicInputReservationRecord({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      capsuleExecutionAuthorityEpoch: 1,
      record: current,
    }), `${label}:seed-unbound`).toMatchObject({ status: "stored" });
    const claimant = planRunForCleanup({
      id: `plan_public_v1_plan_fence_claimant_${label}`,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      status: "running",
    });
    const applyable = planRunForCleanup({
      id: `plan_public_v1_plan_fence_applyable_${label}`,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      status: "succeeded",
    });
    await store.putPlanRun(claimant);
    await store.putPlanRun(applyable);
    const claimed = await createPublicInputReservationLifecycle({
      candidate: {
        planRunId: claimant.id,
        purpose: "legacy_repair",
        stagedAt: claimant.updatedAt,
        requirement: current.candidate!.requirement,
        reservation: intent,
      },
      retiring: [],
    });
    const claimInput = {
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      capsuleExecutionAuthorityEpoch: 1,
      expectedRecordDigest: current.digest,
      record: claimed,
    } as const;
    expect(
      await store.claimCapsulePublicInputReservationLegacyCandidate(claimInput),
      `${label}:applyable-blocks`,
    ).toMatchObject({ status: "record_changed" });
    await store.putPlanRun({
      ...applyable,
      status: "failed",
      updatedAt: 200,
      finishedAt: 200,
    });
    expect(
      await store.claimCapsulePublicInputReservationLegacyCandidate(claimInput),
      `${label}:terminal-allows`,
    ).toMatchObject({ status: "stored" });
  }
});

test("global repair discovers and atomically projects untouched legacy intents in archived Workspaces", async () => {
  for (const [label, store] of await stores()) {
    const seeded = await seedCapsuleModel(store, {
      workspaceId: `workspace_public_v1_global_${label}`,
      capsuleId: `capsule_public_v1_global_${label}`,
      installConfigId: `config_public_v1_global_${label}`,
    });
    await store.putWorkspace({
      ...seeded.workspace,
      archivedAt: "2026-06-06T00:00:00.000Z",
    });
    const intent = await legacyPublicInputIntent({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      sourceSnapshotId: seeded.snapshot.id,
      suffix: `${label}-global`,
    });
    const lifecycle = await decodePublicInputReservationLifecycle(intent);
    expect(await store.adoptCapsulePublicInputReservationRecord({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      installConfigId: seeded.installConfig.id,
      capsuleExecutionAuthorityEpoch: 1,
      record: lifecycle,
    }), `${label}:seed-unprojected`).toMatchObject({ status: "stored" });
    const carrier = planRunForCleanup({
      id: `plan_public_v1_global_${label}`,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      status: "failed",
    });
    await store.putPlanRun(carrier);
    const applyable = planRunForCleanup({
      id: `plan_public_v1_global_applyable_${label}`,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      status: "succeeded",
    });
    await store.putPlanRun(applyable);

    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 200 })
      ).map((run) => run.id),
      `${label}:applyable-reference-blocks-discovery`,
    ).not.toContain(carrier.id);
    expect(await store.claimPendingDestroyTailDispatch({
      runId: carrier.id,
      staleBeforeMs: 200,
      attemptedAt: 205,
    }), `${label}:applyable-reference-blocks-claim`).toBe(false);
    await store.putPlanRun({
      ...applyable,
      status: "failed",
      updatedAt: 300,
      finishedAt: 300,
    });

    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 200 })
      ).map((run) => run.id),
      `${label}:unprojected-discovery`,
    ).toContain(carrier.id);
    const claims = await Promise.all([
      store.claimPendingDestroyTailDispatch({
        runId: carrier.id,
        staleBeforeMs: 200,
        attemptedAt: 210,
      }),
      store.claimPendingDestroyTailDispatch({
        runId: carrier.id,
        staleBeforeMs: 200,
        attemptedAt: 211,
      }),
    ]);
    expect(claims.filter(Boolean), `${label}:one-global-claim`).toHaveLength(1);
    expect(
      await store.getCapsulePublicInputReservationRecord(seeded.capsule.id),
      `${label}:durable-repair-projection`,
    ).toMatchObject({
      candidate: {
        planRunId: carrier.id,
        purpose: "legacy_repair",
        reservation: intent,
      },
    });
    expect(
      (
        await store.listPendingDestroyTailRuns({ staleBeforeMs: 209 })
      ).map((run) => run.id),
      `${label}:retry-cursor-rotated`,
    ).not.toContain(carrier.id);
  }
});

test("global legacy repair applies its limit only after carrier and no-applyable eligibility", async () => {
  for (const [label, store] of await stores()) {
    const seedLegacy = async (rank: "a" | "b" | "c") => {
      const workspaceId = `workspace_public_v1_limit_${rank}_${label}`;
      const capsuleId = `capsule_public_v1_limit_${rank}_${label}`;
      const seeded = await seedCapsuleModel(store, {
        workspaceId,
        capsuleId,
        installConfigId: `config_public_v1_limit_${rank}_${label}`,
        sourceId: `source_public_v1_limit_${rank}_${label}`,
        snapshotId: `snapshot_public_v1_limit_${rank}_${label}`,
      });
      const intent = await legacyPublicInputIntent({
        workspaceId,
        capsuleId,
        installConfigId: seeded.installConfig.id,
        sourceSnapshotId: seeded.snapshot.id,
        suffix: `${label}-limit-${rank}`,
      });
      const lifecycle = await decodePublicInputReservationLifecycle(intent);
      expect(await store.adoptCapsulePublicInputReservationRecord({
        workspaceId,
        capsuleId,
        installConfigId: seeded.installConfig.id,
        capsuleExecutionAuthorityEpoch: 1,
        record: lifecycle,
      }), `${label}:${rank}:seed-unprojected`).toMatchObject({
        status: "stored",
      });
      return seeded;
    };

    // These rows sort before the eligible Capsule. The first has no terminal
    // carrier; the second still has an applyable Plan. Neither may consume the
    // bounded discovery query before eligibility is proven.
    await seedLegacy("a");
    const blocked = await seedLegacy("b");
    const blockedCarrier = planRunForCleanup({
      id: `plan_public_v1_limit_b_carrier_${label}`,
      workspaceId: blocked.workspace.id,
      capsuleId: blocked.capsule.id,
      status: "failed",
    });
    const blockedApplyable = planRunForCleanup({
      id: `plan_public_v1_limit_b_applyable_${label}`,
      workspaceId: blocked.workspace.id,
      capsuleId: blocked.capsule.id,
      status: "succeeded",
    });
    await store.putPlanRun(blockedCarrier);
    await store.putPlanRun(blockedApplyable);

    const eligible = await seedLegacy("c");
    const eligibleCarrier = planRunForCleanup({
      id: `plan_public_v1_limit_c_carrier_${label}`,
      workspaceId: eligible.workspace.id,
      capsuleId: eligible.capsule.id,
      status: "failed",
    });
    await store.putPlanRun(eligibleCarrier);

    expect(
      (
        await store.listPendingDestroyTailRuns({
          staleBeforeMs: 200,
          limit: 1,
        })
      ).map((run) => run.id),
      `${label}:limit-after-eligibility`,
    ).toEqual([eligibleCarrier.id]);
  }
});

test("Postgres and D1 backward-decode a bare v1 receipt as applied lifecycle state", async () => {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const pgStore = new SqlOpenTofuControlStore({ client: pgClient });
  const pgSeeded = await seedCapsuleModel(pgStore, {
    workspaceId: "workspace_public_v1_postgres",
    capsuleId: "capsule_public_v1_postgres",
    installConfigId: "config_public_v1_postgres",
  });
  const pgReceipt = await legacyPublicInputReceipt({
    workspaceId: pgSeeded.workspace.id,
    capsuleId: pgSeeded.capsule.id,
    installConfigId: pgSeeded.installConfig.id,
    sourceSnapshotId: pgSeeded.snapshot.id,
    suffix: "postgres",
  });
  await pgClient.query(
    `update takosumi_capsules
       set public_input_reservation_json = $1::jsonb
     where id = $2`,
    [JSON.stringify(pgReceipt), pgSeeded.capsule.id],
  );
  const pgDecoded = await pgStore.getCapsulePublicInputReservationRecord(
    pgSeeded.capsule.id,
  );
  expect(pgDecoded).toMatchObject({
    kind: "takosumi.public-input-reservation-lifecycle@v2",
    applied: pgReceipt,
    retiring: [],
  });
  expect(await pgStore.replaceCapsulePublicInputReservationRecord({
    workspaceId: pgSeeded.workspace.id,
    capsuleId: pgSeeded.capsule.id,
    installConfigId: pgSeeded.installConfig.id,
    capsuleExecutionAuthorityEpoch: 1,
    expectedRecordDigest: pgDecoded!.digest,
    record: pgDecoded!,
  })).toMatchObject({ status: "stored" });
  const pgRaw = await pgClient.query<{ kind: string }>(
    `select public_input_reservation_json->>'kind' as kind
       from takosumi_capsules where id = $1`,
    [pgSeeded.capsule.id],
  );
  expect(pgRaw.rows[0]?.kind).toBe(
    "takosumi.public-input-reservation-lifecycle@v2",
  );

  const d1 = new SqliteFakeD1();
  const d1Store = new CloudflareD1OpenTofuControlStore(d1);
  const d1Seeded = await seedCapsuleModel(d1Store, {
    workspaceId: "workspace_public_v1_d1",
    capsuleId: "capsule_public_v1_d1",
    installConfigId: "config_public_v1_d1",
  });
  const d1Receipt = await legacyPublicInputReceipt({
    workspaceId: d1Seeded.workspace.id,
    capsuleId: d1Seeded.capsule.id,
    installConfigId: d1Seeded.installConfig.id,
    sourceSnapshotId: d1Seeded.snapshot.id,
    suffix: "d1",
  });
  await d1.prepare(
    `update capsules
        set public_input_reservation_json = ?
      where id = ?`,
  ).bind(JSON.stringify(d1Receipt), d1Seeded.capsule.id).run();
  const d1Decoded = await d1Store.getCapsulePublicInputReservationRecord(
    d1Seeded.capsule.id,
  );
  expect(d1Decoded).toMatchObject({
    kind: "takosumi.public-input-reservation-lifecycle@v2",
    applied: d1Receipt,
    retiring: [],
  });
  expect(await d1Store.replaceCapsulePublicInputReservationRecord({
    workspaceId: d1Seeded.workspace.id,
    capsuleId: d1Seeded.capsule.id,
    installConfigId: d1Seeded.installConfig.id,
    capsuleExecutionAuthorityEpoch: 1,
    expectedRecordDigest: d1Decoded!.digest,
    record: d1Decoded!,
  })).toMatchObject({ status: "stored" });
  const d1Raw = await d1.prepare(
    `select json_extract(public_input_reservation_json, '$.kind') as kind
       from capsules where id = ?`,
  ).bind(d1Seeded.capsule.id).first<{ kind: string }>();
  expect(d1Raw?.kind).toBe("takosumi.public-input-reservation-lifecycle@v2");
});

test("Postgres and D1 backward-decode and authority-claim a bare v1 intent", async () => {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const pgStore = new SqlOpenTofuControlStore({ client: pgClient });
  const pgSeeded = await seedCapsuleModel(pgStore, {
    workspaceId: "workspace_public_v1_intent_postgres",
    capsuleId: "capsule_public_v1_intent_postgres",
    installConfigId: "config_public_v1_intent_postgres",
  });
  const pgIntent = await legacyPublicInputIntent({
    workspaceId: pgSeeded.workspace.id,
    capsuleId: pgSeeded.capsule.id,
    installConfigId: pgSeeded.installConfig.id,
    sourceSnapshotId: pgSeeded.snapshot.id,
    suffix: "postgres-raw",
  });
  await pgClient.query(
    `update takosumi_capsules
       set public_input_reservation_json = $1::jsonb
     where id = $2`,
    [JSON.stringify(pgIntent), pgSeeded.capsule.id],
  );
  const pgDecoded = await pgStore.getCapsulePublicInputReservationRecord(
    pgSeeded.capsule.id,
  );
  expect(pgDecoded?.candidate).toMatchObject({
    stagedAt: 0,
    reservation: pgIntent,
  });
  expect(pgDecoded?.candidate?.planRunId).toBeUndefined();
  const pgPlan = planRunForCleanup({
    id: "plan_public_v1_intent_postgres_repair",
    workspaceId: pgSeeded.workspace.id,
    capsuleId: pgSeeded.capsule.id,
    status: "failed",
  });
  await pgStore.putPlanRun(pgPlan);
  expect(
    (await pgStore.listPendingDestroyTailRuns({ staleBeforeMs: 200 })).map(
      (run) => run.id,
    ),
  ).toContain(pgPlan.id);
  expect(await pgStore.claimPendingDestroyTailDispatch({
    runId: pgPlan.id,
    staleBeforeMs: 200,
    attemptedAt: 210,
  })).toBe(true);
  const pgProjection = await pgClient.query<{ run_id: string; kind: string }>(
    `select public_input_reservation_cleanup_run_id as run_id,
            public_input_reservation_json->>'kind' as kind
       from takosumi_capsules where id = $1`,
    [pgSeeded.capsule.id],
  );
  expect(pgProjection.rows[0]).toEqual({
    run_id: pgPlan.id,
    kind: "takosumi.public-input-reservation-lifecycle@v2",
  });

  const d1 = new SqliteFakeD1();
  const d1Store = new CloudflareD1OpenTofuControlStore(d1);
  const d1Seeded = await seedCapsuleModel(d1Store, {
    workspaceId: "workspace_public_v1_intent_d1",
    capsuleId: "capsule_public_v1_intent_d1",
    installConfigId: "config_public_v1_intent_d1",
  });
  const d1Intent = await legacyPublicInputIntent({
    workspaceId: d1Seeded.workspace.id,
    capsuleId: d1Seeded.capsule.id,
    installConfigId: d1Seeded.installConfig.id,
    sourceSnapshotId: d1Seeded.snapshot.id,
    suffix: "d1-raw",
  });
  await d1.prepare(
    `update capsules
        set public_input_reservation_json = ?
      where id = ?`,
  ).bind(JSON.stringify(d1Intent), d1Seeded.capsule.id).run();
  const d1Decoded = await d1Store.getCapsulePublicInputReservationRecord(
    d1Seeded.capsule.id,
  );
  expect(d1Decoded?.candidate).toMatchObject({
    stagedAt: 0,
    reservation: d1Intent,
  });
  expect(d1Decoded?.candidate?.planRunId).toBeUndefined();
  const d1Plan = planRunForCleanup({
    id: "plan_public_v1_intent_d1_repair",
    workspaceId: d1Seeded.workspace.id,
    capsuleId: d1Seeded.capsule.id,
    status: "failed",
  });
  await d1Store.putPlanRun(d1Plan);
  expect(
    (await d1Store.listPendingDestroyTailRuns({ staleBeforeMs: 200 })).map(
      (run) => run.id,
    ),
  ).toContain(d1Plan.id);
  expect(await d1Store.claimPendingDestroyTailDispatch({
    runId: d1Plan.id,
    staleBeforeMs: 200,
    attemptedAt: 210,
  })).toBe(true);
  expect(await d1.prepare(
    `select public_input_reservation_cleanup_run_id as run_id,
            json_extract(public_input_reservation_json, '$.kind') as kind
       from capsules where id = ?`,
  ).bind(d1Seeded.capsule.id).first()).toEqual({
    run_id: d1Plan.id,
    kind: "takosumi.public-input-reservation-lifecycle@v2",
  });
});

test("sealed secret create-if-absent converges under concurrent writers on every store backend", async () => {
  for (const [label, store] of await stores()) {
    const connectionId = `runtime_secret_file_concurrent_${label}`;
    const blob = (suffix: string): StoredSecretBlob => ({
      id: `secret_${label}_${suffix}`,
      connectionId,
      workspaceId: `workspace_${label}`,
      kind: `runtime-secret-file:capsule_${label}`,
      ciphertext: `sealed-${suffix}`,
      encryptedDek: `runtime-secret-file-aes-gcm/v1/runtime-secret-file:capsule_${label}`,
      nonce: `nonce-${suffix}`,
      aad: `aad-${suffix}`,
      keyVersion: 1,
      createdAt: TS,
    });
    const candidates = [blob("a"), blob("b")];
    const created = await Promise.all(
      candidates.map((candidate) =>
        store.createSecretBlobIfAbsent(candidate),
      ),
    );

    expect(created.filter(Boolean), label).toHaveLength(1);
    const winner = candidates[created.findIndex(Boolean)];
    expect(await store.getSecretBlob(connectionId), label).toEqual(winner);
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
