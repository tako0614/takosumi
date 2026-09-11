import { afterEach, expect, test } from "bun:test";

import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { BackupRecord } from "takosumi-contract/backups";
import type { Capsule } from "takosumi-contract/capsules";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract";
import type { Output } from "takosumi-contract/outputs";
import type {
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { Run } from "takosumi-contract/runs";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { Workspace } from "takosumi-contract/workspaces";
import {
  APPLY_BILLING_CAPTURE_COMPLETED_EVENT,
  APPLY_BILLING_CAPTURE_PENDING_EVENT,
  APPLY_RUNTIME_SECRET_RETIREMENT_COMPLETED_EVENT,
  APPLY_RUNTIME_SECRET_RETIREMENT_PENDING_EVENT,
  type CommitBackupRunInput,
  type CommitCompatibilityCheckRunInput,
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
  capsuleLifecycleExpected,
  type OpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import {
  createCapsuleInterfaceMaterializationIntent,
  pinCapsuleInterfaceBlueprints,
} from "../../../../core/domains/deploy-control/interface_materialization_intent.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import type {
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { InMemoryGitInstallPlanStore } from "../../../../core/domains/install-plans/store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";

const pgClients: PGliteSqlClient[] = [];

test("Postgres claim loses when the persisted Run Workspace changes after observation", async () => {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const store = new SqlOpenTofuControlStore({ client: pg });
  const active = workspace("claim-active");
  const stopped = workspace("claim-stopped");
  await store.putWorkspace(active);
  await store.putWorkspace(stopped);
  await store.beginWorkspaceDraining(stopped.id, {
    workspaceId: stopped.id,
    managementState: "active",
    managementEpoch: 1,
  });
  const queued = applyRun("claim-workspace-interleaving", active.id);
  await store.beginApplyRun(queued, {
    workspaceId: active.id,
    managementState: "active",
    managementEpoch: 1,
  });
  const changed = { ...queued, workspaceId: stopped.id };
  let interleaved = false;
  const client: SqlClient = {
    query: (statement, parameters) => pg.query(statement, parameters),
    transaction: (callback) => pg.transaction((transaction) => {
      const wrapped: SqlTransaction = {
        transaction: (nested) => transaction.transaction(nested),
        async query<Row extends Record<string, unknown>>(
          statement: string,
          parameters?: SqlParameters,
        ) {
          const result = await transaction.query<Row>(statement, parameters);
          if (
            !interleaved &&
            /select\s+space_id\s+as\s+"workspaceId"\s+from\s+takosumi_runs/u.test(statement)
          ) {
            // Model another writer becoming visible between the claim's
            // initial observation and its guarded UPDATE. Execute real SQL;
            // do not fabricate the observed row or the CAS result.
            interleaved = true;
            await transaction.query(
              "update takosumi_runs set space_id = $1, run_json = $2 where id = $3",
              [stopped.id, JSON.stringify(changed), queued.id],
            );
          }
          return result;
        },
      };
      return callback(wrapped);
    }),
  };
  const claimant = new SqlOpenTofuControlStore({ client });
  const result = await claimant.transitionRun({
    id: queued.id,
    kind: "apply",
    expectFrom: ["queued"],
    setLeaseToken: "stale-workspace-lease",
    run: { ...queued, status: "running" },
  });
  expect(interleaved).toBe(true);
  expect(result).toEqual({ won: false, run: changed });
  expect(await store.getApplyRun(queued.id)).toEqual(changed);
});

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

test("queued Apply retains its original authority across drain and resume", async () => {
  const durable = (await adapters()).filter((adapter) => adapter.resumeManagement !== undefined);
  expect(durable.length).toBe(2);
  for (const adapter of durable) {
    const { store } = adapter;
    const owner = workspace(`apply-original-${adapter.label}`);
    await store.putWorkspace(owner);
    const original = { workspaceId: owner.id, managementState: "active" as const, managementEpoch: 1 };
    const queued = applyRun(`apply-original-${adapter.label}`, owner.id);
    expect((await store.beginApplyRun(queued, original)).status).toBe("created");
    await store.beginWorkspaceDraining(owner.id, original);
    await adapter.resumeManagement!(owner.id);
    const reopened = adapter.reopen();
    const current = await reopened.getWorkspaceManagement(owner.id);
    expect(current?.managementEpoch).toBe(3);
    const claim = await reopened.transitionRun({
      id: queued.id, kind: "apply", expectFrom: ["queued"], setLeaseToken: "stale-apply-claim",
      expectedWorkspaceManagementAuthority: { ...original, managementEpoch: 3 },
      run: { ...queued, status: "running" },
    });
    expect(claim.won).toBe(false);
    expect(await reopened.getApplyRun(queued.id)).toEqual(queued);
  }
});

function workspace(id: string): Workspace {
  return {
    id,
    handle: `ws-${id}`.slice(0, 39),
    displayName: id,
    type: "personal",
    ownerUserId: `owner-${id}`,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

function applyRun(id: string, workspaceId: string, status: ApplyRun["status"] = "queued"): ApplyRun {
  return {
    id,
    planRunId: `plan-${id}`,
    workspaceId,
    operation: "update",
    runnerProfileId: "runner",
    status,
    expected: {
      planRunId: `plan-${id}`,
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
}

function planRun(id: string, workspaceId: string, overrides: Partial<PlanRun> = {}): PlanRun {
  return {
    id,
    workspaceId,
    source: {
      kind: "git",
      url: "https://example.test/freeze.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "runner",
    variablesDigest: "sha256:variables",
    executionInputsDigest: "sha256:inputs",
    requiredProviders: [],
    requiredProviderRequirements: [],
    status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function interfaceBlueprint(key: string): CapsuleInterfaceBlueprint {
  return {
    key,
    name: `interface-${key}`,
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "capsule_output", outputName: "endpoint" },
      },
      access: { visibility: "workspace", resourceUriInput: "endpoint" },
    },
  };
}

function backupRun(
  id: string,
  workspaceId: string,
  overrides: Partial<Run> = {},
): Run {
  return {
    id,
    workspaceId,
    type: "backup",
    status: "running",
    createdBy: "manual",
    createdAt: "2026-09-08T00:00:00.000Z",
    startedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

function compatibilityRun(
  id: string,
  workspaceId: string,
  overrides: Partial<Run> = {},
): Run {
  return {
    id,
    workspaceId,
    sourceId: `source-${workspaceId}`,
    capsuleId: `capsule-${id}`,
    type: "compatibility_check",
    status: "running",
    sourceSnapshotId: `snapshot-${id}`,
    createdBy: "compatibility-test",
    createdAt: "2026-09-08T00:00:00.000Z",
    startedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

function backupRecord(run: Run, id: string): BackupRecord {
  return {
    id,
    workspaceId: run.workspaceId,
    ...(run.capsuleId ? { capsuleId: run.capsuleId } : {}),
    ...(run.environment ? { environment: run.environment } : {}),
    ref: `workspaces/${run.workspaceId}/backups/${id}/control.json.zst.enc`,
    digest: `sha256:${"a".repeat(64)}`,
    sizeBytes: 4_096,
    createdByRunId: run.id,
    createdAt: run.createdAt,
  };
}

function backupSettlementInput(
  expectedRunningRun: Run,
  terminalRun: Run,
  record?: BackupRecord,
): CommitBackupRunInput {
  return {
    expectedRunningRun,
    terminalRun,
    ...(record === undefined ? {} : { record }),
  };
}

function jsonNormalized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

class BackupSettlementFailingSqlClient implements SqlClient {
  #armed = false;
  recordInsertPrecededFinalUpdate = false;

  constructor(private readonly inner: SqlClient) {}

  arm(): void {
    this.#armed = true;
    this.recordInsertPrecededFinalUpdate = false;
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.inner.query<Row>(sql, parameters);
  }

  transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return this.inner.transaction(async (transaction) => {
      let sawBackupRecordInsert = false;
      const handle: SqlTransaction = {
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          parameters?: SqlParameters,
        ): Promise<SqlQueryResult<Row>> => {
          const normalized = sql.trimStart().toLowerCase();
          if (
            normalized.includes("insert into") &&
            normalized.includes("takosumi_backups")
          ) {
            sawBackupRecordInsert = true;
          }
          if (
            this.#armed &&
            sawBackupRecordInsert &&
            normalized.includes("update") &&
            normalized.includes("takosumi_runs")
          ) {
            this.#armed = false;
            this.recordInsertPrecededFinalUpdate = true;
            throw new Error("injected backup terminal update failure");
          }
          return await transaction.query<Row>(sql, parameters);
        },
        transaction: async <Nested>(
          nested: (transaction: SqlTransaction) => Nested | Promise<Nested>,
        ): Promise<Nested> => await nested(handle),
      };
      return await fn(handle);
    });
  }
}

class ReplayRecordMutatingD1 extends SqliteFakeD1 {
  #recordId: string | undefined;

  armRecordMutation(recordId: string): void {
    this.#recordId = recordId;
  }

  override async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const recordId = this.#recordId;
    this.#recordId = undefined;
    if (recordId !== undefined) {
      await this
        .prepare(
          "update backups set record_json = json_set(record_json, '$.digest', ?) where id = ?",
        )
        .bind(`sha256:${"b".repeat(64)}`, recordId)
        .run();
    }
    return await super.batch<T>(statements);
  }
}

function sourceSyncRun(
  id: string,
  workspaceId: string,
  overrides: Partial<SourceSyncRun> = {},
): SourceSyncRun {
  return {
    id,
    kind: "source_sync",
    workspaceId,
    sourceId: `source-${workspaceId}`,
    url: "https://example.com/repository.git",
    ref: "main",
    path: ".",
    archiveRef: `archive-${id}`,
    intent: "observe",
    status: "queued",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    snapshotId: `snapshot-${id}`,
    ...overrides,
  };
}

function capsule(id: string, workspaceId: string): Capsule {
  return {
    id,
    workspaceId,
    projectId: `project-${workspaceId}`,
    name: `capsule-${id}`,
    slug: `capsule-${id}`,
    sourceId: `source-${workspaceId}`,
    installConfigId: `install-config-${id}`,
    environment: "preview",
    currentStateGeneration: 0,
    status: "active",
    autoUpdate: true,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

interface Adapter {
  readonly label: string;
  readonly store: OpenTofuControlStore;
  readonly reopen: () => OpenTofuControlStore;
  readonly database?: ReplayRecordMutatingD1;
  /** Fixture for the not-yet-public abort operation; no production bypass. */
  readonly resumeManagement?: (workspaceId: string) => Promise<void>;
  readonly setStoredSourceSyncAuthority?: (runId: string, value: unknown) => Promise<void>;
  /** Fixture-only raw JSON mutation for persisted numeric representation checks. */
  readonly setStoredRunUpdatedAtNumericOne?: (runId: string) => Promise<void>;
}

async function adapters(): Promise<readonly Adapter[]> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const d1 = new ReplayRecordMutatingD1();
  const memory = new InMemoryOpenTofuControlStore();
  memory.attachGitInstallPlanStore(new InMemoryGitInstallPlanStore(memory));
  return [
    {
      label: "memory",
      store: memory,
      reopen: () => memory,
    },
    {
      label: "postgres",
      store: new SqlOpenTofuControlStore({ client: pgClient }),
      reopen: () => new SqlOpenTofuControlStore({ client: pgClient }),
      async resumeManagement(workspaceId) {
        await pgClient.query(
          "update takosumi_workspaces set management_state = 'active', management_epoch = management_epoch + 1 where id = $1 and management_state = 'draining'",
          [workspaceId],
        );
      },
      async setStoredSourceSyncAuthority(runId, value) {
        await pgClient.query(
          "update takosumi_runs set run_json = (run_json::jsonb - 'workspaceManagementAuthority') || $1::jsonb where id = $2",
          [JSON.stringify(value === undefined ? {} : { workspaceManagementAuthority: value }), runId],
        );
      },
      async setStoredRunUpdatedAtNumericOne(runId) {
        await pgClient.query(
          "update takosumi_runs set run_json = jsonb_set(run_json, '{updatedAt}', '1.0'::jsonb) where id = $1",
          [runId],
        );
      },
    },
    {
      label: "d1",
      store: new CloudflareD1OpenTofuControlStore(d1),
      reopen: () => new CloudflareD1OpenTofuControlStore(d1),
      database: d1,
      async resumeManagement(workspaceId) {
        await d1.prepare(
          "update workspaces set management_state = 'active', management_epoch = management_epoch + 1 where id = ? and management_state = 'draining'",
        ).bind(workspaceId).run();
      },
      async setStoredSourceSyncAuthority(runId, value) {
        if (value === undefined) {
          await d1.prepare("update runs set run_json = json_remove(run_json, '$.workspaceManagementAuthority') where id = ?")
            .bind(runId).run();
        } else {
          await d1.prepare("update runs set run_json = json_set(run_json, '$.workspaceManagementAuthority', json(?)) where id = ?")
            .bind(JSON.stringify(value), runId).run();
        }
      },
    },
  ];
}

test("Workspace management observations cannot change stored admission authority", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`management-snapshot-${label}`);
    await store.putWorkspace(ws);
    const original = { workspaceId: ws.id, managementState: "active" as const, managementEpoch: 1 };
    const observation = (await store.getWorkspaceManagement(ws.id))!;
    Object.assign(observation, { managementState: "released", managementEpoch: 90 });
    expect(await store.getWorkspaceManagement(ws.id), label).toEqual(original);

    for (const expectedStatus of ["started", "existing", "conflict"] as const) {
      const result = await store.beginWorkspaceDraining(ws.id, {
        ...original,
        managementEpoch: expectedStatus === "conflict" ? 2 : 1,
      });
      expect(result.status, label).toBe(expectedStatus);
      if (result.status === "not_found") throw new Error("Workspace disappeared");
      Object.assign(result.management, original);
      expect(await store.getWorkspaceManagement(ws.id), label).toEqual({
        workspaceId: ws.id, managementState: "draining", managementEpoch: 2,
      });
      await expect(store.beginApplyRun(applyRun(`snapshot-${expectedStatus}-${label}`, ws.id), original), label)
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    }
  }
});

test("Workspace draining binds the command epoch before asynchronous storage work", async () => {
  for (const { label, store } of await adapters()) {
    for (const originalEpoch of [42, 1]) {
      const ws = workspace(`drain-command-${label}-${originalEpoch}`);
      await store.putWorkspace(ws);
      const expected = { workspaceId: ws.id, managementState: "active" as const, managementEpoch: originalEpoch };
      const pending = store.beginWorkspaceDraining(ws.id, expected);
      expected.managementEpoch = originalEpoch === 1 ? 42 : 1;
      expect(await pending, label).toEqual(originalEpoch === 1
        ? { status: "started", management: { workspaceId: ws.id, managementState: "draining", managementEpoch: 2 } }
        : { status: "conflict", management: { workspaceId: ws.id, managementState: "active", managementEpoch: 1 } });
      expect(await store.getWorkspaceManagement(ws.id), label).toEqual({
        workspaceId: ws.id,
        managementState: originalEpoch === 1 ? "draining" : "active",
        managementEpoch: originalEpoch === 1 ? 2 : 1,
      });
    }
  }
});

test("Workspace management CAS and guarded admissions are conformed across storage adapters", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`management-${label}`);
    await store.putWorkspace(ws);
    const authority = (await store.getWorkspaceManagement(ws.id))!;
    expect(authority, label).toEqual({
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 1,
    });

    const existing = applyRun(`existing-${label}`, ws.id);
    expect(await store.beginApplyRun(existing, authority), label).toEqual({
      status: "created",
      run: existing,
    });
    const forged = applyRun(`forged-${label}`, ws.id);
    expect(await store.beginApplyRun(forged, authority), label).toEqual({
      status: "created",
      run: forged,
    });
    const otherWorkspace = workspace(`other-${label}`);
    await store.putWorkspace(otherWorkspace);

    // Claim while active so the later heartbeat/finalizer can prove that an
    // existing lease remains valid after the Workspace starts draining.
    const leaseToken = `lease-${label}`;
    const claimedRun = {
      ...existing,
      status: "running" as const,
      startedAt: 2,
      heartbeatAt: 2,
    };
    expect(
      await store.transitionRun({
        id: existing.id,
        kind: "apply",
        expectFrom: ["queued"],
        run: claimedRun,
        setLeaseToken: leaseToken,
      }),
      label,
    ).toEqual({ won: true, run: claimedRun });

    expect(await store.beginWorkspaceDraining(ws.id, authority), label).toEqual({
      status: "started",
      management: {
        workspaceId: ws.id,
        managementState: "draining",
        managementEpoch: 2,
      },
    });
    expect(await store.beginWorkspaceDraining(ws.id, authority), label).toEqual({
      status: "existing",
      management: {
        workspaceId: ws.id,
        managementState: "draining",
        managementEpoch: 2,
      },
    });
    expect(
      await store.beginWorkspaceDraining(ws.id, {
        workspaceId: ws.id,
        managementState: "active",
        managementEpoch: 2,
      }),
      label,
    ).toEqual({
      status: "conflict",
      management: {
        workspaceId: ws.id,
        managementState: "draining",
        managementEpoch: 2,
      },
    });

    const staleTakeover = await store.transitionRun({
      id: existing.id,
      kind: "apply",
      expectFrom: ["running"],
      expectHeartbeatAt: 2,
      run: { ...claimedRun, heartbeatAt: 3 },
      setLeaseToken: `takeover-${label}`,
    });
    expect(staleTakeover, label).toEqual({
      won: false,
      run: claimedRun,
    });

    // Exact existing reads remain idempotent, but every new row is denied even
    // when the optional expected authority is omitted.
    expect(await store.beginApplyRun({ ...existing, updatedAt: 2 }), label).toEqual({
      status: "existing",
      run: claimedRun,
    });
    await expect(
      store.beginApplyRun(applyRun(`new-${label}`, ws.id)),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    await expect(
      store.beginApplyRun(
        applyRun(`cross-${label}`, ws.id),
        {
          workspaceId: `other-${label}`,
          managementState: "active",
          managementEpoch: 1,
        } as WorkspaceManagementAuthority,
      ),
      label,
    ).rejects.toBeInstanceOf(TypeError);

    // Missing Workspace is fail-closed for both transition and CAS begin.
    expect(
      await store.beginWorkspaceDraining(`missing-${label}`, {
        workspaceId: `missing-${label}`,
        managementState: "active",
        managementEpoch: 1,
      }),
      label,
    ).toEqual({ status: "not_found" });
    await expect(
      store.beginApplyRun(applyRun(`missing-run-${label}`, `missing-${label}`)),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);

    // A new lease is denied from the persisted authoritative Workspace row,
    // even when the replacement payload names a different active Workspace.
    const claim = await store.transitionRun({
      id: forged.id,
      kind: "apply",
      expectFrom: ["queued"],
      run: { ...forged, workspaceId: otherWorkspace.id, status: "running" },
      setLeaseToken: `forged-lease-${label}`,
    });
    expect(claim, label).toEqual({ won: false, run: forged });

    const wrongLease = await store.transitionRun({
      id: existing.id,
      kind: "apply",
      expectFrom: ["running"],
      expectLeaseToken: "wrong-lease",
      run: { ...claimedRun, heartbeatAt: 3 },
    });
    expect(wrongLease, label).toEqual({ won: false, run: claimedRun });

    const heartbeat = await store.transitionRun({
      id: existing.id,
      kind: "apply",
      expectFrom: ["running"],
      expectLeaseToken: leaseToken,
      expectHeartbeatAt: 2,
      run: { ...claimedRun, heartbeatAt: 3 },
    });
    expect(heartbeat, label).toEqual({
      won: true,
      run: { ...claimedRun, heartbeatAt: 3 },
    });
    const terminal = await store.transitionRun({
      id: existing.id,
      kind: "apply",
      expectFrom: ["running"],
      expectLeaseToken: leaseToken,
      expectHeartbeatAt: 3,
      run: { ...claimedRun, heartbeatAt: 3, status: "succeeded", finishedAt: 4 },
      clearLeaseToken: true,
    });
    expect(terminal, label).toEqual({
      won: true,
      run: { ...claimedRun, heartbeatAt: 3, status: "succeeded", finishedAt: 4 },
    });
  }
});

test("drain-owned Apply cancellation requires the exact draining Workspace authority", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`drain-cancel-${label}`);
    await store.putWorkspace(ws);
    const original = {
      workspaceId: ws.id,
      managementState: "active" as const,
      managementEpoch: 1,
    };
    const queued = applyRun(`drain-cancel-run-${label}`, ws.id);
    expect(await store.beginApplyRun(queued, original), label).toEqual({
      status: "created",
      run: queued,
    });

    const draining = {
      workspaceId: ws.id,
      managementState: "draining" as const,
      managementEpoch: 2,
    };
    const cancelled: ApplyRun = {
      ...queued,
      status: "cancelled",
      auditEvents: [
        ...queued.auditEvents,
        {
          id: `${queued.id}:apply.cancelled:3`,
          type: "apply.cancelled",
          at: 3,
        },
      ],
      updatedAt: 3,
      finishedAt: 3,
    };
    const cancel = (management: typeof draining) => store.transitionRun({
      id: queued.id,
      kind: "apply",
      expectFrom: ["queued"],
      expectStartedAt: null,
      clearLeaseToken: true,
      expectDrainCancellation: {
        management,
        expectedRun: queued,
      },
      run: cancelled,
    });

    // A drain-owned cancellation cannot be used as an active-work mutation.
    expect(await cancel(draining), label).toEqual({
      won: false,
      run: queued,
    });
    expect(await store.getApplyRun(queued.id), label).toEqual(queued);

    expect(await store.beginWorkspaceDraining(ws.id, original), label).toEqual({
      status: "started",
      management: draining,
    });
    expect(
      await cancel({ ...draining, managementEpoch: 3 }),
      label,
    ).toEqual({
      won: false,
      run: queued,
    });
    expect(await store.getApplyRun(queued.id), label).toEqual(queued);

    expect(await cancel(draining), label).toEqual({
      won: true,
      run: cancelled,
    });
    expect(await store.getApplyRun(queued.id), label).toEqual(cancelled);
    expect(
      await store.getRunManagementAuthority({
        id: queued.id,
        workspaceId: ws.id,
        kind: "apply",
      }),
      label,
    ).toEqual(original);
  }
});

