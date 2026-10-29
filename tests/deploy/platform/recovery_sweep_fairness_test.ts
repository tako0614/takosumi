import { expect, test } from "bun:test";
import { planStaleCapsuleUpdates, repairStaleOpenTofuRuns } from "../../../deploy/platform/worker.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../core/domains/workspaces/mod.ts";
import { CapsuleQuery } from "../../../core/domains/deploy-control/capsule_query.ts";
import { RunGroupsService } from "../../../core/domains/run-groups/mod.ts";
import { driftSweep } from "../../../worker/src/scheduled/drift.ts";

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

test("auto-plan visits every Workspace beyond the fixed window despite permanent prefix failures", async () => {
  const store = new InMemoryOpenTofuControlStore();
  for (let i = 0; i < 7; i++) {
    const id = `ws_${i}`;
    await store.putWorkspace(workspace(id));
    await store.putCapsule(capsule(`cap_${i}`, id, "stale"));
  }
  const visited = new Set<string>();
  const operations = {
    workspaces: new WorkspacesService({ store }),
    capsules: { listCapsules: (id: string) => store.listCapsules(id) },
    controller: { listRuns: () => Promise.resolve([]) },
    createCapsulePlan: (id: string) => {
      visited.add(id);
      return Promise.reject(new Error("persistent failure"));
    },
  };
  for (let tick = 0; tick < 4; tick++) {
    const result = await planStaleCapsuleUpdates(operations, { workspaceLimit: 2 });
    expect(result.workspacesScanned).toBeLessThanOrEqual(2);
  }
  expect([...visited].sort()).toEqual(Array.from({ length: 7 }, (_, i) => `cap_${i}`));
});

test("drift checks the selected Capsules beyond the window within a single Workspace", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace(workspace("ws_drift"));
  for (let i = 0; i < 7; i++) await store.putCapsule(capsule(`cap_${i}`, "ws_drift"));
  const visited = new Set<string>();
  let nextId = 0;
  const controller = {
    createCapsuleDriftCheck: (id: string) => {
      visited.add(id);
      return Promise.resolve({ planRun: { id: `plan_${nextId++}` } });
    },
    getRun: (id: string) => Promise.resolve({ id, type: "drift_check", status: "queued", createdAt: at }),
  };
  const groups = new RunGroupsService({ store, controller: controller as never });
  const query = new CapsuleQuery(store, (value) => value);
  const operations = {
    listActiveCapsules: (limit: number) => query.listActiveCapsules(limit),
    createWorkspaceDriftCheck: (id: string, options?: { readonly limit?: number; readonly capsuleIds?: readonly string[] }) => groups.createWorkspaceDriftCheck(id, options),
  };
  for (let tick = 0; tick < 4; tick++) {
    const result = await driftSweep(operations, { limit: 2 });
    expect(result.checked).toBeLessThanOrEqual(2);
  }
  expect([...visited].sort()).toEqual(Array.from({ length: 7 }, (_, i) => `cap_${i}`));
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

test("drift page revalidation never widens to another Workspace, inactive or prefix Capsule", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace(workspace("ws_selected"));
  await store.putWorkspace(workspace("ws_other"));
  await store.putCapsule(capsule("cap_prefix", "ws_selected"));
  await store.putCapsule(capsule("cap_selected", "ws_selected"));
  await store.putCapsule(capsule("cap_inactive", "ws_selected", "stale"));
  await store.putCapsule(capsule("cap_cross_workspace", "ws_other"));
  const visited: string[] = [];
  const controller = {
    createCapsuleDriftCheck: (id: string) => {
      visited.push(id);
      return Promise.resolve({ planRun: { id: `plan_${id}` } });
    },
    getRun: (id: string) => Promise.resolve({ id, type: "drift_check", status: "queued", createdAt: at }),
  };
  const groups = new RunGroupsService({ store, controller: controller as never });
  await groups.createWorkspaceDriftCheck("ws_selected", {
    limit: 4,
    capsuleIds: ["cap_selected", "cap_selected", "cap_deleted", "cap_inactive", "cap_cross_workspace"],
  });
  expect(visited).toEqual(["cap_selected"]);
  await expect(groups.createWorkspaceDriftCheck("ws_selected", {
    limit: 2, capsuleIds: ["cap_deleted", "cap_inactive"],
  })).rejects.toThrow("nothing_to_drift_check");
  expect(visited).toEqual(["cap_selected"]);
});

test("drift counts only checks created after selected Capsule status revalidation", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace(workspace("ws_race"));
  await store.putCapsule(capsule("cap_live", "ws_race"));
  await store.putCapsule(capsule("cap_changed", "ws_race", "stale"));
  const groups = new RunGroupsService({
    store,
    controller: {
      createCapsuleDriftCheck: (id: string) => Promise.resolve({ planRun: { id: `plan_${id}` } }),
      getRun: (id: string) => Promise.resolve({ id, type: "drift_check", status: "queued", createdAt: at }),
    } as never,
  });
  const result = await driftSweep({
    listActiveCapsules: () => Promise.resolve([
      { id: "cap_live", workspaceId: "ws_race" },
      { id: "cap_changed", workspaceId: "ws_race" },
    ]),
    createWorkspaceDriftCheck: (id, options) => groups.createWorkspaceDriftCheck(id, options),
  }, { limit: 2 });
  expect(result).toEqual({ scanned: 2, checked: 1 });
});

test("auto-plan revisits a failed page while newer Workspaces arrive every tick", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const attempts = new Map<string, number>();
  const add = async (index: number) => {
    const id = `ws_append_${String(index).padStart(3, "0")}`;
    await store.putWorkspace(workspace(id));
    await store.putCapsule(capsule(`cap_${id}`, id, "stale"));
  };
  for (let i = 0; i < 3; i++) await add(i);
  const operations = {
    workspaces: new WorkspacesService({ store }),
    capsules: { listCapsules: (id: string) => store.listCapsules(id) },
    controller: { listRuns: () => Promise.resolve([]) },
    createCapsulePlan: (id: string) => {
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      return Promise.reject(new Error("crashed or failed page"));
    },
  };
  for (let tick = 0; tick < 4; tick++) {
    const result = await planStaleCapsuleUpdates(operations, { workspaceLimit: 1 });
    expect(result.workspacesScanned).toBeLessThanOrEqual(1);
    await add(tick + 3);
  }
  expect(attempts.get("cap_ws_append_000")).toBe(2);
  expect(attempts.get("cap_ws_append_001")).toBe(1);
  expect(attempts.get("cap_ws_append_002")).toBe(1);
});
