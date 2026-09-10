import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type {
  ApplyRun,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type { Workspace } from "takosumi-contract/workspaces";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const TS = "2026-09-10T00:00:00.000Z";
const FORGED_AUTHORITY = 3;
const pgClients: PGliteSqlClient[] = [];

setDefaultTimeout(20_000);

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

interface Adapter {
  readonly label: string;
  readonly store: OpenTofuControlStore;
  readonly reopen: () => OpenTofuControlStore;
  readonly resumeManagement?: (workspaceId: string) => Promise<void>;
  readonly readRawRun?: (runId: string) => Promise<unknown>;
}

function parseRaw(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "") return undefined;
  return JSON.parse(value);
}

async function adapters(): Promise<readonly Adapter[]> {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const d1 = new SqliteFakeD1();
  const memory = new InMemoryOpenTofuControlStore();
  return [
    {
      label: "memory",
      store: memory,
      reopen: () => memory,
    },
    {
      label: "postgres",
      store: new SqlOpenTofuControlStore({ client: pg }),
      reopen: () => new SqlOpenTofuControlStore({ client: pg }),
      async resumeManagement(workspaceId) {
        await pg.query(
          "update takosumi_workspaces set management_state = 'active', management_epoch = management_epoch + 1 where id = $1 and management_state = 'draining'",
          [workspaceId],
        );
      },
      async readRawRun(runId) {
        const result = await pg.query<{ readonly runJson: unknown }>(
          'select run_json as "runJson" from takosumi_runs where id = $1',
          [runId],
        );
        return parseRaw(result.rows[0]?.runJson);
      },
    },
    {
      label: "d1",
      store: new CloudflareD1OpenTofuControlStore(d1),
      reopen: () => new CloudflareD1OpenTofuControlStore(d1),
      async resumeManagement(workspaceId) {
        await d1
          .prepare(
            "update workspaces set management_state = 'active', management_epoch = management_epoch + 1 where id = ? and management_state = 'draining'",
          )
          .bind(workspaceId)
          .run();
      },
      async readRawRun(runId) {
        const row = await d1
          .prepare("select run_json as runJson from runs where id = ?")
          .bind(runId)
          .first<{ readonly runJson: unknown }>();
        return parseRaw(row?.runJson);
      },
    },
  ];
}

async function activeAuthority(
  store: OpenTofuControlStore,
  workspaceId: string,
): Promise<WorkspaceManagementAuthority> {
  const management = await store.getWorkspaceManagement(workspaceId);
  if (!management || management.managementState !== "active") {
    throw new Error(`Workspace ${workspaceId} is not active`);
  }
  return {
    workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  };
}

