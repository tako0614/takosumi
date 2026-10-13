import { afterEach, expect, test } from "bun:test";

import type { Capsule, CapsuleUninstall } from "takosumi-contract/capsules";
import type { ApplyRun } from "@takosumi/internal/deploy-control-api";
import {
  CapsuleApplyRunAdmissionConflictError,
  capsuleApplyRunAdmissionFence,
  capsuleLifecycleExpected,
  type CapsuleLifecycleMutation,
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type UpdateCapsuleLifecycleResult,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function adapters(): Promise<
  readonly { readonly label: string; readonly store: OpenTofuControlStore }[]
> {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  return [
    { label: "memory", store: new InMemoryOpenTofuControlStore() },
    { label: "postgres", store: new SqlOpenTofuControlStore({ client: pg }) },
    {
      label: "d1",
      store: new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()),
    },
  ];
}

async function authority(
  store: OpenTofuControlStore,
  workspaceId: string,
): Promise<WorkspaceManagementAuthority> {
  const management = await store.getWorkspaceManagement(workspaceId);
  if (!management || management.managementState !== "active") {
    throw new Error("fixture Workspace is not active");
  }
  return {
    workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  };
}

async function mutate(
  store: OpenTofuControlStore,
  capsule: Capsule,
  mutation: CapsuleLifecycleMutation,
  updatedAt: string,
): Promise<UpdateCapsuleLifecycleResult> {
  const epoch = await store.getCapsuleExecutionAuthorityEpoch(capsule.id);
  return await store.updateCapsuleLifecycle({
    capsuleId: capsule.id,
    expected: capsuleLifecycleExpected(capsule, epoch!),
    mutation,
    updatedAt,
  });
}

function updated(result: UpdateCapsuleLifecycleResult, label: string): Capsule {
  expect(result.kind, label).toBe("updated");
  if (result.kind !== "updated") throw new Error(label);
  return result.capsule;
}

function scheduled(
  id: string,
  revision: number,
  scheduledDestroyAt: string,
): CapsuleUninstall {
  return {
    id,
    revision,
    phase: "scheduled",
    requestedAt: "2026-10-13T00:00:00.000Z",
    scheduledDestroyAt,
    previousStatus: "active",
  };
}

async function activeCapsule(
  store: OpenTofuControlStore,
  label: string,
  suffix: string,
): Promise<Capsule> {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `ws_uninstall_${suffix}_${label}`,
    capsuleId: `cap_uninstall_${suffix}_${label}`,
    sourceId: `src_uninstall_${suffix}_${label}`,
    installConfigId: `cfg_uninstall_${suffix}_${label}`,
  });
  return updated(
    await mutate(
      store,
      seeded.capsule,
      {
        kind: "status",
        status: "active",
        expectedWorkspaceManagementAuthority: await authority(
          store,
          seeded.capsule.workspaceId,
        ),
      },
      "2026-10-13T00:00:00.000Z",
    ),
    `${label} activate`,
  );
}

test("uninstall writes replace the whole record under an exact revision fence", async () => {
  for (const { label, store } of await adapters()) {
    const active = await activeCapsule(store, label, "fence");
    const auth = await authority(store, active.workspaceId);

    const first = scheduled("uninstall_first", 1, "2026-10-20T00:00:00.000Z");
    const parked = updated(
      await mutate(store, active, {
        kind: "uninstall",
        status: "uninstalled",
        uninstall: first,
        expectedUninstallRevision: undefined,
        expectedWorkspaceManagementAuthority: auth,
      }, "2026-10-13T00:00:01.000Z"),
      `${label} schedule`,
    );
    expect(parked.status, label).toBe("uninstalled");
    expect(parked.uninstall, label).toEqual(first);

    // A bare status write can neither leave nor re-enter the grace state.
    const statusWrite = await mutate(store, parked, {
      kind: "status",
      status: "active",
      expectedWorkspaceManagementAuthority: auth,
    }, "2026-10-13T00:00:02.000Z");
    expect(statusWrite.kind, `${label} status write`).toBe("conflict");

    // A writer that observed no record loses against the scheduled one.
    const stale = await mutate(store, parked, {
      kind: "uninstall",
      status: "uninstalled",
      uninstall: scheduled("uninstall_racing", 1, "2026-10-21T00:00:00.000Z"),
      expectedUninstallRevision: undefined,
      expectedWorkspaceManagementAuthority: auth,
    }, "2026-10-13T00:00:03.000Z");
    expect(stale.kind, `${label} stale revision`).toBe("conflict");

    const progressed = updated(
      await mutate(store, parked, {
        kind: "uninstall",
        status: "uninstalled",
        uninstall: {
          ...first,
          revision: 2,
          preDestroyExport: {
            status: "exported",
            backupId: "bkp_first",
            at: "2026-10-20T00:00:00.000Z",
          },
          destroyPlanRunId: "plan_uninstallfirsta1",
          destroyAttempts: 1,
        },
        expectedUninstallRevision: 1,
        expectedWorkspaceManagementAuthority: auth,
      }, "2026-10-13T00:00:04.000Z"),
      `${label} progress`,
    );
    const cancelled = updated(
      await mutate(store, progressed, {
        kind: "uninstall",
        status: "active",
        uninstall: {
          ...progressed.uninstall!,
          revision: 3,
          phase: "cancelled",
          cancelledAt: "2026-10-14T00:00:00.000Z",
        },
        expectedUninstallRevision: 2,
        expectedWorkspaceManagementAuthority: auth,
      }, "2026-10-13T00:00:05.000Z"),
      `${label} cancel`,
    );
    expect(cancelled.status, label).toBe("active");

    // The next request must not inherit evidence or Run ids from the
    // cancelled one (a recursive JSON merge would carry them over).
    const second = scheduled("uninstall_second", 4, "2026-10-27T00:00:00.000Z");
    const reparked = updated(
      await mutate(store, cancelled, {
        kind: "uninstall",
        status: "uninstalled",
        uninstall: second,
        expectedUninstallRevision: 3,
        expectedWorkspaceManagementAuthority: auth,
      }, "2026-10-13T00:00:06.000Z"),
      `${label} reschedule`,
    );
    expect(reparked.uninstall, label).toEqual(second);
    expect((await store.getCapsule(active.id))?.uninstall, label).toEqual(second);
  }
});

