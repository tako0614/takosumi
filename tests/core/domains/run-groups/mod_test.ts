/** RunGroups create independent plans for source-stale Capsules. */
import { expect, test } from "bun:test";
import { OpenTofuController, type OpenTofuPlanJob, type OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { InMemoryAppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
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
    groups: new RunGroupsService({
      store, controller, newId: ids(),
      activity: { record: async (event) => { activityEvents.push(event); return undefined; } },
    }),
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
async function seedOwnership(store: InMemoryOpenTofuControlStore, capsuleId: string) {
  const ownership = new InMemoryAppOwnershipStore(store);
  const capsule = (await store.getCapsule(capsuleId))!;
  expect(await ownership.putOwnership({ capsuleId, ownerAccountId: "user_test", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsuleId}` }, 0)).toBe(true);
  return ownership;
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

test("workspace update plans only source-stale Capsules in one unordered layer", async () => {
  const { store, groups } = service(["cap_active"]);
  await seed(store, "first", "stale");
  await seed(store, "second", "stale");
  await seed(store, "active", "active");
  const created = await groups.createWorkspaceUpdate("ws_test001");
  const graph = JSON.parse(created.runGroup.graphJson) as { order: string[][]; runs: Record<string, string> };
  expect(graph.order).toEqual([["cap_first", "cap_second"]]);
  expect(Object.keys(graph.runs)).toEqual(["cap_first", "cap_second"]);
  expect(created.runs).toHaveLength(2);
  expect((await groups.getRunGroup(created.runGroup.id))?.runs).toHaveLength(2);
});

test("trusted system RunGroup uses each current app owner for Runs and keeps system audit actor", async () => {
  const { store, controller } = service();
  await seed(store, "owned", "stale");
  const appOwnership = await seedOwnership(store, "cap_owned");
  const events: unknown[] = [];
  const groups = new RunGroupsService({ store, controller, systemOwnedFlow: true,
    actor: "system:run-group", appOwnership, activity: { record: async (event) => { events.push(event); return undefined; } } });
  const result = await groups.createWorkspaceUpdate("ws_test001");
  expect(result.runs[0]?.createdBy).toBe("user_test");
  expect(events).toContainEqual(expect.objectContaining({ actorId: "system:run-group", action: "run_group.created" }));
});

test("trusted system RunGroup keeps the legacy system actor for ownerless stale apps", async () => {
  const { store, controller } = service();
  await seed(store, "legacy_ownerless", "stale");
  const events: unknown[] = [];
  const groups = new RunGroupsService({
    store,
    controller,
    systemOwnedFlow: true,
    actor: "system:run-group",
    appOwnership: { getOwnership: async () => undefined } as never,
    activity: { record: async (event) => { events.push(event); return undefined; } },
  });
  const result = await groups.createWorkspaceUpdate("ws_test001");
  expect(result.runs[0]?.createdBy).toBe("system:run-group");
  expect(events).toContainEqual(expect.objectContaining({
    actorId: "system:run-group",
    action: "run_group.created",
  }));
});

test("public RunGroup actor must have current access to every owned app", async () => {
  const { store, controller } = service();
  await seed(store, "owned", "stale");
  const appOwnership = await seedOwnership(store, "cap_owned");
  const groups = new RunGroupsService({ store, controller, systemOwnedFlow: true,
    appOwnership,
    appAccess: { resolveAppAccess: async () => undefined,
      listAccessibleApps: async () => ({ apps: [] }) } });
  await expect(groups.createWorkspaceUpdate("ws_test001", "workspace_member"))
    .rejects.toMatchObject({ code: "permission_denied" });
  expect(await controller.listRuns("ws_test001")).toHaveLength(0);
});

test("public RunGroup approval records its current app member, not the system trigger", async () => {
  const { store } = service();
  await seed(store, "owned", "stale");
  const capsule = (await store.getCapsule("cap_owned"))!;
  await store.putCapsule({ ...capsule, ownerAccountId: "user_test", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0 });
  await store.putRunGroup({ id: "rg_member_approval", workspaceId: "ws_test001",
    type: "workspace_update", status: "waiting_approval",
    graphJson: JSON.stringify({ order: [["cap_owned"]], runs: { cap_owned: "plan_member" } }),
    createdAt: "2026-10-28T00:00:00.000Z" });
  const approvedBy: string[] = [];
  const groups = new RunGroupsService({ store, systemOwnedFlow: true, actor: "system:run-group",
    controller: { getRun: async () => ({ id: "plan_member", status: "waiting_approval",
      capsuleId: "cap_owned" }), approveRun: async (_id: string, input: { approvedBy?: string }) => {
        approvedBy.push(input.approvedBy!); return undefined; } } as never,
    appAccess: { resolveAppAccess: async (accountId, capsuleId) => accountId === "member"
      ? { capsuleId, role: "member", ownerAccountId: "user_test", ownershipEpoch: 0 }
      : undefined, listAccessibleApps: async () => ({ apps: [] }) } });
  await groups.approveRunGroup("rg_member_approval", "member");
  expect(approvedBy).toEqual(["member"]);
});

test("workspace update with no stale Capsule refuses the group", async () => {
  const { store, groups } = service();
  await seed(store, "active", "active");
  await expect(groups.createWorkspaceUpdate("ws_test001")).rejects.toThrow(/nothing_to_update/);
});

test("drift group still plans active Capsules independently", async () => {
  const { store, groups } = service();
  await seed(store, "first", "active");
  await seed(store, "second", "active");
  await seed(store, "stale", "stale");
  const created = await groups.createWorkspaceDriftCheck("ws_test001");
  const graph = JSON.parse(created.runGroup.graphJson) as { order: string[][] };
  expect(graph.order).toEqual([["cap_first", "cap_second"]]);
  expect(created.runs).toHaveLength(2);
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

for (const kind of ["update", "drift"] as const) {
  const status = kind === "update" ? "stale" : "active";
  const create = (groups: RunGroupsService) => kind === "update"
    ? groups.createWorkspaceUpdate("ws_test001")
    : groups.createWorkspaceDriftCheck("ws_test001");

  test(`${kind} group records a retired member and continues an independent Capsule`, async () => {
    const { store, groups, jobs, activityEvents } = service(["cap_blocked"]);
    await seed(store, "blocked", status);
    await seed(store, "independent", status);

    const created = await create(groups);
    const graph = JSON.parse(created.runGroup.graphJson) as {
      order: string[][];
      runs: Record<string, string>;
      failures: Record<string, string>;
    };
    expect(graph.order).toEqual([["cap_blocked", "cap_independent"]]);
    expect(graph.failures).toEqual({ cap_blocked: "dependency_retired" });
    expect(Object.keys(graph.runs)).toEqual(["cap_independent"]);
    expect(activityEvents).toHaveLength(1);
    expect(activityEvents[0]?.metadata).toMatchObject({
      memberCapsuleIds: ["cap_blocked", "cap_independent"],
      runIds: Object.values(graph.runs),
      failures: graph.failures,
    });
    expect(created.runs).toHaveLength(1);
    expect(created.runs[0]?.status).toBe("succeeded");
    const expectedStatus = "failed";
    expect(created.runGroup.status).toBe(expectedStatus);
    expect(jobs.map((job) => job.planRun.capsuleId)).toEqual(["cap_independent"]);
    expect((await store.listRunsByWorkspace("ws_test001")).filter((run) => run.capsuleId === "cap_blocked")).toHaveLength(0);

    const stored = await store.getRunGroup(created.runGroup.id);
    expect(stored?.graphJson).toBe(created.runGroup.graphJson);
    expect(stored?.status).toBe(expectedStatus);
    const readback = await groups.getRunGroup(created.runGroup.id);
    expect(readback?.runGroup.graphJson).toBe(created.runGroup.graphJson);
    expect(readback?.runGroup.status).toBe(expectedStatus);
    expect(readback?.runs).toHaveLength(1);
  });

  test(`${kind} group with only retired members remains failed on read and approval`, async () => {
    const { store, groups } = service(["cap_blocked"]);
    await seed(store, "blocked", status);

    const created = await create(groups);
    expect(created.runs).toHaveLength(0);
    expect(created.runGroup.status).toBe("failed");
    expect(JSON.parse(created.runGroup.graphJson).failures).toEqual({
      cap_blocked: "dependency_retired",
    });
    expect(await store.listRunsByWorkspace("ws_test001")).toHaveLength(0);
    expect((await groups.getRunGroup(created.runGroup.id))?.runGroup.status).toBe("failed");
    expect((await groups.approveRunGroup(created.runGroup.id))?.runGroup.status).toBe("failed");
  });
}