function planRun(
  id: string,
  workspaceId: string,
  capsuleId: string,
  sourceSnapshotId: string,
): PlanRun {
  return {
    id,
    workspaceId,
    capsuleId,
    capsuleContext: {
      workspaceId,
      capsuleId,
      environment: "production",
    },
    source: {
      kind: "git",
      url: "https://example.test/terminal-authority.git",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    sourceSnapshotId,
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    executionInputsDigest: "sha256:inputs",
    requiredProviders: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function applyRun(
  id: string,
  planRunId: string,
  workspaceId: string,
  capsuleId: string,
): ApplyRun {
  return {
    id,
    planRunId,
    workspaceId,
    capsuleId,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "queued",
    expected: {
      planRunId,
      capsuleId,
      currentStateVersionId: null,
      runnerProfileId: "opentofu-default",
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
}

function restoreRun(
  id: string,
  workspaceId: string,
  capsuleId: string,
): Run {
  return {
    id,
    workspaceId,
    capsuleId,
    environment: "production",
    type: "restore",
    status: "queued",
    backupId: `backup_${id}`,
    restoreStateGeneration: 1,
    createdBy: "operator",
    createdAt: TS,
  };
}

function stateVersion(
  id: string,
  workspaceId: string,
  capsuleId: string,
  createdByRunId: string,
) {
  return {
    id,
    workspaceId,
    capsuleId,
    environment: "production",
    generation: 1,
    stateRef: `state://${id}`,
    digest: `sha256:${id}`,
    createdByRunId,
    createdAt: TS,
  } as const;
}

function output(id: string, workspaceId: string, capsuleId: string) {
  return {
    id,
    workspaceId,
    capsuleId,
    stateGeneration: 1,
    rawArtifactRef: `output://${id}`,
    publicOutputs: { endpoint: "https://example.test" },
    workspaceOutputs: { endpoint: "https://example.test" },
    outputDigest: `sha256:${id}`,
    createdAt: TS,
  } as const;
}

async function seedApplyFixture(store: OpenTofuControlStore, label: string) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `terminal_apply_workspace_${label}`,
    sourceId: `terminal_apply_source_${label}`,
    snapshotId: `terminal_apply_snapshot_${label}`,
    installConfigId: `terminal_apply_config_${label}`,
    capsuleId: `terminal_apply_capsule_${label}`,
  });
  const authority = await activeAuthority(store, seeded.workspace.id);
  const plan = planRun(
    `terminal_apply_plan_${label}`,
    seeded.workspace.id,
    seeded.capsule.id,
    `terminal_apply_snapshot_${label}`,
  );
  await store.preparePlanRun({
    run: plan,
    inputs: { planRunId: plan.id, variables: {} },
    expectedWorkspaceManagementAuthority: authority,
  });
  const apply = applyRun(
    `terminal_apply_run_${label}`,
    plan.id,
    seeded.workspace.id,
    seeded.capsule.id,
  );
  expect((await store.beginApplyRun(apply, authority)).status, label).toBe(
    "created",
  );
  const running: ApplyRun = {
    ...apply,
    status: "running",
    startedAt: 2,
    heartbeatAt: 2,
  };
  const lease = `terminal_apply_lease_${label}`;
  expect(
    (
      await store.transitionRun({
        id: apply.id,
        kind: "apply",
        expectFrom: ["queued"],
        run: running,
        setLeaseToken: lease,
      })
    ).won,
    label,
  ).toBe(true);
  return { seeded, authority, plan, apply, running, lease };
}

async function seedRestoreFixture(store: OpenTofuControlStore, label: string) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: `terminal_restore_workspace_${label}`,
    sourceId: `terminal_restore_source_${label}`,
    snapshotId: `terminal_restore_snapshot_${label}`,
    installConfigId: `terminal_restore_config_${label}`,
    capsuleId: `terminal_restore_capsule_${label}`,
  });
  const authority = await activeAuthority(store, seeded.workspace.id);
  const restore = restoreRun(
    `terminal_restore_run_${label}`,
    seeded.workspace.id,
    seeded.capsule.id,
  );
  expect((await store.beginRestoreRun(restore, authority)).status, label).toBe(
    "created",
  );
  const running: Run = {
    ...restore,
    status: "running",
    startedAt: TS,
    heartbeatAt: 2,
  };
  const lease = `terminal_restore_lease_${label}`;
  expect(
    (
      await store.transitionRun({
        id: restore.id,
        kind: "restore",
        expectFrom: ["queued"],
        run: running,
        setLeaseToken: lease,
      })
    ).won,
    label,
  ).toBe(true);
  return { seeded, authority, restore, running, lease };
}

function publicProjectionHasNoAuthority(value: unknown): void {
  expect(
    value && typeof value === "object"
      ? Object.prototype.hasOwnProperty.call(
          value,
          "workspaceManagementAuthority",
        )
      : false,
  ).toBe(false);
  expect(JSON.stringify(value)).not.toContain("workspaceManagementAuthority");
}

function forgedAuthority(
  authority: WorkspaceManagementAuthority,
): WorkspaceManagementAuthority {
  return { ...authority, managementEpoch: FORGED_AUTHORITY };
}

