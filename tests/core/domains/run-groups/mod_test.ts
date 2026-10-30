/** RunGroups are retired (TASK-0118 9.1): only a historical row is read. */
import { expect, test } from "bun:test";
import { OpenTofuController, type OpenTofuPlanJob, type OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { computeGroupStatus, RunGroupsService } from "../../../../core/domains/run-groups/mod.ts";
import type { Run } from "takosumi-contract/runs";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fakeProviderVault,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
function ids() { let n = 1; return (prefix: string) => `${prefix}_${String(n++).padStart(8, "0")}`; }
function service(legacyDependencyConsumerCapsuleIds: readonly string[] = []) {
  const store = new InMemoryOpenTofuControlStore({ legacyDependencyConsumerCapsuleIds });
  const jobs: OpenTofuPlanJob[] = [];
  const activityEvents: { metadata: Record<string, unknown> }[] = [];
  const runner: OpenTofuRunner = {
    plan: async (job) => {
      jobs.push(job);
      return {
        planDigest: DIGEST,
        planArtifact: { kind: "runner-local", ref: "runner-local://plan/test", digest: DIGEST },
        providerLockDigest: DIGEST,
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      };
    },
    apply: async () => ({}),
    destroy: async () => ({}),
  };
  const controller = new OpenTofuController({
    store, runner, vault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    now: (() => { let t = 1; return () => t++; })(), newId: ids(),
  });
  return {
    store, controller, jobs, activityEvents,
    groups: new RunGroupsService({ store, controller }),
  };
}
async function seed(store: InMemoryOpenTofuControlStore, name: string, status: "stale" | "active") {
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "ws_test001", environment: "preview", sourceId: `src_${name}`,
    snapshotId: `snap_${name}`, installConfigId: `cfg_${name}`,
    capsuleId: `cap_${name}`, name,
  });
  await seedProviderConnections(store, capsule);
  await store.putCapsule({ ...capsule, status });
}
function fakeRun(status: Run["status"]): Run {
  return { id: `run_${status}`, workspaceId: "ws_test001", type: "plan", status, createdBy: "system", createdAt: "2026-10-28T00:00:00.000Z" };
}

test("group status keeps active, approval and terminal precedence", () => {
  expect(computeGroupStatus([])).toBe("succeeded");
  expect(computeGroupStatus([fakeRun("queued"), fakeRun("failed")])).toBe("running");
  expect(computeGroupStatus([fakeRun("waiting_approval"), fakeRun("failed")])).toBe("waiting_approval");
  expect(computeGroupStatus([fakeRun("cancelled"), fakeRun("failed")])).toBe("failed");
  expect(computeGroupStatus([], true)).toBe("failed");
  expect(computeGroupStatus([fakeRun("queued")], true)).toBe("running");
  expect(computeGroupStatus([fakeRun("succeeded")], true)).toBe("failed");
});

test("the service only reads; creating and approving RunGroups is retired", () => {
  const { groups } = service();
  for (const retired of ["createWorkspaceUpdate", "createWorkspaceDriftCheck", "approveRunGroup"]) {
    expect(retired in groups).toBe(false);
  }
});

test("a historical group reads its member Runs and recomputes its status", async () => {
  const { store, controller, groups } = service();
  await seed(store, "first", "stale");
  await seed(store, "second", "stale");
  const first = await controller.createCapsulePlan("cap_first", {});
  const second = await controller.createCapsulePlan("cap_second", {});
  const graphJson = JSON.stringify({
    order: [["cap_first", "cap_second", "cap_missing"]],
    runs: { cap_first: first.planRun.id, cap_second: second.planRun.id, cap_missing: "plan_gone" },
    failures: {},
  });
  await store.putRunGroup({
    id: "rg_history", workspaceId: "ws_test001", type: "workspace_update",
    status: "running", graphJson, createdAt: "2026-10-28T00:00:00.000Z",
  });
  const readback = await groups.getRunGroup("rg_history");
  // A member Run the ledger no longer holds is skipped.
  expect(readback?.runs.map((run) => run.id)).toEqual([first.planRun.id, second.planRun.id]);
  expect(readback?.runGroup.graphJson).toBe(graphJson);
  expect(readback?.runGroup.status).toBe(computeGroupStatus(readback!.runs));
  expect(await groups.getRunGroup("rg_absent")).toBeUndefined();
});

test("a historical group with a recorded retired member reads as failed", async () => {
  const { store, groups } = service();
  await store.putRunGroup({
    id: "rg_failed", workspaceId: "ws_test001", type: "workspace_drift_check",
    status: "failed",
    graphJson: JSON.stringify({ order: [["cap_blocked"]], runs: {}, failures: { cap_blocked: "dependency_retired" } }),
    createdAt: "2026-10-28T00:00:00.000Z",
  });
  const readback = await groups.getRunGroup("rg_failed");
  expect(readback?.runs).toEqual([]);
  expect(readback?.runGroup.status).toBe("failed");
});

test("older group graphs without failures keep their computed status", async () => {
  const { store, groups } = service();
  const graphJson = JSON.stringify({ order: [["cap_old"]], runs: {} });
  await store.putRunGroup({
    id: "rg_old", workspaceId: "ws_test001", type: "workspace_update",
    status: "running", graphJson, createdAt: "2026-10-28T00:00:00.000Z",
  });
  const readback = await groups.getRunGroup("rg_old");
  expect(readback?.runGroup.graphJson).toBe(graphJson);
  expect(readback?.runGroup.status).toBe("succeeded");
});
