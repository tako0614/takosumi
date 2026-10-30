import { expect, test } from "bun:test";
import { repairStaleOpenTofuRuns, runCapsuleSweep } from "../../../deploy/platform/worker.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { CapsuleQuery } from "../../../core/domains/deploy-control/capsule_query.ts";

const at = "2026-10-01T00:00:00.000Z";

function capsule(id: string, workspaceId: string, status = "active"): never {
  return {
    id, workspaceId, projectId: "prj_sweep", sourceId: "src_sweep",
    name: id, slug: id, installConfigId: "cfg_sweep", environment: "production", ownerAccountId: "usr_sweep",
    currentStateGeneration: 1, status, createdAt: at, updatedAt: at,
  } as never;
}

function workspace(id: string): never {
  return { id, handle: id, displayName: id, type: "personal", ownerUserId: "usr_sweep", createdAt: at, updatedAt: at } as never;
}

/** The facade members the per-app sweep reads, backed by one in-memory store. */
function sweepOperations(
  store: InMemoryOpenTofuControlStore,
  handlers: {
    readonly plan?: (id: string, options: { readonly actor: string }) => Promise<unknown>;
    readonly drift?: (id: string, options: { readonly actor: string }) => Promise<unknown>;
    readonly runReads?: { capsuleId: string; workspaceId: string; types?: readonly string[] }[];
  } = {},
) {
  const query = new CapsuleQuery(store, (value) => value);
  return {
    controller: {
      listCapsulesForScheduledSweep: (limit: number) => query.listCapsulesForScheduledSweep(limit),
    },
    listCapsuleRunsPage: (capsuleId: string, options: { readonly workspaceId: string; readonly types?: readonly string[] }) => {
      handlers.runReads?.push({ capsuleId, workspaceId: options.workspaceId, ...(options.types ? { types: options.types } : {}) });
      return Promise.resolve({ runs: [] });
    },
    createCapsulePlan: (id: string, options: { readonly actor: string }) =>
      handlers.plan ? handlers.plan(id, options) : Promise.resolve({}),
    createCapsuleDriftCheck: (id: string, options: { readonly actor: string }) =>
      handlers.drift ? handlers.drift(id, options) : Promise.resolve({}),
  };
}

test("the per-app sweep visits every live app beyond the page despite permanent failures", async () => {
  const store = new InMemoryOpenTofuControlStore();
  // Apps spread over shared and separate Workspaces; the sweep never reads one.
  for (let i = 0; i < 7; i++) {
    await store.putCapsule(capsule(`cap_stale_${i}`, `ws_${i % 3}`, "stale"));
    await store.putCapsule(capsule(`cap_active_${i}`, `ws_${i}`, "active"));
  }
  const planned = new Set<string>();
  const checked = new Set<string>();
  const runReads: { capsuleId: string; workspaceId: string; types?: readonly string[] }[] = [];
  const operations = sweepOperations(store, {
    runReads,
    plan: (id, options) => {
      expect(options.actor).toBe("system:stale-auto-plan");
      planned.add(id);
      return Promise.reject(new Error("persistent failure"));
    },
    drift: (id, options) => {
      expect(options.actor).toBe("system:drift-check");
      checked.add(id);
      return Promise.reject(new Error("persistent failure"));
    },
  });
  for (let tick = 0; tick < 7; tick++) {
    const result = await runCapsuleSweep(operations, { autoPlanStale: true, driftCheck: true, limit: 2 });
    expect(result.scanned).toBeLessThanOrEqual(2);
  }
  expect([...planned].sort()).toEqual(Array.from({ length: 7 }, (_, i) => `cap_stale_${i}`));
  expect([...checked].sort()).toEqual(Array.from({ length: 7 }, (_, i) => `cap_active_${i}`));
  // Open plans are read per app, with only that app's own Workspace column.
  for (const read of runReads) {
    expect(read.types).toEqual(["plan"]);
    expect(read.workspaceId).toBe(`ws_${Number(read.capsuleId.slice("cap_stale_".length)) % 3}`);
  }
});

test("the per-app sweep never hands a non-live app to a step", async () => {
  const store = new InMemoryOpenTofuControlStore();
  for (const status of ["pending", "disabled", "error", "uninstalled", "destroyed"]) {
    await store.putCapsule(capsule(`cap_${status}`, "ws_mixed", status));
  }
  await store.putCapsule(capsule("cap_live_stale", "ws_mixed", "stale"));
  await store.putCapsule(capsule("cap_live_active", "ws_other", "active"));
  const visited: string[] = [];
  const operations = sweepOperations(store, {
    plan: (id) => { visited.push(id); return Promise.resolve({}); },
    drift: (id) => { visited.push(id); return Promise.resolve({}); },
  });
  const result = await runCapsuleSweep(operations, { autoPlanStale: true, driftCheck: true, limit: 10 });
  expect(visited.sort()).toEqual(["cap_live_active", "cap_live_stale"]);
  expect(result).toEqual({ scanned: 2, plansCreated: 1, driftChecksCreated: 1 });
});

