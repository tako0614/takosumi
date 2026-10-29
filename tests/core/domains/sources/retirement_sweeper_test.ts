import { expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import { InMemoryOpenTofuControlStore, type StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { deterministicInitialCapsuleId, deterministicInstallSourceId } from "../../../../core/domains/install-plans/source-reservation.ts";
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
  return { id, workspaceId: "ws_one", phase, updatedAt: "2026-10-27T11:00:00.000Z", ...extra } as StoredGitInstallPlan;
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
      listCapsulesPage: async () => ({ items: capsules }),
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

test("source retirement sweep selects destroyed owners and explicit markers, preserving creator plan guards", async () => {
  const expiredAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const rows = [
    source("src_destroyed", 1, { ownerCapsuleId: "cap_destroyed" }),
    source("src_live", 72, { ownerCapsuleId: "cap_live" }),
    source("src_marked_live", 72, { ownerCapsuleId: "cap_live", retiringAt: NOW.toISOString() }),
    source("src_missing_owner", 72, { ownerCapsuleId: "cap_missing" }),
    source("src_marked", 1, { status: "disabled", retiringAt: NOW.toISOString() }),
    source("src_marked_plan_live", 1, { status: "disabled", retiringAt: NOW.toISOString(),
      createdByInstallPlanId: "plan_marked_live" }),
    source("src_discarded", 48, { createdByInstallPlanId: "plan_discarded" }),
    source("src_failed", 48, { createdByInstallPlanId: "plan_failed" }),
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
    plan("plan_marked_live", "syncing_source", { sourceId: "src_marked_plan_live" }),
    plan("plan_public_preflight", "planning", { sourceId: "src_public_preflight" }),
    plan("plan_expired_public_preflight", "planning", {
      sourceId: "src_expired_public_preflight", expiresAt: expiredAt,
    }),
  ], [
    { id: "cap_destroyed", status: "destroyed" } as Capsule,
    { id: "cap_live", status: "active" } as Capsule,
  ]);
  const result = await sweepRetiredSources(dependencies);
  expect(result).toEqual({ scanned: 14, attempted: 5, retired: 5, deferred: 0, failures: 0 });
  expect(calls.map((call) => call.split(":")[0]).sort()).toEqual([
    "src_destroyed", "src_marked", "src_discarded", "src_failed", "src_expired",
  ].sort());
});

test("source retirement sweep isolates one cleanup failure and keeps scanning", async () => {
  const { calls, dependencies } = fixture(
    [source("src_one", 48, { retiringAt: NOW.toISOString() }),
      source("src_two", 48, { retiringAt: NOW.toISOString() })],
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
    ids.map((id) => source(id, 48, { retiringAt: NOW.toISOString() })), [], [],
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

test("deterministic orphan retirement requires scoped creator evidence and a full day of terminal or expiry grace", async () => {
  const cutoff = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const cases: readonly [string, Partial<StoredGitInstallPlan>, boolean][] = [
    ["discarded_boundary", { phase: "discarded", mode: "attempt", completedAt: cutoff }, true],
    ["failed_boundary", { phase: "failed", completedAt: cutoff }, true],
    ["expired_boundary", { phase: "awaiting_input", mode: "attempt", expiresAt: cutoff }, true],
    ["recent_discard", { phase: "discarded", completedAt: NOW.toISOString() }, false],
    ["recent_failure", { phase: "failed", updatedAt: NOW.toISOString() }, false],
    ["recent_expiry", { phase: "awaiting_input", mode: "attempt", expiresAt: NOW.toISOString() }, false],
    ["retryable_failed_attempt", { phase: "failed", mode: "attempt" }, false],
    ["expired_failed_attempt", { phase: "failed", mode: "attempt", expiresAt: cutoff }, true],
    ["reviewable", { phase: "reviewable", mode: "attempt", expiresAt: cutoff }, false],
    ["invalid_expiry", { phase: "awaiting_input", mode: "attempt", expiresAt: "invalid" }, false],
    ["invalid_terminal_time", { phase: "discarded", completedAt: "invalid" }, false],
    ["wrong_workspace", { phase: "discarded", workspaceId: "ws_other" }, false],
    ["wrong_source", { phase: "discarded", sourceId: "src_other" }, false],
    ["revision", { phase: "discarded", operation: "revision" }, false],
    ["creation_in_progress", { phase: "creating_capsule", mode: "attempt", creationAttempted: true, expiresAt: cutoff }, false],
  ];
  for (const [id, extra, expected] of cases) {
    const creator = plan(`plan_${id}`, "discarded", extra);
    const row = source(`src_${id}`, 48, { createdByInstallPlanId: creator.id });
    const { calls, dependencies } = fixture([row], [creator]);
    await sweepRetiredSources(dependencies);
    expect(calls.length, id).toBe(expected ? 1 : 0);
  }
  for (const age of [23, 24]) {
    const creator = plan("plan_age", "discarded");
    const { calls, dependencies } = fixture([source("src_age", age, { createdByInstallPlanId: creator.id })], [creator]);
    await sweepRetiredSources(dependencies);
    expect(calls.length).toBe(age === 24 ? 1 : 0);
  }
  const { calls, dependencies } = fixture([source("src_missing", 72, { createdByInstallPlanId: "plan_missing" })]);
  await sweepRetiredSources(dependencies);
  expect(calls).toEqual([]);
});

test("deterministic orphan sweep preserves any existing Capsule and paginates references including destroyed rows", async () => {
  const creator = plan("plan_capsule", "discarded", { capsuleId: deterministicInitialCapsuleId("plan_capsule") });
  const row = source("src_capsule", 48, { createdByInstallPlanId: creator.id });
  const { calls, dependencies } = fixture([row], [creator], [{ id: creator.capsuleId } as Capsule]);
  await sweepRetiredSources(dependencies);
  expect(calls).toEqual([]);
  const pages: unknown[] = [];
  for (const status of ["active", "destroyed"] as const) {
    await sweepRetiredSources({ ...dependencies,
      store: { ...dependencies.store, getCapsule: async () => undefined,
        listCapsulesPage: async (workspaceId, params) => {
          pages.push({ workspaceId, ...params });
          return params.cursor ? { items: [{ id: "cap_reference", sourceId: row.id, status } as Capsule] }
            : { items: [], nextCursor: "next" };
        } },
    });
  }
  expect(calls).toEqual([]);
  expect(pages).toHaveLength(4);
  expect(pages.every((page) => (page as { includeDestroyed: boolean }).includeDestroyed)).toBe(true);
});

test("sweep retires actual pre-Capsule reservations, including a lost Source acknowledgement", async () => {
  for (const kind of ["discarded", "failed", "expired"] as const) {
    for (const lostAck of [false, true]) {
      const planId = `git_reserved_${kind}_${lostAck}`;
      const sourceId = deterministicInstallSourceId(planId);
      const creator = plan(planId, kind === "expired" ? "awaiting_input" : kind, {
        ...(kind === "failed" ? {} : { mode: "attempt" as const }),
        sourceId: lostAck ? undefined : sourceId,
        expiresAt: "2026-10-27T11:00:00.000Z",
      });
      const { dependencies } = fixture([], [creator]);
      const store = new InMemoryOpenTofuControlStore();
      await store.putWorkspace({ id: "ws_one", handle: "one", displayName: "One", type: "personal",
        ownerUserId: "user_one", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
      const service = new SourcesService({ store, plans: dependencies.plans, now: () => NOW });
      await service.ensureOwnedSource({ id: sourceId, workspaceId: "ws_one", name: "Reserved",
        ownerCapsuleId: deterministicInitialCapsuleId(planId), createdByInstallPlanId: planId,
        url: "https://example.com/repo.git", ref: "main", path: ".", createdAt: "2026-10-25T00:00:00.000Z" });
      const result = await sweepRetiredSources({ ...dependencies, store,
        retireOwnedSource: (id, reason) => service.retireOwnedSource(id, reason) });
      expect(result, `${kind}/${lostAck}`).toMatchObject({ attempted: 1, retired: 1, failures: 0 });
      expect(await store.getSource(sourceId)).toBeUndefined();
    }
  }
});

test("destructive admission rechecks the reserved Source creator and keeps changed evidence active", async () => {
  const planId = "git_creator_recheck";
  for (const extra of [{ sourceId: "src_other" }, { workspaceId: "ws_other" },
    { operation: "revision" as const }, { phase: "awaiting_input" as const, mode: "attempt" as const, expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() },
    { capsuleId: "cap_other" }]) {
    const sourceId = deterministicInstallSourceId(planId);
    const creator = plan(planId, "discarded", extra);
    const store = new InMemoryOpenTofuControlStore();
    await store.putWorkspace({ id: "ws_one", handle: "one", displayName: "One", type: "personal",
      ownerUserId: "user_one", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    const service = new SourcesService({ store, now: () => NOW, plans: { get: async () => creator } });
    await service.ensureOwnedSource({ id: sourceId, workspaceId: "ws_one", name: "Reserved",
      ownerCapsuleId: deterministicInitialCapsuleId(planId), createdByInstallPlanId: planId,
      url: "https://example.com/repo.git", ref: "main", path: ".", createdAt: "2026-10-25T00:00:00.000Z" });
    await expect(service.retireOwnedSource(sourceId, "recovery")).rejects.toMatchObject({
      details: { reason: "source_owner_not_destroyed" },
    });
    expect(await store.getSource(sourceId)).toMatchObject({ status: "active" });
  }
});