test("durable drain cancellation settles an older admission after resume and re-drain", async () => {
  for (const { label, store, reopen, resumeManagement } of await adapters()) {
    if (resumeManagement === undefined) continue;
    const ws = workspace(`drain-cancel-older-${label}`);
    await store.putWorkspace(ws);
    const original = {
      workspaceId: ws.id,
      managementState: "active" as const,
      managementEpoch: 1,
    };
    const queued = applyRun(`drain-cancel-older-run-${label}`, ws.id);
    expect(await store.beginApplyRun(queued, original), label).toEqual({
      status: "created",
      run: queued,
    });
    expect(await store.beginWorkspaceDraining(ws.id, original), label).toMatchObject({
      status: "started",
      management: { workspaceId: ws.id, managementState: "draining", managementEpoch: 2 },
    });
    await resumeManagement(ws.id);
    const resumed = reopen();
    const resumedAuthority = await resumed.getWorkspaceManagement(ws.id);
    expect(resumedAuthority, label).toEqual({
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 3,
    });
    expect(await resumed.beginWorkspaceDraining(ws.id, resumedAuthority!), label).toMatchObject({
      status: "started",
      management: { workspaceId: ws.id, managementState: "draining", managementEpoch: 4 },
    });
    const draining = {
      workspaceId: ws.id,
      managementState: "draining" as const,
      managementEpoch: 4,
    };
    const cancelled: ApplyRun = {
      ...queued,
      status: "cancelled",
      auditEvents: [
        ...queued.auditEvents,
        {
          id: `${queued.id}:apply.cancelled:3`,
          type: "apply.cancelled",
          at: 3,
        },
      ],
      updatedAt: 3,
      finishedAt: 3,
    };
    expect(
      await resumed.transitionRun({
        id: queued.id,
        kind: "apply",
        expectFrom: ["queued"],
        expectStartedAt: null,
        clearLeaseToken: true,
        expectDrainCancellation: {
          management: draining,
          expectedRun: queued,
        },
        run: cancelled,
      }),
      label,
    ).toEqual({ won: true, run: cancelled });
    expect(await resumed.getApplyRun(queued.id), label).toEqual(cancelled);
    expect(
      await resumed.getRunManagementAuthority({
        id: queued.id,
        workspaceId: ws.id,
        kind: "apply",
      }),
      label,
    ).toEqual(original);
  }
});

test("drain-owned Apply cancellation rejects malformed present timestamps", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`drain-cancel-timestamp-${label}`);
    await store.putWorkspace(ws);
    const original = {
      workspaceId: ws.id,
      managementState: "active" as const,
      managementEpoch: 1,
    };
    const queued = applyRun(`drain-cancel-timestamp-run-${label}`, ws.id);
    expect(await store.beginApplyRun(queued, original), label).toEqual({
      status: "created",
      run: queued,
    });
    const malformed = {
      ...queued,
      updatedAt: "bad" as unknown as number,
    };
    await store.putApplyRun(malformed);
    expect(await store.getApplyRun(queued.id), label).toEqual(malformed);

    const draining = {
      workspaceId: ws.id,
      managementState: "draining" as const,
      managementEpoch: 2,
    };
    expect(await store.beginWorkspaceDraining(ws.id, original), label).toEqual({
      status: "started",
      management: draining,
    });
    const cancelled: ApplyRun = {
      ...malformed,
      status: "cancelled",
      auditEvents: [
        ...malformed.auditEvents,
        {
          id: `${queued.id}:apply.cancelled:3`,
          type: "apply.cancelled",
          at: 3,
        },
      ],
      updatedAt: 3,
      finishedAt: 3,
    };
    await expect(
      Promise.resolve().then(() => store.transitionRun({
        id: queued.id,
        kind: "apply",
        expectFrom: ["queued"],
        expectStartedAt: null,
        clearLeaseToken: true,
        expectDrainCancellation: {
          management: draining,
          expectedRun: malformed,
        },
        run: cancelled,
      })),
      label,
    ).rejects.toBeInstanceOf(TypeError);
    expect(await store.getApplyRun(queued.id), label).toEqual(malformed);
  }
});

