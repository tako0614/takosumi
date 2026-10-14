/** Local, non-RPC allocation capture. Core remains the allocation authority;
 * none of these contexts can be obtained by supplying a Workspace UID. */
import type { ArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import type { D1Database, R2Bucket } from "./bindings.ts";
import { storedOwnerDatabase, storedOwnerRecord, storedOwnerRows } from "./stored-object-owner-resolver.ts";
import { storedServiceUsageBucket, StoredServiceUsageError, type StoredBucketRole, type StoredServiceComposition } from "./stored-service-usage.ts";

const SEGMENT = /^[A-Za-z0-9._-]+$/u;
export const STORED_RUN_LEASE_HEADER = "x-takosumi-run-lease";
export interface StoredRunLease { readonly runId: string; readonly leaseToken: string }
export function storedRunLeaseHeaderValue(input: StoredRunLease | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (!validRunLease(input)) throw new StoredServiceUsageError();
  const bytes = new TextEncoder().encode(JSON.stringify([input.runId, input.leaseToken]));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
export function readStoredRunLeaseHeader(value: string | null): StoredRunLease | undefined {
  if (value === null) return undefined;
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(value)) throw new StoredServiceUsageError();
  try {
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value.replace(/-/gu, "+").replace(/_/gu, "/")), character => character.charCodeAt(0))));
    if (!Array.isArray(decoded) || decoded.length !== 2) throw new StoredServiceUsageError();
    const result = { runId: decoded[0], leaseToken: decoded[1] };
    if (!validRunLease(result) || storedRunLeaseHeaderValue(result) !== value) throw new StoredServiceUsageError();
    return Object.freeze(result);
  } catch { throw new StoredServiceUsageError(); }
}
function validRunLease(input: { readonly runId?: unknown; readonly leaseToken?: unknown }): input is StoredRunLease {
  return typeof input.runId === "string" && input.runId.length <= 128 && SEGMENT.test(input.runId) && typeof input.leaseToken === "string" && input.leaseToken.length > 0 && input.leaseToken.length <= 1024 && input.leaseToken.trim() === input.leaseToken && !/[\u0000-\u001f\u007f]/u.test(input.leaseToken);
}
export async function assertStoredRunLease(database: D1Database, original: StoredRunLease): Promise<void> {
  if (!validRunLease(original)) throw new StoredServiceUsageError();
  const records = await storedOwnerRows(storedOwnerDatabase(database), "select id, space_id, status, lease_token, run_json from runs where id = ? limit 2", [original.runId]);
  if (records.length !== 1) throw new StoredServiceUsageError();
  const row = records[0]!, run = storedOwnerRecord(row.run_json);
  if (row.status !== "running" || row.lease_token !== original.leaseToken || run.id !== original.runId || run.workspaceId !== row.space_id || run.status !== row.status) throw new StoredServiceUsageError();
}
type RecordValue = Record<string, unknown>;
export interface StoredRunnerScope {
  readonly workspaceId: string;
  readonly subjectKind: "capsule" | "resource";
  readonly subjectId: string;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
}

/** Paired exclusively with the allocator passed into this Core composition.
 * Backup allocation occurs only after beginBackupRun's admission CAS. Capture
 * the exact opaque ref, not a prefix or a request's Workspace parameter. */
export function createBackupStoredOwnerContext(allocator: ArtifactReferenceAllocator, composition: StoredServiceComposition | undefined, bucket: R2Bucket | undefined) {
  if (!composition || !bucket) return { allocator, bucket };
  const pending = new Map<string, string>();
  const wrapped = storedServiceUsageBucket(bucket, {
    usage: composition.usage,
    owners: { async resolveStoredObjectOwner(input) {
      const owner = pending.get(input.key);
      return owner === undefined ? await composition.owners.resolveStoredObjectOwner(input) : { workspaceId: owner };
    } },
  }, { bucketRole: "backups", writerId: "control-backup" });
  return {
    allocator: {
      async allocate(input) {
        // Freeze before the allocator's first await. This is an in-process Core
        // port, never an API accepting an external allocation assertion.
        const captured = structuredClone(input);
        const ref = await allocator.allocate(captured);
        if (captured.kind.startsWith("backup_")) {
          const existing = pending.get(ref);
          if (existing !== undefined && existing !== captured.workspaceId || existing === undefined && pending.size >= 128) throw new StoredServiceUsageError();
          pending.set(ref, captured.workspaceId);
        }
        return ref;
      },
    } satisfies ArtifactReferenceAllocator,
    bucket: {
      get: key => wrapped.get(key), head: key => wrapped.head(key), list: input => wrapped.list(input), delete: key => wrapped.delete(key),
      async put(key, bytes, options) {
        try { return await wrapped.put(key, bytes, options); }
        finally { pending.delete(key); }
      },
    } satisfies R2Bucket,
  };
}

