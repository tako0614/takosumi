import { afterEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { ApplyRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";

import type {
  SqlClient,
  SqlParameters,
} from "../../../../core/adapters/storage/sql.ts";
import {
  createCapsuleExecutionAuthorityResolver,
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import {
  PGliteSqlClient,
  splitSqlStatements,
} from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type {
  D1Database,
  D1PreparedStatement,
} from "../../../../worker/src/bindings.ts";

const NOW = "2026-08-10T00:00:00.000Z";
const WORKSPACE_ID = "workspace_authority";
const CAPSULE_ID = "capsule_authority";
const BATCH_CAPSULE_A = "capsule_authority_batch_a";
const BATCH_CAPSULE_B = "capsule_authority_batch_b";
const BATCH_CAPSULE_DESTROYED = "capsule_authority_batch_destroyed";
const BATCH_CAPSULE_UNSAFE = "capsule_authority_batch_unsafe";
const clients: PGliteSqlClient[] = [];

interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function recordingD1(
  database: D1Database,
  records: RecordedQuery[],
): D1Database {
  return {
    prepare(query) {
      const statement = database.prepare(query);
      const record = (parameters: readonly unknown[]) => {
        records.push({ sql: query, parameters });
      };
      return {
        bind(...values) {
          record(values);
          return statement.bind(...values);
        },
        first<T>() {
          record([]);
          return statement.first<T>();
        },
        all<T>() {
          record([]);
          return statement.all<T>();
        },
        run<T>() {
          record([]);
          return statement.run<T>();
        },
      } satisfies D1PreparedStatement;
    },
    batch: (statements) => database.batch(statements),
  };
}

function recordingSqlClient(
  client: SqlClient,
  records: RecordedQuery[],
): SqlClient {
  return {
    query(sql, parameters) {
      records.push({
        sql,
        parameters: Array.isArray(parameters) ? parameters : [],
      });
      return client.query(sql, parameters as SqlParameters | undefined);
    },
    transaction: (fn) => client.transaction(fn),
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function capsule(status: Capsule["status"] = "active"): Capsule {
  return {
    id: CAPSULE_ID,
    workspaceId: WORKSPACE_ID,
    projectId: "project_authority",
    name: "authority",
    slug: "authority",
    sourceId: "source_authority",
    installConfigId: "config_authority",
    environment: "production",
    currentStateGeneration: 0,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function terminatingRun(status: "queued" | "failed"): ApplyRun {
  return {
    id: "run_authority_destroy",
    planRunId: "plan_authority_destroy",
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    operation: "destroy",
    runnerProfileId: "opentofu-default",
    status,
    expected: {
      planRunId: "plan_authority_destroy",
      capsuleId: CAPSULE_ID,
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:plan",
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: status === "queued" ? 1 : 2,
    startedAt: 1,
    ...(status === "failed" ? { finishedAt: 2 } : {}),
  };
}

function batchCapsule(
  capsuleId: string,
  status: Capsule["status"] = "active",
): Capsule {
  return {
    ...capsule(status),
    id: capsuleId,
    projectId: `project_${capsuleId}`,
    name: capsuleId,
    slug: capsuleId,
  };
}

function batchTerminatingRun(capsuleId: string): ApplyRun {
  const run = terminatingRun("queued");
  return {
    ...run,
    id: `run_destroy_${capsuleId}`,
    planRunId: `plan_destroy_${capsuleId}`,
    capsuleId,
    expected: {
      ...run.expected,
      planRunId: `plan_destroy_${capsuleId}`,
      capsuleId,
    },
  };
}

const batchAuthorityInputs = [
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_B },
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_A },
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_B },
  { workspaceId: WORKSPACE_ID, capsuleId: "capsule_authority_batch_missing" },
  { workspaceId: "workspace_foreign", capsuleId: BATCH_CAPSULE_A },
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_DESTROYED },
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_UNSAFE },
] as const;

const batchAuthorityExpected = [
  {
    workspaceId: WORKSPACE_ID,
    capsuleId: BATCH_CAPSULE_B,
    executionAuthorityEpoch: 1,
  },
  {
    workspaceId: WORKSPACE_ID,
    capsuleId: BATCH_CAPSULE_A,
    executionAuthorityEpoch: 1,
  },
  {
    workspaceId: WORKSPACE_ID,
    capsuleId: BATCH_CAPSULE_B,
    executionAuthorityEpoch: 1,
  },
  undefined,
  undefined,
  undefined,
  undefined,
] as const;

async function seedBatchAuthorities(
  store: OpenTofuControlStore,
): Promise<void> {
  await store.putCapsule(batchCapsule(BATCH_CAPSULE_A));
  await store.putCapsule(batchCapsule(BATCH_CAPSULE_B));
  await store.putCapsule(
    batchCapsule(BATCH_CAPSULE_DESTROYED, "destroyed"),
  );
  await store.putCapsule(batchCapsule(BATCH_CAPSULE_UNSAFE));
  await store.putApplyRun(batchTerminatingRun(BATCH_CAPSULE_UNSAFE));
}

async function expectBatchAuthorityParity(
  store: OpenTofuControlStore,
): Promise<void> {
  await seedBatchAuthorities(store);
  await expect(
    store.resolveCapsuleExecutionAuthorities(batchAuthorityInputs),
  ).resolves.toEqual(batchAuthorityExpected);
}

async function expectLifecycleParity(
  stores: readonly OpenTofuControlStore[],
): Promise<void> {
  const [first, second = first] = stores;
  if (!first || !second) throw new Error("authority stores are required");
  await first.putCapsule(capsule());

  await expect(
    first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toEqual({
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    executionAuthorityEpoch: 1,
  });
  await expect(
    first.resolveCapsuleExecutionAuthority("workspace_foreign", CAPSULE_ID),
  ).resolves.toBeUndefined();

  await first.patchCapsule(CAPSULE_ID, { status: "stale", updatedAt: NOW });
  expect(
    (
      await first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID)
    )?.executionAuthorityEpoch,
  ).toBe(1);

  await first.putApplyRun(terminatingRun("queued"));
  await expect(
    first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toBeUndefined();
  await first.putApplyRun(terminatingRun("failed"));
  await expect(
    first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toMatchObject({ executionAuthorityEpoch: 1 });

  // Two independently composed writers can observe a live row and race the
  // same terminal transition. The durable trigger/CAS consumes one epoch.
  await Promise.all([
    first.patchCapsule(CAPSULE_ID, { status: "destroyed", updatedAt: NOW }),
    second.patchCapsule(CAPSULE_ID, { status: "destroyed", updatedAt: NOW }),
  ]);
  await expect(
    first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toBeUndefined();

  // A synthetic reactivation is not a product lifecycle operation, but proves
  // that retirement did not reset the private fence to its default.
  await first.patchCapsule(CAPSULE_ID, { status: "active", updatedAt: NOW });
  expect(
    (
      await first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID)
    )?.executionAuthorityEpoch,
  ).toBe(2);

  await first.commitRunState({
    capsulePatch: {
      id: CAPSULE_ID,
      patch: { status: "destroyed", updatedAt: NOW },
      guard: { currentStateVersionId: undefined, status: "active" },
    },
  });
  await first.patchCapsule(CAPSULE_ID, { status: "active", updatedAt: NOW });
  expect(
    (
      await first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID)
    )?.executionAuthorityEpoch,
  ).toBe(3);
}

async function expectInitiallyDestroyedDefault(
  store: OpenTofuControlStore,
): Promise<void> {
  await store.putCapsule(capsule("destroyed"));
  await store.patchCapsule(CAPSULE_ID, { status: "active", updatedAt: NOW });
  await expect(
    store.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toMatchObject({ executionAuthorityEpoch: 1 });
}

describe("Capsule execution authority", () => {
  test("InMemory keeps the same private terminal-transition semantics", async () => {
    const store = new InMemoryOpenTofuControlStore();
    await expectLifecycleParity([store]);
  });

  test("D1 converges terminal writers and commitRunState on one durable epoch", async () => {
    const database = new SqliteFakeD1();
    await expectLifecycleParity([
      new CloudflareD1OpenTofuControlStore(database),
      new CloudflareD1OpenTofuControlStore(database),
    ]);
  });

  test("Postgres converges terminal writers and commitRunState on one durable epoch", async () => {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    await expectLifecycleParity([
      new SqlOpenTofuControlStore({ client }),
      new SqlOpenTofuControlStore({ client }),
    ]);
  });

  test("all stores keep the default epoch at one for an initially destroyed row", async () => {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    await Promise.all([
      expectInitiallyDestroyedDefault(new InMemoryOpenTofuControlStore()),
      expectInitiallyDestroyedDefault(
        new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()),
      ),
      expectInitiallyDestroyedDefault(new SqlOpenTofuControlStore({ client })),
    ]);
  });

  test("ordered batches preserve duplicates and fail closed across all stores", async () => {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    await expectBatchAuthorityParity(new InMemoryOpenTofuControlStore());
    await expectBatchAuthorityParity(
      new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()),
    );
    await expectBatchAuthorityParity(new SqlOpenTofuControlStore({ client }));
  });

  test("D1 resolves an ordered authority batch in one json_each statement", async () => {
    const records: RecordedQuery[] = [];
    const database = new SqliteFakeD1();
    const store = new CloudflareD1OpenTofuControlStore(
      recordingD1(database, records),
    );
    await seedBatchAuthorities(store);
    records.length = 0;

    await expect(
      store.resolveCapsuleExecutionAuthorities(batchAuthorityInputs),
    ).resolves.toEqual(batchAuthorityExpected);

    const authorityStatements = records.filter((record) =>
      record.sql.includes("ordered_capsule_authority_requests"),
    );
    expect(authorityStatements).toHaveLength(1);
    const [authorityStatement] = authorityStatements;
    if (!authorityStatement) throw new Error("D1 batch statement is missing");
    expect(authorityStatement.sql).toContain("json_each");
    expect(authorityStatement.parameters).toHaveLength(1);
    const plan = await database
      .prepare(`explain query plan ${authorityStatement.sql}`)
      .bind(...authorityStatement.parameters)
      .all<{ readonly detail: string }>();
    const details = (plan.results ?? []).map((row) => row.detail);
    expect(details.some((detail) =>
      detail.includes("capsules_execution_authority_exact_idx")
    )).toBe(true);
    expect(details.some((detail) => detail.includes("runs_installation_idx")))
      .toBe(true);
  });

  test("ordered authority batches execute on an isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [
        {
          type: "ESModule",
          path: "capsule-execution-authority-workerd.mjs",
          contents: "export default {fetch(){return new Response('ok')}}",
        },
      ],
      d1Databases: { CONTROL: "capsule-execution-authority-workerd" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL");
      const store = new CloudflareD1OpenTofuControlStore(
        database as unknown as D1Database,
      );
      await expectBatchAuthorityParity(store);
    } finally {
      await runtime.dispose();
    }
  }, 10_000);

  test("durable resolvers use one indexed database snapshot", async () => {
    const d1Records: RecordedQuery[] = [];
    const database = new SqliteFakeD1();
    const d1Store = new CloudflareD1OpenTofuControlStore(
      recordingD1(database, d1Records),
    );
    await d1Store.putCapsule(capsule());
    d1Records.length = 0;
    await expect(
      d1Store.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
    ).resolves.toMatchObject({ executionAuthorityEpoch: 1 });
    const d1AuthorityQueries = d1Records.filter((entry) =>
      entry.sql.includes("latest_capsule_runtime_safety"),
    );
    expect(d1AuthorityQueries).toHaveLength(1);
    const [d1AuthorityQuery] = d1AuthorityQueries;
    if (!d1AuthorityQuery) throw new Error("D1 authority query is missing");
    const d1Plan = await database
      .prepare(`explain query plan ${d1AuthorityQuery.sql}`)
      .bind(...d1AuthorityQuery.parameters)
      .all<{ readonly detail: string }>();
    const d1PlanDetails = (d1Plan.results ?? []).map((row) => row.detail);
    expect(d1PlanDetails).toContain(
      "SEARCH capsules USING INDEX capsules_execution_authority_exact_idx (space_id=? AND id=?)",
    );
    expect(d1PlanDetails.some((detail) =>
      detail.includes("runs_installation_idx (installation_id=?)")
    )).toBe(true);

    const client = await PGliteSqlClient.create();
    clients.push(client);
    const pgRecords: RecordedQuery[] = [];
    const pgStore = new SqlOpenTofuControlStore({
      client: recordingSqlClient(client, pgRecords),
    });
    await pgStore.putCapsule(capsule());
    await client.exec(`insert into takosumi_runs (
      id, kind, space_id, installation_id, status, created_at, run_json
    )
    select
      'authority_filler_run_' || n,
      'apply',
      '${WORKSPACE_ID}',
      'authority_filler_capsule_' || n,
      'succeeded',
      '1',
      '{}'::jsonb
    from generate_series(1, 500) as n`);
    await client.exec("analyze takosumi_runs");
    pgRecords.length = 0;
    await expect(
      pgStore.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
    ).resolves.toMatchObject({ executionAuthorityEpoch: 1 });
    const pgAuthorityQueries = pgRecords.filter((entry) =>
      entry.sql.includes("latest_capsule_runtime_safety"),
    );
    expect(pgAuthorityQueries).toHaveLength(1);
    const [pgAuthorityQuery] = pgAuthorityQueries;
    if (!pgAuthorityQuery) {
      throw new Error("Postgres authority query is missing");
    }
    const pgPlan = await client.query<{ readonly "QUERY PLAN": unknown }>(
      `explain (format json) ${pgAuthorityQuery.sql}`,
      pgAuthorityQuery.parameters,
    );
    const pgPlanJson = JSON.stringify(pgPlan.rows);
    expect(pgPlanJson).toContain(
      "takosumi_capsules_execution_authority_exact_idx",
    );
    expect(pgPlanJson).toContain(
      "takosumi_runs_installation_created_at_idx",
    );
  });

  test("resolver suspends unsafe runtime phases without consuming an epoch", async () => {
    let phase: "safe" | "terminating" | "unknown" = "safe";
    let reads = 0;
    const resolver = createCapsuleExecutionAuthorityResolver({
      async resolveCapsuleExecutionAuthority(workspaceId, capsuleId) {
        reads += 1;
        return phase === "safe"
          ? { workspaceId, capsuleId, executionAuthorityEpoch: 7 }
          : undefined;
      },
      async resolveCapsuleExecutionAuthorities(inputs) {
        return inputs.map(({ workspaceId, capsuleId }) =>
          phase === "safe"
            ? { workspaceId, capsuleId, executionAuthorityEpoch: 7 }
            : undefined,
        );
      },
    });

    await expect(
      resolver.resolveExact({
        workspaceId: WORKSPACE_ID,
        capsuleId: CAPSULE_ID,
      }),
    ).resolves.toMatchObject({ executionAuthorityEpoch: 7 });
    expect(reads).toBe(1);

    phase = "terminating";
    await expect(
      resolver.resolveExact({
        workspaceId: WORKSPACE_ID,
        capsuleId: CAPSULE_ID,
      }),
    ).resolves.toBeUndefined();
    phase = "unknown";
    await expect(
      resolver.resolveExact({
        workspaceId: WORKSPACE_ID,
        capsuleId: CAPSULE_ID,
      }),
    ).resolves.toBeUndefined();
  });

  test("resolver cannot authorize across a terminating-Run interleaving", async () => {
    let phase: "safe" | "terminating" = "safe";
    let atomicReads = 0;
    let legacyReads = 0;
    const interleavableStore = {
      async resolveCapsuleExecutionAuthority(workspaceId: string, capsuleId: string) {
        atomicReads += 1;
        phase = "terminating";
        return undefined;
      },
      async resolveCapsuleExecutionAuthorities() {
        phase = "terminating";
        return [];
      },
      async getCapsuleExecutionAuthority(workspaceId: string, capsuleId: string) {
        legacyReads += 1;
        if (legacyReads === 2) phase = "terminating";
        return {
          workspaceId,
          capsuleId,
          executionAuthorityEpoch: 7,
        };
      },
      async getCapsuleRuntimeSafety() {
        return phase === "safe"
          ? { phase, runId: "run_apply", runType: "apply" }
          : { phase, runId: "run_destroy", runType: "destroy_apply" };
      },
    };
    const resolver = createCapsuleExecutionAuthorityResolver(interleavableStore);

    await expect(
      resolver.resolveExact({
        workspaceId: WORKSPACE_ID,
        capsuleId: CAPSULE_ID,
      }),
    ).resolves.toBeUndefined();
    expect(atomicReads).toBe(1);
    expect(legacyReads).toBe(0);
  });

  test("batch resolver delegates once without per-item interleaving", async () => {
    let singleReads = 0;
    let batchReads = 0;
    const resolver = createCapsuleExecutionAuthorityResolver({
      async resolveCapsuleExecutionAuthority(workspaceId, capsuleId) {
        singleReads += 1;
        return { workspaceId, capsuleId, executionAuthorityEpoch: singleReads };
      },
      async resolveCapsuleExecutionAuthorities(inputs) {
        batchReads += 1;
        return inputs.map(({ workspaceId, capsuleId }) => ({
          workspaceId,
          capsuleId,
          executionAuthorityEpoch: 11,
        }));
      },
    });

    await expect(
      resolver.resolveExactMany([
        { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_A },
        { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_B },
      ]),
    ).resolves.toEqual([
      {
        workspaceId: WORKSPACE_ID,
        capsuleId: BATCH_CAPSULE_A,
        executionAuthorityEpoch: 11,
      },
      {
        workspaceId: WORKSPACE_ID,
        capsuleId: BATCH_CAPSULE_B,
        executionAuthorityEpoch: 11,
      },
    ]);
    expect(batchReads).toBe(1);
    expect(singleReads).toBe(0);
  });

  test("D1 v64 upgrades a populated v63 row and fences an older writer", async () => {
    const database = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(database, {
      throughMigrationVersion: 63,
    });
    await database
      .prepare(
        `insert into capsules (
           id, space_id, project_id, name, slug, source_id,
           install_config_id, environment, current_state_generation,
           status, record_json, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`,
      )
      .bind(
        CAPSULE_ID,
        WORKSPACE_ID,
        "project_authority",
        "authority",
        "authority",
        "source_authority",
        "config_authority",
        "production",
        JSON.stringify(capsule()),
        NOW,
        NOW,
      )
      .run();

    await ensureD1OpenTofuLedgerSchema(database);
    expect(
      await database
        .prepare(
          `select execution_authority_epoch as epoch
             from capsules where id = ?`,
        )
        .bind(CAPSULE_ID)
        .first(),
    ).toEqual({ epoch: 1 });
    const d1Plan = await database
      .prepare(
        `explain query plan
         select execution_authority_epoch from capsules
          where id = ? and space_id = ? and status <> 'destroyed'
          limit 1`,
      )
      .bind(CAPSULE_ID, WORKSPACE_ID)
      .all<{ readonly detail: string }>();
    expect((d1Plan.results ?? []).map((row) => row.detail)).toEqual([
      "SEARCH capsules USING INDEX sqlite_autoindex_capsules_1 (id=?)",
    ]);
    await database
      .prepare(`update capsules set status = 'destroyed' where id = ?`)
      .bind(CAPSULE_ID)
      .run();
    expect(
      await database
        .prepare(
          `select execution_authority_epoch as epoch
             from capsules where id = ?`,
        )
        .bind(CAPSULE_ID)
        .first(),
    ).toEqual({ epoch: 2 });
  });

  test("Postgres v108 upgrades a populated v107 row and fences an older writer", async () => {
    const client = await PGliteSqlClient.createThroughMigrationVersion(107);
    clients.push(client);
    await client.exec(`insert into takosumi_capsules (
      id, space_id, project_id, name, environment, source_id,
      install_config_id, current_state_version_id, status,
      installation_json, created_at, updated_at
    ) values (
      '${CAPSULE_ID}', '${WORKSPACE_ID}', 'project_authority', 'authority',
      'production', 'source_authority', 'config_authority', null, 'active',
      '${JSON.stringify(capsule())}'::jsonb, '${NOW}', '${NOW}'
    )`);
    const migration = postgresStorageMigrationStatements.find(
      (entry) => entry.version === 108,
    );
    if (!migration) throw new Error("Postgres v108 migration is missing");
    for (const statement of splitSqlStatements(migration.sql)) {
      await client.exec(statement);
    }

    expect(
      (
        await client.query<{ execution_authority_epoch: number }>(
          `select execution_authority_epoch
             from takosumi_capsules where id = $1`,
          [CAPSULE_ID],
        )
      ).rows,
    ).toEqual([{ execution_authority_epoch: 1 }]);
    await client.exec(`insert into takosumi_capsules (
      id, space_id, project_id, name, environment, source_id,
      install_config_id, current_state_version_id, status,
      installation_json, created_at, updated_at
    )
    select
      'capsule_authority_filler_' || n,
      '${WORKSPACE_ID}',
      'project_authority',
      'authority-filler-' || n,
      'production',
      'source_authority',
      'config_authority',
      null,
      'active',
      jsonb_build_object('id', 'capsule_authority_filler_' || n),
      '${NOW}',
      '${NOW}'
    from generate_series(1, 500) as n`);
    await client.exec("analyze takosumi_capsules");
    const postgresPlan = await client.query<{ readonly "QUERY PLAN": unknown }>(
      `explain (format json)
       select execution_authority_epoch from takosumi_capsules
        where id = $1 and space_id = $2 and status <> 'destroyed'
        limit 1`,
      [CAPSULE_ID, WORKSPACE_ID],
    );
    expect(JSON.stringify(postgresPlan.rows)).toContain(
      "takosumi_capsules_execution_authority_exact_idx",
    );
    await client.query(
      `update takosumi_capsules set status = 'destroyed' where id = $1`,
      [CAPSULE_ID],
    );
    expect(
      (
        await client.query<{ execution_authority_epoch: number }>(
          `select execution_authority_epoch
             from takosumi_capsules where id = $1`,
          [CAPSULE_ID],
        )
      ).rows,
    ).toEqual([{ execution_authority_epoch: 2 }]);
  });
});