test("the per-app sweep records the stale auto-plan on the app itself", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putCapsule(capsule("cap_owned", "ws_owner", "stale"));
  const events: unknown[] = [];
  const operations = {
    ...sweepOperations(store),
    appOwnership: {
      getOwnership: (capsuleId: string) => Promise.resolve({
        capsuleId, ownerAccountId: "acct_owner", ownershipEpoch: 1, managementState: "active",
      } as never),
    },
    activity: { record: (event: unknown) => { events.push(event); return Promise.resolve(undefined); } },
  };
  const plans: { id: string; actor: string }[] = [];
  operations.createCapsulePlan = (id, options) => {
    plans.push({ id, actor: options.actor });
    return Promise.resolve({});
  };
  const result = await runCapsuleSweep(operations, { autoPlanStale: true, driftCheck: false });
  expect(plans).toEqual([{ id: "cap_owned", actor: "acct_owner" }]);
  expect(events).toEqual([{
    workspaceId: "ws_owner",
    actorId: "system:stale-auto-plan",
    action: "capsule.stale_auto_plan_created",
    targetType: "capsule",
    targetId: "cap_owned",
    metadata: {},
  }]);
  expect(result.plansCreated).toBe(1);
});

test("repair visits all 5001 eligible Runs while the first 5000 remain permanently recoverable", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace(workspace("ws_repair"));
  for (let i = 0; i < 5001; i++) {
    await store.putPlanRun({
      id: `plan_${String(i).padStart(5, "0")}`, workspaceId: "ws_repair", kind: "update",
      status: "queued", sourceDigest: "sha256:source", variablesDigest: "sha256:variables",
      createdAt: Date.parse(at), auditEvents: [],
    } as never);
  }
  const visited = new Set<string>();
  const operations = {
    workspaces: { listWorkspacesByIds: (ids: readonly string[]) => Promise.resolve(ids.map(workspace)) },
    controller: {
      listRecoverableOpenTofuRuns: async (options: Parameters<typeof store.listRecoverableOpenTofuRuns>[0]) =>
        (await store.listRecoverableOpenTofuRuns(options)).map((run) => ({
          id: run.id, workspaceId: run.workspaceId, type: "plan", status: run.status,
          createdAt: new Date(run.createdAt).toISOString(),
        })) as never,
      listPendingRuntimeSecretRetirementRuns: () => Promise.resolve([]),
      claimPendingRuntimeSecretRetirementDispatch: () => Promise.resolve(false),
    },
  };
  for (let tick = 0; tick < 2; tick++) {
    const result = await repairStaleOpenTofuRuns(operations, {
      schedule: (dispatch) => {
        visited.add(dispatch.runId);
        return Promise.reject(new Error("persistent dispatch failure"));
      },
    }, { now: Date.parse("2026-10-14T08:35:00.000Z") });
    expect(result.runsScanned).toBeLessThanOrEqual(5000);
  }
  expect(visited.size).toBe(5001);
});

test("the per-app sweep revisits a failed page while newer apps arrive every tick", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const attempts = new Map<string, number>();
  let clock = Date.parse(at);
  const add = async (index: number) => {
    clock += 1000;
    await store.putCapsule({
      ...(capsule(`cap_append_${String(index).padStart(3, "0")}`, `ws_append_${index}`, "stale") as object),
      createdAt: new Date(clock).toISOString(),
    } as never);
  };
  for (let i = 0; i < 3; i++) await add(i);
  const operations = sweepOperations(store, {
    plan: (id) => {
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      return Promise.reject(new Error("crashed or failed page"));
    },
  });
  for (let tick = 0; tick < 4; tick++) {
    const result = await runCapsuleSweep(operations, { autoPlanStale: true, driftCheck: false, limit: 1 });
    expect(result.scanned).toBeLessThanOrEqual(1);
    await add(tick + 3);
  }
  // The lap's upper key is fixed, so newer apps never postpone the oldest.
  expect(attempts.get("cap_append_000")).toBe(2);
  expect(attempts.get("cap_append_001")).toBe(1);
  expect(attempts.get("cap_append_002")).toBe(1);
});