/** The private Runner binding supplies the Run selector. D1, rather than the
 * dispatch body, supplies its original owner, lease and exact Capsule lineage.
 * Unscoped historical Resource/legacy mutations have no such proof and block. */
export function runnerStoredServiceBucket(bucket: R2Bucket, composition: StoredServiceComposition | undefined, database: D1Database, allocation: {
  readonly bucketRole: Exclude<StoredBucketRole, "backups">;
  readonly runId?: string;
  /** Exact original Core dispatch lease, captured before the private transport.
   * Never filled by rereading whichever lease currently happens to be in D1. */
  readonly expectedLeaseToken?: string;
  readonly scope?: StoredRunnerScope;
  /** Only the Runner's already-claimed durable Restore allocation supplies it. */
  readonly restoreStageRef?: string;
  /** Only the GC path after its retained DO claim + ledger disposition check. */
  readonly restoreCleanup?: { readonly runId: string; readonly scopeKey: string; readonly stateRef: string };
}): R2Bucket {
  if (!composition) return bucket;
  const frozen = structuredClone(allocation);
  const fences = new Map<string, string>();
  const resolve = async (key: string, dispatch = false): Promise<{ readonly workspaceId: string }> => {
    const db = storedOwnerDatabase(database);
    const cleanup = frozen.restoreCleanup;
    const runId = cleanup?.runId ?? frozen.runId;
    if (!runId || !SEGMENT.test(runId)) throw new StoredServiceUsageError();
    const rows = await storedOwnerRows(db, "select id, space_id, installation_id, environment, type, status, lease_token, run_json from runs where id = ? limit 2", [runId]);
    if (rows.length !== 1) throw new StoredServiceUsageError();
    const row = rows[0]!, run = storedOwnerRecord(row.run_json);
    if (run.id !== runId || run.workspaceId !== row.space_id || run.status !== row.status || typeof run.workspaceId !== "string" || !SEGMENT.test(run.workspaceId) || run.type !== undefined && run.type !== row.type || run.kind !== undefined && run.kind !== row.type) throw new StoredServiceUsageError();
    if (cleanup) {
      // Accepted cleanup uses the original retained Run and durable stage, not
      // current human membership, Workspace existence or new admission.
      const capsule = run.capsuleId;
      const environment = run.environment;
      if (row.type !== "restore" || !["failed", "cancelled", "expired"].includes(String(row.status)) || typeof capsule !== "string" || typeof environment !== "string" || row.installation_id !== capsule || row.environment !== environment || cleanup.scopeKey !== `workspaces/${run.workspaceId}/capsules/${capsule}/environments/${environment}/state-versions` || key !== cleanup.stateRef || !key.startsWith(`${cleanup.scopeKey}/restore-operations/`) || !/\/restore-operations\/[0-9]{8,16}-[0-9a-f]{24}\.tfstate\.enc$/u.test(key)) throw new StoredServiceUsageError();
    } else {
      if (row.status !== "running" || typeof frozen.expectedLeaseToken !== "string" || !frozen.expectedLeaseToken || frozen.expectedLeaseToken.length > 1024 || row.lease_token !== frozen.expectedLeaseToken) throw new StoredServiceUsageError();
      if (frozen.bucketRole === "source") {
        if (row.type !== "source_sync" || run.kind !== "source_sync" || run.archiveRef !== key || typeof run.sourceId !== "string") throw new StoredServiceUsageError();
        const sourceRows = await storedOwnerRows(db, "select id, space_id, record_json from sources where id = ? limit 2", [run.sourceId]);
        if (sourceRows.length !== 1) throw new StoredServiceUsageError();
        const source = storedOwnerRecord(sourceRows[0]!.record_json);
        if (source.id !== run.sourceId || source.workspaceId !== run.workspaceId || sourceRows[0]!.space_id !== run.workspaceId) throw new StoredServiceUsageError();
      } else {
        await assertRunnerAllocation(db, row, run, frozen, key, dispatch);
      }
    }
    // The lease is captured independently of the body and checked again after
    // the remote prepare ACK. A takeover never dispatches under an older lease.
    const fence = JSON.stringify([row.id, row.space_id, row.installation_id, row.environment, row.type, row.status, row.lease_token, cleanup ? null : allocationIdentity(run)]);
    const previous = fences.get(key);
    if (previous !== undefined && previous !== fence) throw new StoredServiceUsageError();
    if (fences.size >= 32 && previous === undefined) throw new StoredServiceUsageError();
    fences.set(key, fence);
    return { workspaceId: run.workspaceId };
  };
  return storedServiceUsageBucket(bucket, {
    usage: composition.usage,
    owners: { async resolveStoredObjectOwner(input) {
      // The active allocation path validates the current lease even when a
      // previous inventory already knows the object. General retained reads
      // use the immutable ledger resolver directly.
      if (frozen.runId || frozen.restoreCleanup) {
        try { return await resolve(input.key); }
        catch (error) {
          // A read of another immutable source during Restore is historical;
          // the dispatch fence below still forbids mutating it.
          const retained = await composition.owners.resolveStoredObjectOwner(input);
          if (retained) return retained;
          throw error;
        }
      }
      return await composition.owners.resolveStoredObjectOwner(input);
    } },
  }, {
    bucketRole: frozen.bucketRole, writerId: "runner",
    beforePrepare: async (key, kind) => {
      if (frozen.restoreCleanup ? kind !== "delete" : kind !== "put") throw new StoredServiceUsageError();
      await resolve(key, true);
    },
    beforeDispatch: async (key, kind) => {
      if (frozen.restoreCleanup ? kind !== "delete" : kind !== "put") throw new StoredServiceUsageError();
      if (!fences.has(key)) throw new StoredServiceUsageError();
      await resolve(key, true);
    },
  });
}