test("terminal Apply and Restore commits retain original authority while held leases converge during drain", async () => {
  for (const adapter of await adapters()) {
    const { store, label, readRawRun } = adapter;
    const applyFixture = await seedApplyFixture(store, label);
    const applyDrain = await store.beginWorkspaceDraining(
      applyFixture.seeded.workspace.id,
      applyFixture.authority,
    );
    expect(applyDrain.status, `${label}:apply drain`).toBe("started");

    const nextState = stateVersion(
      `terminal_apply_state_${label}`,
      applyFixture.seeded.workspace.id,
      applyFixture.seeded.capsule.id,
      applyFixture.apply.id,
    );
    const nextOutput = output(
      `terminal_apply_output_${label}`,
      applyFixture.seeded.workspace.id,
      applyFixture.seeded.capsule.id,
    );
    const forged = forgedAuthority(applyFixture.authority);
    const terminalApply = {
      ...applyFixture.running,
      status: "succeeded" as const,
      stateVersionId: nextState.id,
      outputId: nextOutput.id,
      finishedAt: 4,
      workspaceManagementAuthority: forged,
    } as ApplyRun;
    const appliedPlan = {
      ...applyFixture.plan,
      status: "succeeded" as const,
      appliedApplyRunId: applyFixture.apply.id,
      finishedAt: 4,
      workspaceManagementAuthority: forged,
    } as PlanRun;

    const committed = await store.commitRunState({
      stateVersion: nextState,
      output: nextOutput,
      capsulePatch: {
        id: applyFixture.seeded.capsule.id,
        patch: {
          currentStateVersionId: nextState.id,
          currentStateGeneration: nextState.generation,
          currentOutputId: nextOutput.id,
          status: "active",
          updatedAt: TS,
        },
        guard: {
          currentStateVersionId: undefined,
          status: "pending",
        },
      },
      applyRunTerminal: terminalApply,
      applyRunLeaseToken: applyFixture.lease,
      planRunApplied: appliedPlan,
    });
    expect(committed.capsule?.currentStateVersionId, label).toBe(nextState.id);

    publicProjectionHasNoAuthority(await store.getApplyRun(applyFixture.apply.id));
    publicProjectionHasNoAuthority(await store.getPlanRun(applyFixture.plan.id));
    const listed = await store.listRunsByWorkspace(
      applyFixture.seeded.workspace.id,
    );
    publicProjectionHasNoAuthority(
      listed.find((run) => run.id === applyFixture.apply.id),
    );
    publicProjectionHasNoAuthority(
      listed.find((run) => run.id === applyFixture.plan.id),
    );
    if (readRawRun) {
      const raw = (await readRawRun(applyFixture.apply.id)) as {
        readonly workspaceManagementAuthority?: unknown;
      };
      expect(raw.workspaceManagementAuthority, label).toEqual(
        applyFixture.authority,
      );
    }

    // A low-level typed put is allowed to park the same row for redelivery, but
    // a caller-supplied epoch must not replace the original private authority.
    const requeued = {
      ...terminalApply,
      status: "queued" as const,
      heartbeatAt: undefined,
      finishedAt: undefined,
      updatedAt: 5,
      workspaceManagementAuthority: forged,
    } as ApplyRun;
    await store.putApplyRun(requeued);
    if (adapter.resumeManagement) {
      await adapter.resumeManagement(applyFixture.seeded.workspace.id);
      const reopened = adapter.reopen();
      const resumed = await reopened.getWorkspaceManagement(
        applyFixture.seeded.workspace.id,
      );
      expect(resumed?.managementEpoch, label).toBe(3);
      const lateClaim = await reopened.transitionRun({
        id: requeued.id,
        kind: "apply",
        expectFrom: ["queued"],
        expectedWorkspaceManagementAuthority: forged,
        run: {
          ...requeued,
          status: "running",
          workspaceManagementAuthority: forged,
        } as ApplyRun,
        setLeaseToken: `late-${label}`,
      });
      expect(lateClaim.won, label).toBe(false);
      const preservedQueued = await reopened.getApplyRun(requeued.id);
      expect(preservedQueued, label).toMatchObject({
        id: requeued.id,
        status: "queued",
        startedAt: applyFixture.running.startedAt,
        stateVersionId: nextState.id,
        outputId: nextOutput.id,
        updatedAt: 5,
      });
      publicProjectionHasNoAuthority(preservedQueued);
    }

    const restoreFixture = await seedRestoreFixture(store, label);
    const restoreDrain = await store.beginWorkspaceDraining(
      restoreFixture.seeded.workspace.id,
      restoreFixture.authority,
    );
    expect(restoreDrain.status, `${label}:restore drain`).toBe("started");
    const restoredState = stateVersion(
      `terminal_restore_state_${label}`,
      restoreFixture.seeded.workspace.id,
      restoreFixture.seeded.capsule.id,
      restoreFixture.restore.id,
    );
    const restoredOutput = output(
      `terminal_restore_output_${label}`,
      restoreFixture.seeded.workspace.id,
      restoreFixture.seeded.capsule.id,
    );
    const restoreForged = forgedAuthority(restoreFixture.authority);
    const terminalRestore = {
      ...restoreFixture.running,
      status: "succeeded" as const,
      restoredStateVersionId: restoredState.id,
      finishedAt: TS,
      workspaceManagementAuthority: restoreForged,
    } as Run;
    const restoreCommitted = await store.commitRestoredState({
      stateVersion: restoredState,
      output: restoredOutput,
      capsulePatch: {
        id: restoreFixture.seeded.capsule.id,
        patch: {
          currentStateVersionId: restoredState.id,
          currentStateGeneration: restoredState.generation,
          currentOutputId: restoredOutput.id,
          status: "stale",
          updatedAt: TS,
        },
        guard: {
          currentStateVersionId: undefined,
          currentStateGeneration: 0,
          status: "pending",
        },
      },
      restoreRunTerminal: terminalRestore,
      restoreRunLeaseToken: restoreFixture.lease,
    });
    expect(
      restoreCommitted.capsule?.currentStateVersionId,
      label,
    ).toBe(restoredState.id);
    publicProjectionHasNoAuthority(
      await store.getBackupRun(restoreFixture.restore.id),
    );
    publicProjectionHasNoAuthority(
      (await store.listRunsByWorkspace(restoreFixture.seeded.workspace.id)).find(
        (run) => run.id === restoreFixture.restore.id,
      ),
    );
    if (readRawRun) {
      const raw = (await readRawRun(restoreFixture.restore.id)) as {
        readonly workspaceManagementAuthority?: unknown;
      };
      expect(raw.workspaceManagementAuthority, label).toEqual(
        restoreFixture.authority,
      );
    }
    const requeuedRestore = {
      ...terminalRestore,
      status: "queued" as const,
      heartbeatAt: undefined,
      finishedAt: undefined,
      updatedAt: TS,
      workspaceManagementAuthority: restoreForged,
    } as Run;
    await store.putBackupRun(requeuedRestore);
    if (adapter.resumeManagement) {
      await adapter.resumeManagement(restoreFixture.seeded.workspace.id);
      const reopened = adapter.reopen();
      const resumed = await reopened.getWorkspaceManagement(
        restoreFixture.seeded.workspace.id,
      );
      expect(resumed?.managementEpoch, label).toBe(3);
      const lateClaim = await reopened.transitionRun({
        id: requeuedRestore.id,
        kind: "restore",
        expectFrom: ["queued"],
        expectedWorkspaceManagementAuthority: restoreForged,
        run: {
          ...requeuedRestore,
          status: "running",
          workspaceManagementAuthority: restoreForged,
        } as Run,
        setLeaseToken: `late-restore-${label}`,
      });
      expect(lateClaim.won, label).toBe(false);
      const preservedQueued = await reopened.getBackupRun(requeuedRestore.id);
      expect(preservedQueued, label).toMatchObject({
        id: requeuedRestore.id,
        status: "queued",
        startedAt: restoreFixture.running.startedAt,
        restoredStateVersionId: restoredState.id,
        updatedAt: TS,
      });
      publicProjectionHasNoAuthority(preservedQueued);
    }
  }
});

