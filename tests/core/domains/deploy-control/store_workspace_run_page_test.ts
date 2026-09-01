/**
 * Newest-first keyset pagination over a Workspace's run ledger, plus the bulk
 * PlanRun read that removes the run list's N+1. All three store
 * implementations must agree on ordering, cursor resume, and page boundaries.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
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
  readonly createdAt: number;
  readonly workspaceId?: string;
}): PlanRun {
  return {
    id: input.id,
    workspaceId: input.workspaceId ?? "ws_page",
    capsuleId: "cap_page",
    source: { kind: "git", sourceId: "src_a" } as never,
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { decision: "allow" } as never,
    policyDecisionDigest: "sha256:policy",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  } as PlanRun;
}

function applyRunFixture(input: {
  readonly id: string;
  readonly planRunId: string;
  readonly createdAt: number;
}): ApplyRun {
  return {
    id: input.id,
    planRunId: input.planRunId,
    workspaceId: "ws_page",
    capsuleId: "cap_page",
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId: input.planRunId,
      capsuleId: "cap_page",
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
    createdAt: input.createdAt,
    updatedAt: input.createdAt + 10,
  } as ApplyRun;
}

test("run pages walk the whole ledger newest-first without overlap or gaps", async () => {
  for (const [label, store] of await stores()) {
    for (let index = 0; index < 5; index += 1) {
      await store.putPlanRun(
        planRunFixture({
          id: `plan_page_${index}`,
          createdAt: NOW - 50_000 + index * 1_000,
        }),
      );
    }
    const page1 = await store.listRunsByWorkspacePage("ws_page", { limit: 2 });
    expect(page1.runs.map((run) => run.id), label).toEqual([
      "plan_page_4",
      "plan_page_3",
    ]);
    expect(page1.nextCursor, label).toBeDefined();

    const page2 = await store.listRunsByWorkspacePage("ws_page", {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.runs.map((run) => run.id), label).toEqual([
      "plan_page_2",
      "plan_page_1",
    ]);

    const page3 = await store.listRunsByWorkspacePage("ws_page", {
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.runs.map((run) => run.id), label).toEqual(["plan_page_0"]);
    // The final page carries no cursor: the walk is finished.
    expect(page3.nextCursor, label).toBeUndefined();
  }
});

test("run pages are scoped to their Workspace", async () => {
  for (const [label, store] of await stores()) {
    await store.putPlanRun(
      planRunFixture({ id: "plan_mine", createdAt: NOW - 1_000 }),
    );
    await store.putPlanRun(
      planRunFixture({
        id: "plan_theirs",
        createdAt: NOW,
        workspaceId: "ws_other",
      }),
    );
    const page = await store.listRunsByWorkspacePage("ws_page", { limit: 10 });
    expect(page.runs.map((run) => run.id), label).toEqual(["plan_mine"]);
  }
});

test("getPlanRunsByIds bulk-reads plans, skipping unknown and non-plan ids", async () => {
  for (const [label, store] of await stores()) {
    for (const index of [0, 1, 2]) {
      await store.putPlanRun(
        planRunFixture({
          id: `plan_bulk_${index}`,
          createdAt: NOW - index * 1_000,
        }),
      );
    }
    await store.putApplyRun(
      applyRunFixture({
        id: "apply_bulk_0",
        planRunId: "plan_bulk_0",
        createdAt: NOW,
      }),
    );

    const plans = await store.getPlanRunsByIds([
      "plan_bulk_0",
      "plan_bulk_2",
      // Duplicate, unknown, and an apply-run id must all be tolerated.
      "plan_bulk_0",
      "plan_missing",
      "apply_bulk_0",
    ]);
    expect([...plans.map((plan) => plan.id)].sort(), label).toEqual([
      "plan_bulk_0",
      "plan_bulk_2",
    ]);
  }
});

test("an empty id set never reaches the database", async () => {
  for (const [label, store] of await stores()) {
    expect(await store.getPlanRunsByIds([]), label).toEqual([]);
  }
});

test("capsule usage totals aggregate in the database, rated money only", async () => {
  for (const [label, store] of await stores()) {
    const base = {
      workspaceId: "ws_page",
      kind: "runner_minute",
      quantity: 1,
      source: "runner",
      createdAt: new Date(NOW).toISOString(),
    };
    await store.putUsageEvent({
      ...base,
      id: "usage_rated_1",
      capsuleId: "cap_page",
      usdMicros: 1_500,
      ratingStatus: "rated",
      idempotencyKey: "k1",
    });
    await store.putUsageEvent({
      ...base,
      id: "usage_rated_2",
      capsuleId: "cap_page",
      usdMicros: 500,
      ratingStatus: "rated",
      idempotencyKey: "k2",
    });
    await store.putUsageEvent({
      ...base,
      id: "usage_unrated",
      capsuleId: "cap_page",
      usdMicros: 0,
      ratingStatus: "unrated",
      idempotencyKey: "k3",
    });
    // Another Capsule's event must never leak into this Capsule's totals.
    await store.putUsageEvent({
      ...base,
      id: "usage_other_capsule",
      capsuleId: "cap_other",
      usdMicros: 9_999,
      ratingStatus: "rated",
      idempotencyKey: "k4",
    });

    expect(await store.getCapsuleUsageTotals("cap_page"), label).toEqual({
      usdMicros: 2_000,
      eventCount: 3,
      ratedEventCount: 2,
    });
    expect(await store.getCapsuleUsageTotals("cap_absent"), label).toEqual({
      usdMicros: 0,
      eventCount: 0,
      ratedEventCount: 0,
    });
  }
});
