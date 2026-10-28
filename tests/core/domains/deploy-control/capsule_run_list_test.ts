import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import { RunQueryService } from "../../../../core/domains/deploy-control/run_query.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

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

function publicRun(
  id: string,
  createdAt: string,
  over: Partial<Run> = {},
): Run {
  return {
    id,
    workspaceId: "ws_app",
    capsuleId: "cap_app",
    type: "compatibility_check",
    status: "succeeded",
    createdBy: "test",
    createdAt,
    ...over,
  };
}

function planRun(id: string, createdAt: number, over: Partial<PlanRun> = {}): PlanRun {
  return {
    id,
    workspaceId: "ws_app",
    capsuleId: "cap_app",
    source: { kind: "git", url: "https://example.test/repo.git", ref: "main", path: "." },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: createdAt },
    policyDecisionDigest: "sha256:policy",
    capsuleContext: {
      workspaceId: "ws_app",
      capsuleId: "cap_app",
      environment: "production",
    },
    auditEvents: [],
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

function applyRun(id: string, planRunId: string, createdAt: number): ApplyRun {
  return {
    id,
    planRunId,
    workspaceId: "ws_app",
    capsuleId: "cap_app",
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "failed",
    expected: {
      planRunId,
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
    createdAt,
    updatedAt: createdAt,
  };
}

async function seed(store: OpenTofuControlStore): Promise<void> {
  await store.putPlanRun(planRun("plan_old", 1_893_456_000_000));
  await store.putApplyRun(applyRun("apply_mid", "plan_old", 1_893_456_100_000));
  await store.putPlanRun(
    planRun("drift_new", 1_893_456_200_000, { driftCheck: true }),
  );
  await store.putPlanRun(
    planRun("plan_destroy", 1_893_456_300_000, { operation: "destroy", status: "waiting_approval" }),
  );
  // ISO and epoch-millis timestamps interleave exactly as on the Workspace list.
  await store.putCompatibilityCheckRun(
    publicRun("check_iso", "2030-01-01T00:09:00.000Z"),
  );
  // Same Capsule id in another Workspace, another Capsule, a Source-only row.
  await store.putCompatibilityCheckRun(
    publicRun("check_other_ws", "2030-01-01T00:10:00.000Z", { workspaceId: "ws_other" }),
  );
  await store.putCompatibilityCheckRun(
    publicRun("check_other_capsule", "2030-01-01T00:11:00.000Z", { capsuleId: "cap_other" }),
  );
  await store.putCompatibilityCheckRun(
    publicRun("check_no_capsule", "2030-01-01T00:12:00.000Z", { capsuleId: undefined }),
  );
}

test("Capsule Run pages are newest first, Workspace-scoped and keyset-stable across stores", async () => {
  for (const [label, store] of await stores()) {
    await seed(store);
    const all = await store.listRunsByCapsulePage("cap_app", { workspaceId: "ws_app" });
    expect(all.rows.map(({ id }) => id), label).toEqual([
      "check_iso",
      "plan_destroy",
      "drift_new",
      "apply_mid",
      "plan_old",
    ]);
    expect(all.hasMore, label).toBe(false);

    const first = await store.listRunsByCapsulePage("cap_app", { workspaceId: "ws_app", limit: 2 });
    expect(first.rows.map(({ id }) => id), label).toEqual(["check_iso", "plan_destroy"]);
    expect(first.hasMore, label).toBe(true);
    const second = await store.listRunsByCapsulePage("cap_app", {
      workspaceId: "ws_app",
      limit: 2,
      after: { createdAtMillis: 1_893_456_300_000, id: "plan_destroy" },
    });
    expect(second.rows.map(({ id }) => id), label).toEqual(["drift_new", "apply_mid"]);
    expect(second.hasMore, label).toBe(true);

    expect(
      (await store.listRunsByCapsulePage("cap_app", { workspaceId: "ws_other" })).rows
        .map(({ id }) => id),
      label,
    ).toEqual(["check_other_ws"]);
  }
});

test("Capsule Run pages narrow to exact persisted kinds across stores", async () => {
  for (const [label, store] of await stores()) {
    await seed(store);
    const lifecycle = await store.listRunsByCapsulePage("cap_app", {
      workspaceId: "ws_app",
      kinds: ["plan", "apply", "destroy_plan", "destroy_apply"],
    });
    expect(lifecycle.rows.map(({ id }) => id), label).toEqual([
      "plan_destroy",
      "apply_mid",
      "plan_old",
    ]);
    const newest = await store.listRunsByCapsulePage("cap_app", {
      workspaceId: "ws_app",
      kinds: ["plan", "apply"],
      limit: 1,
    });
    expect(newest.rows.map(({ id }) => id), label).toEqual(["apply_mid"]);
    expect(newest.hasMore, label).toBe(true);
    expect(
      (await store.listRunsByCapsulePage("cap_app", { workspaceId: "ws_app", kinds: ["drift_check"] }))
        .rows.map(({ id }) => id),
      label,
    ).toEqual(["drift_new"]);
    expect(
      await store.listRunsByCapsulePage("cap_app", { workspaceId: "ws_app", kinds: [] }),
      label,
    ).toEqual({ rows: [], hasMore: false });
  }
});

test("RunQueryService pages one Capsule's projected Runs with the opaque cursor", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seed(store);
  const query = new RunQueryService(store);
  const first = await query.listCapsuleRunsPage("cap_app", { workspaceId: "ws_app", limit: 3 });
  expect(first.runs.map((run) => [run.id, run.type])).toEqual([
    ["check_iso", "compatibility_check"],
    ["plan_destroy", "destroy_plan"],
    ["drift_new", "drift_check"],
  ]);
  expect(first.runs[1]).toMatchObject({
    status: "waiting_approval",
    policyReasons: [{ code: "approval_required_destroy", layer: "action" }],
  });
  expect(first.nextCursor).toBeString();
  const second = await query.listCapsuleRunsPage("cap_app", {
    workspaceId: "ws_app",
    limit: 3,
    cursor: first.nextCursor!,
  });
  expect(second.runs.map((run) => run.id)).toEqual(["apply_mid", "plan_old"]);
  expect(second.runs[0]).toMatchObject({ capsuleId: "cap_app", planRunId: "plan_old" });
  expect(second.nextCursor).toBeUndefined();
  await expect(
    query.listCapsuleRunsPage("cap_app", { workspaceId: "ws_app", cursor: "not a cursor" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("a Plan's change origin round-trips through every store and reaches the public Run", async () => {
  const origins = [
    { kind: "revision", ref: "release/v2" },
    { kind: "rollback", stateVersionId: "sv_app_1" },
    { kind: "configuration" },
  ] as const;
  for (const [name, store] of await stores()) {
    for (const [index, origin] of origins.entries()) {
      await store.putPlanRun(planRun(`plan_origin_${index}`, 1_000 + index, { origin }));
    }
    await store.putPlanRun(planRun("plan_origin_none", 2_000));
    for (const [index, origin] of origins.entries()) {
      expect({ name, origin: (await store.getPlanRun(`plan_origin_${index}`))?.origin }).toEqual({ name, origin });
    }
    expect({ name, origin: (await store.getPlanRun("plan_origin_none"))?.origin }).toEqual({ name, origin: undefined });
    const query = new RunQueryService(store);
    const page = await query.listCapsuleRunsPage("cap_app", { workspaceId: "ws_app", limit: 10 });
    const projected = new Map(page.runs.map((run) => [run.id, run.origin]));
    expect({ name, revision: projected.get("plan_origin_0"), rollback: projected.get("plan_origin_1"), configuration: projected.get("plan_origin_2"), none: projected.get("plan_origin_none") })
      .toEqual({ name, revision: origins[0], rollback: origins[1], configuration: origins[2], none: undefined });
  }
});
