import type { JsonValue } from "takosumi-contract";
import type {
  DeployPublicIdempotencyRecord,
  DeployPublicIdempotencySaveInput,
  DeployPublicIdempotencyStore,
} from "../../../packages/kernel/src/domains/deploy/deploy_public_idempotency_store.ts";
import {
  assertReplayCompatible,
  compareJournalEntries,
  type OperationJournalAppendInput,
  operationJournalEffectDigest,
  type OperationJournalEntry,
  type OperationJournalStore,
} from "../../../packages/kernel/src/domains/deploy/operation_journal.ts";
import {
  ageRevokeDebtIfDue,
  clearRevokeDebt,
  compareRevokeDebtRecords,
  defaultRetryPolicy,
  markRevokeDebtOperatorActionRequired,
  recordRevokeDebtRetryAttempt,
  reopenRevokeDebt,
  type RevokeDebtAgeOpenInput,
  type RevokeDebtEnqueueInput,
  type RevokeDebtRecord,
  type RevokeDebtRetryAttemptInput,
  revokeDebtSourceKey,
  type RevokeDebtStore,
  type RevokeDebtTransitionInput,
} from "../../../packages/kernel/src/domains/deploy/revoke_debt_store.ts";
import type {
  TakosumiDeploymentRecord,
  TakosumiDeploymentRecordStore,
  TakosumiDeploymentUpsertInput,
} from "../../../packages/kernel/src/domains/deploy/takosumi_deployment_record_store.ts";
import type { D1Database } from "./bindings.ts";

const DEPLOYMENT_NAMESPACE = "takosumi-deployment";
const IDEMPOTENCY_NAMESPACE = "takosumi-idempotency";
const JOURNAL_NAMESPACE = "takosumi-operation-journal";
const REVOKE_DEBT_NAMESPACE = "takosumi-revoke-debt";
const ARTIFACT_HASH_REGEX = /^sha256:[0-9a-f]{64}$/;

export interface CloudflareD1DeployStores {
  readonly deploymentRecordStore: TakosumiDeploymentRecordStore;
  readonly idempotencyStore: DeployPublicIdempotencyStore;
  readonly operationJournalStore: OperationJournalStore;
  readonly revokeDebtStore: RevokeDebtStore;
}

export function createCloudflareD1DeployStores(
  db: D1Database,
): CloudflareD1DeployStores {
  const records = new D1RecordTable(db);
  return {
    deploymentRecordStore: new D1TakosumiDeploymentRecordStore(records),
    idempotencyStore: new D1DeployPublicIdempotencyStore(records),
    operationJournalStore: new D1OperationJournalStore(records),
    revokeDebtStore: new D1RevokeDebtStore(records),
  };
}

class D1TakosumiDeploymentRecordStore implements TakosumiDeploymentRecordStore {
  readonly #locks: D1LeaseTable;

  constructor(private readonly records: D1RecordTable) {
    this.#locks = new D1LeaseTable(records, "deployment-lock");
  }

  async upsert(
    input: TakosumiDeploymentUpsertInput,
  ): Promise<TakosumiDeploymentRecord> {
    const key = naturalKey(input.tenantId, input.name);
    const existing = await this.get(input.tenantId, input.name);
    const record: TakosumiDeploymentRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      tenantId: input.tenantId,
      name: input.name,
      manifest: input.manifest,
      appliedResources: input.appliedResources,
      status: input.status,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    await this.records.put({
      namespace: DEPLOYMENT_NAMESPACE,
      key,
      tenantId: input.tenantId,
      name: input.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      record,
    });
    return freezeClone(record);
  }

  async get(
    tenantId: string,
    name: string,
  ): Promise<TakosumiDeploymentRecord | undefined> {
    return await this.records.get<TakosumiDeploymentRecord>(
      DEPLOYMENT_NAMESPACE,
      naturalKey(tenantId, name),
    );
  }

  async list(tenantId: string): Promise<readonly TakosumiDeploymentRecord[]> {
    return await this.records.listByTenant<TakosumiDeploymentRecord>(
      DEPLOYMENT_NAMESPACE,
      tenantId,
    );
  }

