import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { Capsule } from "takosumi-contract/capsules";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import {
  PGliteSqlClient,
  splitSqlStatements,
} from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const pgClients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function adapters(): Promise<readonly {
  name: string;
  first: OpenTofuControlStore;
  reopen: () => OpenTofuControlStore;
  removeCapsule: (id: string) => Promise<void>;
}[]> {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const d1 = new SqliteFakeD1();
  const memory = new InMemoryOpenTofuControlStore();
  return [
    {
      name: "memory",
      first: memory,
      reopen: () => memory,
      removeCapsule: async (id) => {
        const row = await memory.getCapsule(id);
        if (row) await memory.putCapsule({ ...row, status: "destroyed" });
      },
    },
    {
      name: "postgres",
      first: new SqlOpenTofuControlStore({ client: pg }),
      reopen: () => new SqlOpenTofuControlStore({ client: pg }),
      removeCapsule: async (id) => {
        await pg.query("delete from takosumi_capsules where id = $1", [id]);
      },
    },
    {
      name: "d1",
      first: new CloudflareD1OpenTofuControlStore(d1),
      reopen: () => new CloudflareD1OpenTofuControlStore(d1),
      removeCapsule: async (id) => {
        await d1.prepare("delete from capsules where id = ?").bind(id).run();
      },
    },
  ];
}

