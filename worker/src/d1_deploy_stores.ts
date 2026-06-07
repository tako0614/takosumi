import type { JsonValue } from "takosumi-contract/reference/compat";
import { and, asc, eq, lte, or } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  ageRevokeDebtIfDue,
  clearRevokeDebt,
  compareRevokeDebtRecords,
  defaultRetryPolicy,
  markRevokeDebtOperatorActionRequired,
  recordRevokeDebtRetryAttempt,
  reopenRevokeDebt,
  type RevokeDebtAgeOpenInput,
  type RevokeDebtDueOpenInput,
  type RevokeDebtEnqueueInput,
  type RevokeDebtRecord,
  type RevokeDebtRetryAttemptInput,
  revokeDebtSourceKey,
  type RevokeDebtStore,
  type RevokeDebtTransitionInput,
} from "../../src/service/domains/deploy-records/revoke_debt_store.ts";
import type {
  TakosumiDeploymentRecord,
  TakosumiDeploymentRecordStore,
  TakosumiDeploymentUpsertInput,
} from "../../src/service/domains/deploy-records/deployment_record_store.ts";
import type { D1Database } from "./bindings.ts";

const cfRecords = sqliteTable(
  "takosumi_cf_records",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    recordJson: text("record_json", { mode: "json" })
      .$type<unknown>()
      .notNull(),
  },
  (table) => [
    index("takosumi_cf_records_tenant_idx").on(
      table.namespace,
      table.tenantId,
      table.createdAt,
      table.key,
    ),
    index("takosumi_cf_records_tenant_name_idx").on(
      table.namespace,
      table.tenantId,
      table.name,
      table.createdAt,
      table.key,
    ),
  ],
);

const cfLocks = sqliteTable(
  "takosumi_cf_locks",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    ownerToken: text("owner_token").notNull(),
    lockedUntil: integer("locked_until").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("takosumi_cf_locks_expiry_idx").on(table.lockedUntil)],
);

const d1DeploySchema = { cfRecords, cfLocks };

const DEPLOYMENT_NAMESPACE = "takosumi-deployment";
const REVOKE_DEBT_NAMESPACE = "takosumi-revoke-debt";
const ARTIFACT_HASH_REGEX = /^sha256:[0-9a-f]{64}$/;

export interface CloudflareD1DeployStores {
  readonly deploymentRecordStore: TakosumiDeploymentRecordStore;
  readonly revokeDebtStore: RevokeDebtStore;
}

export function createCloudflareD1DeployStores(
  db: D1Database,
): CloudflareD1DeployStores {
  const records = new D1RecordTable(db);
  return {
    deploymentRecordStore: new D1TakosumiDeploymentRecordStore(records),
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
      sourceEvidence: input.sourceEvidence,
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
    const rows =
      await this.records.listNamespace<TakosumiDeploymentRecord>(
        DEPLOYMENT_NAMESPACE,
      );
    const hashes = new Set<string>();
    for (const row of rows) {
      collectArtifactHashes(row.sourceEvidence as JsonValue, hashes);
      for (const applied of row.appliedResources) {
        collectArtifactHashes(applied.outputs as JsonValue, hashes);
      }
    }
    return hashes;
  }
}

class D1RevokeDebtStore implements RevokeDebtStore {
  constructor(private readonly records: D1RecordTable) {}

  async enqueue(input: RevokeDebtEnqueueInput): Promise<RevokeDebtRecord> {
    // `revokeDebtSourceKey` became async after the service switched off
    // `node:crypto` to Web Crypto (`crypto.subtle.digest`).
    const sourceKey = await revokeDebtSourceKey(input);
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
    return (
      (await this.records.get<RevokeDebtRecord>(
        REVOKE_DEBT_NAMESPACE,
        sourceKey,
      )) ?? freezeClone(record)
    );
  }

  async listByOwnerSpace(
    ownerSpaceId: string,
  ): Promise<readonly RevokeDebtRecord[]> {
    return (
      await this.records.listByTenant<RevokeDebtRecord>(
        REVOKE_DEBT_NAMESPACE,
        ownerSpaceId,
      )
    ).sort(compareRevokeDebtRecords);
  }

  async listByDeployment(
    ownerSpaceId: string,
    deploymentName: string,
  ): Promise<readonly RevokeDebtRecord[]> {
    return (
      await this.records.listByTenantAndName<RevokeDebtRecord>(
        REVOKE_DEBT_NAMESPACE,
        ownerSpaceId,
        deploymentName,
      )
    ).sort(compareRevokeDebtRecords);
  }