  async markDestroyed(
    tenantId: string,
    name: string,
    now: string,
  ): Promise<TakosumiDeploymentRecord | undefined> {
    const existing = await this.get(tenantId, name);
    if (!existing) return undefined;
    const updated: TakosumiDeploymentRecord = {
      ...existing,
      appliedResources: [],
      status: "destroyed",
      updatedAt: now,
    };
    await this.records.put({
      namespace: DEPLOYMENT_NAMESPACE,
      key: naturalKey(tenantId, name),
      tenantId,
      name,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      record: updated,
    });
    return freezeClone(updated);
  }

  remove(tenantId: string, name: string): Promise<boolean> {
    return this.records.delete(
      DEPLOYMENT_NAMESPACE,
      naturalKey(tenantId, name),
    );
  }

  acquireLock(tenantId: string, name: string): Promise<void> {
    return this.#locks.acquire(naturalKey(tenantId, name));
  }

  releaseLock(tenantId: string, name: string): Promise<void> {
    return this.#locks.release(naturalKey(tenantId, name));
  }

  async listReferencedArtifactHashes(): Promise<Set<string>> {
    const rows = await this.records.listNamespace<TakosumiDeploymentRecord>(
      DEPLOYMENT_NAMESPACE,
    );
    const hashes = new Set<string>();
    for (const row of rows) {
      collectArtifactHashes(row.manifest as JsonValue, hashes);
      for (const applied of row.appliedResources) {
        collectArtifactHashes(applied.outputs as JsonValue, hashes);
      }
    }
    return hashes;
  }
}

class D1DeployPublicIdempotencyStore implements DeployPublicIdempotencyStore {
  readonly #locks: D1LeaseTable;

  constructor(private readonly records: D1RecordTable) {
    this.#locks = new D1LeaseTable(records, "idempotency-lock");
  }

  get(
    tenantId: string,
    key: string,
  ): Promise<DeployPublicIdempotencyRecord | undefined> {
    return this.records.get<DeployPublicIdempotencyRecord>(
      IDEMPOTENCY_NAMESPACE,
      naturalKey(tenantId, key),
    );
  }

  async save(
    input: DeployPublicIdempotencySaveInput,
  ): Promise<DeployPublicIdempotencyRecord> {
    const key = naturalKey(input.tenantId, input.key);
    const existing = await this.records.get<DeployPublicIdempotencyRecord>(
      IDEMPOTENCY_NAMESPACE,
      key,
    );
    if (existing) return existing;
    const record: DeployPublicIdempotencyRecord = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      key: input.key,
      requestDigest: input.requestDigest,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
      createdAt: input.now,
    };
    await this.records.putIfAbsent({
      namespace: IDEMPOTENCY_NAMESPACE,
      key,
      tenantId: input.tenantId,
      name: input.key,
      createdAt: input.now,
      updatedAt: input.now,
      record,
    });
    return await this.get(input.tenantId, input.key) ?? record;
  }

  acquireLock(tenantId: string, key: string): Promise<void> {
    return this.#locks.acquire(naturalKey(tenantId, key));
  }

  releaseLock(tenantId: string, key: string): Promise<void> {
    return this.#locks.release(naturalKey(tenantId, key));
  }
}

class D1OperationJournalStore implements OperationJournalStore {
  constructor(private readonly records: D1RecordTable) {}

  async append(
    input: OperationJournalAppendInput,
  ): Promise<OperationJournalEntry> {
    const effectDigest = operationJournalEffectDigest(input.effect);
    const key = [
      input.spaceId,
      input.operationPlanDigest,
      input.journalEntryId,
      input.stage,
    ].join("\u0000");
    const existing = await this.records.get<OperationJournalEntry>(
      JOURNAL_NAMESPACE,
      key,
    );
    if (existing) {
      assertReplayCompatible(existing, effectDigest);
      return existing;
    }
    const entry: OperationJournalEntry = stripUndefined({
      id: crypto.randomUUID(),
      spaceId: input.spaceId,
      deploymentName: input.deploymentName,
      operationPlanDigest: input.operationPlanDigest,
      journalEntryId: input.journalEntryId,
      operationId: input.operationId,
      phase: input.phase,
      stage: input.stage,
      operationKind: input.operationKind,
      resourceName: input.resourceName,
      providerId: input.providerId,
      effectDigest,
      effect: input.effect,
      status: input.status ?? "recorded",
      createdAt: input.createdAt,
    }) as unknown as OperationJournalEntry;
    await this.records.putIfAbsent({
      namespace: JOURNAL_NAMESPACE,
      key,
      tenantId: input.spaceId,
      name: input.deploymentName ?? "",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      record: entry,
    });
    const stored = await this.records.get<OperationJournalEntry>(
      JOURNAL_NAMESPACE,
      key,
    );
    if (stored) {
      assertReplayCompatible(stored, effectDigest);
      return stored;
    }
    return freezeClone(entry);
  }

