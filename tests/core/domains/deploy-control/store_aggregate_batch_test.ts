import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { UsageEvent } from "takosumi-contract/billing";
import type { Capsule } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import { RunQueryService } from "../../../../core/domains/deploy-control/run_query.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { UsageReportingService } from "../../../../core/domains/deploy-control/usage_service.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  pgClients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "usage_000000000001",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    kind: "runner_minute",
    quantity: 0,
    usdMicros: 0,
    ratingStatus: "unrated",
    source: "runner",
    idempotencyKey: "usage-key-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function compatibilityRun(id: string, createdAt: string): Run {
  return {
    id,
    workspaceId: "workspace_1",
    type: "compatibility_check",
    status: "succeeded",
    createdBy: "test",
    createdAt,
  };
}

function planRun(id: string): PlanRun {
  return {
    id,
    workspaceId: "workspace_1",
    source: { kind: "git", url: "https://example.test/repo.git", ref: "main", path: "." },
    sourceDigest: "sha256:source",
    operation: "create",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    capsuleContext: {
      capsuleId: "capsule_1",
      environment: "production",
    },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

function applyRun(): ApplyRun {
  return {
    id: "apply_1",
    planRunId: "plan_1",
    workspaceId: "workspace_1",
    operation: "create",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId: "plan_1",
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: 3,
    updatedAt: 4,
  };
}

test("capsule usage totals match across stores, including zero-valued rated events", async () => {
  for (const [label, store] of await stores()) {
    await store.putUsageEvent(usageEvent({
      id: `usage_${label}_rated`,
      idempotencyKey: `${label}_rated`,
      ratingStatus: "rated",
      usdMicros: 7,
      quantity: 0.5,
    }));
    await store.putUsageEvent(usageEvent({
      id: `usage_${label}_rated_zero`,
      idempotencyKey: `${label}_rated_zero`,
      ratingStatus: "rated",
      usdMicros: 0,
      quantity: 0,
    }));
    await store.putUsageEvent(usageEvent({
      id: `usage_${label}_unrated`,
      idempotencyKey: `${label}_unrated`,
      ratingStatus: "unrated",
      quantity: -0.25,
    }));
    await store.putUsageEvent(usageEvent({
      id: `usage_${label}_other_capsule`,
      idempotencyKey: `${label}_other_capsule`,
      capsuleId: "capsule_2",
      ratingStatus: "rated",
      usdMicros: 100,
    }));

    expect(await store.getCapsuleUsageTotals("capsule_1"), label).toEqual({
      usdMicros: 7,
      eventCount: 3,
      ratedEventCount: 2,
    });
    expect(await store.getCapsuleUsageTotals("capsule_empty"), label).toEqual({
      usdMicros: 0,
      eventCount: 0,
      ratedEventCount: 0,
    });
  }
});

test("bulk PlanRun lookup deduplicates requested ids and omits missing or non-plan rows", async () => {
  for (const [label, store] of await stores()) {
    await store.putPlanRun(planRun("plan_1"));
    await store.putPlanRun(planRun("plan_2"));
    await store.putApplyRun(applyRun());

    const plans = await store.getPlanRunsByIds([
      "plan_2",
      "missing",
      "apply_1",
      "plan_1",
      "plan_2",
    ]);
    expect(plans.map(({ id }) => id).sort(), label).toEqual(["plan_1", "plan_2"]);
    expect(await store.getPlanRunsByIds([]), label).toEqual([]);
    expect(
      await store.getPlanRunsByIds([
        ...Array.from({ length: 105 }, (_, index) => `missing_${index}`),
        "plan_1",
      ]),
      label,
    ).toMatchObject([{ id: "plan_1" }]);
  }
});

test("RunQueryService bulk-projects ApplyRun Capsule context once for the list", async () => {
  const batchIds: string[][] = [];
  let individualPlanReads = 0;
  const plan = planRun("plan_1");
  const queryStore = {
    listRunsByWorkspace: async () => [applyRun()],
    getPlanRunsByIds: async (ids: readonly string[]) => {
      batchIds.push([...ids]);
      return [plan];
    },
    getPlanRun: async () => {
      individualPlanReads += 1;
      return plan;
    },
  } as unknown as OpenTofuControlStore;

  const runs = await new RunQueryService(queryStore).listRuns("workspace_1");
  expect(batchIds).toEqual([["plan_1"]]);
  expect(individualPlanReads).toBe(0);
  expect(runs[0]).toMatchObject({
    id: "apply_1",
    capsuleId: "capsule_1",
    environment: "production",
  });
});

test("keyset Run pages match the legacy ordering across stores and ignore later inserts", async () => {
  for (const [label, store] of await stores()) {
    await store.putCompatibilityCheckRun(
      compatibilityRun("run_iso_new", "2030-01-02T00:00:00.000Z"),
    );
    await store.putCompatibilityCheckRun(
      compatibilityRun("run_tie_z", "1893456000000"),
    );
    await store.putCompatibilityCheckRun(
      compatibilityRun("run_tie_a", "1893456000000"),
    );
    await store.putCompatibilityCheckRun(
      compatibilityRun("run_older", "2029-12-31T23:59:59.000Z"),
    );

    const legacyIds = (await store.listRunsByWorkspace("workspace_1"))
      .map(({ id }) => id);
    const first = await store.listRunsByWorkspacePage("workspace_1", { limit: 2 });
    expect(first.rows.map(({ id }) => id), label).toEqual(legacyIds.slice(0, 2));
    expect(first.hasMore, label).toBe(true);

    await store.putCompatibilityCheckRun(
      compatibilityRun("run_inserted_newer", "2031-01-01T00:00:00.000Z"),
    );
    const second = await store.listRunsByWorkspacePage("workspace_1", {
      limit: 2,
      after: {
        createdAtMillis: 1893456000000,
        id: "run_tie_z",
      },
    });
    expect(second.rows.map(({ id }) => id), label).toEqual(["run_tie_a", "run_older"]);
    expect(second.hasMore, label).toBe(false);
  }
});

test("keyset Run pages inherit the 500-row cap and continue beyond 100 rows", async () => {
  const store = new InMemoryOpenTofuControlStore();
  for (let index = 0; index < 501; index += 1) {
    await store.putCompatibilityCheckRun(
      compatibilityRun(
        `run_${String(index).padStart(4, "0")}`,
        String(2_000_000_000_000 + index),
      ),
    );
  }
  const first = await store.listRunsByWorkspacePage("workspace_1", { limit: 900 });
  expect(first.rows).toHaveLength(500);
  expect(first.hasMore).toBe(true);
  const cursor = {
    createdAtMillis: Number(first.rows.at(-1)!.createdAt),
    id: first.rows.at(-1)!.id,
  };
  const second = await store.listRunsByWorkspacePage("workspace_1", {
    limit: 900,
    after: cursor,
  });
  expect(second.rows.map(({ id }) => id)).toEqual(["run_0000"]);
  expect(second.hasMore).toBe(false);
});

test("keyset Run pages use binary ID tie ordering across SQL and memory stores", async () => {
  for (const [label, store] of await stores()) {
    for (const id of ["run_A", "run-a", "run_a"]) {
      await store.putCompatibilityCheckRun(
        compatibilityRun(id, "1893456000000"),
      );
    }
    const page = await store.listRunsByWorkspacePage("workspace_1", { limit: 3 });
    expect(page.rows.map(({ id }) => id), label).toEqual([
      "run_a",
      "run_A",
      "run-a",
    ]);
  }
});

test("usage summary keeps the existing counted-event and rated-cost semantics", async () => {
  const capsule = { id: "capsule_1", workspaceId: "workspace_1" } as Capsule;
  const service = new UsageReportingService({
    store: {
      getCapsule: async () => capsule,
      getCapsuleUsageTotals: async () => ({
        usdMicros: 7,
        eventCount: 3,
        ratedEventCount: 2,
      }),
    } as unknown as OpenTofuControlStore,
    newId: () => "unused",
    now: () => 0,
    requireWorkspace: async () => ({ id: "workspace_1" }) as never,
    billing: {} as never,
  });

  expect(await service.getCapsuleUsageSummary("capsule_1")).toEqual({
    capsuleId: "capsule_1",
    usdMicros: 7,
    eventCount: 3,
    ratedEventCount: 2,
    unratedEventCount: 1,
  });
});