  async listDueOpenDebts(
    input: RevokeDebtDueOpenInput,
  ): Promise<readonly RevokeDebtRecord[]> {
    // Mirror the SQL store: only `open` debts whose `nextRetryAt` is set and
    // due (<= now) are returned, ordered by `compareRevokeDebtRecords`
    // (createdAt asc, id asc, via listByOwnerSpace) and bounded by `limit`.
    // ISO-8601 timestamps compare lexicographically, matching the SQL
    // `next_retry_at <= now` predicate.
    const due = (await this.listByOwnerSpace(input.ownerSpaceId)).filter(
      (record) =>
        record.status === "open" &&
        record.nextRetryAt !== undefined &&
        record.nextRetryAt !== null &&
        record.nextRetryAt <= input.now,
    );
    return input.limit !== undefined ? due.slice(0, input.limit) : due;
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
  readonly #orm: DrizzleD1Database<typeof d1DeploySchema>;
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {
    this.#orm = drizzle(db, { schema: d1DeploySchema });
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.#orm
      .select({ recordJson: cfRecords.recordJson })
      .from(cfRecords)
      .where(and(eq(cfRecords.namespace, namespace), eq(cfRecords.key, key)))
      .get();
    return row?.recordJson as T | undefined;
  }

  async put(input: RecordPutInput): Promise<void> {
    await this.#ensureSchema();
    await this.#orm
      .insert(cfRecords)
      .values(recordValues(input))
      .onConflictDoUpdate({
        target: [cfRecords.namespace, cfRecords.key],
        set: {
          tenantId: input.tenantId,
          name: input.name,
          updatedAt: input.updatedAt,
          recordJson: input.record,
        },
      })
      .run();
  }

  async putIfAbsent(input: RecordPutInput): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.#orm
      .insert(cfRecords)
      .values(recordValues(input))
      .onConflictDoNothing({
        target: [cfRecords.namespace, cfRecords.key],
      })
      .run();
    return changes(result) > 0;
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.#orm
      .delete(cfRecords)
      .where(and(eq(cfRecords.namespace, namespace), eq(cfRecords.key, key)))
      .run();
    return changes(result) > 0;
  }

  async listNamespace<T>(namespace: string): Promise<T[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select({ recordJson: cfRecords.recordJson })
      .from(cfRecords)
      .where(eq(cfRecords.namespace, namespace))
      .orderBy(asc(cfRecords.createdAt), asc(cfRecords.key));
    return rows.map((row) => row.recordJson as T);
  }

  async listByTenant<T>(namespace: string, tenantId: string): Promise<T[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select({ recordJson: cfRecords.recordJson })
      .from(cfRecords)
      .where(
        and(
          eq(cfRecords.namespace, namespace),
          eq(cfRecords.tenantId, tenantId),
        ),
      )
      .orderBy(asc(cfRecords.createdAt), asc(cfRecords.key));
    return rows.map((row) => row.recordJson as T);
  }

  async listByTenantAndName<T>(
    namespace: string,
    tenantId: string,
    name: string,
  ): Promise<T[]> {
    await this.#ensureSchema();
    const rows = await this.#orm
      .select({ recordJson: cfRecords.recordJson })
      .from(cfRecords)
      .where(
        and(
          eq(cfRecords.namespace, namespace),
          eq(cfRecords.tenantId, tenantId),
          eq(cfRecords.name, name),
        ),
      )
      .orderBy(asc(cfRecords.createdAt), asc(cfRecords.key));
    return rows.map((row) => row.recordJson as T);
  }

  async acquireLease(input: {
    readonly namespace: string;
    readonly key: string;
    readonly ownerToken: string;
    readonly lockedUntil: number;
    readonly now: number;
  }): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.#orm
      .insert(cfLocks)
      .values({
        namespace: input.namespace,
        key: input.key,
        ownerToken: input.ownerToken,
        lockedUntil: input.lockedUntil,
        updatedAt: new Date(input.now).toISOString(),
      })
      .onConflictDoUpdate({
        target: [cfLocks.namespace, cfLocks.key],
        set: {
          ownerToken: input.ownerToken,
          lockedUntil: input.lockedUntil,
          updatedAt: new Date(input.now).toISOString(),
        },
        where: or(
          lte(cfLocks.lockedUntil, input.now),
          eq(cfLocks.ownerToken, input.ownerToken),
        ),
      })
      .run();
    return changes(result) > 0;
  }

  async releaseLease(input: {
    readonly namespace: string;
    readonly key: string;
    readonly ownerToken: string;
  }): Promise<void> {
    await this.#ensureSchema();
    await this.#orm
      .delete(cfLocks)
      .where(
        and(
          eq(cfLocks.namespace, input.namespace),
          eq(cfLocks.key, input.key),
          eq(cfLocks.ownerToken, input.ownerToken),
        ),
      )
      .run();
  }

  async #ensureSchema(): Promise<void> {
    this.#initialized ??= ensureD1RecordSchema(this.db);
    await this.#initialized;
  }
}

function recordValues(input: RecordPutInput) {
  return {
    namespace: input.namespace,
    key: input.key,
    tenantId: input.tenantId,
    name: input.name,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    recordJson: input.record,
  };
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
  await db
    .prepare(
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
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_cf_records_tenant_idx
      on takosumi_cf_records (namespace, tenant_id, created_at, key)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_cf_records_tenant_name_idx
      on takosumi_cf_records (namespace, tenant_id, name, created_at, key)`,
    )
    .run();
  await db
    .prepare(
      `create table if not exists takosumi_cf_locks (
      namespace text not null,
      key text not null,
      owner_token text not null,
      locked_until integer not null,
      updated_at text not null,
      primary key (namespace, key)
    )`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_cf_locks_expiry_idx
      on takosumi_cf_locks (locked_until)`,
    )
    .run();
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