  async listByPlan(
    spaceId: string,
    operationPlanDigest: `sha256:${string}`,
  ): Promise<readonly OperationJournalEntry[]> {
    const entries = await this.records.listByTenant<OperationJournalEntry>(
      JOURNAL_NAMESPACE,
      spaceId,
    );
    return entries
      .filter((entry) => entry.operationPlanDigest === operationPlanDigest)
      .sort(compareJournalEntries);
  }

  async listByDeployment(
    spaceId: string,
    deploymentName: string,
  ): Promise<readonly OperationJournalEntry[]> {
    const entries = await this.records.listByTenantAndName<
      OperationJournalEntry
    >(
      JOURNAL_NAMESPACE,
      spaceId,
      deploymentName,
    );
    return entries.sort(compareJournalEntries);
  }
}

class D1RevokeDebtStore implements RevokeDebtStore {
  constructor(private readonly records: D1RecordTable) {}

  async enqueue(input: RevokeDebtEnqueueInput): Promise<RevokeDebtRecord> {
    const sourceKey = revokeDebtSourceKey(input);
    const existing = await this.records.get<RevokeDebtRecord>(
      REVOKE_DEBT_NAMESPACE,
      sourceKey,
    );
    if (existing) return existing;
    const record: RevokeDebtRecord = stripUndefined({
      id: `revoke-debt:${crypto.randomUUID()}`,
      sourceKey,
      generatedObjectId: input.generatedObjectId,
      sourceExportSnapshotId: input.sourceExportSnapshotId,
      externalParticipantId: input.externalParticipantId,
      reason: input.reason,
      status: "open",
      ownerSpaceId: input.ownerSpaceId,
      originatingSpaceId: input.originatingSpaceId ?? input.ownerSpaceId,
      deploymentName: input.deploymentName,
      operationPlanDigest: input.operationPlanDigest,
      journalEntryId: input.journalEntryId,
      operationId: input.operationId,
      resourceName: input.resourceName,
      providerId: input.providerId,
      retryPolicy: input.retryPolicy ?? defaultRetryPolicy(),
      retryAttempts: 0,
      nextRetryAt: input.now,
      detail: input.detail,
      createdAt: input.now,
      statusUpdatedAt: input.now,
    }) as unknown as RevokeDebtRecord;
    await this.records.putIfAbsent({
      namespace: REVOKE_DEBT_NAMESPACE,
      key: sourceKey,
      tenantId: input.ownerSpaceId,
      name: input.deploymentName ?? "",
      createdAt: input.now,
      updatedAt: input.now,
      record,
    });
    return await this.records.get<RevokeDebtRecord>(
      REVOKE_DEBT_NAMESPACE,
      sourceKey,
    ) ?? freezeClone(record);
  }

  async listByOwnerSpace(
    ownerSpaceId: string,
  ): Promise<readonly RevokeDebtRecord[]> {
    return (await this.records.listByTenant<RevokeDebtRecord>(
      REVOKE_DEBT_NAMESPACE,
      ownerSpaceId,
    )).sort(compareRevokeDebtRecords);
  }

  async listByDeployment(
    ownerSpaceId: string,
    deploymentName: string,
  ): Promise<readonly RevokeDebtRecord[]> {
    return (await this.records.listByTenantAndName<RevokeDebtRecord>(
      REVOKE_DEBT_NAMESPACE,
      ownerSpaceId,
      deploymentName,
    )).sort(compareRevokeDebtRecords);
  }

  async listOpenOwnerSpaces(): Promise<readonly string[]> {
    const debts = await this.records.listNamespace<RevokeDebtRecord>(
      REVOKE_DEBT_NAMESPACE,
    );
    return Array.from(
      new Set(
        debts
          .filter((record) => record.status === "open")
          .map((record) => record.ownerSpaceId),
      ),
    ).sort();
  }

