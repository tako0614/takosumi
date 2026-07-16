// Cloudflare D1 (SQLite) implementations of the Resource Shape stores.
// Runtime records use bound SQL against the shared deploy-control D1 database;
// the physical schema is created by ensureD1OpenTofuLedgerSchema.

import type {
  Condition,
  FormRef,
  InstalledFormReference,
  JsonObject,
  NativeResourceRef,
  ResourceManagedBy,
  ResourcePhase,
  ResourcePortability,
  ResourceShapeKind,
  TargetImplementationDescriptor,
  TargetPoolEntry,
} from "takosumi-contract";
import {
  isInstalledFormReference,
  parseResourceShapeKind,
} from "takosumi-contract";
import {
  clampPageLimit,
  decodeCursor,
  pageFromProbe,
  type Page,
  type PageParams,
} from "takosumi-contract/pagination";
import { deployControlD1TableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { SpaceId } from "../../shared/ids.ts";
import type { IsoTimestamp } from "../../shared/time.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeExecutionRecord,
  ResourceShapeRecord,
  ResourceShapeRecordId,
  ResourceShapeStateAdoptionDescriptor,
  SpacePolicyRecord,
  SpacePolicyRecordId,
  TargetPoolRecord,
  TargetPoolRecordId,
} from "./records.ts";
import { assertResourceFormIdentity } from "./records.ts";
import type {
  ResourceApplyAbortInput,
  ResourceApplyAbortResult,
  ResourceApplyBeginInput,
  ResourceApplyBeginResult,
  ResourceApplyCommitInput,
  ResourceApplyCommitResult,
  ResourceAtomicRemoveInput,
  ResourceAtomicRemoveResult,
  ResourceCreateResult,
  ResourceDeleteClaimResult,
  ResourceObservationClaimInput,
  ResolutionLockStore,
  ResourceShapeStore,
  ResourceShapeStores,
  SpacePolicyStore,
  TargetPoolCreateResult,
  TargetPoolStore,
} from "./stores.ts";
import {
  assertAbortInput,
  assertAtomicRemoveInput,
  assertApplyPair,
  matchesApplyLock,
  matchesExpectedLock,
  matchesVersion,
} from "./stores.ts";

export interface D1Like {
  prepare(query: string): D1LikePreparedStatement;
  batch?<T = unknown>(
    statements: readonly D1LikePreparedStatement[],
  ): Promise<
    readonly {
      readonly meta?: { readonly changes?: number };
    }[]
  >;
}

interface D1LikePreparedStatement {
  bind(...values: readonly unknown[]): D1LikePreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ readonly results?: readonly T[] }>;
  run<T = unknown>(): Promise<{
    readonly meta?: { readonly changes?: number };
  }>;
}

interface ResourceShapeRow {
  readonly id: string;
  readonly space_id: string;
  readonly project: string | null;
  readonly environment: string | null;
  readonly kind: string;
  readonly form_ref_json: string | null;
  readonly package_digest: string | null;
  readonly name: string;
  readonly managed_by: string;
  readonly spec_json: string;
  readonly phase: string;
  readonly generation: number;
  readonly observed_generation: number;
  readonly outputs_json: string | null;
  readonly execution_json: string | null;
  readonly state_adoption_json: string | null;
  readonly conditions_json: string | null;
  readonly labels_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ResolutionLockRow {
  readonly resource_id: string;
  readonly form_ref_json: string | null;
  readonly package_digest: string | null;
  readonly selected_implementation: string;
  readonly target_pool: string | null;
  readonly target: string;
  readonly target_snapshot_json: string | null;
  readonly implementation_snapshot_json: string | null;
  readonly implementation_plugin: string | null;
  readonly implementation_options_json: string | null;
  readonly implementation_fingerprint: string | null;
  readonly locked: number;
  readonly reason_json: string;
  readonly portability: string | null;
  readonly native_resources_json: string | null;
  readonly locked_at: string;
  readonly updated_at: string;
}

interface NamedSpecRow {
  readonly id: string;
  readonly space_id: string;
  readonly name: string;
  readonly spec_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

class D1ResourceShapeStore implements ResourceShapeStore {
  readonly #table = names.resourceShapes;

  constructor(private readonly db: D1Like) {}