test("terminal commits reject a mismatched Plan replacement without changing the Apply lease or ledger", async () => {
  for (const adapter of await adapters()) {
    const { store, label } = adapter;
    const fixture = await seedApplyFixture(store, `plan-mismatch-${label}`);
    const otherWorkspace: Workspace = {
      ...fixture.seeded.workspace,
      id: `terminal_other_workspace_${label}`,
      handle: `terminal-other-${label}`,
    };
    await store.putWorkspace(otherWorkspace);
    const nextState = stateVersion(
      `terminal_mismatch_state_${label}`,
      fixture.seeded.workspace.id,
      fixture.seeded.capsule.id,
      fixture.apply.id,
    );
    const nextOutput = output(
      `terminal_mismatch_output_${label}`,
      fixture.seeded.workspace.id,
      fixture.seeded.capsule.id,
    );
    const terminalApply = {
      ...fixture.running,
      status: "succeeded" as const,
      stateVersionId: nextState.id,
      outputId: nextOutput.id,
      finishedAt: 4,
    };
    const mismatchedPlan = {
      ...fixture.plan,
      status: "succeeded" as const,
      appliedApplyRunId: fixture.apply.id,
      workspaceId: otherWorkspace.id,
    } as PlanRun;
    let refused = false;
    try {
      const result = await store.commitRunState({
        stateVersion: nextState,
        output: nextOutput,
        capsulePatch: {
          id: fixture.seeded.capsule.id,
          patch: {
            currentStateVersionId: nextState.id,
            currentStateGeneration: nextState.generation,
            currentOutputId: nextOutput.id,
            status: "active",
            updatedAt: TS,
          },
          guard: {
            currentStateVersionId: undefined,
            status: "pending",
          },
        },
        applyRunTerminal: terminalApply,
        applyRunLeaseToken: fixture.lease,
        planRunApplied: mismatchedPlan,
      });
      refused = result.applyRunLeaseLost === true;
    } catch {
      refused = true;
    }
    expect(refused, label).toBe(true);
    expect(await store.getApplyRun(fixture.apply.id), label).toEqual(
      fixture.running,
    );
    expect(await store.getPlanRun(fixture.plan.id), label).toEqual(fixture.plan);
    expect(await store.getStateVersion(nextState.id), label).toBeUndefined();
    expect(await store.getOutput(nextOutput.id), label).toBeUndefined();
    expect(await store.getCapsule(fixture.seeded.capsule.id), label).toEqual(
      fixture.seeded.capsule,
    );
    const heldLeaseHeartbeat = await store.transitionRun({
      id: fixture.apply.id,
      kind: "apply",
      expectFrom: ["running"],
      expectLeaseToken: fixture.lease,
      run: { ...fixture.running, heartbeatAt: 3 },
      heartbeatAt: 3,
    });
    expect(heldLeaseHeartbeat.won, label).toBe(true);
  }
});