test("drain-owned Apply cancellation rejects raw Postgres numeric timestamps", async () => {
  for (const adapter of await adapters()) {
    if (adapter.setStoredRunUpdatedAtNumericOne === undefined) continue;
    const { label, store } = adapter;
    const ws = workspace(`drain-cancel-numeric-${label}`);
    await store.putWorkspace(ws);
    const original = {
      workspaceId: ws.id,
      managementState: "active" as const,
      managementEpoch: 1,
    };
    const queued = applyRun(`drain-cancel-numeric-run-${label}`, ws.id);
    expect(await store.beginApplyRun(queued, original), label).toEqual({
      status: "created",
      run: queued,
    });
    await adapter.setStoredRunUpdatedAtNumericOne(queued.id);
    const malformed = await store.getApplyRun(queued.id);
    expect(malformed, label).toMatchObject({ id: queued.id, updatedAt: 1 });
    if (malformed === undefined) throw new Error("Apply row disappeared");

    const draining = {
      workspaceId: ws.id,
      managementState: "draining" as const,
      managementEpoch: 2,
    };
    expect(await store.beginWorkspaceDraining(ws.id, original), label).toEqual({
      status: "started",
      management: draining,
    });
    const cancelled: ApplyRun = {
      ...malformed,
      status: "cancelled",
      auditEvents: [
        ...malformed.auditEvents,
        {
          id: `${queued.id}:apply.cancelled:3`,
          type: "apply.cancelled",
          at: 3,
        },
      ],
      updatedAt: 3,
      finishedAt: 3,
    };
    expect(
      await store.transitionRun({
        id: queued.id,
        kind: "apply",
        expectFrom: ["queued"],
        expectStartedAt: null,
        clearLeaseToken: true,
        expectDrainCancellation: {
          management: draining,
          expectedRun: malformed,
        },
        run: cancelled,
      }),
      label,
    ).toEqual({
      won: false,
      run: malformed,
    });
    expect(await store.getApplyRun(queued.id), label).toEqual(malformed);
  }
});