test("the due read returns only unblocked uninstalled Capsules past their schedule", async () => {
  for (const { label, store } of await adapters()) {
    const early = await activeCapsule(store, label, "early");
    const late = await activeCapsule(store, label, "late");
    const blocked = await activeCapsule(store, label, "blocked");
    const untouched = await activeCapsule(store, label, "untouched");
    for (const [capsule, uninstall] of [
      [early, scheduled("uninstall_early", 1, "2026-10-20T00:00:00.000Z")],
      [late, scheduled("uninstall_late", 1, "2026-10-21T00:00:00.000Z")],
      [
        blocked,
        {
          ...scheduled("uninstall_blocked", 1, "2026-10-19T00:00:00.000Z"),
          blockedReason: "destroy_plan_failed",
        },
      ],
    ] as const) {
      updated(
        await mutate(store, capsule, {
          kind: "uninstall",
          status: "uninstalled",
          uninstall,
          expectedUninstallRevision: undefined,
          expectedWorkspaceManagementAuthority: await authority(
            store,
            capsule.workspaceId,
          ),
        }, "2026-10-13T00:00:01.000Z"),
        `${label} park ${capsule.id}`,
      );
    }
    const ids = async (now: string, limit = 10) =>
      (await store.listDueCapsuleUninstalls({ now, limit })).map(
        (capsule) => capsule.id,
      );
    expect(await ids("2026-10-19T23:59:59.999Z"), label).toEqual([]);
    expect(await ids("2026-10-20T00:00:00.000Z"), label).toEqual([early.id]);
    expect(await ids("2026-10-22T00:00:00.000Z"), label).toEqual([
      early.id,
      late.id,
    ]);
    expect(await ids("2026-10-22T00:00:00.000Z", 1), label).toEqual([early.id]);
    expect(await ids("2026-10-22T00:00:00.000Z"), label).not.toContain(
      untouched.id,
    );

    // A waiting oldest request yields the next limited scheduler read without
    // changing the original due deadline. Both rows remain due and rotate.
    const waitingEarly = updated(await mutate(store, (await store.getCapsule(early.id))!, {
      kind: "uninstall",
      status: "uninstalled",
      uninstall: {
        ...(await store.getCapsule(early.id))!.uninstall!,
        revision: 2,
        lastFinalizeAttemptAt: "2026-10-22T00:00:01.000Z",
      },
      expectedUninstallRevision: 1,
      expectedWorkspaceManagementAuthority: await authority(store, early.workspaceId),
    }, "2026-10-22T00:00:01.000Z"), `${label} early waits`);
    expect(waitingEarly.uninstall?.scheduledDestroyAt, label).toBe("2026-10-20T00:00:00.000Z");
    expect(await ids("2026-10-22T00:00:02.000Z", 1), label).toEqual([late.id]);
    updated(await mutate(store, (await store.getCapsule(late.id))!, {
      kind: "uninstall",
      status: "uninstalled",
      uninstall: {
        ...(await store.getCapsule(late.id))!.uninstall!,
        revision: 2,
        lastFinalizeAttemptAt: "2026-10-22T00:00:02.000Z",
      },
      expectedUninstallRevision: 1,
      expectedWorkspaceManagementAuthority: await authority(store, late.workspaceId),
    }, "2026-10-22T00:00:02.000Z"), `${label} late waits`);
    expect(await ids("2026-10-22T00:00:03.000Z", 1), label).toEqual([early.id]);

    // A Workspace that is not accepting management work cannot hold the head
    // of the queue; its request waits until the Workspace is active again.
    await store.beginWorkspaceDraining(
      early.workspaceId,
      await authority(store, early.workspaceId),
    );
    expect(await ids("2026-10-22T00:00:00.000Z", 1), label).toEqual([late.id]);
  }
});

