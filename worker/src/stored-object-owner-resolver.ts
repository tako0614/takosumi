/** Read-only projection of Core's retained allocations. Object names and native
 * metadata select records; neither is an ownership authority by itself. */
import type { D1Database, R2Bucket, R2Object } from "./bindings.ts";
import { storedDigest, storedObjectReference, StoredServiceUsageError, type StoredBucketRole, type StoredObjectOwnerPort, type StoredServiceUsagePort } from "./stored-service-usage.ts";
import { storedCapsuleArtifactRoot } from "./stored-capsule-root.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_MATCHES = 8;
const MAX_ROWS_READ = 4096;
type Row = Record<string, unknown>;
export interface StoredOriginalObjectOwnerPort {
  readOriginalStoredObjectOwner(input: { readonly bucketRole: StoredBucketRole; readonly objectRef: string }): Promise<{
    readonly workspaceId: string;
    readonly sourceRef: string;
    readonly epochRef: string;
    readonly qualificationDigest: string;
  } | null>;
}

/** Use the primary session when D1 exposes sessions; never read a stale replica
 * for an allocation which may have been committed immediately before the PUT. */
export function storedOwnerDatabase(db: D1Database): D1Database {
  const sessions = db as D1Database & { withSession?: (constraint: string) => D1Database };
  return typeof sessions.withSession === "function" ? sessions.withSession("first-primary") : db;
}