test("Workspace freezes an empty draining namespace with CAS parity", async () => {
  for (const { label, store } of await adapters()) {
    const owner = workspace(`freeze-empty-${label}`);
    const unrelated = workspace(`freeze-unrelated-${label}`);
    await store.putWorkspace(owner);
    await store.putWorkspace(unrelated);
    const authority = {
      workspaceId: owner.id,
      managementState: "active" as const,
      managementEpoch: 1,
    };
    const unrelatedAuthority = {
      workspaceId: unrelated.id,
      managementState: "active" as const,
      managementEpoch: 1,
    };
    expect(
      await store.beginApplyRun(
        applyRun(`freeze-unrelated-run-${label}`, unrelated.id),
        unrelatedAuthority,
      ),
      label,
    ).toMatchObject({ status: "created" });

    expect(await store.beginWorkspaceDraining(owner.id, authority), label).toEqual({
      status: "started",
      management: {
        workspaceId: owner.id,
        managementState: "draining",
        managementEpoch: 2,
      },
    });
    const draining = {
      workspaceId: owner.id,
      managementState: "draining" as const,
      managementEpoch: 2,
    };
    expect(
      await store.freezeWorkspaceManagementIfQuiescent(draining),
      label,
    ).toEqual({
      status: "frozen",
      management: {
        workspaceId: owner.id,
        managementState: "frozen",
        managementEpoch: 2,
      },
    });
    expect(
      await store.freezeWorkspaceManagementIfQuiescent(draining),
      label,
    ).toEqual({
      status: "existing",
      management: {
        workspaceId: owner.id,
        managementState: "frozen",
        managementEpoch: 2,
      },
    });
    expect(
      await store.freezeWorkspaceManagementIfQuiescent({
        ...draining,
        managementEpoch: 1,
      }),
      label,
    ).toEqual({
      status: "conflict",
      management: {
        workspaceId: owner.id,
        managementState: "frozen",
        managementEpoch: 2,
      },
    });
    await expect(
      store.beginApplyRun(applyRun(`freeze-after-${label}`, owner.id), authority),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
  }
});

test("Workspace freeze observes terminal Plan, finalizer, and Interface lineage blockers", async () => {
  for (const { label, store } of await adapters()) {
    const drain = async (workspaceId: string) => {
      const current = await store.getWorkspaceManagement(workspaceId);
      if (!current || current.managementState !== "active") {
        throw new Error(`${label}: Workspace is not active`);
      }
      const result = await store.beginWorkspaceDraining(workspaceId, {
        workspaceId,
        managementState: "active",
        managementEpoch: current.managementEpoch,
      });
      expect(result.status, label).toBe("started");
      return {
        workspaceId,
        managementState: "draining" as const,
        managementEpoch: current.managementEpoch + 1,
      };
    };
    const expectFreeze = async (
      draining: { workspaceId: string; managementState: "draining"; managementEpoch: number },
      status: "blocked" | "frozen",
    ) => expect((await store.freezeWorkspaceManagementIfQuiescent(draining)).status, label).toBe(status);

    const legacy = workspace(`freeze-legacy-plan-${label}`);
    await store.putWorkspace(legacy);
    const legacyPlan = planRun(`freeze-legacy-plan-row-${label}`, legacy.id, {
      status: "succeeded",
      requiresApproval: true,
    });
    await store.putPlanRun(legacyPlan);
    const legacyDraining = await drain(legacy.id);
    await expectFreeze(legacyDraining, "blocked");

    const finalizerWorkspace = workspace(`freeze-finalizer-${label}`);
    await store.putWorkspace(finalizerWorkspace);
    const finalizerAuthority = (await store.getWorkspaceManagement(finalizerWorkspace.id))!;
    const finalizerApplyId = `freeze-finalizer-apply-${label}`;
    const finalizerPlan = planRun(`freeze-finalizer-plan-${label}`, finalizerWorkspace.id, {
      capsuleId: `freeze-finalizer-capsule-${label}`,
      capsuleContext: {
        workspaceId: finalizerWorkspace.id,
        capsuleId: `freeze-finalizer-capsule-${label}`,
        environment: "production",
      },
    });
    await store.preparePlanRun({
      run: finalizerPlan,
      inputs: { planRunId: finalizerPlan.id, variables: {} },
      expectedWorkspaceManagementAuthority: finalizerAuthority,
    });
    const finalizerApplyBase = applyRun(finalizerApplyId, finalizerWorkspace.id);
    const finalizerApplyQueued = {
      ...finalizerApplyBase,
      planRunId: finalizerPlan.id,
      capsuleId: finalizerPlan.capsuleId,
      expected: {
        ...finalizerApplyBase.expected,
        planRunId: finalizerPlan.id,
        capsuleId: finalizerPlan.capsuleId,
      },
    } satisfies ApplyRun;
    await store.beginApplyRun(finalizerApplyQueued, finalizerAuthority);
    const finalizerPlanSucceeded: PlanRun = {
      ...finalizerPlan,
      status: "succeeded",
      appliedApplyRunId: finalizerApplyId,
      updatedAt: 2,
    };
    expect(
      (await store.transitionRun({
        id: finalizerPlan.id,
        kind: "plan",
        expectFrom: ["queued"],
        run: finalizerPlanSucceeded,
      })).won,
      label,
    ).toBe(true);
    const pendingFinalizers: ApplyRun = {
      ...finalizerApplyQueued,
      status: "succeeded",
      finishedAt: 4,
      updatedAt: 4,
      auditEvents: [
        { id: "billing-pending", type: APPLY_BILLING_CAPTURE_PENDING_EVENT, at: 2 },
        { id: "retirement-pending", type: APPLY_RUNTIME_SECRET_RETIREMENT_PENDING_EVENT, at: 3 },
      ],
    };
    expect(
      (await store.transitionRun({
        id: finalizerApplyId,
        kind: "apply",
        expectFrom: ["queued"],
        run: pendingFinalizers,
      })).won,
      label,
    ).toBe(true);
    const finalizerDraining = await drain(finalizerWorkspace.id);
    await expectFreeze(finalizerDraining, "blocked");
    const billingFinalized: ApplyRun = {
      ...pendingFinalizers,
      updatedAt: 5,
      auditEvents: [
        ...pendingFinalizers.auditEvents,
        { id: "billing-completed", type: APPLY_BILLING_CAPTURE_COMPLETED_EVENT, at: 5 },
      ],
    };
    expect(
      (await store.transitionRun({
        id: finalizerApplyId,
        kind: "apply",
        expectFrom: ["succeeded"],
        expectExactRun: pendingFinalizers,
        run: billingFinalized,
      })).won,
      label,
    ).toBe(true);
    await expectFreeze(finalizerDraining, "blocked");
    const retirementFinalized: ApplyRun = {
      ...billingFinalized,
      updatedAt: 6,
      auditEvents: [
        ...billingFinalized.auditEvents,
        { id: "retirement-completed", type: APPLY_RUNTIME_SECRET_RETIREMENT_COMPLETED_EVENT, at: 6 },
      ],
    };
    expect(
      (await store.transitionRun({
        id: finalizerApplyId,
        kind: "apply",
        expectFrom: ["succeeded"],
        expectExactRun: billingFinalized,
        run: retirementFinalized,
      })).won,
      label,
    ).toBe(true);
    await expectFreeze(finalizerDraining, "frozen");

    const seeded = await seedCapsuleModel(store, {
      workspaceId: `freeze-interface-${label}`,
      sourceId: `freeze-interface-source-${label}`,
      snapshotId: `freeze-interface-snapshot-${label}`,
      installConfigId: `freeze-interface-config-${label}`,
      capsuleId: `freeze-interface-capsule-${label}`,
    });
    const interfaceApplyId = `freeze-interface-apply-${label}`;
    const interfaceState: StateVersion = {
      id: `freeze-interface-state-${label}`,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      generation: 1,
      stateRef: `state://freeze-interface-${label}`,
      digest: `sha256:${"a".repeat(64)}`,
      createdByRunId: interfaceApplyId,
      createdAt: "2026-09-11T00:00:00.000Z",
    };
    const interfaceOutput: Output = {
      id: `freeze-interface-output-${label}`,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      stateGeneration: 1,
      rawArtifactRef: `output://freeze-interface-${label}`,
      publicOutputs: { endpoint: "https://example.test/mcp" },
      workspaceOutputs: { endpoint: "https://example.test/mcp" },
      outputDigest: `sha256:${"b".repeat(64)}`,
      createdAt: "2026-09-11T00:00:00.000Z",
    };
    const interfaceApplyBase = applyRun(interfaceApplyId, seeded.workspace.id);
    const interfaceApply: ApplyRun = {
      ...interfaceApplyBase,
      planRunId: `freeze-interface-plan-${label}`,
      capsuleId: seeded.capsule.id,
      stateVersionId: interfaceState.id,
      outputId: interfaceOutput.id,
      status: "succeeded",
      startedAt: 1,
      finishedAt: 2,
      expected: {
        ...interfaceApplyBase.expected,
        planRunId: `freeze-interface-plan-${label}`,
        capsuleId: seeded.capsule.id,
      },
    };
    const pinned = await pinCapsuleInterfaceBlueprints({
      installConfigId: seeded.capsule.installConfigId,
      blueprints: [interfaceBlueprint(`freeze-${label}`)],
    });
    const intent = createCapsuleInterfaceMaterializationIntent({
      applyRunId: interfaceApplyId,
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      stateVersionId: interfaceState.id,
      outputId: interfaceOutput.id,
      stateGeneration: 1,
      pinned: pinned!,
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    expect(
      await store.commitRunState({
        stateVersion: interfaceState,
        output: interfaceOutput,
        capsulePatch: {
          id: seeded.capsule.id,
          patch: {
            currentStateVersionId: interfaceState.id,
            currentStateGeneration: 1,
            currentOutputId: interfaceOutput.id,
            status: "active",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
          guard: {
            currentStateVersionId: seeded.capsule.currentStateVersionId,
            status: seeded.capsule.status,
          },
        },
        applyRunTerminal: interfaceApply,
        interfaceMaterializationIntent: intent,
      }),
      label,
    ).toMatchObject({ capsule: { id: seeded.capsule.id } });
    const interfaceDraining = await drain(seeded.workspace.id);
    await expectFreeze(interfaceDraining, "blocked");
    const claimedIntent = await store.claimCapsuleInterfaceMaterializationIntent({
      intentId: intent.id,
      leaseToken: `freeze-interface-lease-${label}`,
      claimedAt: "2026-09-11T00:01:00.000Z",
      leaseExpiresAt: "2026-09-11T01:00:00.000Z",
    });
    expect(claimedIntent?.id, label).toBe(intent.id);
    expect(
      await store.settleCapsuleInterfaceMaterializationIntent({
        id: intent.id,
        leaseToken: `freeze-interface-lease-${label}`,
        expectedNextItemIndex: claimedIntent!.nextItemIndex,
        settledAt: "2026-09-11T00:02:00.000Z",
        outcome: { kind: "completed", disposition: "materialized" },
      }),
      label,
    ).toMatchObject({ kind: "updated", intent: { status: "completed" } });
    await store.putStateVersion({
      ...interfaceState,
      workspaceId: `freeze-interface-malformed-${label}`,
    });
    await expectFreeze(interfaceDraining, "blocked");
    await store.putStateVersion(interfaceState);
    await expectFreeze(interfaceDraining, "frozen");
  }
});

test("Workspace freeze validates Restore StateVersion lineage and scoped source intent", async () => {
  for (const { label, store } of await adapters()) {
    const drain = async (workspaceId: string) => {
      const current = await store.getWorkspaceManagement(workspaceId);
      if (!current || current.managementState !== "active") {
        throw new Error(`${label}: Workspace is not active`);
      }
      const result = await store.beginWorkspaceDraining(workspaceId, {
        workspaceId,
        managementState: "active",
        managementEpoch: current.managementEpoch,
      });
      expect(result.status, label).toBe("started");
      return {
        workspaceId,
        managementState: "draining" as const,
        managementEpoch: current.managementEpoch + 1,
      };
    };
    const stateVersion = (
      id: string,
      workspaceId: string,
      capsuleId: string,
      generation: number,
      createdByRunId: string,
    ): StateVersion => ({
      id,
      workspaceId,
      capsuleId,
      environment: "production",
      generation,
      stateRef: `state://${id}`,
      digest: `sha256:${"a".repeat(64)}`,
      createdByRunId,
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    const succeededRestore = (
      id: string,
      workspaceId: string,
      capsuleId: string,
      sourceStateVersionId: string,
      targetStateVersionId: string,
    ): Run => ({
      id,
      workspaceId,
      capsuleId,
      environment: "production",
      type: "restore",
      status: "succeeded",
      backupId: `backup-${id}`,
      restoreStateGeneration: 1,
      restoredFromStateVersionId: sourceStateVersionId,
      restoredStateVersionId: targetStateVersionId,
      createdBy: "historical-restore",
      createdAt: "2026-09-11T00:00:00.000Z",
      startedAt: "2026-09-11T00:00:01.000Z",
      finishedAt: "2026-09-11T00:00:02.000Z",
    });

    const validWorkspace = workspace(`freeze-restore-valid-${label}`);
    const validCapsuleId = `freeze-restore-valid-capsule-${label}`;
    const validRestoreId = `freeze-restore-valid-run-${label}`;
    const validSource = stateVersion(
      `freeze-restore-valid-source-${label}`,
      validWorkspace.id,
      validCapsuleId,
      1,
      `historical-source-${label}`,
    );
    const validTarget = stateVersion(
      `freeze-restore-valid-target-${label}`,
      validWorkspace.id,
      validCapsuleId,
      2,
      validRestoreId,
    );
    await store.putWorkspace(validWorkspace);
    await store.putStateVersion(validSource);
    await store.putStateVersion(validTarget);
    await store.putBackupRun(
      succeededRestore(
        validRestoreId,
        validWorkspace.id,
        validCapsuleId,
        validSource.id,
        validTarget.id,
      ),
    );
    const validDraining = await drain(validWorkspace.id);
    expect(
      await store.freezeWorkspaceManagementIfQuiescent(validDraining),
      label,
    ).toMatchObject({
      status: "frozen",
      management: { workspaceId: validWorkspace.id, managementEpoch: 2 },
    });

    // Build one real pending source intent in another Workspace. The target
    // Restore's source StateVersion points at that deterministic intent id;
    // the scoped lineage check must not treat the foreign row as absent.
    const foreign = await seedCapsuleModel(store, {
      workspaceId: `freeze-restore-foreign-source-${label}`,
      sourceId: `freeze-restore-foreign-source-ledger-${label}`,
      snapshotId: `freeze-restore-foreign-snapshot-${label}`,
      installConfigId: `freeze-restore-foreign-config-${label}`,
      capsuleId: `freeze-restore-foreign-capsule-${label}`,
    });
    const foreignApplyId = `freeze-restore-foreign-apply-${label}`;
    const foreignState = stateVersion(
      `freeze-restore-foreign-state-${label}`,
      foreign.workspace.id,
      foreign.capsule.id,
      1,
      foreignApplyId,
    );
    const foreignOutput: Output = {
      id: `freeze-restore-foreign-output-${label}`,
      workspaceId: foreign.workspace.id,
      capsuleId: foreign.capsule.id,
      stateGeneration: 1,
      rawArtifactRef: `output://freeze-restore-foreign-${label}`,
      publicOutputs: { endpoint: "https://example.test/mcp" },
      workspaceOutputs: { endpoint: "https://example.test/mcp" },
      outputDigest: `sha256:${"b".repeat(64)}`,
      createdAt: "2026-09-11T00:00:00.000Z",
    };
    const foreignApplyBase = applyRun(foreignApplyId, foreign.workspace.id);
    const foreignApply: ApplyRun = {
      ...foreignApplyBase,
      planRunId: `freeze-restore-foreign-plan-${label}`,
      capsuleId: foreign.capsule.id,
      status: "succeeded",
      startedAt: 1,
      finishedAt: 2,
      stateVersionId: foreignState.id,
      outputId: foreignOutput.id,
      expected: {
        ...foreignApplyBase.expected,
        planRunId: `freeze-restore-foreign-plan-${label}`,
        capsuleId: foreign.capsule.id,
      },
    };
    const pinned = await pinCapsuleInterfaceBlueprints({
      installConfigId: foreign.capsule.installConfigId,
      blueprints: [interfaceBlueprint(`freeze-restore-foreign-${label}`)],
    });
    expect(pinned, label).toBeDefined();
    const foreignIntent = createCapsuleInterfaceMaterializationIntent({
      applyRunId: foreignApplyId,
      workspaceId: foreign.workspace.id,
      capsuleId: foreign.capsule.id,
      stateVersionId: foreignState.id,
      outputId: foreignOutput.id,
      stateGeneration: 1,
      pinned: pinned!,
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    expect(
      await store.commitRunState({
        stateVersion: foreignState,
        output: foreignOutput,
        capsulePatch: {
          id: foreign.capsule.id,
          patch: {
            currentStateVersionId: foreignState.id,
            currentStateGeneration: 1,
            currentOutputId: foreignOutput.id,
            status: "active",
            updatedAt: "2026-09-11T00:00:00.000Z",
          },
          guard: {
            currentStateVersionId: foreign.capsule.currentStateVersionId,
            status: foreign.capsule.status,
          },
        },
        applyRunTerminal: foreignApply,
        interfaceMaterializationIntent: foreignIntent,
      }),
      label,
    ).toMatchObject({ capsule: { id: foreign.capsule.id } });

    const foreignTargetWorkspace = workspace(`freeze-restore-foreign-target-${label}`);
    const foreignTargetCapsuleId = `freeze-restore-foreign-target-capsule-${label}`;
    const foreignTargetRestoreId = `freeze-restore-foreign-target-run-${label}`;
    const foreignSource = stateVersion(
      `freeze-restore-foreign-target-source-${label}`,
      foreignTargetWorkspace.id,
      foreignTargetCapsuleId,
      1,
      foreignApplyId,
    );
    const foreignTarget = stateVersion(
      `freeze-restore-foreign-target-state-${label}`,
      foreignTargetWorkspace.id,
      foreignTargetCapsuleId,
      2,
      foreignTargetRestoreId,
    );
    await store.putWorkspace(foreignTargetWorkspace);
    await store.putStateVersion(foreignSource);
    await store.putStateVersion(foreignTarget);
    await store.putBackupRun(
      succeededRestore(
        foreignTargetRestoreId,
        foreignTargetWorkspace.id,
        foreignTargetCapsuleId,
        foreignSource.id,
        foreignTarget.id,
      ),
    );
    const foreignDraining = await drain(foreignTargetWorkspace.id);
    expect(
      await store.freezeWorkspaceManagementIfQuiescent(foreignDraining),
      label,
    ).toMatchObject({
      status: "blocked",
      management: { workspaceId: foreignTargetWorkspace.id, managementEpoch: 2 },
    });

    const missingWorkspace = workspace(`freeze-restore-missing-${label}`);
    const missingCapsuleId = `freeze-restore-missing-capsule-${label}`;
    const missingRestoreId = `freeze-restore-missing-run-${label}`;
    const missingTarget = stateVersion(
      `freeze-restore-missing-target-${label}`,
      missingWorkspace.id,
      missingCapsuleId,
      2,
      missingRestoreId,
    );
    await store.putWorkspace(missingWorkspace);
    await store.putStateVersion(missingTarget);
    await store.putBackupRun(
      succeededRestore(
        missingRestoreId,
        missingWorkspace.id,
        missingCapsuleId,
        `freeze-restore-missing-source-${label}`,
        missingTarget.id,
      ),
    );
    const missingDraining = await drain(missingWorkspace.id);
    expect(
      await store.freezeWorkspaceManagementIfQuiescent(missingDraining),
      label,
    ).toMatchObject({
      status: "blocked",
      management: { workspaceId: missingWorkspace.id, managementEpoch: 2 },
    });
  }
});

test("manual Backup admission is create-only and rejects stale authority across adapters", async () => {
  for (const { label, store, reopen, resumeManagement } of await adapters()) {
    const ws = workspace(`backup-${label}`);
    await store.putWorkspace(ws);
    const original: WorkspaceManagementAuthority = {
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 1,
    };
    const run = backupRun(`backup-run-${label}`, ws.id);
    expect(await store.beginBackupRun(run, original), label).toEqual({
      status: "created",
      run,
    });

    // A reused Run id is a conflict and cannot adopt or overwrite the
    // caller's replacement payload, even while the authority is still active.
    expect(
      await store.beginBackupRun(
        { ...run, finishedAt: "2026-09-08T00:00:01.000Z", status: "running" },
        original,
      ),
      label,
    ).toEqual({ status: "conflict" });
    expect(await reopen().getBackupRun(run.id), label).toEqual(run);

    expect(await store.beginWorkspaceDraining(ws.id, original), label).toMatchObject({
      status: "started",
      management: { managementState: "draining", managementEpoch: 2 },
    });

    // The management guard runs before the occupied-id check: a stopped
    // Workspace cannot turn an existing Run id into an idempotent bypass.
    await expect(
      reopen().beginBackupRun(run, original),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await reopen().getBackupRun(run.id), label).toEqual(run);

    // Memory has no resume fixture; its draining authority is already stale.
    const staleBeforeResume = backupRun(`backup-stale-draining-${label}`, ws.id);
    await expect(
      reopen().beginBackupRun(staleBeforeResume, original),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await reopen().getBackupRun(staleBeforeResume.id), label).toBeUndefined();

    if (!resumeManagement) continue;
    await resumeManagement(ws.id);
    const resumed = reopen();
    const current = await resumed.getWorkspaceManagement(ws.id);
    expect(current, label).toEqual({
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 3,
    });

    // The original N=1 tuple remains stale after drain/resume (N=3), so it
    // cannot be borrowed to create a fresh manual Backup Run.
    const staleAfterResume = backupRun(`backup-stale-resumed-${label}`, ws.id);
    await expect(
      resumed.beginBackupRun(staleAfterResume, original),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await resumed.getBackupRun(staleAfterResume.id), label).toBeUndefined();

    // A caller with the actual current tuple can create a distinct Run; this
    // proves the stale rejection is epoch-specific rather than a permanent
    // prohibition after a completed resume fixture.
    const fresh = backupRun(`backup-fresh-resumed-${label}`, ws.id);
    expect(await resumed.beginBackupRun(fresh, current!), label).toEqual({
      status: "created",
      run: fresh,
    });
  }
});

test("Compatibility admission is create-only and fences the original Workspace epoch across adapters", async () => {
  for (const { label, store, reopen, resumeManagement } of await adapters()) {
    const ws = workspace(`compatibility-admission-${label}`);
    await store.putWorkspace(ws);
    const original: WorkspaceManagementAuthority = {
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 1,
    };
    const run = compatibilityRun(`compatibility-run-${label}`, ws.id);
    const created = await store.beginCompatibilityCheckRun(run, original);
    expect(created, label).toEqual({ status: "created", run });
    if (created.status !== "created") throw new Error("Compatibility admission did not create");
    expect(Object.prototype.hasOwnProperty.call(created.run, "workspaceManagementAuthority"), label).toBe(false);
    expect(await reopen().getCompatibilityCheckRun(run.id), label).toEqual(run);

    expect(await store.beginWorkspaceDraining(ws.id, original), label).toMatchObject({
      status: "started",
      management: { managementState: "draining", managementEpoch: 2 },
    });

    // An already-admitted analysis may be observed again while the Workspace
    // drains; the original active tuple is the replay fence.
    expect(
      await reopen().beginCompatibilityCheckRun(run, original),
      `${label}: running replay while draining`,
    ).toEqual({ status: "existing", run });

    const absent = compatibilityRun(`compatibility-absent-${label}`, ws.id);
    await expect(
      reopen().beginCompatibilityCheckRun(absent, original),
      `${label}: fresh id while draining`,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await reopen().getCompatibilityCheckRun(absent.id), label).toBeUndefined();

    // Durable adapters expose the resumed N=3 tuple. It must not adopt the
    // old row, even when the caller supplies the current authority under the
    // occupied Run id.
    if (resumeManagement === undefined) continue;
    await resumeManagement(ws.id);
    const resumed = reopen();
    const current = await resumed.getWorkspaceManagement(ws.id);
    expect(current, label).toEqual({
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 3,
    });
    expect(
      await resumed.beginCompatibilityCheckRun(run, current!),
      `${label}: current epoch cannot adopt old run`,
    ).toEqual({ status: "conflict" });
    expect(await resumed.getCompatibilityCheckRun(run.id), label).toEqual(run);
  }
});

test("Compatibility settlement commits an admitted Run and report atomically while draining", async () => {
  for (const { label, store, reopen } of await adapters()) {
    const ws = workspace(`compatibility-settlement-${label}`);
    await store.putWorkspace(ws);
    const authority: WorkspaceManagementAuthority = {
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 1,
    };
    const running = compatibilityRun(
      `compatibility-settlement-${label}`,
      ws.id,
      { capsuleId: undefined },
    );
    expect(
      await store.beginCompatibilityCheckRun(running, authority),
      label,
    ).toEqual({ status: "created", run: running });
    expect(await store.beginWorkspaceDraining(ws.id, authority), label).toMatchObject({
      status: "started",
      management: { managementState: "draining", managementEpoch: 2 },
    });

    const report: CapsuleCompatibilityReport = {
      id: `caprep-settlement-${label}`,
      sourceId: running.sourceId!,
      sourceSnapshotId: running.sourceSnapshotId!,
      level: "ready",
      findings: [
        {
          severity: "info",
          compatibilityImpact: "none",
          code: "settlement-sentinel",
          message: "must remain exact",
        },
      ],
      providerPackages: [],
      rootProviderRequirements: [],
      resources: [],
      dataSources: [],
      provisioners: [],
      createdAt: "2026-09-08T00:00:01.000Z",
    };
    const persistedReport: CapsuleCompatibilityReport = {
      ...report,
      rootModuleVariables: [],
      rootModuleOutputs: [],
    };
    const terminal: Run = {
      ...running,
      status: "succeeded",
      compatibilityReportId: report.id,
      finishedAt: "2026-09-08T00:00:02.000Z",
    };
    const input: CommitCompatibilityCheckRunInput = {
      expectedRunningRun: running,
      terminalRun: terminal,
      report,
    };
    const committed = await store.commitCompatibilityCheckRun(input);
    expect(committed.status, label).toBe("committed");
    if (committed.status !== "committed") throw new Error("Compatibility settlement did not commit");
    expect(jsonNormalized(committed.run), label).toEqual(jsonNormalized(terminal));
    expect(jsonNormalized(committed.report), label).toEqual(jsonNormalized(persistedReport));
    expect(jsonNormalized(await reopen().getCompatibilityCheckRun(running.id)), label).toEqual(
      jsonNormalized(terminal),
    );
    expect(jsonNormalized(await reopen().getCapsuleCompatibilityReport(report.id)), label).toEqual(
      jsonNormalized(persistedReport),
    );

    const replay = await reopen().commitCompatibilityCheckRun(input);
    expect(jsonNormalized(replay), `${label}: exact replay`).toEqual(
      jsonNormalized({ status: "replayed", run: terminal, report: persistedReport }),
    );

    const changedReport: CapsuleCompatibilityReport = {
      ...report,
      findings: [
        {
          ...report.findings[0]!,
          message: "must not overwrite",
        },
      ],
    };
    expect(
      await reopen().commitCompatibilityCheckRun({
        ...input,
        report: changedReport,
      }),
      `${label}: changed report collision`,
    ).toEqual({ status: "conflict" });
    expect(jsonNormalized(await reopen().getCompatibilityCheckRun(running.id)), label).toEqual(
      jsonNormalized(terminal),
    );
    expect(jsonNormalized(await reopen().getCapsuleCompatibilityReport(report.id)), label).toEqual(
      jsonNormalized(persistedReport),
    );
  }
});

test("manual Backup settlement is atomic, replayable, and authority-fenced across adapters", async () => {
  for (const { label, store, reopen, database } of await adapters()) {
    const ws = workspace(`backup-settlement-${label}`);
    await store.putWorkspace(ws);
    const authority: WorkspaceManagementAuthority = {
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 1,
    };

    // Keep optional keys explicitly undefined in the caller payload. Durable
    // JSON storage drops those keys; settlement comparisons must remain exact
    // after that normalization.
    const successfulRunning = backupRun(
      `backup-settlement-success-${label}`,
      ws.id,
      {
        capsuleId: `capsule-${label}`,
        environment: "preview",
        sourceId: undefined,
        planDigest: undefined,
      },
    );
    const failedRunning = backupRun(
      `backup-settlement-failed-${label}`,
      ws.id,
    );
    const collisionRunning = backupRun(
      `backup-settlement-collision-${label}`,
      ws.id,
    );
    for (const run of [successfulRunning, failedRunning, collisionRunning]) {
      expect(
        jsonNormalized(await store.beginBackupRun(run, authority)),
        label,
      ).toEqual(jsonNormalized({ status: "created", run }));
    }

    const failedTerminal: Run = {
      ...failedRunning,
      status: "failed",
      errorCode: "backup_failed",
      finishedAt: "2026-09-08T00:00:02.000Z",
    };
    expect(
      jsonNormalized(
        await store.commitBackupRun(
          backupSettlementInput(failedRunning, failedTerminal),
        ),
      ),
      label,
    ).toEqual(jsonNormalized({ status: "committed", run: failedTerminal }));
    expect(await store.getBackupRecord(failedRunning.id), label).toBeUndefined();
    expect(await store.listBackupRecords(ws.id), label).toEqual([]);
    expect(
      jsonNormalized(
        await reopen().commitBackupRun(
          backupSettlementInput(failedRunning, failedTerminal),
        ),
      ),
      `${label}: failed replay`,
    ).toEqual(jsonNormalized({ status: "replayed", run: failedTerminal }));

    const successRecord: BackupRecord = {
      ...backupRecord(successfulRunning, `backup-record-success-${label}`),
      stateArchive: undefined,
      artifactsManifest: undefined,
      serviceData: undefined,
    };
    const successTerminal: Run = {
      ...successfulRunning,
      status: "succeeded",
      finishedAt: "2026-09-08T00:00:03.000Z",
    };
    expect(await store.beginWorkspaceDraining(ws.id, authority), label).toMatchObject({
      status: "started",
      management: { managementState: "draining", managementEpoch: 2 },
    });

    // Finishing an already-admitted export is allowed while draining; the
    // current Workspace epoch is not consulted at settlement.
    const persisted = reopen();
    expect(
      jsonNormalized(
        await persisted.commitBackupRun(
          backupSettlementInput(successfulRunning, successTerminal, successRecord),
        ),
      ),
      label,
    ).toEqual(
      jsonNormalized({
        status: "committed",
        run: successTerminal,
        record: successRecord,
      }),
    );
    expect(await persisted.getBackupRun(successfulRunning.id), label).toEqual(
      jsonNormalized(successTerminal),
    );
    expect(await persisted.getBackupRecord(successRecord.id), label).toEqual(
      jsonNormalized(successRecord),
    );
    expect(
      jsonNormalized(
        await persisted.commitBackupRun(
          backupSettlementInput(successfulRunning, successTerminal, successRecord),
        ),
      ),
      `${label}: success replay`,
    ).toEqual(
      jsonNormalized({
        status: "replayed",
        run: successTerminal,
        record: successRecord,
      }),
    );

    if (database !== undefined) {
      // The record JSON can change after the observation reads. Replay must
      // fence the exact pre-read JSON and leave both rows untouched.
      const tamperedRecord = {
        ...successRecord,
        digest: `sha256:${"b".repeat(64)}`,
      };
      database.armRecordMutation(successRecord.id);
      expect(
        await reopen().commitBackupRun(
          backupSettlementInput(successfulRunning, successTerminal, successRecord),
        ),
        `${label}: replay record race`,
      ).toEqual({ status: "conflict" });
      expect(await reopen().getBackupRun(successfulRunning.id), label).toEqual(
        jsonNormalized(successTerminal),
      );
      expect(await reopen().getBackupRecord(successRecord.id), label).toEqual(
        jsonNormalized(tamperedRecord),
      );
    }

    // A terminal success cannot be rewritten by a stale failed completion.
    const downgrade: Run = {
      ...successfulRunning,
      status: "failed",
      errorCode: "backup_failed",
      finishedAt: "2026-09-08T00:00:04.000Z",
    };
    expect(
      await persisted.commitBackupRun(
        backupSettlementInput(successfulRunning, downgrade),
      ),
      `${label}: downgrade`,
    ).toEqual({ status: "conflict" });
    expect(await persisted.getBackupRun(successfulRunning.id), label).toEqual(
      jsonNormalized(successTerminal),
    );

    // A pre-existing pointer id is a collision, never an adoption target.
    const collisionRecordId = `backup-record-collision-${label}`;
    const existingCollisionRecord: BackupRecord = {
      ...backupRecord(collisionRunning, collisionRecordId),
      createdByRunId: `unrelated-run-${label}`,
    };
    await persisted.putBackupRecord(existingCollisionRecord);
    const collisionRecord = backupRecord(collisionRunning, collisionRecordId);
    const collisionTerminal: Run = {
      ...collisionRunning,
      status: "succeeded",
      finishedAt: "2026-09-08T00:00:05.000Z",
    };
    expect(
      await persisted.commitBackupRun(
        backupSettlementInput(collisionRunning, collisionTerminal, collisionRecord),
      ),
      `${label}: record collision`,
    ).toEqual({ status: "conflict" });
    expect(await persisted.getBackupRun(collisionRunning.id), label).toEqual(
      jsonNormalized(collisionRunning),
    );
    expect(await persisted.getBackupRecord(collisionRecordId), label).toEqual(
      jsonNormalized(existingCollisionRecord),
    );

    // A raw legacy running row has no private original authority and cannot be
    // completed, even when the caller supplies a structurally valid record.
    const legacyRunning = backupRun(`backup-settlement-legacy-${label}`, ws.id);
    await persisted.putBackupRun(legacyRunning);
    const legacyRecord = backupRecord(
      legacyRunning,
      `backup-record-legacy-${label}`,
    );
    const legacyTerminal: Run = {
      ...legacyRunning,
      status: "succeeded",
      finishedAt: "2026-09-08T00:00:06.000Z",
    };
    expect(
      await persisted.commitBackupRun(
        backupSettlementInput(legacyRunning, legacyTerminal, legacyRecord),
      ),
      `${label}: authorityless legacy`,
    ).toEqual({ status: "conflict" });
    expect(await persisted.getBackupRun(legacyRunning.id), label).toEqual(
      jsonNormalized(legacyRunning),
    );
    expect(await persisted.getBackupRecord(legacyRecord.id), label).toBeUndefined();

    const absentRunning = backupRun(`backup-settlement-absent-${label}`, ws.id);
    const absentRecord = backupRecord(
      absentRunning,
      `backup-record-absent-${label}`,
    );
    const absentTerminal: Run = {
      ...absentRunning,
      status: "succeeded",
      finishedAt: "2026-09-08T00:00:07.000Z",
    };
    expect(
      await persisted.commitBackupRun(
        backupSettlementInput(absentRunning, absentTerminal, absentRecord),
      ),
      `${label}: absent running`,
    ).toEqual({ status: "conflict" });
    expect(await persisted.getBackupRun(absentRunning.id), label).toBeUndefined();
    expect(await persisted.getBackupRecord(absentRecord.id), label).toBeUndefined();
  }
});

test("Postgres Backup settlement rolls back the record when its final Run update fails", async () => {
  const backing = await PGliteSqlClient.create();
  pgClients.push(backing);
  const faulting = new BackupSettlementFailingSqlClient(backing);
  const store = new SqlOpenTofuControlStore({ client: faulting });
  const ws = workspace("backup-settlement-postgres-fault");
  await store.putWorkspace(ws);
  const authority: WorkspaceManagementAuthority = {
    workspaceId: ws.id,
    managementState: "active",
    managementEpoch: 1,
  };
  const running = backupRun("backup-settlement-postgres-fault-run", ws.id);
  expect(await store.beginBackupRun(running, authority)).toEqual({
    status: "created",
    run: running,
  });
  const record = backupRecord(running, "backup-record-postgres-fault");
  const terminal: Run = {
    ...running,
    status: "succeeded",
    finishedAt: "2026-09-08T00:00:02.000Z",
  };
  faulting.arm();

  await expect(
    store.commitBackupRun(
      backupSettlementInput(running, terminal, record),
    ),
  ).rejects.toThrow("injected backup terminal update failure");
  expect(faulting.recordInsertPrecededFinalUpdate).toBe(true);
  expect(await store.getBackupRun(running.id)).toEqual(running);
  expect(await store.getBackupRecord(record.id)).toBeUndefined();

  // The failed transaction left no terminal or pointer residue, so the exact
  // same settlement can be retried after the transient database fault clears.
  expect(
    jsonNormalized(
      await store.commitBackupRun(
        backupSettlementInput(running, terminal, record),
      ),
    ),
  ).toEqual(
    jsonNormalized({ status: "committed", run: terminal, record }),
  );
});

test("Workspace metadata replacement fences stopped and resumed authority without losing concurrent settings", async () => {
  for (const { label, store, reopen, resumeManagement } of await adapters()) {
    const before = workspace(`metadata-cas-${label}`);
    await store.putWorkspace(before);
    const authority: WorkspaceManagementAuthority = {
      workspaceId: before.id, managementState: "active", managementEpoch: 1,
    };
    const changed = { ...before, displayName: "Reviewed name" };
    expect(await store.replaceWorkspace({
      workspace: changed, expectedWorkspace: before, expectedWorkspaceManagementAuthority: authority,
    }), label).toBe(true);
    expect(await store.replaceWorkspace({
      workspace: { ...before, billingSettings: { mode: "showback" } },
      expectedWorkspace: before, expectedWorkspaceManagementAuthority: authority,
    }), label).toBe(false);
    expect(await reopen().getWorkspace(before.id), label).toEqual(changed);
    await store.beginWorkspaceDraining(before.id, authority);
    await expect(store.replaceWorkspace({
      workspace: { ...changed, displayName: "Late name" }, expectedWorkspace: changed,
      expectedWorkspaceManagementAuthority: authority,
    }), label).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    if (resumeManagement) {
      await resumeManagement(before.id);
      await expect(store.replaceWorkspace({
        workspace: { ...changed, displayName: "Late name" }, expectedWorkspace: changed,
        expectedWorkspaceManagementAuthority: authority,
      }), label).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      const service = new WorkspacesService({ store: reopen() });
      expect((await service.updateWorkspace(before.id, { displayName: "Fresh name" })).displayName, label).toBe("Fresh name");
    }
  }
});

test("Workspace member writes recheck actor, target, and original epoch across adapters", async () => {
  for (const { label, store, reopen, resumeManagement } of await adapters()) {
    const service = new WorkspacesService({ store });
    const ws = await service.createWorkspace({
      handle: `member-cas-${label}`, displayName: "Members", type: "personal", ownerUserId: "namespace-owner",
    });
    const actor = await service.upsertWorkspaceMember({
      workspaceId: ws.id, accountId: "administrator", actorAccountId: ws.ownerUserId, roles: ["admin"],
    });
    const target = await service.upsertWorkspaceMember({
      workspaceId: ws.id, accountId: "reader", actorAccountId: ws.ownerUserId, roles: ["member"],
    });
    const authority: WorkspaceManagementAuthority = {
      workspaceId: ws.id, managementState: "active", managementEpoch: 1,
    };
    const input = {
      member: { ...target, roles: ["viewer"] as const }, expectedMember: target,
      expectedActor: actor, expectedWorkspace: ws, expectedWorkspaceManagementAuthority: authority,
    };
    await store.putWorkspaceMember({ ...actor, status: "suspended" });
    expect(await store.mutateWorkspaceMember(input), label).toBe(false);
    expect(await reopen().getWorkspaceMember(ws.id, target.accountId), label).toEqual(target);
    await store.putWorkspaceMember(actor);
    expect(await store.mutateWorkspaceMember(input), label).toBe(true);
    expect(await store.mutateWorkspaceMember({ ...input, member: { ...target, status: "suspended" } }), label).toBe(false);
    const current = (await store.getWorkspaceMember(ws.id, target.accountId))!;
    await store.beginWorkspaceDraining(ws.id, authority);
    await expect(store.mutateWorkspaceMember({ ...input, expectedMember: current }), label)
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    if (resumeManagement) {
      await resumeManagement(ws.id);
      await expect(store.mutateWorkspaceMember({ ...input, expectedMember: current }), label)
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    }
    expect(await reopen().getWorkspaceMember(ws.id, target.accountId), label).toEqual(current);
  }
});

test("Accounts metadata writes fence revoked actors and preserve namespace-owner access", async () => {
  for (const { label, store } of await adapters()) {
    const service = new WorkspacesService({ store });
    const ws = await service.createWorkspace({
      handle: `account-cas-${label}`, displayName: "Account settings", type: "personal", ownerUserId: "namespace-owner",
    });
    const actor = await service.upsertWorkspaceMember({
      workspaceId: ws.id, accountId: "admin", actorAccountId: ws.ownerUserId, roles: ["admin"],
    });
    const authority = await service.captureManagementAuthority(ws.id);
    const input = {
      workspace: { ...ws, displayName: "Updated" }, expectedWorkspace: ws,
      expectedWorkspaceManagementAuthority: authority, actorAccountId: actor.accountId, expectedActor: actor,
    };
    await store.putWorkspaceMember({ ...actor, status: "suspended" });
    expect(await store.replaceWorkspaceForAccount(input), label).toBe(false);
    expect(await store.getWorkspace(ws.id), label).toEqual(ws);
    await store.putWorkspaceMember(actor);
    expect(await store.replaceWorkspaceForAccount(input), label).toBe(true);
    const fresh = workspace(`owner-fallback-${label}`);
    await store.putWorkspace(fresh);
    expect(await store.replaceWorkspaceForAccount({
      workspace: { ...fresh, displayName: "Namespace owner" }, expectedWorkspace: fresh,
      actorAccountId: fresh.ownerUserId,
      expectedWorkspaceManagementAuthority: { workspaceId: fresh.id, managementState: "active", managementEpoch: 1 },
    }), label).toBe(true);
    expect(await store.getWorkspaceMember(fresh.id, fresh.ownerUserId), label).toBeUndefined();
  }
});

test("member writes cannot demote the final active owner after a competing demotion", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`last-owner-${label}`);
    await store.putWorkspace(ws);
    // An imported roster without its derived namespace-owner row still must
    // not lose its last explicit owner through two previously reviewed edits.
    const owners = ["first", "second"].map((accountId) => ({
      id: `owner-${accountId}`, workspaceId: ws.id, accountId,
      roles: ["owner"] as const, status: "active" as const,
      createdAt: ws.createdAt, updatedAt: ws.updatedAt,
    }));
    for (const owner of owners) await store.putWorkspaceMember(owner);
    const inputs = owners.map((owner) => ({
      member: { ...owner, roles: ["member"] as const }, expectedMember: owner, expectedActor: owner,
      expectedWorkspace: ws,
      expectedWorkspaceManagementAuthority: { workspaceId: ws.id, managementState: "active" as const, managementEpoch: 1 },
    }));
    expect(await store.mutateWorkspaceMember(inputs[0]!), label).toBe(true);
    expect(await store.mutateWorkspaceMember(inputs[1]!), label).toBe(false);
    expect(await store.getWorkspaceMember(ws.id, "second"), label).toEqual(owners[1]);
  }
});

test("guarded member writes refuse a candidate the canonical reader cannot decode", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const service = new WorkspacesService({ store });
  const ws = await service.createWorkspace({
    handle: "canonical-owner", displayName: "Owner", type: "personal", ownerUserId: "owner",
  });
  const owner = (await store.getWorkspaceMember(ws.id, "owner"))!;
  const input = {
    expectedWorkspace: ws, expectedActor: owner, expectedMember: owner,
    expectedWorkspaceManagementAuthority: await service.captureManagementAuthority(ws.id),
  };
  await expect(store.mutateWorkspaceMember({ ...input, member: { ...owner, roles: ["owner", "owner"] } }))
    .rejects.toBeInstanceOf(TypeError);
  await expect(store.mutateWorkspaceMember({ ...input, member: { ...owner, updatedAt: "not-a-timestamp" } }))
    .rejects.toBeInstanceOf(TypeError);
  expect(await store.getWorkspaceMember(ws.id, "owner")).toEqual(owner);
});

test("D1 cannot count a corrupt member identity as the remaining active owner", async () => {
  const database = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(database);
  const ws = workspace("corrupt-other-owner");
  await store.putWorkspace(ws);
  const owner = {
    id: "canonical-owner", workspaceId: ws.id, accountId: "first",
    roles: ["owner"] as const, status: "active" as const,
    createdAt: ws.createdAt, updatedAt: ws.updatedAt,
  };
  await store.putWorkspaceMember(owner);
  await store.putWorkspaceMember({ ...owner, id: "corrupt-owner", accountId: "second" });
  await database.prepare("update workspace_members set record_json = json_set(record_json, '$.id', 'different-row') where id = ?")
    .bind("corrupt-owner").run();
  expect(await store.mutateWorkspaceMember({
    member: { ...owner, roles: ["member"] }, expectedMember: owner, expectedActor: owner,
    expectedWorkspace: ws,
    expectedWorkspaceManagementAuthority: { workspaceId: ws.id, managementState: "active", managementEpoch: 1 },
  })).toBe(false);
  expect(await store.getWorkspaceMember(ws.id, owner.accountId)).toEqual(owner);
});

test("private management columns survive Workspace upsert, bootstrap claim, and reopen", async () => {
  for (const { label, store, reopen } of await adapters()) {
    const ws = workspace(`upsert-${label}`);
    await store.putWorkspace(ws);
    const authority = (await store.getWorkspaceManagement(ws.id))!;
    await store.beginWorkspaceDraining(ws.id, authority);
    const updated = { ...ws, displayName: "updated public projection" };
    await store.putWorkspace(updated);
    expect(await store.getWorkspace(updated.id), label).toEqual(updated);
    expect(await store.getWorkspaceManagement(updated.id), label).toEqual({
      workspaceId: updated.id,
      managementState: "draining",
      managementEpoch: 2,
    });

    const candidate = workspace(`bootstrap-${label}`);
    const claimed = await store.claimPersonalWorkspaceBootstrap(
      candidate.ownerUserId,
      candidate,
    );
    expect(claimed, label).toEqual(candidate);
    const candidateAuthority = (await store.getWorkspaceManagement(candidate.id))!;
    expect(candidateAuthority, label).toMatchObject({
      workspaceId: candidate.id,
      managementState: "active",
      managementEpoch: 1,
    });
    await store.beginWorkspaceDraining(candidate.id, candidateAuthority);
    expect(
      await store.claimPersonalWorkspaceBootstrap(candidate.ownerUserId, {
        ...candidate,
        displayName: "ignored replay",
      }),
      label,
    ).toEqual(candidate);
    expect(await reopen().getWorkspaceManagement(candidate.id), label).toEqual({
      workspaceId: candidate.id,
      managementState: "draining",
      managementEpoch: 2,
    });
  }
});

test("SourceSync admission fences new rows and preserves exact retries across adapters", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`source-${label}`);
    await store.putWorkspace(ws);
    const authority = (await store.getWorkspaceManagement(ws.id))!;
    const initial = sourceSyncRun(`source-run-${label}`, ws.id);
    expect(await store.beginSourceSyncRun(initial, authority), label).toEqual({
      status: "created",
      run: initial,
    });
    // Creation must already persist a readable Run, before any transition
    // rewrites its payload. Exact replay is observation, not re-admission.
    expect(await store.getSourceSyncRun(initial.id), label).toEqual(initial);
    expect(await store.beginSourceSyncRun(initial), label).toEqual({
      status: "existing",
      run: initial,
    });

    const claimed: SourceSyncRun = {
      ...initial,
      status: "running",
      startedAt: "2026-09-08T00:00:01.000Z",
      heartbeatAt: 1,
      updatedAt: "2026-09-08T00:00:01.000Z",
    };
    expect(
      await store.transitionRun({
        id: initial.id,
        kind: "source_sync",
        expectFrom: ["queued"],
        run: claimed,
        setLeaseToken: `source-lease-${label}`,
      }),
      label,
    ).toEqual({ won: true, run: claimed });

    expect(await store.beginWorkspaceDraining(ws.id, authority), label).toEqual({
      status: "started",
      management: {
        workspaceId: ws.id,
        managementState: "draining",
        managementEpoch: 2,
      },
    });

    // Mutable status/evidence changes in a retry candidate do not overwrite
    // the durable row or its lease/evidence while the Workspace drains.
    expect(
      await store.beginSourceSyncRun(
        {
          ...initial,
          status: "failed",
          updatedAt: "2026-09-08T00:00:02.000Z",
          finishedAt: "2026-09-08T00:00:02.000Z",
          errorCode: "retry-candidate",
        },
        authority,
      ),
      label,
    ).toEqual({ status: "existing", run: claimed });
    expect(await store.getSourceSyncRun(initial.id), label).toEqual(claimed);

    await expect(
      store.beginSourceSyncRun(sourceSyncRun(`source-new-${label}`, ws.id)),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    await expect(
      store.beginSourceSyncRun(sourceSyncRun(`source-new-expected-${label}`, ws.id), authority),
      label,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);

    expect(
      await store.beginSourceSyncRun({
        ...initial,
        sourceId: "source-different",
      }),
      label,
    ).toEqual({ status: "conflict" });

    // The already-held lease can still finalize after draining; the expected
    // active authority is only an optional stale-transition fence.
    const terminal: SourceSyncRun = {
      ...claimed,
      status: "failed",
      finishedAt: "2026-09-08T00:00:03.000Z",
      updatedAt: "2026-09-08T00:00:03.000Z",
    };
    expect(
      await store.transitionRun({
        id: claimed.id,
        kind: "source_sync",
        expectFrom: ["running"],
        expectLeaseToken: `source-lease-${label}`,
        run: terminal,
        clearLeaseToken: true,
      }),
      label,
    ).toEqual({ won: true, run: terminal });

    const staleAuthorityRun = sourceSyncRun(`source-stale-${label}`, ws.id);
    // Seed through the raw path to model a pre-existing queue item created
    // before the Workspace began draining.
    await store.putSourceSyncRun(staleAuthorityRun);
    expect(
      await store.transitionRun({
        id: staleAuthorityRun.id,
        kind: "source_sync",
        expectFrom: ["queued"],
        run: { ...staleAuthorityRun, status: "running" },
        expectedWorkspaceManagementAuthority: authority,
      }),
      label,
    ).toEqual({ won: false, run: staleAuthorityRun });
  }
});

test("SourceSync retains its original authority through public rewrites and cannot borrow a resumed epoch", async () => {
  for (const { label, store, reopen, resumeManagement } of await adapters()) {
    if (!resumeManagement) continue;
    const ws = workspace(`source-epoch-${label}`);
    await store.putWorkspace(ws);
    const authority: WorkspaceManagementAuthority = {
      workspaceId: ws.id, managementState: "active", managementEpoch: 1,
    };
    const currentAuthority: WorkspaceManagementAuthority = { ...authority, managementEpoch: 3 };
    const queued = sourceSyncRun(`source-epoch-run-${label}`, ws.id);
    expect(await store.beginSourceSyncRun(queued, authority), label).toEqual({ status: "created", run: queued });
    // A public read/modify/write must preserve storage-owned original authority
    // even if the input attempts to replace it with the future active epoch.
    expect(await store.putSourceSyncRun({ ...queued, workspaceManagementAuthority: currentAuthority } as SourceSyncRun), label)
      .toEqual(queued);
    const observed = { ...queued, updatedAt: "2026-09-08T00:00:01.000Z" };
    expect(await store.transitionRun({
      id: queued.id, kind: "source_sync", expectFrom: ["queued"], run: observed,
    }), label).toEqual({ won: true, run: observed });
    expect(await reopen().listSourceSyncRuns(queued.sourceId), label).toEqual([observed]);
    expect(await reopen().listRunsByWorkspace(ws.id), label).toEqual([observed]);
    expect(await reopen().listRecoverableOpenTofuRuns({
      staleQueuedBeforeMs: Date.parse("2026-09-09T00:00:00.000Z"),
      staleRunningBeforeMs: Date.parse("2026-09-09T00:00:00.000Z"),
    }), label).toEqual([observed]);

    await store.beginWorkspaceDraining(ws.id, authority);
    await resumeManagement(ws.id);
    const resumed = reopen();
    expect(await resumed.getWorkspaceManagement(ws.id), label).toEqual(currentAuthority);
    expect(await resumed.beginSourceSyncRun(queued), label).toEqual({ status: "existing", run: observed });
    for (const expectedWorkspaceManagementAuthority of [undefined, currentAuthority]) {
      expect(await resumed.transitionRun({
        id: queued.id, kind: "source_sync", expectFrom: ["queued"],
        run: { ...observed, status: "running" }, setLeaseToken: `stale-${label}`,
        expectedWorkspaceManagementAuthority,
      }), label).toEqual({ won: false, run: observed });
    }
    const fresh = sourceSyncRun(`source-epoch-fresh-${label}`, ws.id);
    await expect(resumed.beginSourceSyncRun(fresh), label)
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    await expect(resumed.beginSourceSyncRun(fresh, authority), label)
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await resumed.beginSourceSyncRun(fresh, currentAuthority), label)
      .toEqual({ status: "created", run: fresh });
    const running = { ...fresh, status: "running" as const };
    expect(await resumed.transitionRun({
      id: fresh.id, kind: "source_sync", expectFrom: ["queued"],
      run: running, setLeaseToken: `fresh-${label}`,
    }), label).toEqual({ won: true, run: running });
  }
});

test("SourceSync stale replacement requires the stored authority on durable adapters", async () => {
  for (const { label, store, reopen, resumeManagement } of await adapters()) {
    const ws = workspace(`source-replace-${label}`);
    await store.putWorkspace(ws);
    const originalAuthority: WorkspaceManagementAuthority = {
      workspaceId: ws.id,
      managementState: "active",
      managementEpoch: 1,
    };
    const queued = sourceSyncRun(`source-replace-run-${label}`, ws.id);
    expect(
      await store.beginSourceSyncRun(queued, originalAuthority),
      label,
    ).toEqual({ status: "created", run: queued });
    const leaseToken = `source-replace-lease-${label}`;
    const running: SourceSyncRun = {
      ...queued,
      status: "running",
      startedAt: "2026-09-08T00:00:01.000Z",
      heartbeatAt: 1,
      updatedAt: "2026-09-08T00:00:01.000Z",
    };
    expect(
      await store.transitionRun({
        id: queued.id,
        kind: "source_sync",
        expectFrom: ["queued"],
        run: running,
        setLeaseToken: leaseToken,
        heartbeatAt: running.heartbeatAt,
      }),
      label,
    ).toEqual({ won: true, run: running });

    // Memory has no reopen/resume seam yet; the actual durable adapters use
    // their existing raw-fixture resume to advance N=1 -> draining N+1 -> N+2.
    if (resumeManagement) {
      expect(
        await store.beginWorkspaceDraining(ws.id, originalAuthority),
        label,
      ).toMatchObject({
        status: "started",
        management: {
          workspaceId: ws.id,
          managementState: "draining",
          managementEpoch: 2,
        },
      });
      await resumeManagement(ws.id);
      const resumed = reopen();
      const currentAuthority = await resumed.getWorkspaceManagement(ws.id);
      expect(currentAuthority, label).toEqual({
        workspaceId: ws.id,
        managementState: "active",
        managementEpoch: 3,
      });
      const failed: SourceSyncRun = {
        ...running,
        status: "failed",
        finishedAt: "2026-09-08T00:00:02.000Z",
        heartbeatAt: 2,
        updatedAt: "2026-09-08T00:00:02.000Z",
        error: "stale_source_sync_replaced",
      };
      expect(
        await resumed.transitionRun({
          id: running.id,
          kind: "source_sync",
          expectFrom: ["running"],
          expectLeaseToken: leaseToken,
          expectHeartbeatAt: running.heartbeatAt,
          run: failed,
          clearLeaseToken: true,
          heartbeatAt: failed.heartbeatAt,
          expectedWorkspaceManagementAuthority: currentAuthority!,
          requireStoredManagementAuthority: true,
        }),
        label,
      ).toEqual({ won: false, run: running });
      expect(await resumed.getSourceSyncRun(running.id), label).toEqual(running);

      // A held lease remains usable for the completion path after the guarded
      // stale-replacement attempt loses; this proves the failed CAS did not
      // clear or replace the original lease.
      const heartbeat: SourceSyncRun = {
        ...running,
        heartbeatAt: 2,
        updatedAt: "2026-09-08T00:00:02.500Z",
      };
      expect(
        await resumed.transitionRun({
          id: running.id,
          kind: "source_sync",
          expectFrom: ["running"],
          expectLeaseToken: leaseToken,
          expectHeartbeatAt: running.heartbeatAt,
          run: heartbeat,
          heartbeatAt: heartbeat.heartbeatAt,
        }),
        label,
      ).toEqual({ won: true, run: heartbeat });
    }

    // Same-epoch stale terminalization remains valid when the stored tuple
    // matches the active caller authority, including the strict flag. Use a
    // separate Workspace because the durable case above has already resumed
    // this one to N+2.
    const sameEpochWorkspace = workspace(`source-replace-same-${label}`);
    await store.putWorkspace(sameEpochWorkspace);
    const sameEpochAuthority: WorkspaceManagementAuthority = {
      workspaceId: sameEpochWorkspace.id,
      managementState: "active",
      managementEpoch: 1,
    };
    const sameEpochQueued = sourceSyncRun(
      `source-replace-same-run-${label}`,
      sameEpochWorkspace.id,
    );
    expect(
      await store.beginSourceSyncRun(sameEpochQueued, sameEpochAuthority),
      label,
    ).toEqual({ status: "created", run: sameEpochQueued });
    const sameEpochLease = `source-replace-same-lease-${label}`;
    const sameEpochRunning: SourceSyncRun = {
      ...sameEpochQueued,
      status: "running",
      startedAt: "2026-09-08T00:01:01.000Z",
      heartbeatAt: 1,
      updatedAt: "2026-09-08T00:01:01.000Z",
    };
    expect(
      await store.transitionRun({
        id: sameEpochQueued.id,
        kind: "source_sync",
        expectFrom: ["queued"],
        run: sameEpochRunning,
        setLeaseToken: sameEpochLease,
        heartbeatAt: sameEpochRunning.heartbeatAt,
      }),
      label,
    ).toEqual({ won: true, run: sameEpochRunning });
    const sameEpochFailed: SourceSyncRun = {
      ...sameEpochRunning,
      status: "failed",
      finishedAt: "2026-09-08T00:01:02.000Z",
      heartbeatAt: 2,
      updatedAt: "2026-09-08T00:01:02.000Z",
      error: "stale_source_sync_replaced",
    };
    expect(
      await store.transitionRun({
        id: sameEpochRunning.id,
        kind: "source_sync",
        expectFrom: ["running"],
        expectLeaseToken: sameEpochLease,
        expectHeartbeatAt: sameEpochRunning.heartbeatAt,
        run: sameEpochFailed,
        clearLeaseToken: true,
        heartbeatAt: sameEpochFailed.heartbeatAt,
        expectedWorkspaceManagementAuthority: sameEpochAuthority,
        requireStoredManagementAuthority: true,
      }),
      label,
    ).toEqual({ won: true, run: sameEpochFailed });
    expect(await store.getSourceSyncRun(sameEpochRunning.id), label).toEqual(
      sameEpochFailed,
    );
  }
});

test("SourceSync legacy rows cannot gain authority from raw writes or a current caller", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`source-legacy-${label}`);
    await store.putWorkspace(ws);
    const authority: WorkspaceManagementAuthority = {
      workspaceId: ws.id, managementState: "active", managementEpoch: 1,
    };
    const queued = sourceSyncRun(`source-legacy-run-${label}`, ws.id);
    await expect(store.beginSourceSyncRun(queued), label)
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await store.putSourceSyncRun({ ...queued, workspaceManagementAuthority: authority } as SourceSyncRun), label)
      .toEqual(queued);
    expect(await store.beginSourceSyncRun(queued, authority), label)
      .toEqual({ status: "existing", run: queued });
    for (const expectedWorkspaceManagementAuthority of [undefined, authority]) {
      expect(await store.transitionRun({
        id: queued.id, kind: "source_sync", expectFrom: ["queued"],
        run: { ...queued, status: "running" }, setLeaseToken: `legacy-${label}`,
        expectedWorkspaceManagementAuthority,
      }), label).toEqual({ won: false, run: queued });
    }
  }
});