test("a cancelled or replaced uninstall cannot admit its approved system destroy Apply", async () => {
  for (const { label, store } of await adapters()) {
    const active = await activeCapsule(store, label, "admission");
    const auth = await authority(store, active.workspaceId);
    const first = {
      ...scheduled("uninstall_first", 1, "2026-10-20T00:00:00.000Z"),
      destroyPlanRunId: "plan_system_destroy_first",
    };
    const parked = updated(await mutate(store, active, {
      kind: "uninstall", status: "uninstalled", uninstall: first,
      expectedUninstallRevision: undefined,
      expectedWorkspaceManagementAuthority: auth,
    }, "2026-10-13T00:00:01.000Z"), `${label} first schedule`);
    const fence = capsuleApplyRunAdmissionFence(parked, 1, {
      id: first.id, destroyPlanRunId: first.destroyPlanRunId,
    });
    const run: ApplyRun = {
      id: "apply_old_system_destroy",
      planRunId: first.destroyPlanRunId,
      workspaceId: parked.workspaceId,
      capsuleId: parked.id,
      operation: "destroy",
      runnerProfileId: "runner",
      status: "queued",
      expected: {
        planRunId: first.destroyPlanRunId,
        capsuleId: parked.id,
        currentStateVersionId: fence.currentStateVersionId,
        capsuleExecutionAuthorityEpoch: fence.executionAuthorityEpoch,
        runnerProfileId: "runner",
        sourceDigest: "sha256:source",
        variablesDigest: "sha256:variables",
        policyDecisionDigest: "sha256:policy",
        planDigest: "sha256:plan",
        planArtifactDigest: "sha256:artifact",
      },
      stateBackend: { kind: "operator-managed", ref: "state" },
      stateLock: { status: "pending", backendRef: "state" },
      auditEvents: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const cancelled = updated(await mutate(store, parked, {
      kind: "uninstall", status: "active",
      uninstall: { ...first, revision: 2, phase: "cancelled", cancelledAt: "2026-10-13T00:00:02.000Z" },
      expectedUninstallRevision: 1,
      expectedWorkspaceManagementAuthority: auth,
    }, "2026-10-13T00:00:02.000Z"), `${label} cancel`);
    await expect(store.beginApplyRun(run, auth, fence), `${label} restored`)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect(await store.getApplyRun(run.id), label).toBeUndefined();

    const second = {
      ...scheduled("uninstall_second", 3, "2026-10-21T00:00:00.000Z"),
      destroyPlanRunId: "plan_system_destroy_second",
    };
    updated(await mutate(store, cancelled, {
      kind: "uninstall", status: "uninstalled", uninstall: second,
      expectedUninstallRevision: 2,
      expectedWorkspaceManagementAuthority: auth,
    }, "2026-10-13T00:00:03.000Z"), `${label} replacement schedule`);
    await expect(store.beginApplyRun(run, auth, fence), `${label} replacement`)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect(await store.getApplyRun(run.id), label).toBeUndefined();

    // Same status, state cursor and epoch: only uninstall identity changes.
    const replacement = (await store.getCapsule(parked.id))!;
    const oldOnNewCapsuleFence = capsuleApplyRunAdmissionFence(replacement, 1, {
      id: first.id, destroyPlanRunId: first.destroyPlanRunId,
    });
    await expect(store.beginApplyRun(run, auth, oldOnNewCapsuleFence), `${label} identity only`)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect(await store.getApplyRun(run.id), label).toBeUndefined();
    const newFence = capsuleApplyRunAdmissionFence(replacement, 1, {
      id: second.id, destroyPlanRunId: second.destroyPlanRunId,
    });
    const newRun: ApplyRun = {
      ...run, id: "apply_new_system_destroy", planRunId: second.destroyPlanRunId,
      expected: { ...run.expected, planRunId: second.destroyPlanRunId },
    };
    await expect(store.beginApplyRun(run, auth, newFence), `${label} wrong Plan id`)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect((await store.beginApplyRun(newRun, auth, newFence)).status, label).toBe("created");
  }
});