export function createStoredObjectOwnerResolver(options: {
  readonly database: D1Database;
  readonly buckets: Readonly<Record<StoredBucketRole, R2Bucket | undefined>>;
  readonly privateRunFilePrefix?: string;
  /** Existing 0009 prepare pins survive failed final Core ledger writes. This
   * readonly private role can return an owner, never settle its pending intent. */
  readonly originalOwners?: StoredOriginalObjectOwnerPort;
  readonly sources?: Pick<StoredServiceUsagePort, "readStoredSource">;
}): StoredObjectOwnerPort {
  return {
    async resolveStoredObjectOwner(input) {
      const { bucketRole, key } = input;
      if (!["state", "artifacts", "source", "backups"].includes(bucketRole) || !validKey(key)) throw new StoredServiceUsageError();
      const db = storedOwnerDatabase(options.database);
      const owners: string[] = [];
      const add = (value: unknown) => {
        if (typeof value !== "string" || !ID.test(value)) throw new StoredServiceUsageError();
        owners.push(value);
      };
      if (bucketRole === "state") {
        // The exact retained StateVersion is sufficient even after Workspace,
        // Capsule, membership or Run deletion. No current admission is needed.
        const stateRef = key.endsWith(".execution-evidence.json") ? key.slice(0, -".execution-evidence.json".length) : key;
        for (const row of await rows(db, "select space_id as owner from state_versions where object_key = ? limit 9", [stateRef])) add(row.owner);
        if (owners.length === 0 && key.endsWith("/current.json")) {
          // Verify an exact canonical allocation from a retained StateVersion;
          // replacing its filename is not an inference from a Workspace prefix.
          const match = /^(?:workspaces\/[^/]+\/capsules\/|apps\/)([^/]+)\/environments\/([^/]+)\/state-versions\/current\.json$/u.exec(key);
          const candidates = match ? await rows(db, `select space_id, installation_id, environment, generation, object_key
            from state_versions where installation_id = ? and environment = ? order by generation desc limit 1`, [match[1], match[2]]) : [];
          for (const row of candidates) {
            if (typeof row.space_id !== "string" || typeof row.installation_id !== "string" || typeof row.environment !== "string" || !Number.isSafeInteger(row.generation) || (row.generation as number) < 0) throw new StoredServiceUsageError();
            const objectKey = row.object_key;
            if (typeof objectKey !== "string") throw new StoredServiceUsageError();
            const suffix = `/environments/${row.environment}/state-versions/${String(row.generation).padStart(8, "0")}.tfstate.enc`;
            const legacyRoot = `workspaces/${row.space_id}/capsules/${row.installation_id}`;
            const appRoot = `apps/${row.installation_id}`;
            const root = objectKey === `${appRoot}${suffix}` ? appRoot : legacyRoot;
            const prefix = `${root}/environments/${row.environment}/state-versions/`;
            if (row.object_key !== `${prefix}${String(row.generation).padStart(8, "0")}.tfstate.enc` || key !== `${prefix}current.json`) throw new StoredServiceUsageError();
            add(row.space_id);
          }
        }
      } else if (bucketRole === "artifacts") {
        for (const row of await rows(db, `select a.run_id, r.id, r.space_id, r.type, r.status, r.run_json
          from artifacts a join runs r on r.id = a.run_id where a.object_key = ? limit 9`, [key])) add(exactRun(row).workspaceId);
        // Current Runner sidecars are allocated from the original Run/Capsule
        // context. Metadata is only the bounded Run selector; its Workspace
        // fields are never accepted as proof. Unscoped legacy names block.
        if (owners.length === 0 && (!options.privateRunFilePrefix || !key.startsWith(`${options.privateRunFilePrefix}/`))) {
          const object = await options.buckets.artifacts?.head(key);
          const selector = object?.customMetadata?.["takosumi-plan-run-id"] ?? object?.customMetadata?.["takosumi-run-id"];
          if (typeof selector === "string" && ID.test(selector)) {
            for (const row of await rows(db, "select id, space_id, type, status, run_json from runs where id = ? limit 2", [selector])) {
              const run = exactRun(row);
              const plan = ["plan", "destroy_plan", "drift_check"].includes(String(row.type));
              const apply = ["apply", "destroy_apply"].includes(String(row.type));
              const context = nested(run.capsuleContext);
              const capsuleId = run.capsuleId;
              if (typeof capsuleId !== "string" || !ID.test(capsuleId) || plan && (context.workspaceId !== run.workspaceId || context.capsuleId !== capsuleId)) continue;
              const root = await storedCapsuleArtifactRoot(db, run.workspaceId as string, capsuleId);
              const prefix = `${root}/runs/${selector}/`;
              const suffixes = plan ? ["plan.bin.enc", "provider-lockfile.hcl.enc", "plan.json.zst.enc"] : apply ? ["outputs.raw.json.enc"] : [];
              if (suffixes.some(suffix => key === prefix + suffix)) add(run.workspaceId);
            }
          }
        }
        if (options.privateRunFilePrefix && key.startsWith(`${options.privateRunFilePrefix}/`)) {
          const suffix = key.slice(options.privateRunFilePrefix.length + 1);
          if (!/^[0-9a-f]{64}$/u.test(suffix)) throw new StoredServiceUsageError();
          const blobId = `sha256:${suffix}`;
          const receipts = await rows(db, `select workspace_id, capsule_id, environment, slot, digest, blob_id from private_run_file_receipts where blob_id = ?
            union select workspace_id, capsule_id, environment, slot, digest, blob_id from private_run_file_pointers where blob_id = ? limit 9`, [blobId, blobId]);
          const object = receipts.length ? await options.buckets.artifacts?.head(key) : null;
          for (const row of receipts) {
            await assertPrivateReceipt(row, key, options.privateRunFilePrefix, object ?? null);
            add(row.workspace_id);
          }
        }
      } else if (bucketRole === "source") {
        for (const row of await rows(db, `select ss.id, ss.source_id, s.space_id, s.record_json as source_json, ss.record_json as snapshot_json
          from source_snapshots ss left join sources s on s.id = ss.source_id
          where case when json_valid(ss.record_json) then json_extract(ss.record_json, '$.archiveRef') = ? else 0 end limit 9`, [key])) {
          const snapshot = record(row.snapshot_json);
          if (snapshot.id !== row.id || snapshot.sourceId !== row.source_id || snapshot.archiveRef !== key) throw new StoredServiceUsageError();
          // The immutable snapshot retains its original canonical owner when
          // its Source or Workspace is subsequently removed.
          if (row.source_json !== null) {
            const source = record(row.source_json);
            if (source.id !== snapshot.sourceId || source.workspaceId !== row.space_id || source.workspaceId !== snapshot.workspaceId) throw new StoredServiceUsageError();
          }
          add(snapshot.workspaceId);
        }
        // SourceSyncRun persists the exact allocation before dispatch, including
        // failed/cancelled Runs whose archive was never promoted to a snapshot.
        for (const row of await rows(db, `select id, space_id, type, status, run_json from runs where type = 'source_sync'
          and case when json_valid(run_json) then json_extract(run_json, '$.archiveRef') = ? else 0 end limit 9`, [key])) {
          const run = exactRun(row);
          if (run.archiveRef !== key || run.kind !== "source_sync") throw new StoredServiceUsageError();
          add(run.workspaceId);
        }
      } else {
        for (const row of await rows(db, `select id, space_id, record_json from backups where case when json_valid(record_json) then
          json_extract(record_json, '$.ref') = ? or json_extract(record_json, '$.stateArchive.ref') = ?
          or json_extract(record_json, '$.serviceData.ref') = ? or json_extract(record_json, '$.artifactsManifest.ref') = ? else 0 end limit 9`, [key, key, key, key])) {
          const backup = record(row.record_json);
          if (backup.id !== row.id || backup.workspaceId !== row.space_id || ![backup.ref, nested(backup.stateArchive).ref, nested(backup.serviceData).ref, nested(backup.artifactsManifest).ref].includes(key)) throw new StoredServiceUsageError();
          add(backup.workspaceId);
        }
      }
      if (owners.length === 0 && options.originalOwners && options.sources) {
        const sourceInput = { bucketRole, writerId: bucketRole === "backups" ? "control-backup" : "runner" };
        const source = await options.sources.readStoredSource(sourceInput);
        if (!source || typeof source.sourceRef !== "string" || !ID.test(source.sourceRef) || typeof source.epochRef !== "string" || !ID.test(source.epochRef) || typeof source.qualificationDigest !== "string" || !DIGEST.test(source.qualificationDigest)) throw new StoredServiceUsageError();
        const objectRef = await storedObjectReference(bucketRole, key, source.sourceRef);
        const original = await options.originalOwners.readOriginalStoredObjectOwner({ bucketRole, objectRef });
        const current = await options.sources.readStoredSource(sourceInput);
        if (!current || current.sourceRef !== source.sourceRef || current.epochRef !== source.epochRef || current.qualificationDigest !== source.qualificationDigest) throw new StoredServiceUsageError();
        if (original) {
          if (original.sourceRef !== source.sourceRef || original.epochRef !== source.epochRef || original.qualificationDigest !== source.qualificationDigest) throw new StoredServiceUsageError();
          add(original.workspaceId);
        }
      }
      if (owners.length > MAX_MATCHES || new Set(owners).size > 1) throw new StoredServiceUsageError();
      return owners.length === 0 ? null : { workspaceId: owners[0]! };
    },
  };
}