test("SourceSync corrupt stored authority denies fresh leases while historical held leases can finish", async () => {
  for (const { label, store, reopen, setStoredSourceSyncAuthority } of await adapters()) {
    if (!setStoredSourceSyncAuthority) continue;
    const ws = workspace(`source-corrupt-${label}`);
    await store.putWorkspace(ws);
    const authority: WorkspaceManagementAuthority = {
      workspaceId: ws.id, managementState: "active", managementEpoch: 1,
    };
    const queued = sourceSyncRun(`source-corrupt-run-${label}`, ws.id);
    await store.beginSourceSyncRun(queued, authority);
    for (const value of [undefined, null, [], { ...authority, managementEpoch: "1" },
      { ...authority, managementEpoch: 0 }, { ...authority, managementEpoch: 1.5 },
      { ...authority, workspaceId: "another-workspace" }, { ...authority, managementState: "released" }]) {
      await setStoredSourceSyncAuthority(queued.id, value);
      expect(await reopen().getSourceSyncRun(queued.id), label).toEqual(queued);
      expect(await reopen().transitionRun({
        id: queued.id, kind: "source_sync", expectFrom: ["queued"],
        run: { ...queued, status: "running" }, setLeaseToken: `corrupt-${label}`,
      }), label).toEqual({ won: false, run: queued });
    }

    const held = sourceSyncRun(`source-held-legacy-${label}`, ws.id);
    await store.beginSourceSyncRun(held, authority);
    const running = { ...held, status: "running" as const, heartbeatAt: 1 };
    expect(await store.transitionRun({
      id: held.id, kind: "source_sync", expectFrom: ["queued"],
      run: running, setLeaseToken: `held-${label}`,
    }), label).toEqual({ won: true, run: running });
    await setStoredSourceSyncAuthority(held.id, undefined);
    await store.beginWorkspaceDraining(ws.id, authority);
    const heartbeat = { ...running, heartbeatAt: 2 };
    expect(await reopen().transitionRun({
      id: held.id, kind: "source_sync", expectFrom: ["running"],
      expectLeaseToken: `held-${label}`, run: heartbeat, heartbeatAt: 2,
    }), label).toEqual({ won: true, run: heartbeat });
    const terminal = { ...heartbeat, status: "failed" as const };
    expect(await reopen().transitionRun({
      id: held.id, kind: "source_sync", expectFrom: ["running"],
      expectLeaseToken: `held-${label}`, run: terminal, clearLeaseToken: true,
    }), label).toEqual({ won: true, run: terminal });
  }
});

