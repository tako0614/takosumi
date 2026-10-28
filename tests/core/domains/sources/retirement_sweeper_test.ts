import { expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import type { StoredGitInstallPlan } from "../../../../core/domains/install-plans/store.ts";
import {
  sweepRetiredSources,
  type SourceRetirementSweepDependencies,
} from "../../../../core/domains/sources/retirement_sweeper.ts";

const NOW = new Date("2026-10-28T12:00:00.000Z");

function source(id: string, ageHours: number, extra: Partial<StoredSource> = {}): StoredSource {
  const createdAt = new Date(NOW.getTime() - ageHours * 60 * 60 * 1000).toISOString();
  return {
    id,
    workspaceId: "ws_one",
    name: id,
    url: "https://example.com/repo.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    autoSync: false,
    hookSecretHash: "hash",
    createdAt,
    updatedAt: createdAt,
    ...extra,
  } as StoredSource;
}

function plan(id: string, phase: StoredGitInstallPlan["phase"], extra: Partial<StoredGitInstallPlan> = {}): StoredGitInstallPlan {
  return { id, workspaceId: "ws_one", phase, ...extra } as StoredGitInstallPlan;
}

function fixture(
  sources: readonly StoredSource[],
  plans: readonly StoredGitInstallPlan[] = [],
  capsules: readonly Capsule[] = [],
  retire?: SourceRetirementSweepDependencies["retireOwnedSource"],
) {
  const calls: string[] = [];
  const dependencies: SourceRetirementSweepDependencies = {
    store: {
      listAllSourcesPage: async () => ({ items: sources }),
      getCapsule: async (id) => capsules.find((capsule) => capsule.id === id),
    },
    plans: {
      get: async (id) => plans.find((candidate) => candidate.id === id),
      hasNonterminalPlanSourceReference: async (workspaceId, sourceId, expiredBefore) =>
        plans.some((candidate) =>
          candidate.workspaceId === workspaceId && candidate.sourceId === sourceId &&
          !["failed", "reviewable", "discarded"].includes(candidate.phase) &&
          !(candidate.expiresAt && candidate.expiresAt <= expiredBefore)
        ),
    },
    retireOwnedSource: async (id, reason) => {
      calls.push(`${id}:${reason}`);
      return retire ? await retire(id, reason) : "retired";
    },
    now: () => NOW,
  };
  return { calls, dependencies };
}

test("source retirement sweep selects destroyed owners, terminal plans, expired attempts and stale orphans", async () => {
  const expiredAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const rows = [
    source("src_destroyed", 1, { ownerCapsuleId: "cap_destroyed" }),
    source("src_live", 72, { ownerCapsuleId: "cap_live" }),
    source("src_discarded", 1, { createdByInstallPlanId: "plan_discarded" }),
    source("src_failed", 1, { createdByInstallPlanId: "plan_failed" }),
    source("src_expired", 48, { createdByInstallPlanId: "plan_expired" }),
    source("src_open", 72, { createdByInstallPlanId: "plan_open" }),
    source("src_public_preflight", 72),
    source("src_expired_public_preflight", 72),
    source("src_orphan", 25),
    source("src_fresh", 23),
  ];
  const { calls, dependencies } = fixture(rows, [
    plan("plan_discarded", "discarded", { mode: "attempt" }),
    plan("plan_failed", "failed"),
    plan("plan_expired", "awaiting_input", { mode: "attempt", expiresAt: expiredAt }),
    plan("plan_open", "syncing_source"),
    plan("plan_public_preflight", "planning", { sourceId: "src_public_preflight" }),
    plan("plan_expired_public_preflight", "planning", {
      sourceId: "src_expired_public_preflight", expiresAt: expiredAt,
    }),
  ], [
    { id: "cap_destroyed", status: "destroyed" } as Capsule,
    { id: "cap_live", status: "active" } as Capsule,
  ]);
  const result = await sweepRetiredSources(dependencies);
  expect(result).toEqual({ scanned: 10, attempted: 6, retired: 6, deferred: 0, failures: 0 });
  expect(calls.map((call) => call.split(":")[0]).sort()).toEqual([
    "src_destroyed", "src_discarded", "src_failed", "src_expired",
    "src_expired_public_preflight", "src_orphan",
  ].sort());
});

test("source retirement sweep isolates one cleanup failure and keeps scanning", async () => {
  const { calls, dependencies } = fixture(
    [source("src_one", 48), source("src_two", 48)],
    [],
    [],
    async (id) => {
      if (id === "src_one") throw new Error("archive unavailable");
      return "retired";
    },
  );
  expect(await sweepRetiredSources(dependencies)).toEqual({
    scanned: 2, attempted: 2, retired: 1, deferred: 0, failures: 1,
  });
  expect(calls).toHaveLength(2);
});

test("failed retirement stays bounded and daily rotation reaches later candidates", async () => {
  const ids = ["src_one", "src_two", "src_three", "src_four"];
  const { calls, dependencies } = fixture(
    ids.map((id) => source(id, 48)), [], [],
    async () => { throw new Error("custody unavailable"); },
  );
  const first = await sweepRetiredSources(dependencies, { limit: 2 });
  expect(first).toMatchObject({ attempted: 2, failures: 2 });
  const second = await sweepRetiredSources({
    ...dependencies,
    now: () => new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  }, { limit: 2 });
  expect(second).toMatchObject({ attempted: 2, failures: 2 });
  expect(new Set(calls.map((call) => call.split(":")[0]))).toEqual(new Set(ids));
});