function capsule(
  id: string,
  createdAt = "2026-10-14T00:00:00.000Z",
  status: Capsule["status"] = "active",
  workspaceId = "workspace_sweep",
): Capsule {
  return {
    id,
    workspaceId,
    projectId: "project_sweep",
    name: id,
    slug: id.toLowerCase(),
    sourceId: "source_sweep",
    installConfigId: `config_${id}`,
    environment: "production",
    currentStateGeneration: 0,
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

function planRun(id: string, createdAt: number): PlanRun {
  return {
    id,
    workspaceId: "workspace_sweep",
    capsuleId: "capsule_sweep",
    source: { kind: "git", url: "https://example.invalid/repo.git", commit: "a".repeat(40) },
    sourceDigest: "sha256:source",
    operation: "create",
    runnerProfileId: "profile_sweep",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: createdAt },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt,
    updatedAt: createdAt,
  };
}

const ids = <T extends { readonly id: string }>(rows: readonly T[]): string[] =>
  rows.map((row) => row.id);

test("all adapters reserve bounded live Capsule pages across new instances, deletion, and wrap", async () => {
  for (const { name, first, reopen, removeCapsule } of await adapters()) {
    expect(ids(await first.listCapsulesForScheduledSweep(2)), name).toEqual([]);
    // Stale and active apps from different Workspaces share one lane.
    for (const [id, status, workspaceId] of [
      ["cap_a", "active", "ws_one"],
      ["cap_B", "stale", "ws_two"],
      ["cap_A", "stale", "ws_three"],
      ["cap_b", "active", "ws_one"],
    ] as const) {
      await first.putCapsule(capsule(id, undefined, status, workspaceId));
    }
    // Equal timestamps use database byte ordering, including mixed case.
    expect(ids(await first.listCapsulesForScheduledSweep(2)), name).toEqual(["cap_A", "cap_B"]);
    expect(ids(await reopen().listCapsulesForScheduledSweep(0)), name).toEqual([]);
    expect(ids(await reopen().listCapsulesForScheduledSweep(Number.NaN)), name).toEqual([]);
    expect(ids(await reopen().listCapsulesForScheduledSweep(Number.POSITIVE_INFINITY)), name).toEqual([]);
    // The page is reserved before callers perform external work; a fresh adapter
    // continues even when the caller drops the prior result.
    expect(ids(await reopen().listCapsulesForScheduledSweep(2)), name).toEqual(["cap_a", "cap_b"]);
    await removeCapsule("cap_b");
    // Deleted tails still end the lap and the next call starts at its prefix.
    expect(ids(await reopen().listCapsulesForScheduledSweep(2)), name).toEqual(["cap_A", "cap_B"]);
    // SqliteFakeD1 has one synchronous connection and cannot overlap its own
    // BEGIN statements. PostgreSQL and memory exercise concurrent allocation;
    // D1 still exercises fresh-adapter allocation in sequence on real SQLite.
    const concurrent = name === "d1"
      ? [await reopen().listCapsulesForScheduledSweep(1), await reopen().listCapsulesForScheduledSweep(1)]
      : await Promise.all([
          reopen().listCapsulesForScheduledSweep(1),
          reopen().listCapsulesForScheduledSweep(1),
        ]);
    expect(concurrent.map(ids).flat().sort(), name).toEqual(["cap_A", "cap_a"]);
  }
});

test("all adapters reserve only active and stale Capsules and reenter after an empty lap", async () => {
  for (const { name, first, reopen } of await adapters()) {
    expect(ids(await first.listCapsulesForScheduledSweep(2)), name).toEqual([]);
    await first.putCapsule(capsule("cap_B"));
    await first.putCapsule(capsule("cap_a", undefined, "stale"));
    await first.putCapsule(capsule("cap_A"));
    for (const status of ["pending", "disabled", "error", "uninstalled", "destroyed"] as const) {
      await first.putCapsule(capsule(`cap_${status}`, undefined, status));
    }
    expect(ids(await first.listCapsulesForScheduledSweep(2)), name).toEqual(["cap_A", "cap_B"]);
    expect(ids(await reopen().listCapsulesForScheduledSweep(2)), name).toEqual(["cap_a"]);
    expect(ids(await reopen().listCapsulesForScheduledSweep(2)), name).toEqual(["cap_A", "cap_B"]);
  }
});

test("each live Capsule lap has a fixed upper key while newer rows arrive every tick", async () => {
  for (const { name, first, reopen } of await adapters()) {
    for (let n = 1; n <= 4; n += 1) {
      await first.putCapsule(capsule(`old_${n}`, `2026-10-14T00:00:0${n}.000Z`, n % 2 ? "stale" : "active"));
    }
    // Treat the first allocation as lost to a crashed caller. Newer eligible
    // rows arrive before every subsequent tick, so a moving upper key would
    // indefinitely postpone the first row's next opportunity.
    await first.listCapsulesForScheduledSweep(1);
    for (let n = 2; n <= 4; n += 1) {
      await reopen().putCapsule(capsule(`new_${n}`, `2026-10-14T00:01:0${n}.000Z`));
      expect(ids(await reopen().listCapsulesForScheduledSweep(1)), name).toEqual([`old_${n}`]);
    }
    await reopen().putCapsule(capsule("new_5", "2026-10-14T00:01:05.000Z", "stale"));
    expect(ids(await reopen().listCapsulesForScheduledSweep(1)), name).toEqual(["old_1"]);
  }
});

test("recoverable Run sweep has numeric time and binary equal-time ordering on all adapters", async () => {
  for (const { name, first, reopen } of await adapters()) {
    for (const [id, time] of [
      ["run_10", 10], ["run_b", 2], ["run_B", 2], ["run_A", 2], ["run_1", 1],
    ] as const) await first.putPlanRun(planRun(id, time));
    const options = { staleQueuedBeforeMs: 20, staleRunningBeforeMs: 20, limit: 2, sweep: true as const };
    expect(ids(await first.listRecoverableOpenTofuRuns(options)), name).toEqual(["run_1", "run_A"]);
    expect(ids(await reopen().listRecoverableOpenTofuRuns(options)), name).toEqual(["run_B", "run_b"]);
    expect(ids(await reopen().listRecoverableOpenTofuRuns(options)), name).toEqual(["run_10"]);
    expect(ids(await reopen().listRecoverableOpenTofuRuns(options)), name).toEqual(["run_1", "run_A"]);
  }
});

test("Postgres and D1 recoverable Run sweeps traverse beyond the old 5000-row prefix", async () => {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const d1 = new SqliteFakeD1();
  const pgStore = new SqlOpenTofuControlStore({ client: pg });
  const d1Store = new CloudflareD1OpenTofuControlStore(d1);
  // Boot D1 before direct SQL seed so its migration creates the Runs table.
  await d1Store.listCapsulesForScheduledSweep(1);

  await pg.exec(`insert into takosumi_runs (id, kind, space_id, status, created_at, run_json)
    select 'run_' || lpad(n::text, 5, '0'), 'plan', 'workspace_sweep', 'queued', n::text,
      jsonb_build_object('id', 'run_' || lpad(n::text, 5, '0'),
        'workspaceId', 'workspace_sweep', 'capsuleId', 'capsule_sweep',
        'sourceDigest', 'sha256:source', 'variablesDigest', 'sha256:variables',
        'operation', 'create', 'status', 'queued', 'createdAt', n)
    from generate_series(1, 5001) n`);
  await d1.exec(`with recursive seq(n) as (
      select 1 union all select n + 1 from seq where n < 5001
    ) insert into runs (id, space_id, installation_id, type, status, created_at, run_json)
    select 'run_' || printf('%05d', n), 'workspace_sweep', 'capsule_sweep',
      'plan', 'queued', cast(n as text),
      json_object('id', 'run_' || printf('%05d', n),
        'workspaceId', 'workspace_sweep', 'capsuleId', 'capsule_sweep',
        'sourceDigest', 'sha256:source', 'variablesDigest', 'sha256:variables',
        'operation', 'create', 'status', 'queued', 'createdAt', n)
    from seq`);
  const options = { staleQueuedBeforeMs: 6000, staleRunningBeforeMs: 6000, sweep: true as const };
  for (const [name, first, reopen] of [
    ["postgres", pgStore, () => new SqlOpenTofuControlStore({ client: pg })],
    ["d1", d1Store, () => new CloudflareD1OpenTofuControlStore(d1)],
  ] as const) {
    const firstPage = await first.listRecoverableOpenTofuRuns({ ...options, limit: 5000 });
    expect(firstPage.length, name).toBe(5000);
    expect(firstPage[0]?.id, name).toBe("run_00001");
    expect(firstPage.at(-1)?.id, name).toBe("run_05000");
    expect(ids(await reopen().listRecoverableOpenTofuRuns({ ...options, limit: 5000 })), name)
      .toEqual(["run_05001"]);
    expect(ids(await reopen().listRecoverableOpenTofuRuns({ ...options, limit: 2 })), name)
      .toEqual(["run_00001", "run_00002"]);
    expect(ids(await reopen().listRecoverableOpenTofuRuns({ ...options, limit: 2 })), name)
      .toEqual(["run_00003", "run_00004"]);
    // Operator listing has its original oldest-first prefix behavior.
    expect(ids(await reopen().listRecoverableOpenTofuRuns({ ...options, sweep: undefined, limit: 2 })), name)
      .toEqual(["run_00001", "run_00002"]);
  }
});

test("recoverable cursors advance past raw SQL rows rejected by the shared predicate", async () => {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const d1 = new SqliteFakeD1();
  const stores = [
    ["postgres", new SqlOpenTofuControlStore({ client: pg })],
    ["d1", new CloudflareD1OpenTofuControlStore(d1)],
  ] as const;
  await stores[1][1].listCapsulesForScheduledSweep(1);
  const run = (id: string, status: string, createdAt: number) => ({
    id, workspaceId: "workspace_sweep", capsuleId: "capsule_sweep",
    sourceDigest: "sha256:source", variablesDigest: "sha256:variables",
    operation: "create", status, createdAt,
  });
  for (const [id, jsonStatus, timestamp] of [
    ["run_bad", "succeeded", 1],
    ["run_good", "queued", 2],
  ] as const) {
    const json = JSON.stringify(run(id, jsonStatus, timestamp));
    await pg.query(
      `insert into takosumi_runs (id, kind, space_id, status, created_at, run_json)
       values ($1, 'plan', 'workspace_sweep', 'queued', $2, $3::jsonb)`,
      [id, String(timestamp), json],
    );
    await d1.prepare(
      `insert into runs (id, space_id, installation_id, type, status, created_at, run_json)
       values (?, 'workspace_sweep', 'capsule_sweep', 'plan', 'queued', ?, ?)`,
    ).bind(id, String(timestamp), json).run();
  }
  const options = { staleQueuedBeforeMs: 10, staleRunningBeforeMs: 10, limit: 1, sweep: true as const };
  for (const [name, store] of stores) {
    expect(ids(await store.listRecoverableOpenTofuRuns(options)), name).toEqual([]);
    expect(ids(await store.listRecoverableOpenTofuRuns(options)), name).toEqual(["run_good"]);
    expect(ids(await store.listRecoverableOpenTofuRuns(options)), name).toEqual([]);
    // The operator path still uses its original prefix and defense filter.
    expect(ids(await store.listRecoverableOpenTofuRuns({ ...options, sweep: undefined })), name)
      .toEqual([]);
  }
});

test("predecessor migrations preserve data and seed three empty cursor lanes", async () => {
  const pg = await PGliteSqlClient.createThroughMigrationVersion(117);
  pgClients.push(pg);
  await pg.query(
    `insert into takosumi_workspaces (id, handle, space_json, created_at, updated_at)
     values ('ws_prior', 'ws-prior', '{"id":"ws_prior"}'::jsonb, '2026-10-13', '2026-10-13')`,
  );
  const pgMigration = postgresStorageMigrationStatements.find((entry) => entry.version === 118);
  expect(pgMigration?.id).toBe("deploy.scheduled_sweep_cursors.create");
  for (const statement of splitSqlStatements(pgMigration!.sql)) await pg.query(statement);
  expect((await pg.query<{ id: string }>("select id from takosumi_workspaces where id = 'ws_prior'")).rows)
    .toEqual([{ id: "ws_prior" }]);
  expect((await pg.query<{ lane: string; generation: string | number }>(
    "select lane, generation from takosumi_scheduled_sweep_cursors order by lane",
  )).rows.map((row) => row.lane)).toEqual(["active_capsules", "recoverable_runs", "workspaces"]);

  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1, { throughMigrationVersion: 70 });
  await d1.prepare(
    `insert into workspaces (id, handle, record_json, created_at, updated_at)
     values ('ws_prior', 'ws-prior', '{"id":"ws_prior"}', '2026-10-13', '2026-10-13')`,
  ).run();
  await ensureD1OpenTofuLedgerSchema(d1);
  expect((await d1.prepare("select id from workspaces where id = 'ws_prior'").first<{ id: string }>()))
    .toEqual({ id: "ws_prior" });
  expect((await d1.prepare(
    "select lane from scheduled_sweep_cursors order by lane",
  ).all<{ lane: string }>()).results?.map((row) => row.lane))
    .toEqual(["active_capsules", "recoverable_runs", "workspaces"]);
  const columns = (await d1.prepare("pragma table_info(scheduled_sweep_cursors)").all<{ name: string }>())
    .results?.map((row) => row.name);
  expect(columns).toContain("upper_created_at");
  expect(columns).toContain("upper_id");
});