test("SourceSync held-lease and raw writers cannot change the stored Run owner or kind", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`source-owner-${label}`);
    const other = workspace(`source-other-owner-${label}`);
    await store.putWorkspace(ws);
    await store.putWorkspace(other);
    const authority: WorkspaceManagementAuthority = {
      workspaceId: ws.id, managementState: "active", managementEpoch: 1,
    };
    const queued = sourceSyncRun(`source-owner-run-${label}`, ws.id);
    await store.beginSourceSyncRun(queued, authority);
    const running = { ...queued, status: "running" as const };
    expect(await store.transitionRun({
      id: queued.id, kind: "source_sync", expectFrom: ["queued"],
      run: running, setLeaseToken: `owner-lease-${label}`,
    }), label).toEqual({ won: true, run: running });
    for (const run of [
      { ...running, workspaceId: other.id },
      { ...running, id: `another-run-${label}` },
      applyRun(queued.id, ws.id, "running"),
    ]) {
      expect(await store.transitionRun({
        id: queued.id, kind: "source_sync", expectFrom: ["running"],
        expectLeaseToken: `owner-lease-${label}`, run,
      }), label).toEqual({ won: false, run: running });
    }
    await expect(store.putSourceSyncRun({ ...queued, workspaceId: other.id }), label)
      .rejects.toBeInstanceOf(TypeError);
    await expect(store.putSourceSyncRun(applyRun(queued.id, ws.id, "running") as unknown as SourceSyncRun), label)
      .rejects.toBeInstanceOf(TypeError);
    expect(await store.getSourceSyncRun(queued.id), label).toEqual(running);
    expect(await store.listRunsByWorkspace(other.id), label).toEqual([]);
  }
});