  async create(record: ResourceShapeRecord): Promise<ResourceCreateResult> {
    const result = await this.db
      .prepare(resourceInsertSql(this.#table, "on conflict do nothing"))
      .bind(...resourceParameters(record))
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return { status: "created", record };
    }
    const current = await this.get(record.id);
    if (!current) {
      throw new Error(`resource create conflict did not resolve ${record.id}`);
    }
    return { status: "conflict", record: current };
  }

  async upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord> {
    await this.db
      .prepare(
        resourceInsertSql(
          this.#table,
          `on conflict (id) do update set
            space_id = excluded.space_id,
            project = excluded.project,
            environment = excluded.environment,
            kind = excluded.kind,
            form_ref_json = excluded.form_ref_json,
            package_digest = excluded.package_digest,
            name = excluded.name,
            managed_by = excluded.managed_by,
            spec_json = excluded.spec_json,
            phase = excluded.phase,
            generation = excluded.generation,
            observed_generation = excluded.observed_generation,
            outputs_json = excluded.outputs_json,
            execution_json = excluded.execution_json,
            state_adoption_json = excluded.state_adoption_json,
            conditions_json = excluded.conditions_json,
            labels_json = excluded.labels_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
        ),
      )
      .bind(...resourceParameters(record))
      .run();
    return record;
  }

  async get(
    id: ResourceShapeRecordId,
  ): Promise<ResourceShapeRecord | undefined> {
    const row = await this.db
      .prepare(`select * from ${this.#table} where id = ? limit 1`)
      .bind(id)
      .first<ResourceShapeRow>();
    return row ? resourceShapeFromRow(row) : undefined;
  }

  async getByName(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ResourceShapeRecord | undefined> {
    const row = await this.db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? and kind = ? and name = ? limit 1`,
      )
      .bind(spaceId, kind, name)
      .first<ResourceShapeRow>();
    return row ? resourceShapeFromRow(row) : undefined;
  }

  async deleteIfVersion(
    id: ResourceShapeRecordId,
    expected: {
      readonly generation: number;
      readonly phase: ResourcePhase;
      readonly updatedAt: string;
    },
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `delete from ${this.#table}
         where id = ? and generation = ? and phase = ? and updated_at = ?`,
      )
      .bind(id, expected.generation, expected.phase, expected.updatedAt)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly ResourceShapeRecord[]> {
    const rows = await this.db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? order by kind asc, name asc, id asc`,
      )
      .bind(spaceId)
      .all<ResourceShapeRow>();
    return (rows.results ?? []).map(resourceShapeFromRow);
  }

  async listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = cursor
      ? await this.db
          .prepare(
            `select * from ${this.#table}
             where space_id = ?
               and (created_at > ? or (created_at = ? and id > ?))
             order by created_at asc, id asc limit ?`,
          )
          .bind(
            spaceId,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
            limit + 1,
          )
          .all<ResourceShapeRow>()
      : await this.db
          .prepare(
            `select * from ${this.#table}
             where space_id = ? order by created_at asc, id asc limit ?`,
          )
          .bind(spaceId, limit + 1)
          .all<ResourceShapeRow>();
    return pageFromProbe((rows.results ?? []).map(resourceShapeFromRow), limit);
  }

  async listReadyByKindPage(
    kind: ResourceShapeKind,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = cursor
      ? await this.db
          .prepare(
            `select * from ${this.#table}
             where kind = ? and phase = 'Ready'
               and observed_generation = generation
               and (created_at > ? or (created_at = ? and id > ?))
             order by created_at asc, id asc limit ?`,
          )
          .bind(kind, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
          .all<ResourceShapeRow>()
      : await this.db
          .prepare(
            `select * from ${this.#table}
             where kind = ? and phase = 'Ready'
               and observed_generation = generation
             order by created_at asc, id asc limit ?`,
          )
          .bind(kind, limit + 1)
          .all<ResourceShapeRow>();
    return pageFromProbe((rows.results ?? []).map(resourceShapeFromRow), limit);
  }

  async claimObservationCandidate(
    input: ResourceObservationClaimInput,
  ): Promise<ResourceShapeRecord | undefined> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const selected = await this.db
        .prepare(
          `select id from ${this.#table}
           where phase = 'Ready'
             and observed_generation = generation
             and (last_observation_attempt_at is null
               or last_observation_attempt_at <= ?)
             and (observation_lease_id is null
               or observation_claimed_at is null
               or observation_claimed_at <= ?)
           order by coalesce(last_observation_attempt_at, created_at) asc, id asc
           limit 1`,
        )
        .bind(input.dueBefore, input.staleClaimBefore)
        .first<{ readonly id: string }>();
      if (!selected) return undefined;
      const claimed = await this.db
        .prepare(
          `update ${this.#table}
           set observation_lease_id = ?, observation_claimed_at = ?
           where id = ? and phase = 'Ready'
             and observed_generation = generation
             and (last_observation_attempt_at is null
               or last_observation_attempt_at <= ?)
             and (observation_lease_id is null
               or observation_claimed_at is null
               or observation_claimed_at <= ?)`,
        )
        .bind(
          input.leaseId,
          input.claimedAt,
          selected.id,
          input.dueBefore,
          input.staleClaimBefore,
        )
        .run();
      if ((claimed.meta?.changes ?? 0) === 0) continue;
      return await this.get(selected.id);
    }
    return undefined;
  }

  async finishObservationClaim(
    id: ResourceShapeRecordId,
    leaseId: string,
    attemptedAt: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `update ${this.#table}
         set observation_lease_id = null,
             observation_claimed_at = null,
             last_observation_attempt_at = ?
         where id = ? and observation_lease_id = ?`,
      )
      .bind(attemptedAt, id, leaseId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async confirmStateAdoption(
    id: ResourceShapeRecordId,
    descriptor: ResourceShapeStateAdoptionDescriptor,
    expectedUpdatedAt: string,
  ): Promise<
    | { readonly status: "confirmed"; readonly record: ResourceShapeRecord }
    | { readonly status: "not_found" }
    | { readonly status: "conflict"; readonly record: ResourceShapeRecord }
  > {
    const result = await this.db
      .prepare(
        `update ${this.#table}
         set state_adoption_json = ?, updated_at = ?
         where id = ? and updated_at = ?
           and execution_json is null and state_adoption_json is null`,
      )
      .bind(
        JSON.stringify(descriptor),
        descriptor.confirmedAt,
        id,
        expectedUpdatedAt,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      const record = await this.get(id);
      return record ? { status: "confirmed", record } : { status: "not_found" };
    }
    const current = await this.get(id);
    return current
      ? { status: "conflict", record: current }
      : { status: "not_found" };
  }

  async compareAndSet(
    record: ResourceShapeRecord,
    expected: {
      readonly generation: number;
      readonly phase: ResourceShapeRecord["phase"];
      readonly updatedAt: string;
    },
  ): Promise<
    | { readonly status: "updated"; readonly record: ResourceShapeRecord }
    | { readonly status: "not_found" }
    | { readonly status: "conflict"; readonly record: ResourceShapeRecord }
  > {
    const result = await this.db
      .prepare(
        `update ${this.#table} set
          space_id = ?, project = ?, environment = ?, kind = ?,
          form_ref_json = ?, package_digest = ?, name = ?, managed_by = ?,
          spec_json = ?, phase = ?, generation = ?, observed_generation = ?,
          outputs_json = ?, execution_json = ?, state_adoption_json = ?,
          conditions_json = ?, labels_json = ?, created_at = ?, updated_at = ?
         where id = ? and generation = ? and phase = ? and updated_at = ?`,
      )
      .bind(
        ...resourceParameters(record).slice(1),
        record.id,
        expected.generation,
        expected.phase,
        expected.updatedAt,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return { status: "updated", record };
    }
    const current = await this.get(record.id);
    return current
      ? { status: "conflict", record: current }
      : { status: "not_found" };
  }

  async claimDelete(
    record: ResourceShapeRecord,
    expectedGeneration: number,
    expectedManagedBy: ResourceManagedBy,
  ): Promise<ResourceDeleteClaimResult> {
    const result = await this.db
      .prepare(
        `update ${this.#table}
         set phase = ?, conditions_json = ?, updated_at = ?
         where id = ? and generation = ? and managed_by = ? and phase != 'Deleting'`,
      )
      .bind(
        record.phase,
        jsonOrNull(record.conditions),
        record.updatedAt,
        record.id,
        expectedGeneration,
        expectedManagedBy,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return { status: "claimed", record };
    }
    const current = await this.get(record.id);
    if (!current) return { status: "not_found" };
    if (current.managedBy !== expectedManagedBy) {
      return { status: "ownership_conflict", record: current };
    }
    if (current.phase === "Deleting") {
      return { status: "already_deleting", record: current };
    }
    return { status: "conflict", record: current };
  }

  async delete(id: ResourceShapeRecordId): Promise<void> {
    await this.db
      .prepare(`delete from ${this.#table} where id = ?`)
      .bind(id)
      .run();
  }
}

class D1ResolutionLockStore implements ResolutionLockStore {
  readonly #table = names.resolutionLocks;

  constructor(private readonly db: D1Like) {}

  async put(lock: ResolutionLockRecord): Promise<ResolutionLockRecord> {
    await this.db
      .prepare(lockUpsertSql(this.#table))
      .bind(...lockParameters(lock))
      .run();
    return lock;
  }

  async get(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResolutionLockRecord | undefined> {
    const row = await this.db
      .prepare(`select * from ${this.#table} where resource_id = ? limit 1`)
      .bind(resourceId)
      .first<ResolutionLockRow>();
    return row ? resolutionLockFromRow(row) : undefined;
  }

  async delete(resourceId: ResourceShapeRecordId): Promise<void> {
    await this.db
      .prepare(`delete from ${this.#table} where resource_id = ?`)
      .bind(resourceId)
      .run();
  }
}

class D1TargetPoolStore implements TargetPoolStore {
  readonly #table = names.targetPools;

  constructor(private readonly db: D1Like) {}

  async create(record: TargetPoolRecord): Promise<TargetPoolCreateResult> {
    const result = await this.db
      .prepare(namedSpecCreateSql(this.#table, "?"))
      .bind(...namedSpecParameters(record))
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return { status: "created", record };
    }
    const existing =
      (await this.getByName(record.spaceId, record.name)) ??
      (await this.get(record.id));
    if (!existing) {
      throw new Error("TargetPool create conflict has no durable winner");
    }
    return { status: "conflict", record: existing };
  }

  async upsert(record: TargetPoolRecord): Promise<TargetPoolRecord> {
    await this.db
      .prepare(namedSpecUpsertSql(this.#table))
      .bind(...namedSpecParameters(record))
      .run();
    return record;
  }

  async get(id: TargetPoolRecordId): Promise<TargetPoolRecord | undefined> {
    const row = await this.db
      .prepare(`select * from ${this.#table} where id = ? limit 1`)
      .bind(id)
      .first<NamedSpecRow>();
    return row ? targetPoolFromRow(row) : undefined;
  }

  async getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined> {
    const row = await this.db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? and name = ? limit 1`,
      )
      .bind(spaceId, name)
      .first<NamedSpecRow>();
    return row ? targetPoolFromRow(row) : undefined;
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly TargetPoolRecord[]> {
    const rows = await this.db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? order by name asc, id asc`,
      )
      .bind(spaceId)
      .all<NamedSpecRow>();
    return (rows.results ?? []).map(targetPoolFromRow);
  }

  async listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<TargetPoolRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = cursor
      ? await this.db
          .prepare(
            `select * from ${this.#table}
             where space_id = ?
               and (created_at > ? or (created_at = ? and id > ?))
             order by created_at asc, id asc limit ?`,
          )
          .bind(
            spaceId,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
            limit + 1,
          )
          .all<NamedSpecRow>()
      : await this.db
          .prepare(
            `select * from ${this.#table}
             where space_id = ? order by created_at asc, id asc limit ?`,
          )
          .bind(spaceId, limit + 1)
          .all<NamedSpecRow>();
    return pageFromProbe((rows.results ?? []).map(targetPoolFromRow), limit);
  }

  async delete(id: TargetPoolRecordId): Promise<void> {
    await this.db
      .prepare(`delete from ${this.#table} where id = ?`)
      .bind(id)
      .run();
  }
}

class D1SpacePolicyStore implements SpacePolicyStore {
  readonly #table = names.spacePolicies;

  constructor(private readonly db: D1Like) {}

  async upsert(record: SpacePolicyRecord): Promise<SpacePolicyRecord> {
    await this.db
      .prepare(namedSpecUpsertSql(this.#table))
      .bind(...namedSpecParameters(record))
      .run();
    return record;
  }

  async get(id: SpacePolicyRecordId): Promise<SpacePolicyRecord | undefined> {
    const row = await this.db
      .prepare(`select * from ${this.#table} where id = ? limit 1`)
      .bind(id)
      .first<NamedSpecRow>();
    return row ? spacePolicyFromRow(row) : undefined;
  }

  async getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<SpacePolicyRecord | undefined> {
    const row = await this.db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? and name = ? limit 1`,
      )
      .bind(spaceId, name)
      .first<NamedSpecRow>();
    return row ? spacePolicyFromRow(row) : undefined;
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly SpacePolicyRecord[]> {
    const rows = await this.db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? order by name asc, id asc`,
      )
      .bind(spaceId)
      .all<NamedSpecRow>();
    return (rows.results ?? []).map(spacePolicyFromRow);
  }

  async listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<SpacePolicyRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = cursor
      ? await this.db
          .prepare(
            `select * from ${this.#table}
             where space_id = ?
               and (created_at > ? or (created_at = ? and id > ?))
             order by created_at asc, id asc limit ?`,
          )
          .bind(
            spaceId,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
            limit + 1,
          )
          .all<NamedSpecRow>()
      : await this.db
          .prepare(
            `select * from ${this.#table}
             where space_id = ? order by created_at asc, id asc limit ?`,
          )
          .bind(spaceId, limit + 1)
          .all<NamedSpecRow>();
    return pageFromProbe((rows.results ?? []).map(spacePolicyFromRow), limit);
  }

  async delete(id: SpacePolicyRecordId): Promise<void> {
    await this.db
      .prepare(`delete from ${this.#table} where id = ?`)
      .bind(id)
      .run();
  }
}

export function createD1ResourceShapeStores(db: D1Like): ResourceShapeStores {
  return {
    persistence: "durable",
    resources: new D1ResourceShapeStore(db),
    locks: new D1ResolutionLockStore(db),
    targetPools: new D1TargetPoolStore(db),
    spacePolicies: new D1SpacePolicyStore(db),
    beginApply: (input) => beginD1Apply(db, input),
    commitApply: (input) => commitD1Apply(db, input),
    abortApply: (input) => abortD1Apply(db, input),
    removeResource: (input) => removeD1Resource(db, input),
  };
}

async function beginD1Apply(
  db: D1Like,
  input: ResourceApplyBeginInput,
): Promise<ResourceApplyBeginResult> {
  assertApplyPair(input.applyingRecord, input.plannedLock, "Applying");
  const batch = requireD1Batch(db);
  const statements = [
    input.expected === undefined
      ? createOnlyGuardStatement(db, input.applyingRecord.id)
      : versionGuardStatement(
          db,
          input.applyingRecord.id,
          input.expected,
          input.applyingRecord.managedBy,
        ),
    input.expected === undefined
      ? db
          .prepare(resourceInsertSql(names.resourceShapes, ""))
          .bind(...resourceParameters(input.applyingRecord))
      : resourceUpdateStatement(db, input.applyingRecord),
    lockUpsertStatement(db, input.plannedLock),
  ] as const;
  try {
    await batch(statements);
  } catch (error) {
    const current = await readD1Resource(db, input.applyingRecord.id);
    if (input.expected === undefined) {
      if (current) {
        if (current.managedBy !== input.applyingRecord.managedBy) {
          return { status: "ownership_conflict", record: current };
        }
        return { status: "conflict", record: current };
      }
    } else {
      if (!current) return { status: "not_found" };
      if (current.managedBy !== input.applyingRecord.managedBy) {
        return { status: "ownership_conflict", record: current };
      }
      if (!matchesVersion(current, input.expected)) {
        return { status: "conflict", record: current };
      }
    }
    throw error;
  }
  return {
    status: "begun",
    record: input.applyingRecord,
    lock: input.plannedLock,
  };
}

async function commitD1Apply(
  db: D1Like,
  input: ResourceApplyCommitInput,
): Promise<ResourceApplyCommitResult> {
  assertApplyPair(input.readyRecord, input.finalLock, "Ready");
  const batch = requireD1Batch(db);
  try {
    await batch([
      versionGuardStatement(db, input.readyRecord.id, input.expectedApplying),
      lockUpsertStatement(db, input.finalLock),
      resourceUpdateStatement(db, input.readyRecord),
    ]);
  } catch (error) {
    const current = await readD1Resource(db, input.readyRecord.id);
    if (!current) return { status: "not_found" };
    if (!matchesVersion(current, input.expectedApplying)) {
      return { status: "conflict", record: current };
    }
    throw error;
  }
  return {
    status: "committed",
    record: input.readyRecord,
    lock: input.finalLock,
  };
}

async function abortD1Apply(
  db: D1Like,
  input: ResourceApplyAbortInput,
): Promise<ResourceApplyAbortResult> {
  assertAbortInput(input);
  const batch = requireD1Batch(db);
  const replacementStatements = input.replacement
    ? [
        resourceUpdateStatement(db, input.replacement.record),
        input.replacement.lock
          ? lockUpsertStatement(db, input.replacement.lock)
          : db
              .prepare(
                `delete from ${names.resolutionLocks} where resource_id = ?`,
              )
              .bind(input.resourceId),
      ]
    : [
        db
          .prepare(`delete from ${names.resolutionLocks} where resource_id = ?`)
          .bind(input.resourceId),
        db
          .prepare(`delete from ${names.resourceShapes} where id = ?`)
          .bind(input.resourceId),
      ];
  try {
    await batch([
      applyAndLockGuardStatement(db, input),
      ...replacementStatements,
    ]);
  } catch (error) {
    const [current, currentLock] = await Promise.all([
      readD1Resource(db, input.resourceId),
      readD1Lock(db, input.resourceId),
    ]);
    if (!current && !currentLock) return { status: "not_found" };
    if (
      !current ||
      !currentLock ||
      !matchesVersion(current, input.expectedApplying) ||
      !matchesApplyLock(currentLock, input.expectedPlannedLock)
    ) {
      return {
        status: "conflict",
        ...(current ? { record: current } : {}),
        ...(currentLock ? { lock: currentLock } : {}),
      };
    }
    throw error;
  }
  return { status: "rolled_back" };
}

async function removeD1Resource(
  db: D1Like,
  input: ResourceAtomicRemoveInput,
): Promise<ResourceAtomicRemoveResult> {
  assertAtomicRemoveInput(input);
  const batch = requireD1Batch(db);
  try {
    await batch([
      atomicRemoveGuardStatement(db, input),
      db
        .prepare(`delete from ${names.resolutionLocks} where resource_id = ?`)
        .bind(input.resourceId),
      db
        .prepare(`delete from ${names.resourceShapes} where id = ?`)
        .bind(input.resourceId),
    ]);
  } catch (error) {
    const [current, currentLock] = await Promise.all([
      readD1Resource(db, input.resourceId),
      readD1Lock(db, input.resourceId),
    ]);
    if (!current && !currentLock) return { status: "not_found" };
    if (
      !current ||
      !matchesVersion(current, input.expected) ||
      !matchesExpectedLock(currentLock, input.expectedLock)
    ) {
      return {
        status: "conflict",
        ...(current ? { record: current } : {}),
        ...(currentLock ? { lock: currentLock } : {}),
      };
    }
    // The exact pair is still present, so this was an actual storage failure;
    // D1 batch semantics have rolled both delete statements back.
    throw error;
  }
  return { status: "removed" };
}

function requireD1Batch(
  db: D1Like,
): (
  statements: readonly D1LikePreparedStatement[],
) => Promise<readonly { readonly meta?: { readonly changes?: number } }[]> {
  if (!db.batch) {
    throw new Error("atomic Resource apply requires D1 batch support");
  }
  return (statements) => db.batch!(statements);
}

/**
 * D1 has no interactive transaction or conditional batch branching. These
 * guards deliberately attempt an invalid insert when their predicate fails;
 * D1 then rolls the entire batch back before either lifecycle row is visible.
 */
function createOnlyGuardStatement(
  db: D1Like,
  resourceId: ResourceShapeRecordId,
): D1LikePreparedStatement {
  return db
    .prepare(
      `insert into ${names.resourceShapes} (
        id, space_id, kind, name, managed_by, spec_json, phase,
        generation, observed_generation, created_at, updated_at
      )
      select id, null, kind, name, managed_by, spec_json, phase,
        generation, observed_generation, created_at, updated_at
      from ${names.resourceShapes} where id = ?`,
    )
    .bind(resourceId);
}

function versionGuardStatement(
  db: D1Like,
  resourceId: ResourceShapeRecordId,
  expected: {
    readonly generation: number;
    readonly phase: ResourcePhase;
    readonly updatedAt: string;
  },
  expectedManagedBy?: ResourceManagedBy,
): D1LikePreparedStatement {
  const managedByPredicate = expectedManagedBy ? " and managed_by = ?" : "";
  return db
    .prepare(
      `insert into ${names.resourceShapes} (
        id, space_id, kind, name, managed_by, spec_json, phase,
        generation, observed_generation, created_at, updated_at
      )
      select ?, null, 'guard', 'guard', 'guard', '{}', 'Pending', 0, 0, '', ''
      where not exists (
        select 1 from ${names.resourceShapes}
        where id = ? and generation = ? and phase = ? and updated_at = ?${managedByPredicate}
      )`,
    )
    .bind(
      resourceId,
      resourceId,
      expected.generation,
      expected.phase,
      expected.updatedAt,
      ...(expectedManagedBy ? [expectedManagedBy] : []),
    );
}

function applyAndLockGuardStatement(
  db: D1Like,
  input: ResourceApplyAbortInput,
): D1LikePreparedStatement {
  const lock = input.expectedPlannedLock;
  return db
    .prepare(
      `insert into ${names.resourceShapes} (
        id, space_id, kind, name, managed_by, spec_json, phase,
        generation, observed_generation, created_at, updated_at
      )
      select ?, null, 'guard', 'guard', 'guard', '{}', 'Pending', 0, 0, '', ''
      where not exists (
        select 1
        from ${names.resourceShapes} resource
        join ${names.resolutionLocks} resolution
          on resolution.resource_id = resource.id
        where resource.id = ?
          and resource.generation = ?
          and resource.phase = ?
          and resource.updated_at = ?
          and resolution.selected_implementation = ?
          and resolution.target_pool is ?
          and resolution.target = ?
          and resolution.target_snapshot_json is ?
          and resolution.implementation_snapshot_json is ?
          and resolution.implementation_plugin is ?
          and resolution.implementation_options_json is ?
          and resolution.implementation_fingerprint is ?
          and resolution.locked = ?
          and resolution.reason_json = ?
          and resolution.portability is ?
          and resolution.native_resources_json is ?
          and resolution.locked_at = ?
          and resolution.updated_at = ?
      )`,
    )
    .bind(
      input.resourceId,
      input.resourceId,
      input.expectedApplying.generation,
      input.expectedApplying.phase,
      input.expectedApplying.updatedAt,
      lock.selectedImplementation,
      lock.targetPool ?? null,
      lock.target,
      jsonOrNull(lock.targetSnapshot),
      jsonOrNull(lock.implementationSnapshot),
      lock.selectedImplementationPlugin ?? null,
      jsonOrNull(lock.selectedImplementationOptions),
      lock.implementationFingerprint ?? null,
      lock.locked ? 1 : 0,
      JSON.stringify(lock.reason),
      lock.portability ?? null,
      jsonOrNull(lock.nativeResources),
      lock.lockedAt,
      lock.updatedAt,
    );
}

function atomicRemoveGuardStatement(
  db: D1Like,
  input: ResourceAtomicRemoveInput,
): D1LikePreparedStatement {
  const expectedLock = input.expectedLock;
  const lockPredicate = expectedLock
    ? `exists (
        select 1 from ${names.resolutionLocks} resolution
        where resolution.resource_id = resource.id
          and resolution.selected_implementation = ?
          and resolution.target_pool is ?
          and resolution.target = ?
          and resolution.target_snapshot_json is ?
          and resolution.implementation_snapshot_json is ?
          and resolution.implementation_plugin is ?
          and resolution.implementation_options_json is ?
          and resolution.implementation_fingerprint is ?
          and resolution.locked = ?
          and resolution.reason_json = ?
          and resolution.portability is ?
          and resolution.native_resources_json is ?
          and resolution.locked_at = ?
          and resolution.updated_at = ?
      )`
    : `not exists (
        select 1 from ${names.resolutionLocks} resolution
        where resolution.resource_id = resource.id
      )`;
  return db
    .prepare(
      `insert into ${names.resourceShapes} (
        id, space_id, kind, name, managed_by, spec_json, phase,
        generation, observed_generation, created_at, updated_at
      )
      select ?, null, 'guard', 'guard', 'guard', '{}', 'Pending', 0, 0, '', ''
      where not exists (
        select 1 from ${names.resourceShapes} resource
        where resource.id = ?
          and resource.generation = ?
          and resource.phase = ?
          and resource.updated_at = ?
          and ${lockPredicate}
      )`,
    )
    .bind(
      input.resourceId,
      input.resourceId,
      input.expected.generation,
      input.expected.phase,
      input.expected.updatedAt,
      ...(expectedLock ? exactLockParameters(expectedLock) : []),
    );
}

function exactLockParameters(lock: ResolutionLockRecord): readonly unknown[] {
  return [
    lock.selectedImplementation,
    lock.targetPool ?? null,
    lock.target,
    jsonOrNull(lock.targetSnapshot),
    jsonOrNull(lock.implementationSnapshot),
    lock.selectedImplementationPlugin ?? null,
    jsonOrNull(lock.selectedImplementationOptions),
    lock.implementationFingerprint ?? null,
    lock.locked ? 1 : 0,
    JSON.stringify(lock.reason),
    lock.portability ?? null,
    jsonOrNull(lock.nativeResources),
    lock.lockedAt,
    lock.updatedAt,
  ];
}

function resourceUpdateStatement(
  db: D1Like,
  record: ResourceShapeRecord,
): D1LikePreparedStatement {
  return db
    .prepare(
      `update ${names.resourceShapes} set
        space_id = ?, project = ?, environment = ?, kind = ?,
        form_ref_json = ?, package_digest = ?, name = ?, managed_by = ?,
        spec_json = ?, phase = ?, generation = ?, observed_generation = ?,
        outputs_json = ?, execution_json = ?, state_adoption_json = ?,
        conditions_json = ?, labels_json = ?, created_at = ?, updated_at = ?
      where id = ?`,
    )
    .bind(...resourceParameters(record).slice(1), record.id);
}

function lockUpsertStatement(
  db: D1Like,
  lock: ResolutionLockRecord,
): D1LikePreparedStatement {
  return db
    .prepare(lockUpsertSql(names.resolutionLocks))
    .bind(...lockParameters(lock));
}

async function readD1Resource(
  db: D1Like,
  resourceId: ResourceShapeRecordId,
): Promise<ResourceShapeRecord | undefined> {
  const row = await db
    .prepare(`select * from ${names.resourceShapes} where id = ? limit 1`)
    .bind(resourceId)
    .first<ResourceShapeRow>();
  return row ? resourceShapeFromRow(row) : undefined;
}

async function readD1Lock(
  db: D1Like,
  resourceId: ResourceShapeRecordId,
): Promise<ResolutionLockRecord | undefined> {
  const row = await db
    .prepare(
      `select * from ${names.resolutionLocks} where resource_id = ? limit 1`,
    )
    .bind(resourceId)
    .first<ResolutionLockRow>();
  return row ? resolutionLockFromRow(row) : undefined;
}

function resourceInsertSql(table: string, conflict: string): string {
  return `insert into ${table} (
    id, space_id, project, environment, kind, form_ref_json, package_digest,
    name, managed_by,
    spec_json, phase, generation, observed_generation,
    outputs_json, execution_json, state_adoption_json,
    conditions_json, labels_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`;
}

function resourceParameters(record: ResourceShapeRecord): readonly unknown[] {
  assertResourceFormIdentity(record.form, record.kind);
  return [
    record.id,
    record.spaceId,
    record.project ?? null,
    record.environment ?? null,
    record.kind,
    jsonOrNull(record.form?.formRef),
    record.form?.packageDigest ?? null,
    record.name,
    record.managedBy,
    JSON.stringify(record.spec),
    record.phase,
    record.generation,
    record.observedGeneration,
    jsonOrNull(record.outputs),
    jsonOrNull(record.execution),
    jsonOrNull(record.stateAdoption),
    jsonOrNull(record.conditions),
    jsonOrNull(record.labels),
    record.createdAt,
    record.updatedAt,
  ];
}

function lockParameters(lock: ResolutionLockRecord): readonly unknown[] {
  const form = exactFormIdentity(
    jsonOrNull(lock.form?.formRef),
    lock.form?.packageDigest ?? null,
  );
  return [
    lock.resourceId,
    jsonOrNull(form?.formRef),
    form?.packageDigest ?? null,
    lock.selectedImplementation,
    lock.targetPool ?? null,
    lock.target,
    jsonOrNull(lock.targetSnapshot),
    jsonOrNull(lock.implementationSnapshot),
    lock.selectedImplementationPlugin ?? null,
    jsonOrNull(lock.selectedImplementationOptions),
    lock.implementationFingerprint ?? null,
    lock.locked ? 1 : 0,
    JSON.stringify(lock.reason),
    lock.portability ?? null,
    jsonOrNull(lock.nativeResources),
    lock.lockedAt,
    lock.updatedAt,
  ];
}

function lockUpsertSql(table: string): string {
  return `insert into ${table} (
    resource_id, form_ref_json, package_digest,
    selected_implementation, target_pool, target,
    target_snapshot_json, implementation_snapshot_json,
    implementation_plugin, implementation_options_json,
    implementation_fingerprint, locked, reason_json, portability,
    native_resources_json, locked_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict (resource_id) do update set
    form_ref_json = excluded.form_ref_json,
    package_digest = excluded.package_digest,
    selected_implementation = excluded.selected_implementation,
    target_pool = excluded.target_pool,
    target = excluded.target,
    target_snapshot_json = excluded.target_snapshot_json,
    implementation_snapshot_json = excluded.implementation_snapshot_json,
    implementation_plugin = excluded.implementation_plugin,
    implementation_options_json = excluded.implementation_options_json,
    implementation_fingerprint = excluded.implementation_fingerprint,
    locked = excluded.locked,
    reason_json = excluded.reason_json,
    portability = excluded.portability,
    native_resources_json = excluded.native_resources_json,
    locked_at = excluded.locked_at,
    updated_at = excluded.updated_at`;
}

function namedSpecUpsertSql(table: string): string {
  return `insert into ${table} (
    id, space_id, name, spec_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?)
  on conflict (id) do update set
    space_id = excluded.space_id,
    name = excluded.name,
    spec_json = excluded.spec_json,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`;
}

function namedSpecCreateSql(table: string, placeholder: "?"): string {
  return `insert into ${table} (
    id, space_id, name, spec_json, created_at, updated_at
  ) values (${[placeholder, placeholder, placeholder, placeholder, placeholder, placeholder].join(", ")})
  on conflict do nothing`;
}

function namedSpecParameters(
  record: TargetPoolRecord | SpacePolicyRecord,
): readonly unknown[] {
  return [
    record.id,
    record.spaceId,
    record.name,
    JSON.stringify(record.spec),
    record.createdAt,
    record.updatedAt,
  ];
}

function resourceShapeFromRow(row: ResourceShapeRow): ResourceShapeRecord {
  const kind = parseResourceShapeKind(row.kind);
  const form = exactFormIdentity(row.form_ref_json, row.package_digest);
  assertResourceFormIdentity(form, kind);
  const outputs = parseJson<JsonObject>(row.outputs_json);
  const execution = parseJson<ResourceShapeExecutionRecord>(row.execution_json);
  const stateAdoption = parseJson<ResourceShapeStateAdoptionDescriptor>(
    row.state_adoption_json,
  );
  const conditions = parseJson<readonly Condition[]>(row.conditions_json);
  const labels = parseJson<Record<string, string>>(row.labels_json);
  return {
    id: row.id,
    spaceId: row.space_id as SpaceId,
    ...(row.project === null ? {} : { project: row.project }),
    ...(row.environment === null ? {} : { environment: row.environment }),
    kind,
    ...(form === undefined ? {} : { form }),
    name: row.name,
    managedBy: row.managed_by as ResourceManagedBy,
    spec: parseJson<JsonObject>(row.spec_json) ?? {},
    phase: row.phase as ResourcePhase,
    generation: Number(row.generation),
    observedGeneration: Number(row.observed_generation),
    ...(outputs === undefined ? {} : { outputs }),
    ...(execution === undefined ? {} : { execution }),
    ...(stateAdoption === undefined ? {} : { stateAdoption }),
    ...(conditions === undefined ? {} : { conditions }),
    ...(labels === undefined ? {} : { labels }),
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function resolutionLockFromRow(row: ResolutionLockRow): ResolutionLockRecord {
  const form = exactFormIdentity(row.form_ref_json, row.package_digest);
  const targetSnapshot = parseJson<TargetPoolEntry>(row.target_snapshot_json);
  const implementationSnapshot = parseJson<TargetImplementationDescriptor>(
    row.implementation_snapshot_json,
  );
  const implementationOptions = parseJson<JsonObject>(
    row.implementation_options_json,
  );
  const nativeResources = parseJson<readonly NativeResourceRef[]>(
    row.native_resources_json,
  );
  return {
    resourceId: row.resource_id,
    ...(form === undefined ? {} : { form }),
    selectedImplementation: row.selected_implementation,
    ...(row.target_pool === null ? {} : { targetPool: row.target_pool }),
    target: row.target,
    ...(targetSnapshot === undefined ? {} : { targetSnapshot }),
    ...(implementationSnapshot === undefined ? {} : { implementationSnapshot }),
    ...(row.implementation_plugin === null
      ? {}
      : { selectedImplementationPlugin: row.implementation_plugin }),
    ...(implementationOptions === undefined
      ? {}
      : { selectedImplementationOptions: implementationOptions }),
    ...(row.implementation_fingerprint === null
      ? {}
      : { implementationFingerprint: row.implementation_fingerprint }),
    locked: row.locked === 1,
    reason: parseJson<readonly string[]>(row.reason_json) ?? [],
    ...(row.portability === null
      ? {}
      : { portability: row.portability as ResourcePortability }),
    ...(nativeResources === undefined ? {} : { nativeResources }),
    lockedAt: row.locked_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function targetPoolFromRow(row: NamedSpecRow): TargetPoolRecord {
  return {
    id: row.id,
    spaceId: row.space_id as SpaceId,
    name: row.name,
    spec: parseJson<JsonObject>(row.spec_json) ?? {},
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function spacePolicyFromRow(row: NamedSpecRow): SpacePolicyRecord {
  return {
    id: row.id,
    spaceId: row.space_id as SpaceId,
    name: row.name,
    spec: parseJson<JsonObject>(row.spec_json) ?? {},
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function exactFormIdentity(
  formRefJson: unknown,
  packageDigest: string | null,
): InstalledFormReference | undefined {
  if (
    (formRefJson === undefined || formRefJson === null || formRefJson === "") &&
    packageDigest === null
  ) {
    return undefined;
  }
  const identity = {
    formRef: parseJson<FormRef>(formRefJson),
    packageDigest,
  };
  if (!isInstalledFormReference(identity)) {
    throw new Error("durable Resource form identity is partial or invalid");
  }
  return identity;
}