  async recordRetryAttempt(
    input: RevokeDebtRetryAttemptInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getOwned(input);
    if (!existing) return undefined;
    return await this.#replace(recordRevokeDebtRetryAttempt(existing, input));
  }

  async ageOpenDebts(
    input: RevokeDebtAgeOpenInput,
  ): Promise<readonly RevokeDebtRecord[]> {
    const aged: RevokeDebtRecord[] = [];
    const rows = await this.listByOwnerSpace(input.ownerSpaceId);
    for (const record of rows) {
      if (input.limit !== undefined && aged.length >= input.limit) break;
      const next = ageRevokeDebtIfDue(record, input.now);
      if (!next) continue;
      aged.push(await this.#replace(next));
    }
    return aged;
  }

  async markOperatorActionRequired(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getOwned(input);
    if (!existing) return undefined;
    return await this.#replace(
      markRevokeDebtOperatorActionRequired(existing, input.now),
    );
  }

  async reopen(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getOwned(input);
    if (!existing) return undefined;
    return await this.#replace(reopenRevokeDebt(existing, input.now));
  }

  async clear(
    input: RevokeDebtTransitionInput,
  ): Promise<RevokeDebtRecord | undefined> {
    const existing = await this.#getOwned(input);
    if (!existing) return undefined;
    return await this.#replace(clearRevokeDebt(existing, input.now));
  }

  async #getOwned(input: {
    readonly id: string;
    readonly ownerSpaceId: string;
  }): Promise<RevokeDebtRecord | undefined> {
    const rows = await this.records.listByTenant<RevokeDebtRecord>(
      REVOKE_DEBT_NAMESPACE,
      input.ownerSpaceId,
    );
    return rows.find((row) => row.id === input.id);
  }

  async #replace(record: RevokeDebtRecord): Promise<RevokeDebtRecord> {
    await this.records.put({
      namespace: REVOKE_DEBT_NAMESPACE,
      key: record.sourceKey,
      tenantId: record.ownerSpaceId,
      name: record.deploymentName ?? "",
      createdAt: record.createdAt,
      updatedAt: record.statusUpdatedAt,
      record,
    });
    return freezeClone(record);
  }
}

