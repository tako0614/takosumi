import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import {
  CapsuleApplyRunAdmissionConflictError,
  capsuleApplyRunAdmissionFence,
  InMemoryOpenTofuControlStore,
  storeRunManagementAuthority,
  type CapsuleApplyRunAdmissionFence,
  type OpenTofuControlStore,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import type { SqlClient, SqlParameters, SqlTransaction } from "../../../../core/adapters/storage/sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type { D1PreparedStatement, D1Result } from "../../../../worker/src/bindings.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

setDefaultTimeout(30_000);
const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function workspaceAuthority(capsule: Capsule): WorkspaceManagementAuthority {
  return { workspaceId: capsule.workspaceId, managementState: "active", managementEpoch: 1 };
}

function applyRun(
  id: string,
  capsule: Capsule,
  fence: CapsuleApplyRunAdmissionFence,
  operation: ApplyRun["operation"] = "update",
): ApplyRun {
  return {
    id,
    planRunId: `plan-${id}`,
    workspaceId: capsule.workspaceId,
    capsuleId: fence.capsuleId,
    operation,
    runnerProfileId: "runner",
    status: "queued",
    expected: {
      planRunId: `plan-${id}`,
      capsuleId: fence.capsuleId,
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
}

test("Apply Capsule admission stores preserve create, update, destroy and headless admission", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store);
    const authority = workspaceAuthority(capsule);
    const initial = capsuleApplyRunAdmissionFence(capsule, 1);
    expect((await store.beginApplyRun(applyRun("create", capsule, initial, "create"), authority, initial)).status, label)
      .toBe("created");
    const active: Capsule = { ...capsule, status: "active", currentStateGeneration: 1, currentStateVersionId: "state-before" };
    await store.putCapsule(active);
    const fence = capsuleApplyRunAdmissionFence(active, 1);
    for (const operation of ["update", "destroy"] as const) {
      expect((await store.beginApplyRun(applyRun(operation, active, fence, operation), authority, fence)).status, label)
        .toBe("created");
    }
    const bound = applyRun("headless", active, fence);
    const { capsuleId: _capsuleId, ...headless } = bound;
    const { capsuleId: _expectedCapsuleId, currentStateVersionId: _state, capsuleExecutionAuthorityEpoch: _epoch, ...expected } = bound.expected;
    const run = { ...headless, expected };
    expect((await store.beginApplyRun(run, authority)).status, label).toBe("created");
    await expect(store.beginApplyRun({ ...run, id: "headless-extraneous" }, authority, fence), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    await expect(store.beginApplyRun({ ...run, id: "headless-hidden", expected: bound.expected }, authority), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
  }
});

test("Apply Capsule admission stores reject every stale Capsule field and missing or mismatched guards without inserting", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store);
    const authority = workspaceAuthority(capsule);
    const fence = capsuleApplyRunAdmissionFence(capsule, 1);
    const changed: readonly Partial<CapsuleApplyRunAdmissionFence>[] = [
      { capsuleId: "missing-capsule" },
      { workspaceId: "different-workspace" },
      { environment: "staging" },
      { status: "active" },
      { installConfigId: "different-config" },
      { executionAuthorityEpoch: 2 },
      { currentStateVersionId: "new-state" },
      { currentStateGeneration: 1 },
    ];
    for (const [index, difference] of changed.entries()) {
      const stale = { ...fence, ...difference };
      const run = applyRun(`stale-${index}`, capsule, stale);
      await expect(store.beginApplyRun(run, authority, stale), `${label}:${Object.keys(difference)[0]}`)
        .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
      expect(await store.getApplyRun(run.id), label).toBeUndefined();
    }
    const missing = applyRun("missing-fence", capsule, fence);
    await expect(store.beginApplyRun(missing, authority), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect(await store.getApplyRun(missing.id), label).toBeUndefined();
    const mismatch = { ...missing, id: "mismatched-guard", expected: { ...missing.expected, currentStateVersionId: "different-state" } };
    await expect(store.beginApplyRun(mismatch, authority, fence), label)
      .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
    expect(await store.getApplyRun(mismatch.id), label).toBeUndefined();
    const malformedGuards = [
      { ...missing.expected, currentStateVersionId: undefined },
      { ...missing.expected, capsuleExecutionAuthorityEpoch: null },
    ];
    for (const [index, malformed] of malformedGuards.entries()) {
      const run = { ...missing, id: `malformed-run-guard-${index}`, expected: malformed as ApplyRun["expected"] };
      await expect(store.beginApplyRun(run, authority, fence), label)
        .rejects.toBeInstanceOf(CapsuleApplyRunAdmissionConflictError);
      expect(await store.getApplyRun(run.id), label).toBeUndefined();
    }
  }
});