test("D1 historical double-encoded SourceSync JSON remains observable without new authority", async () => {
  const database = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(database);
  const ws = workspace("source-double-encoded");
  await store.putWorkspace(ws);
  const authority: WorkspaceManagementAuthority = {
    workspaceId: ws.id, managementState: "active", managementEpoch: 1,
  };
  const queued = sourceSyncRun("source-double-encoded-run", ws.id);
  await store.beginSourceSyncRun(queued, authority);
  // Exact historical payload produced by the old jsonText-mode insert.
  const encoded = JSON.stringify(JSON.stringify(queued));
  await database.prepare("update runs set run_json = ? where id = ?").bind(encoded, queued.id).run();
  const reopened = new CloudflareD1OpenTofuControlStore(database);
  expect(await reopened.getSourceSyncRun(queued.id)).toEqual(queued);
  expect(await reopened.listSourceSyncRuns(queued.sourceId)).toEqual([queued]);
  expect(await reopened.listRunsByWorkspace(ws.id)).toEqual([queued]);
  expect(await reopened.beginSourceSyncRun(queued)).toEqual({ status: "existing", run: queued });
  expect(await reopened.transitionRun({
    id: queued.id, kind: "source_sync", expectFrom: ["queued"],
    run: { ...queued, status: "running" }, setLeaseToken: "legacy-double-lease",
    expectedWorkspaceManagementAuthority: authority,
  })).toEqual({ won: false, run: queued });
  expect(await database.prepare("select run_json as payload from runs where id = ?").bind(queued.id).first())
    .toEqual({ payload: encoded });
});