class D1RecordTable {
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {}

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.db.prepare(
      `select record_json from takosumi_cf_records
       where namespace = ? and key = ?`,
    ).bind(namespace, key).first<{ record_json: string }>();
    return row ? JSON.parse(row.record_json) as T : undefined;
  }

  async put(input: RecordPutInput): Promise<void> {
    await this.#ensureSchema();
    await this.db.prepare(
      `insert into takosumi_cf_records
        (namespace, key, tenant_id, name, created_at, updated_at, record_json)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (namespace, key) do update set
        tenant_id = excluded.tenant_id,
        name = excluded.name,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json`,
    ).bind(
      input.namespace,
      input.key,
      input.tenantId,
      input.name,
      input.createdAt,
      input.updatedAt,
      JSON.stringify(input.record),
    ).run();
  }

  async putIfAbsent(input: RecordPutInput): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `insert or ignore into takosumi_cf_records
        (namespace, key, tenant_id, name, created_at, updated_at, record_json)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.namespace,
      input.key,
      input.tenantId,
      input.name,
      input.createdAt,
      input.updatedAt,
      JSON.stringify(input.record),
    ).run();
    return changes(result) > 0;
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      "delete from takosumi_cf_records where namespace = ? and key = ?",
    ).bind(namespace, key).run();
    return changes(result) > 0;
  }

  async listNamespace<T>(namespace: string): Promise<T[]> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `select record_json from takosumi_cf_records
       where namespace = ?
       order by created_at asc, key asc`,
    ).bind(namespace).all<{ record_json: string }>();
    return rows(result).map((row) => JSON.parse(row.record_json) as T);
  }

  async listByTenant<T>(namespace: string, tenantId: string): Promise<T[]> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `select record_json from takosumi_cf_records
       where namespace = ? and tenant_id = ?
       order by created_at asc, key asc`,
    ).bind(namespace, tenantId).all<{ record_json: string }>();
    return rows(result).map((row) => JSON.parse(row.record_json) as T);
  }

  async listByTenantAndName<T>(
    namespace: string,
    tenantId: string,
    name: string,
  ): Promise<T[]> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `select record_json from takosumi_cf_records
       where namespace = ? and tenant_id = ? and name = ?
       order by created_at asc, key asc`,
    ).bind(namespace, tenantId, name).all<{ record_json: string }>();
    return rows(result).map((row) => JSON.parse(row.record_json) as T);
  }

  async acquireLease(input: {
    readonly namespace: string;
    readonly key: string;
    readonly ownerToken: string;
    readonly lockedUntil: number;
    readonly now: number;
  }): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `insert into takosumi_cf_locks
        (namespace, key, owner_token, locked_until, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict (namespace, key) do update set
        owner_token = excluded.owner_token,
        locked_until = excluded.locked_until,
        updated_at = excluded.updated_at
       where takosumi_cf_locks.locked_until <= ?
          or takosumi_cf_locks.owner_token = ?`,
    ).bind(
      input.namespace,
      input.key,
      input.ownerToken,
      input.lockedUntil,
      new Date(input.now).toISOString(),
      input.now,
      input.ownerToken,
    ).run();
    return changes(result) > 0;
  }

  async releaseLease(input: {
    readonly namespace: string;
    readonly key: string;
    readonly ownerToken: string;
  }): Promise<void> {
    await this.#ensureSchema();
    await this.db.prepare(
      `delete from takosumi_cf_locks
       where namespace = ? and key = ? and owner_token = ?`,
    ).bind(input.namespace, input.key, input.ownerToken).run();
  }

  async #ensureSchema(): Promise<void> {
    this.#initialized ??= ensureD1RecordSchema(this.db);
    await this.#initialized;
  }
}

class D1LeaseTable {
  readonly #held = new Map<string, string>();

  constructor(
    private readonly records: D1RecordTable,
    private readonly namespace: string,
  ) {}

  async acquire(key: string): Promise<void> {
    const ownerToken = crypto.randomUUID();
    while (true) {
      const now = Date.now();
      const acquired = await this.records.acquireLease({
        namespace: this.namespace,
        key,
        ownerToken,
        lockedUntil: now + 30_000,
        now,
      });
      if (acquired) {
        this.#held.set(key, ownerToken);
        return;
      }
      await sleep(50);
    }
  }

  async release(key: string): Promise<void> {
    const ownerToken = this.#held.get(key);
    if (!ownerToken) return;
    this.#held.delete(key);
    await this.records.releaseLease({
      namespace: this.namespace,
      key,
      ownerToken,
    });
  }
}

interface RecordPutInput {
  readonly namespace: string;
  readonly key: string;
  readonly tenantId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly record: unknown;
}

async function ensureD1RecordSchema(db: D1Database): Promise<void> {
  await db.prepare(
    `create table if not exists takosumi_cf_records (
      namespace text not null,
      key text not null,
      tenant_id text not null,
      name text not null,
      created_at text not null,
      updated_at text not null,
      record_json text not null,
      primary key (namespace, key)
    )`,
  ).run();
  await db.prepare(
    `create index if not exists takosumi_cf_records_tenant_idx
      on takosumi_cf_records (namespace, tenant_id, created_at, key)`,
  ).run();
  await db.prepare(
    `create index if not exists takosumi_cf_records_tenant_name_idx
      on takosumi_cf_records (namespace, tenant_id, name, created_at, key)`,
  ).run();
  await db.prepare(
    `create table if not exists takosumi_cf_locks (
      namespace text not null,
      key text not null,
      owner_token text not null,
      locked_until integer not null,
      updated_at text not null,
      primary key (namespace, key)
    )`,
  ).run();
  await db.prepare(
    `create index if not exists takosumi_cf_locks_expiry_idx
      on takosumi_cf_locks (locked_until)`,
  ).run();
}

function rows<T>(result: { readonly results?: readonly T[] }): T[] {
  return [...(result.results ?? [])];
}

function changes(result: { readonly meta?: { readonly changes?: number } }) {
  return result.meta?.changes ?? 0;
}

function naturalKey(left: string, right: string): string {
  return JSON.stringify([left, right]);
}

function collectArtifactHashes(value: JsonValue, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (ARTIFACT_HASH_REGEX.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectArtifactHashes(entry, into);
    return;
  }
  if (typeof value === "object") {
    for (const inner of Object.values(value)) {
      collectArtifactHashes(inner as JsonValue, into);
    }
  }
}

function stripUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner !== undefined) out[key] = inner;
  }
  return out;
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