export async function storedOwnerRows(db: D1Database, sql: string, params: readonly unknown[]): Promise<readonly Row[]> { return await rows(db, sql, params); }
async function rows(db: D1Database, sql: string, params: readonly unknown[]): Promise<readonly Row[]> {
  const result = await db.prepare(sql).bind(...params).all<Row>();
  if (result.success === false || !Array.isArray(result.results) || result.results.length > MAX_MATCHES || (result.meta?.rows_read !== undefined && result.meta.rows_read > MAX_ROWS_READ)) throw new StoredServiceUsageError();
  return result.results;
}
export function storedOwnerRecord(value: unknown): Row { return record(value); }
function record(value: unknown): Row {
  if (typeof value !== "string" || value.length > 1024 * 1024) throw new StoredServiceUsageError();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new StoredServiceUsageError(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new StoredServiceUsageError();
  return parsed as Row;
}
function nested(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function exactRun(row: Row): Row {
  const run = record(row.run_json);
  if (run.id !== row.id || run.workspaceId !== row.space_id || run.status !== row.status || (run.type !== undefined && run.type !== row.type) || (run.kind !== undefined && run.kind !== row.type) || typeof run.workspaceId !== "string" || !ID.test(run.workspaceId)) throw new StoredServiceUsageError();
  return run;
}
async function assertPrivateReceipt(row: Row, key: string, prefix: string, object: R2Object | null): Promise<void> {
  const scope = [row.workspace_id, row.capsule_id, row.environment, row.slot];
  if (scope.some(value => typeof value !== "string" || !value || value.length > 1024) || typeof row.digest !== "string" || !DIGEST.test(row.digest)) throw new StoredServiceUsageError();
  const identity = await storedDigest(JSON.stringify([...scope, row.digest]));
  const metadata = object?.customMetadata;
  if (row.blob_id !== identity || key !== `${prefix}/${identity.slice(7)}` || object?.key !== key || !metadata || Object.keys(metadata).length !== 4 || metadata.format !== "takosumi-private-run-file-r2@v1" || metadata.scope !== await storedDigest(JSON.stringify(scope)) || metadata.digest !== row.digest || !/^(0|[1-9][0-9]*)$/u.test(metadata.byteLength ?? "")) throw new StoredServiceUsageError();
  const length = Number(metadata.byteLength);
  if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024 || object.size !== Math.ceil(length * 4 / 3) + 28) throw new StoredServiceUsageError();
}
function validKey(key: unknown): key is string { return typeof key === "string" && key.length > 0 && key.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(key) && key.split("/").every(part => part !== "" && part !== "." && part !== ".."); }
