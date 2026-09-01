import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
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

function planRunFixture(input: {
  readonly id: string;
  readonly status: "queued" | "running" | "succeeded";
  readonly createdAt: number;
  readonly heartbeatAt?: number;
  readonly workspaceId?: string;
}): PlanRun {
  return {
    id: input.id,
    workspaceId: input.workspaceId ?? "ws_recover",
    capsuleId: "cap_recover",
    source: { kind: "git", sourceId: "src_a" } as never,
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: input.status,
    policy: { decision: "allow" } as never,
    policyDecisionDigest: "sha256:policy",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    ...(input.heartbeatAt === undefined
      ? {}
      : { heartbeatAt: input.heartbeatAt }),
  } as PlanRun;
}

function applyRunFixture(input: {
  readonly id: string;
  readonly status: "succeeded" | "failed";
  readonly createdAt: number;
  readonly billing: "pending" | "completed" | "none";
}): ApplyRun {
  const planRunId = `plan_${input.id}`;
  const auditEvents =
    input.billing === "none"
      ? []
      : input.billing === "pending"
        ? [
            {
              id: `audit_${input.id}_pending`,
              type: "billing.capture.pending",
              at: input.createdAt + 5,
              data: { providerMutationCommitted: true },
            },
          ]
        : [
            {
              id: `audit_${input.id}_pending`,
              type: "billing.capture.pending",
              at: input.createdAt + 5,
              data: { providerMutationCommitted: true },
            },
            {
              id: `audit_${input.id}_completed`,
              type: "billing.capture.completed",
              at: input.createdAt + 6,
            },
          ];
  return {
    id: input.id,
    planRunId,
    workspaceId: "ws_recover",
    capsuleId: "cap_recover",
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: input.status,
    expected: {
      planRunId,
      capsuleId: "cap_recover",
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:plan",
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: auditEvents as ApplyRun["auditEvents"],
    createdAt: input.createdAt,
    updatedAt: input.createdAt + 10,
    startedAt: input.createdAt + 1,
    finishedAt: input.createdAt + 10,
  };
}

test("recoverable-run pages rotate over the whole backlog without overlap", async () => {
  for (const [label, store] of await stores()) {
    for (let index = 0; index < 5; index += 1) {
      await store.putPlanRun(
        planRunFixture({
          id: `plan_stale_${index}`,
          status: "queued",
          createdAt: NOW - 100_000 + index * 1_000,
        }),
      );
    }
    const options = {
      staleQueuedBeforeMs: NOW - 60_000,
      staleRunningBeforeMs: NOW - 60_000,
      limit: 2,
    };
    const page1 = await store.listRecoverableOpenTofuRuns(options);
    expect(page1.runs.map((run) => run.id), label).toEqual([
      "plan_stale_0",
      "plan_stale_1",
    ]);
    expect(page1.nextCursor, label).toBeDefined();

    const page2 = await store.listRecoverableOpenTofuRuns({
      ...options,
      cursor: page1.nextCursor,
    });
    expect(page2.runs.map((run) => run.id), label).toEqual([
      "plan_stale_2",
      "plan_stale_3",
    ]);
    expect(page2.nextCursor, label).toBeDefined();

    const page3 = await store.listRecoverableOpenTofuRuns({
      ...options,
      cursor: page2.nextCursor,
    });
    expect(page3.runs.map((run) => run.id), label).toEqual(["plan_stale_4"]);
    expect(page3.nextCursor, label).toBeUndefined();
  }
});

test("the scan cursor advances past rows the exact predicate filters out", async () => {
  for (const [label, store] of await stores()) {
    // Two fresh (not yet stale) queued runs sit between stale ones in scan
    // order. They are scanned (bounding the page) but filtered; the cursor
    // still moves past them so the sweep never stalls on them.
    await store.putPlanRun(
      planRunFixture({
        id: "plan_old_a",
        status: "queued",
        createdAt: NOW - 100_000,
      }),
    );
    await store.putPlanRun(
      planRunFixture({
        id: "plan_old_b",
        status: "queued",
        createdAt: NOW - 90_000,
      }),
    );
    const options = {
      // Every seeded run passes the SQL candidate bound; only _old_ rows pass
      // nothing extra here — use a limit smaller than the candidate set.
      staleQueuedBeforeMs: NOW - 60_000,
      staleRunningBeforeMs: NOW - 60_000,
      limit: 1,
    };
    const page1 = await store.listRecoverableOpenTofuRuns(options);
    expect(page1.runs.map((run) => run.id), label).toEqual(["plan_old_a"]);
    const page2 = await store.listRecoverableOpenTofuRuns({
      ...options,
      cursor: page1.nextCursor,
    });
    expect(page2.runs.map((run) => run.id), label).toEqual(["plan_old_b"]);
  }
});

test("billing-pending terminal applies surface via the flag column and stats", async () => {
  for (const [label, store] of await stores()) {
    await store.putApplyRun(
      applyRunFixture({
        id: "apply_pending",
        status: "succeeded",
        createdAt: NOW - 100_000,
        billing: "pending",
      }),
    );
    await store.putApplyRun(
      applyRunFixture({
        id: "apply_completed",
        status: "succeeded",
        createdAt: NOW - 100_000,
        billing: "completed",
      }),
    );
    await store.putApplyRun(
      applyRunFixture({
        id: "apply_no_billing",
        status: "failed",
        createdAt: NOW - 100_000,
        billing: "none",
      }),
    );
    const page = await store.listRecoverableOpenTofuRuns({
      staleQueuedBeforeMs: NOW - 60_000,
      staleRunningBeforeMs: NOW - 60_000,
    });
    expect(page.runs.map((run) => run.id), label).toEqual(["apply_pending"]);

    const stats = await store.getRunBacklogStats({
      now: NOW,
      staleRunningBeforeMs: NOW - 60_000,
    });
    expect(stats.billingCapturePending, label).toBe(1);
  }
});

test("run backlog stats derive queue depth, oldest age, and stale heartbeats", async () => {
  for (const [label, store] of await stores()) {
    await store.putPlanRun(
      planRunFixture({
        id: "plan_queued_old",
        status: "queued",
        createdAt: NOW - 300_000,
      }),
    );
    await store.putPlanRun(
      planRunFixture({
        id: "plan_queued_new",
        status: "queued",
        createdAt: NOW - 10_000,
      }),
    );
    await store.putPlanRun(
      planRunFixture({
        id: "plan_running_fresh",
        status: "running",
        createdAt: NOW - 50_000,
        heartbeatAt: NOW - 1_000,
      }),
    );
    await store.putPlanRun(
      planRunFixture({
        id: "plan_running_stale",
        status: "running",
        createdAt: NOW - 50_000,
        heartbeatAt: NOW - 120_000,
      }),
    );

    const stats = await store.getRunBacklogStats({
      now: NOW,
      staleRunningBeforeMs: NOW - 60_000,
    });
    expect(stats.queuedByType, label).toEqual({ plan: 2 });
    expect(stats.runningByType, label).toEqual({ plan: 2 });
    expect(stats.oldestQueuedAgeMs, label).toBe(300_000);
    expect(stats.staleHeartbeatRunning, label).toBe(1);
    expect(stats.billingCapturePending, label).toBe(0);
  }
});

test("D1 migration 65 backfills the billing flag from run_json audit events", async () => {
  const db = new SqliteFakeD1();
  // A pre-65 database whose terminal apply rows carry only the JSON markers.
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 64 });
  const insert = `insert into runs
    (id, run_group_id, space_id, source_id, installation_id, environment,
     type, status, lease_token, heartbeat_at, run_json, created_at)
    values (?, null, 'ws_recover', null, 'cap_recover', null,
     'apply', ?, null, null, ?, ?)`;
  const pending = applyRunFixture({
    id: "apply_backfill_pending",
    status: "succeeded",
    createdAt: NOW - 100_000,
    billing: "pending",
  });
  const completed = applyRunFixture({
    id: "apply_backfill_completed",
    status: "succeeded",
    createdAt: NOW - 100_000,
    billing: "completed",
  });
  for (const run of [pending, completed]) {
    await db
      .prepare(insert)
      .bind(run.id, run.status, JSON.stringify(run), String(run.createdAt))
      .run();
  }

  // Migration 65 runs on the populated database.
  await ensureD1OpenTofuLedgerSchema(db);
  const flags = await db
    .prepare(
      `select id, billing_capture_pending as flag from runs order by id`,
    )
    .all<{ readonly id: string; readonly flag: number | null }>();
  expect(flags.results).toEqual([
    { id: "apply_backfill_completed", flag: null },
    { id: "apply_backfill_pending", flag: 1 },
  ]);

  const store = new CloudflareD1OpenTofuControlStore(db);
  const page = await store.listRecoverableOpenTofuRuns({
    staleQueuedBeforeMs: NOW - 60_000,
    staleRunningBeforeMs: NOW - 60_000,
  });
  expect(page.runs.map((run) => run.id)).toEqual(["apply_backfill_pending"]);
});