test("Restore terminal commit rejects a mismatched Workspace without changing its held lease or state", async () => {
  for (const adapter of await adapters()) {
    const { store, label } = adapter;
    const fixture = await seedRestoreFixture(store, `restore-mismatch-${label}`);
    const otherWorkspace: Workspace = {
      ...fixture.seeded.workspace,
      id: `terminal_restore_other_workspace_${label}`,
      handle: `terminal-restore-other-${label}`,
    };
    await store.putWorkspace(otherWorkspace);
    const restoredState = stateVersion(
      `terminal_restore_mismatch_state_${label}`,
      fixture.seeded.workspace.id,
      fixture.seeded.capsule.id,
      fixture.restore.id,
    );
    const restoredOutput = output(
      `terminal_restore_mismatch_output_${label}`,
      fixture.seeded.workspace.id,
      fixture.seeded.capsule.id,
    );
    const mismatchedRestore = {
      ...fixture.running,
      status: "succeeded" as const,
      workspaceId: otherWorkspace.id,
      restoredStateVersionId: restoredState.id,
      finishedAt: TS,
    } as Run;
    let refused = false;
    try {
      const result = await store.commitRestoredState({
        stateVersion: restoredState,
        output: restoredOutput,
        capsulePatch: {
          id: fixture.seeded.capsule.id,
          patch: {
            currentStateVersionId: restoredState.id,
            currentStateGeneration: restoredState.generation,
            currentOutputId: restoredOutput.id,
            status: "stale",
            updatedAt: TS,
          },
          guard: {
            currentStateVersionId: undefined,
            currentStateGeneration: 0,
            status: "pending",
          },
        },
        restoreRunTerminal: mismatchedRestore,
        restoreRunLeaseToken: fixture.lease,
      });
      refused = result.restoreRunLeaseLost === true;
    } catch {
      refused = true;
    }
    expect(refused, label).toBe(true);
    expect(await store.getBackupRun(fixture.restore.id), label).toEqual(
      fixture.running,
    );
    expect(await store.getStateVersion(restoredState.id), label).toBeUndefined();
    expect(await store.getOutput(restoredOutput.id), label).toBeUndefined();
    expect(await store.getCapsule(fixture.seeded.capsule.id), label).toEqual(
      fixture.seeded.capsule,
    );
    const heldLeaseHeartbeat = await store.transitionRun({
      id: fixture.restore.id,
      kind: "restore",
      expectFrom: ["running"],
      expectLeaseToken: fixture.lease,
      run: { ...fixture.running, heartbeatAt: 3 },
      heartbeatAt: 3,
    });
    expect(heldLeaseHeartbeat.won, label).toBe(true);
  }
});