test("D1 historical double-encoded SourceSync held leases finish without authority metadata", async () => {
  const database = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(database);
  const ws = workspace("source-double-held");
  await store.putWorkspace(ws);
  const authority: WorkspaceManagementAuthority = {
    workspaceId: ws.id,
    managementState: "active",
    managementEpoch: 1,
  };
  const queued = sourceSyncRun("source-double-held-run", ws.id);
  await store.beginSourceSyncRun(queued, authority);
  const running: SourceSyncRun = {
    ...queued,
    status: "running",
    startedAt: "2026-09-08T00:00:01.000Z",
    heartbeatAt: 1,
    updatedAt: "2026-09-08T00:00:01.000Z",
  };
  expect(
    await store.transitionRun({
      id: running.id,
      kind: "source_sync",
      expectFrom: ["queued"],
      run: running,
      setLeaseToken: "legacy-held-lease",
    }),
  ).toEqual({ won: true, run: running });

  // This is the historical row shape: one extra JSON string layer and no
  // storage-owned authority metadata. Keep the physical lease columns intact.
  const encoded = JSON.stringify(JSON.stringify(running));
  await database
    .prepare("update runs set run_json = ? where id = ?")
    .bind(encoded, running.id)
    .run();
  expect(
    await database
      .prepare("select status, lease_token, run_json from runs where id = ?")
      .bind(running.id)
      .first(),
  ).toEqual({
    status: "running",
    lease_token: "legacy-held-lease",
    run_json: encoded,
  });

  const reopened = new CloudflareD1OpenTofuControlStore(database);
  expect(await reopened.getSourceSyncRun(running.id)).toEqual(running);

  // A malformed inner string is not a second supported encoding. The guarded
  // SQL must fail closed without relying on SQLite AND/OR evaluation order.
  await database
    .prepare("update runs set run_json = ? where id = ?")
    .bind(JSON.stringify("{invalid-inner"), running.id)
    .run();
  expect(
    await reopened.transitionRun({
      id: running.id,
      kind: "source_sync",
      expectFrom: ["running"],
      expectLeaseToken: "legacy-held-lease",
      run: running,
    }),
  ).toEqual({ won: false });
  await database
    .prepare("update runs set run_json = ? where id = ?")
    .bind(encoded, running.id)
    .run();

  // Missing original authority closes only fresh admission; it must not let a
  // resumed/current tuple be borrowed or backfilled into the legacy row.
  expect(
    await reopened.transitionRun({
      id: running.id,
      kind: "source_sync",
      expectFrom: ["running"],
      run: running,
      setLeaseToken: "fresh-lease-must-deny",
    }),
  ).toEqual({ won: false, run: running });

  expect(await reopened.beginWorkspaceDraining(ws.id, authority)).toMatchObject({
    status: "started",
    management: { managementState: "draining", managementEpoch: 2 },
  });
  const heartbeat: SourceSyncRun = {
    ...running,
    heartbeatAt: 2,
    updatedAt: "2026-09-08T00:00:02.000Z",
  };
  expect(
    await reopened.transitionRun({
      id: running.id,
      kind: "source_sync",
      expectFrom: ["running"],
      expectLeaseToken: "legacy-held-lease",
      run: heartbeat,
      heartbeatAt: heartbeat.heartbeatAt,
    }),
  ).toEqual({ won: true, run: heartbeat });

  // Re-encode the heartbeat to keep the terminal CAS on the historical shape
  // too; the prior heartbeat intentionally exercises the same held lease.
  const terminal: SourceSyncRun = {
    ...heartbeat,
    status: "succeeded",
    finishedAt: "2026-09-08T00:00:03.000Z",
    updatedAt: "2026-09-08T00:00:03.000Z",
    resolvedCommit: "legacy-double-commit",
    archiveDigest: "sha256:legacy-double-commit",
    archiveSizeBytes: 128,
    snapshotId: "snapshot-source-double-held",
  };
  const terminalLegacyPayload = JSON.stringify(JSON.stringify(heartbeat));
  await database
    .prepare("update runs set run_json = ? where id = ?")
    .bind(terminalLegacyPayload, running.id)
    .run();
  const snapshot: SourceSnapshot = {
    id: terminal.snapshotId!,
    origin: "git",
    workspaceId: ws.id,
    sourceId: terminal.sourceId,
    url: terminal.url,
    ref: terminal.ref,
    resolvedCommit: terminal.resolvedCommit!,
    path: terminal.path,
    archiveRef: terminal.archiveRef,
    archiveDigest: terminal.archiveDigest!,
    archiveSizeBytes: terminal.archiveSizeBytes!,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: { status: "ready", scopePath: ".", modules: [] },
    fetchedByRunId: terminal.id,
    fetchedAt: terminal.finishedAt!,
  };
  expect(
    await reopened.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: "legacy-held-lease",
      snapshot,
    }),
  ).toEqual({ won: true, run: terminal });
  expect(await reopened.getSourceSyncRun(running.id)).toEqual(terminal);
  expect(await reopened.getSourceSnapshot(snapshot.id)).toEqual(snapshot);
  expect(
    await database
      .prepare(
        "select json_extract(run_json, '$.workspaceManagementAuthority') as authority from runs where id = ?",
      )
      .bind(running.id)
      .first(),
  ).toEqual({ authority: null });
});

test("D1 historical double-encoded SourceSync preserves its private authority on held-lease rewrites", async () => {
  const database = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(database);
  const ws = workspace("source-double-private");
  await store.putWorkspace(ws);
  const authority: WorkspaceManagementAuthority = {
    workspaceId: ws.id,
    managementState: "active",
    managementEpoch: 1,
  };
  const queued = sourceSyncRun("source-double-private-run", ws.id);
  await store.beginSourceSyncRun(queued, authority);
  const running: SourceSyncRun = {
    ...queued,
    status: "running",
    startedAt: "2026-09-08T00:00:01.000Z",
    heartbeatAt: 1,
    updatedAt: "2026-09-08T00:00:01.000Z",
  };
  expect(
    await store.transitionRun({
      id: running.id,
      kind: "source_sync",
      expectFrom: ["queued"],
      run: running,
      setLeaseToken: "legacy-private-lease",
    }),
  ).toEqual({ won: true, run: running });

  const storedRunning = { ...running, workspaceManagementAuthority: authority };
  await database
    .prepare("update runs set run_json = ? where id = ?")
    .bind(JSON.stringify(JSON.stringify(storedRunning)), running.id)
    .run();
  const reopened = new CloudflareD1OpenTofuControlStore(database);
  expect(await reopened.getSourceSyncRun(running.id)).toEqual(running);
  await reopened.beginWorkspaceDraining(ws.id, authority);

  const heartbeat: SourceSyncRun = {
    ...running,
    heartbeatAt: 2,
    updatedAt: "2026-09-08T00:00:02.000Z",
  };
  expect(
    await reopened.transitionRun({
      id: running.id,
      kind: "source_sync",
      expectFrom: ["running"],
      expectLeaseToken: "legacy-private-lease",
      run: heartbeat,
      heartbeatAt: heartbeat.heartbeatAt,
    }),
  ).toEqual({ won: true, run: heartbeat });
  expect(
    await database
      .prepare(
        "select json_extract(run_json, '$.workspaceManagementAuthority.managementEpoch') as epoch from runs where id = ?",
      )
      .bind(running.id)
      .first(),
  ).toEqual({ epoch: 1 });

  const terminal: SourceSyncRun = {
    ...heartbeat,
    status: "succeeded",
    finishedAt: "2026-09-08T00:00:03.000Z",
    updatedAt: "2026-09-08T00:00:03.000Z",
    resolvedCommit: "legacy-private-commit",
    archiveDigest: "sha256:legacy-private-commit",
    archiveSizeBytes: 128,
    snapshotId: "snapshot-source-double-private",
  };
  const storedHeartbeat = { ...heartbeat, workspaceManagementAuthority: authority };
  await database
    .prepare("update runs set run_json = ? where id = ?")
    .bind(JSON.stringify(JSON.stringify(storedHeartbeat)), running.id)
    .run();
  const snapshot: SourceSnapshot = {
    id: terminal.snapshotId!,
    origin: "git",
    workspaceId: ws.id,
    sourceId: terminal.sourceId,
    url: terminal.url,
    ref: terminal.ref,
    resolvedCommit: terminal.resolvedCommit!,
    path: terminal.path,
    archiveRef: terminal.archiveRef,
    archiveDigest: terminal.archiveDigest!,
    archiveSizeBytes: terminal.archiveSizeBytes!,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: { status: "ready", scopePath: ".", modules: [] },
    fetchedByRunId: terminal.id,
    fetchedAt: terminal.finishedAt!,
  };
  expect(
    await reopened.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: "legacy-private-lease",
      snapshot,
    }),
  ).toEqual({ won: true, run: terminal });
  expect(
    await database
      .prepare(
        "select json_extract(run_json, '$.workspaceManagementAuthority.workspaceId') as workspace_id, json_extract(run_json, '$.workspaceManagementAuthority.managementEpoch') as epoch from runs where id = ?",
      )
      .bind(running.id)
      .first(),
  ).toEqual({ workspace_id: ws.id, epoch: 1 });
  expect(await reopened.getSourceSyncRun(running.id)).toEqual(terminal);
});

test("auto-update claim requires an active Capsule Workspace but exact retries and other finalizers remain readable", async () => {
  for (const { label, store } of await adapters()) {
    const ws = workspace(`capsule-${label}`);
    await store.putWorkspace(ws);
    const initial = capsule(`capsule-${label}`, ws.id);
    await store.putCapsule(initial);
    const management = await store.getWorkspaceManagement(ws.id);
    if (!management || management.managementState !== "active") {
      throw new Error(`${label}: Workspace management is not active`);
    }
    const authority: WorkspaceManagementAuthority = {
      workspaceId: management.workspaceId,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    };
    const first = await store.updateCapsuleLifecycle({
      capsuleId: initial.id,
      expected: capsuleLifecycleExpected(initial, 1),
      mutation: {
        kind: "auto-update-claim",
        sourceSnapshotId: `snapshot-first-${label}`,
        expectedWorkspaceManagementAuthority: authority,
      },
      updatedAt: "2026-09-08T00:00:01.000Z",
    });
    expect(first, label).toMatchObject({ kind: "updated" });
    const claimed = first.kind === "updated" || first.kind === "unchanged"
      ? first.capsule
      : initial;

    expect(await store.beginWorkspaceDraining(ws.id, authority), label).toMatchObject({
      status: "started",
      management: { managementState: "draining", managementEpoch: 2 },
    });

    // Replaying the exact claim is an idempotent read even while draining.
    expect(
      await store.updateCapsuleLifecycle({
        capsuleId: claimed.id,
        expected: capsuleLifecycleExpected(claimed, 1),
        mutation: {
          kind: "auto-update-claim",
          sourceSnapshotId: `snapshot-first-${label}`,
          expectedWorkspaceManagementAuthority: authority,
        },
        updatedAt: "2026-09-08T00:00:02.000Z",
      }),
      label,
    ).toEqual({ kind: "unchanged", capsule: claimed });

    // A different marker is a new admission and must not be consumed after
    // the Workspace fence has changed.
    expect(
      await store.updateCapsuleLifecycle({
        capsuleId: claimed.id,
        expected: capsuleLifecycleExpected(claimed, 1),
        mutation: {
          kind: "auto-update-claim",
          sourceSnapshotId: `snapshot-second-${label}`,
          expectedWorkspaceManagementAuthority: authority,
        },
        updatedAt: "2026-09-08T00:00:03.000Z",
      }),
      label,
    ).toEqual({ kind: "conflict", current: claimed });

    // Existing lifecycle finalization unrelated to auto-update admission is
    // intentionally unchanged and remains allowed while draining.
    const finalizer = await store.updateCapsuleLifecycle({
      capsuleId: claimed.id,
      expected: capsuleLifecycleExpected(claimed, 1),
      mutation: { kind: "status", status: "stale" },
      updatedAt: "2026-09-08T00:00:04.000Z",
    });
    expect(finalizer, label).toMatchObject({
      kind: "updated",
      capsule: { status: "stale" },
    });
  }
});