test("Apply Capsule admission existing-ID replay remains read-only after Capsule advance and Workspace drain", async () => {
  for (const [label, store] of await stores()) {
    const { capsule } = await seedCapsuleModel(store);
    const authority = workspaceAuthority(capsule);
    const fence = capsuleApplyRunAdmissionFence(capsule, 1);
    const run = applyRun("already-admitted", capsule, fence);
    await store.beginApplyRun(run, authority, fence);
    const terminal: ApplyRun = { ...run, status: "failed", updatedAt: 2 };
    await store.putApplyRun(terminal);
    const advanced: Capsule = { ...capsule, status: "error", currentStateGeneration: 1, currentStateVersionId: "state-after" };
    await store.putCapsule(advanced);
    await store.beginWorkspaceDraining(capsule.workspaceId, authority);
    expect(await store.beginApplyRun(run), label).toEqual({ status: "existing", run: terminal });
    expect(await store.beginApplyRun(run, authority, fence), label).toEqual({ status: "existing", run: terminal });
    await expect(store.beginApplyRun(run, { ...authority, managementEpoch: 0 }, fence), label)
      .rejects.toBeInstanceOf(TypeError);
    await expect(store.beginApplyRun(run, authority, { ...fence, executionAuthorityEpoch: 0 }), label)
      .rejects.toBeInstanceOf(TypeError);
    expect(await store.getCapsule(capsule.id), label).toEqual(advanced);
    expect(await store.getRunManagementAuthority({ id: run.id, kind: "apply", workspaceId: run.workspaceId }), label)
      .toEqual(authority);
  }
});

class BeforeBatchD1 extends SqliteFakeD1 {
  beforeBatch?: () => Promise<void>;

  override async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    const callback = this.beforeBatch;
    this.beforeBatch = undefined;
    await callback?.();
    return await super.batch<T>(statements);
  }
}

test("Apply Capsule admission D1 adopts a same-ID winner after the getter even with missing or stale fences", async () => {
  for (const omitted of ["none", "capsule", "both"] as const) {
    const database = new BeforeBatchD1();
    const store = new CloudflareD1OpenTofuControlStore(database);
    const { capsule } = await seedCapsuleModel(store);
    const authority = workspaceAuthority(capsule);
    const fence = capsuleApplyRunAdmissionFence(capsule, 1);
    const run = applyRun("winner", capsule, fence);
    let interleaved = false;
    database.beforeBatch = async () => {
      interleaved = true;
      expect((await store.beginApplyRun(run, authority, fence)).status).toBe("created");
      await store.putCapsule({ ...capsule, status: "active", currentStateGeneration: 1, currentStateVersionId: "winner-state" });
      await store.beginWorkspaceDraining(capsule.workspaceId, authority);
    };
    expect(await store.beginApplyRun(
      run,
      omitted === "both" ? undefined : authority,
      omitted === "none" ? fence : undefined,
    ))
      .toEqual({ status: "existing", run });
    expect(interleaved).toBe(true);
    expect((await store.getCapsule(capsule.id))?.currentStateVersionId).toBe("winner-state");
    expect((await store.getWorkspaceManagement(capsule.workspaceId))?.managementState).toBe("draining");
  }
});

test("Apply Capsule admission Postgres rereads a same-ID winner after acquiring the Workspace lock", async () => {
  for (const omitFence of [false, true]) {
    const pg = await PGliteSqlClient.create();
    clients.push(pg);
    const store = new SqlOpenTofuControlStore({ client: pg });
    const { capsule } = await seedCapsuleModel(store);
    const authority = workspaceAuthority(capsule);
    const fence = capsuleApplyRunAdmissionFence(capsule, 1);
    const run = applyRun("winner", capsule, fence);
    const advanced: Capsule = { ...capsule, status: "active", currentStateGeneration: 1, currentStateVersionId: "winner-state" };
    let interleaved = false;
    const client: SqlClient = {
      query: (statement, parameters) => pg.query(statement, parameters),
      transaction: (callback) => pg.transaction((transaction) => {
        const wrapped: SqlTransaction = {
          transaction: (nested) => transaction.transaction(nested),
          async query<Row extends Record<string, unknown>>(statement: string, parameters?: SqlParameters) {
            if (!interleaved && /from takosumi_workspaces[\s\S]*for update/u.test(statement)) {
              // Model a committed winner becoming visible after the first
              // absent-ID read, before the waiting Workspace lock is acquired.
              // Real SQL rows drive both the lock read and the second ID read.
              interleaved = true;
              await transaction.query(
                `insert into takosumi_runs
                   (id, kind, space_id, source_id, installation_id, status, lease_token, heartbeat_at, created_at, run_json)
                 values ($1, 'apply', $2, null, $3, 'queued', null, null, '1', $4)`,
                [run.id, run.workspaceId, run.capsuleId!, JSON.stringify(storeRunManagementAuthority(run, authority))],
              );
              await transaction.query(
                "update takosumi_capsules set status = 'active', current_state_version_id = 'winner-state', installation_json = $1 where id = $2",
                [JSON.stringify(advanced), capsule.id],
              );
              await transaction.query(
                "update takosumi_workspaces set management_state = 'draining', management_epoch = 2 where id = $1",
                [capsule.workspaceId],
              );
            }
            return await transaction.query<Row>(statement, parameters);
          },
        };
        return callback(wrapped);
      }),
    };
    const contender = new SqlOpenTofuControlStore({ client });
    expect(await contender.beginApplyRun(run, authority, omitFence ? undefined : fence))
      .toEqual({ status: "existing", run });
    expect(interleaved).toBe(true);
    expect(await store.getCapsule(capsule.id)).toEqual(advanced);
    expect((await store.getWorkspaceManagement(capsule.workspaceId))?.managementState).toBe("draining");
  }
});