async function assertRunnerAllocation(db: D1Database, row: RecordValue, run: RecordValue, input: { readonly bucketRole: string; readonly scope?: StoredRunnerScope; readonly restoreStageRef?: string }, key: string, dispatch: boolean): Promise<void> {
  const planKinds = ["plan", "destroy_plan", "drift_check"];
  const applyKinds = ["apply", "destroy_apply"];
  let plan = run;
  if (applyKinds.includes(String(row.type))) {
    if (typeof run.planRunId !== "string") throw new StoredServiceUsageError();
    const plans = await storedOwnerRows(db, "select id, space_id, installation_id, status, run_json from runs where id = ? limit 2", [run.planRunId]);
    if (plans.length !== 1) throw new StoredServiceUsageError();
    const planRow = plans[0]!;
    plan = storedOwnerRecord(planRow.run_json);
    const expected = nested(run.expected);
    if (plan.id !== run.planRunId || plan.workspaceId !== run.workspaceId || plan.capsuleId !== run.capsuleId || planRow.space_id !== run.workspaceId || planRow.installation_id !== run.capsuleId || expected.planRunId !== plan.id || expected.currentStateVersionId !== plan.capsuleCurrentStateVersionId || expected.capsuleExecutionAuthorityEpoch !== plan.capsuleExecutionAuthorityEpoch) throw new StoredServiceUsageError();
  } else if (!planKinds.includes(String(row.type)) && row.type !== "restore") throw new StoredServiceUsageError();
  const context = row.type === "restore" ? { workspaceId: run.workspaceId, capsuleId: run.capsuleId, environment: run.environment } : nested(plan.capsuleContext);
  if (context.workspaceId !== run.workspaceId || context.capsuleId !== run.capsuleId || row.installation_id !== run.capsuleId || typeof context.capsuleId !== "string" || !SEGMENT.test(context.capsuleId) || typeof context.environment !== "string" || !SEGMENT.test(context.environment)) throw new StoredServiceUsageError();
  const capsules = await storedOwnerRows(db, `select id, space_id, environment, current_state_generation, current_state_version_id, execution_authority_epoch, record_json
    from capsules where id = ? limit 2`, [context.capsuleId]);
  if (capsules.length !== 1) throw new StoredServiceUsageError();
  const capsuleRow = capsules[0]!, capsule = storedOwnerRecord(capsuleRow.record_json);
  if (capsule.id !== context.capsuleId || capsule.workspaceId !== run.workspaceId || capsule.environment !== context.environment || capsuleRow.space_id !== run.workspaceId || capsuleRow.environment !== context.environment || !Number.isSafeInteger(capsuleRow.current_state_generation) || (capsuleRow.current_state_generation as number) < 0) throw new StoredServiceUsageError();
  if (row.type !== "restore" && (plan.capsuleCurrentStateVersionId !== capsuleRow.current_state_version_id || plan.capsuleExecutionAuthorityEpoch !== capsuleRow.execution_authority_epoch)) throw new StoredServiceUsageError();
  const scope = input.scope;
  if (scope && (scope.subjectKind !== "capsule" || scope.workspaceId !== run.workspaceId || scope.subjectId !== context.capsuleId || scope.environment !== context.environment)) throw new StoredServiceUsageError();
  const runPrefix = `workspaces/${run.workspaceId}/capsules/${context.capsuleId}/runs/${run.id}/`;
  if (input.bucketRole === "artifacts") {
    const allowed = planKinds.includes(String(row.type)) ? ["plan.bin.enc", "provider-lockfile.hcl.enc", "plan.json.zst.enc"] : applyKinds.includes(String(row.type)) ? ["outputs.raw.json.enc"] : [];
    if (!allowed.some(name => key === runPrefix + name)) throw new StoredServiceUsageError();
    return;
  }
  if (!scope) throw new StoredServiceUsageError();
  if (planKinds.includes(String(row.type))) {
    const stateRef = `workspaces/${run.workspaceId}/capsules/${context.capsuleId}/environments/${context.environment}/state-versions/${String(capsuleRow.current_state_generation).padStart(8, "0")}.tfstate.enc`;
    if (dispatch || scope.generation !== capsuleRow.current_state_generation || scope.stateRef !== stateRef || key !== stateRef) throw new StoredServiceUsageError();
    return;
  }
  if (!applyKinds.includes(String(row.type)) && row.type !== "restore") throw new StoredServiceUsageError();
  let generation = (capsuleRow.current_state_generation as number) + 1;
  if (row.type === "restore") {
    const latest = await storedOwnerRows(db, "select max(generation) as generation from state_versions where installation_id = ? and environment = ?", [context.capsuleId, context.environment]);
    const maximum = latest[0]?.generation;
    if (maximum !== null && (!Number.isSafeInteger(maximum) || (maximum as number) < 0)) throw new StoredServiceUsageError();
    generation = Math.max(generation, ((maximum as number | null) ?? 0) + 1);
  }
  const prefix = `workspaces/${run.workspaceId}/capsules/${context.capsuleId}/environments/${context.environment}/state-versions/`;
  const stateRef = `${prefix}${String(generation).padStart(8, "0")}.tfstate.enc`;
  if (scope.generation !== generation || scope.stateRef !== stateRef) throw new StoredServiceUsageError();
  if (row.type === "restore") {
    if (!input.restoreStageRef || key !== input.restoreStageRef || !key.startsWith(`${prefix}restore-operations/`) || !/\/restore-operations\/[0-9]{8,16}-[0-9a-f]{24}\.tfstate\.enc$/u.test(key)) throw new StoredServiceUsageError();
  } else if (![stateRef, `${stateRef}.execution-evidence.json`, `${prefix}current.json`].includes(key)) throw new StoredServiceUsageError();
}
function nested(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function allocationIdentity(run: RecordValue): string { return JSON.stringify([run.id, run.workspaceId, run.capsuleId, run.sourceId, run.archiveRef, run.planRunId, run.capsuleContext, run.capsuleCurrentStateVersionId, run.capsuleExecutionAuthorityEpoch, run.expected]); }
