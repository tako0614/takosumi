// Postgres implementations of the Resource Shape stores over Takosumi's
// runtime-neutral SqlClient.

import type {
  Condition,
  FormRef,
  InstalledFormReference,
  JsonObject,
  NativeResourceRef,
  ResourceManagedBy,
  ResourceOwner,
  ResourcePhase,
  ResourcePortability,
  ResourceShapeKind,
  TargetImplementationDescriptor,
  TargetPoolEntry,
} from "takosumi-contract";
import {
  formRefOfInstalled,
  isInstalledFormReference,
  parseResourceShapeKind,
  shapeKindForPortableType,
} from "takosumi-contract";
import {
  clampPageLimit,
  decodeCursor,
  pageFromProbe,
  type Page,
  type PageParams,
} from "takosumi-contract/pagination";
import { deployControlPostgresTableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { SqlClient, SqlValue } from "../../adapters/storage/sql.ts";
import type { SpaceId } from "../../shared/ids.ts";
import type { IsoTimestamp } from "../../shared/time.ts";
import type {
  ResolutionLockRecord,
  ResourceIdentityFenceRecord,
  ResourceShapeExecutionRecord,
  ResourceShapePendingOperation,
  ResourceShapeRecord,
  ResourceShapeRecordId,
  ResourceShapeStateAdoptionDescriptor,
  SpacePolicyRecord,
  SpacePolicyRecordId,
  TargetPoolRecord,
  TargetPoolRecordId,
} from "./records.ts";
import {
  assertNativeResourceFormIdentity,
  assertResourceFormIdentity,
  bindNativeResourceFormIdentity,
  resourceFormIdentitiesEqual,
} from "./records.ts";
import type {
  ResourceApplyAbortInput,
  ResourceApplyAbortResult,
  ResourceApplyBeginInput,
  ResourceApplyBeginResult,
  ResourceApplyCommitInput,
  ResourceApplyCommitResult,
  ResourceAggregateClaimInput,
  ResourceAggregateClaimResult,
  ResourceAggregateReplaceInput,
  ResourceAggregateReplaceResult,
  ResourceAtomicRemoveInput,
  ResourceAtomicRemoveResult,
  ResourceCreateResult,
  ResourceDeleteClaimResult,
  ResourceFormIdentityPinInput,
  ResourceFormIdentityPinResult,
  ResourceObservationClaimInput,
  ResolutionLockStore,
  ResourceShapeStore,
  ResourceShapeStores,
  SpacePolicyStore,
  TargetPoolCreateResult,
  TargetPoolDeleteInput,
  TargetPoolDeleteResult,
  TargetPoolPutInput,
  TargetPoolPutResult,
  TargetPoolStore,
} from "./stores.ts";
import {
  assertAbortInput,
  assertAtomicRemoveInput,
  assertApplyPair,
  assertResourceAggregateClaimInput,
  assertResourceAggregateReplaceInput,
  assertExpectedTargetPool,
  assertResourceIdentityFence,
  consumeResourceIdentityFence,
  assertTargetPoolDeleteInput,
  assertTargetPoolPutInput,
  matchesExpectedResourceIdentityFence,
  matchesClaimedResource,
  matchesApplyLock,
  matchesExpectedTargetPool,
  matchesExpectedLock,
  matchesTargetPool,
  matchesVersion,
  matchesResourceIdentityFence,
  retireResourceIdentityFence,
  filterCapsuleOwnerPage,
  resourceRecordRevision,
  assertResourceFormIdentityPinInput,
  targetPoolSpecsEqual,
} from "./stores.ts";

type ResourceShapeRow = {
  readonly id: string;
  readonly space_id: string;
  readonly project: string | null;
  readonly environment: string | null;
  readonly kind: string;
  readonly form_ref_json: unknown;
  readonly package_digest: string | null;
  readonly name: string;
  readonly managed_by: string;
  readonly spec_json: unknown;
  readonly phase: string;
  readonly generation: number;
  readonly observed_generation: number;
  readonly outputs_json: unknown;
  readonly execution_json: unknown;
  readonly state_adoption_json: unknown;
  readonly conditions_json: unknown;
  readonly labels_json: unknown;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision?: number | string | null;
  readonly pending_operation_json?: unknown;
  readonly last_operation_run_id?: string | null;
  readonly owner_json?: unknown;
};

type ResolutionLockRow = {
  readonly resource_id: string;
  readonly form_ref_json: unknown;
  readonly package_digest: string | null;
  readonly selected_implementation: string;
  readonly target_pool: string | null;
  readonly target: string;
  readonly target_snapshot_json: unknown;
  readonly implementation_snapshot_json: unknown;
  readonly implementation_plugin: string | null;
  readonly implementation_options_json: unknown;
  readonly implementation_fingerprint: string | null;
  readonly locked: boolean | number;
  readonly reason_json: unknown;
  readonly portability: string | null;
  readonly native_resources_json: unknown;
  readonly locked_at: string;
  readonly updated_at: string;
};

type ResourceIdentityFenceRow = {
  readonly resource_id: string;
  readonly last_generation: number | string;
  readonly fence_revision: number | string;
  readonly retired_owner_json: unknown;
};

/**
 * A fence CAS can only lose after the transaction has already published a
 * Resource/ResolutionLock pair when a caller races a missing fence row. Throw
 * this private sentinel so SqlClient rolls the transaction back, then expose
 * the same typed conflict result as the preflight comparison path.
 */
class SqlIdentityFenceConflict extends Error {
  readonly fence: ResourceIdentityFenceRecord | undefined;

  constructor(fence: ResourceIdentityFenceRecord | undefined) {
    super("Resource identity fence changed during atomic apply");
    this.name = "SqlIdentityFenceConflict";
    this.fence = fence;
  }
}

type NamedSpecRow = {
  readonly id: string;
  readonly space_id: string;
  readonly name: string;
  readonly spec_json: unknown;
  readonly created_at: string;
  readonly updated_at: string;
};

class SqlResourceShapeStore implements ResourceShapeStore {
  readonly #table = names.resourceShapes;

  constructor(private readonly client: SqlClient) {}

  async create(record: ResourceShapeRecord): Promise<ResourceCreateResult> {
    const result = await this.client.query(
      resourceInsertSql(this.#table, "on conflict do nothing"),
      resourceParameters(record),
    );
    if (result.rowCount > 0) {
      const persisted = await this.get(record.id);
      if (!persisted) {
        throw new Error(`resource create did not persist ${record.id}`);
      }
      return { status: "created", record: persisted };
    }
    const current = await this.get(record.id);
    if (!current) {
      throw new Error(`resource create conflict did not resolve ${record.id}`);
    }
    return { status: "conflict", record: current };
  }

  async upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord> {
    await this.client.query(
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
          updated_at = excluded.updated_at,
          pending_operation_json = excluded.pending_operation_json,
          last_operation_run_id = excluded.last_operation_run_id,
          owner_json = excluded.owner_json,
          revision = ${this.#table}.revision + 1`,
      ),
      resourceParameters(record),
    );
    const persisted = await this.get(record.id);
    if (!persisted) {
      throw new Error(`resource upsert did not persist ${record.id}`);
    }
    return persisted;
  }

  async get(
    id: ResourceShapeRecordId,
  ): Promise<ResourceShapeRecord | undefined> {
    const result = await this.client.query<ResourceShapeRow>(
      `select * from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    return result.rows[0] ? resourceShapeFromRow(result.rows[0]) : undefined;
  }

  async getMany(
    ids: readonly ResourceShapeRecordId[],
  ): Promise<readonly ResourceShapeRecord[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    if (unique.length > 100) {
      throw new RangeError("Resource getMany accepts at most 100 ids");
    }
    const result = await this.client.query<ResourceShapeRow>(
      `select * from ${this.#table}
       where id in (${unique.map((_, index) => `$${index + 1}`).join(",")})`,
      unique,
    );
    return result.rows.map(resourceShapeFromRow);
  }

  async getByName(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ResourceShapeRecord | undefined> {
    const result = await this.client.query<ResourceShapeRow>(
      `select * from ${this.#table}
       where space_id = $1 and kind = $2 and name = $3 limit 1`,
      [spaceId, kind, name],
    );
    return result.rows[0] ? resourceShapeFromRow(result.rows[0]) : undefined;
  }

  async deleteIfVersion(
    id: ResourceShapeRecordId,
    expected: {
      readonly generation: number;
      readonly phase: ResourcePhase;
      readonly updatedAt: string;
      readonly revision?: number;
    },
  ): Promise<boolean> {
    const revisionPredicate =
      expected.revision === undefined ? "" : " and revision = $5";
    const result = await this.client.query(
      `delete from ${this.#table}
       where id = $1 and generation = $2 and phase = $3 and updated_at = $4${revisionPredicate}`,
      [
        id,
        expected.generation,
        expected.phase,
        expected.updatedAt,
        ...(expected.revision === undefined ? [] : [expected.revision]),
      ],
    );
    return result.rowCount === 1;
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly ResourceShapeRecord[]> {
    const result = await this.client.query<ResourceShapeRow>(
      `select * from ${this.#table}
       where space_id = $1 order by kind asc, name asc, id asc`,
      [spaceId],
    );
    return result.rows.map(resourceShapeFromRow);
  }

  async listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const result = cursor
      ? await this.client.query<ResourceShapeRow>(
          `select * from ${this.#table}
           where space_id = $1
             and (created_at > $2 or (created_at = $2 and id > $3))
           order by created_at asc, id asc limit $4`,
          [spaceId, cursor.createdAt, cursor.id, limit + 1],
        )
      : await this.client.query<ResourceShapeRow>(
          `select * from ${this.#table}
           where space_id = $1 order by created_at asc, id asc limit $2`,
          [spaceId, limit + 1],
        );
    return pageFromProbe(result.rows.map(resourceShapeFromRow), limit);
  }

  async listByCapsuleOwnerPage(
    spaceId: SpaceId,
    capsuleId: string,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    return filterCapsuleOwnerPage(
      await this.listBySpacePage(spaceId, params),
      spaceId,
      capsuleId,
    );
  }

  async listByKindsPage(
    kinds: readonly ResourceShapeKind[],
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    const selectedKinds = [...new Set(kinds)];
    if (selectedKinds.length === 0) return { items: [] };
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const kindPlaceholders = selectedKinds
      .map((_, index) => `$${index + 1}`)
      .join(", ");
    const createdAtIndex = selectedKinds.length + 1;
    const idIndex = selectedKinds.length + 2;
    const limitIndex = selectedKinds.length + (cursor ? 3 : 1);
    const result = await this.client.query<ResourceShapeRow>(
      `select * from ${this.#table}
       where kind in (${kindPlaceholders})${
         cursor
           ? ` and (created_at > $${createdAtIndex} or (created_at = $${createdAtIndex} and id > $${idIndex}))`
           : ""
       }
       order by created_at asc, id asc limit $${limitIndex}`,
      cursor
        ? [...selectedKinds, cursor.createdAt, cursor.id, limit + 1]
        : [...selectedKinds, limit + 1],
    );
    return pageFromProbe(result.rows.map(resourceShapeFromRow), limit);
  }

  async listReadyByKindPage(
    kind: ResourceShapeKind,
    params: PageParams,
    spaceId?: SpaceId,
  ): Promise<Page<ResourceShapeRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const result = cursor
      ? await this.client.query<ResourceShapeRow>(
          `select * from ${this.#table}
           where ${spaceId === undefined ? "" : "space_id = $1 and "}kind = $${spaceId === undefined ? 1 : 2} and phase = 'Ready'
             and observed_generation = generation
             and (created_at > $${spaceId === undefined ? 2 : 3} or (created_at = $${spaceId === undefined ? 2 : 3} and id > $${spaceId === undefined ? 3 : 4}))
           order by created_at asc, id asc limit $${spaceId === undefined ? 4 : 5}`,
          [
            ...(spaceId === undefined ? [] : [spaceId]),
            kind,
            cursor.createdAt,
            cursor.id,
            limit + 1,
          ],
        )
      : await this.client.query<ResourceShapeRow>(
          `select * from ${this.#table}
           where ${spaceId === undefined ? "" : "space_id = $1 and "}kind = $${spaceId === undefined ? 1 : 2} and phase = 'Ready'
             and observed_generation = generation
           order by created_at asc, id asc limit $${spaceId === undefined ? 2 : 3}`,
          [...(spaceId === undefined ? [] : [spaceId]), kind, limit + 1],
        );
    return pageFromProbe(result.rows.map(resourceShapeFromRow), limit);
  }

  async listUnpinnedBySpaceKindPage(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const result = cursor
      ? await this.client.query<ResourceShapeRow>(
          `select * from ${this.#table}
           where space_id = $1 and kind = $2
             and form_ref_json is null and package_digest is null
             and (created_at > $3 or (created_at = $3 and id > $4))
           order by created_at asc, id asc limit $5`,
          [spaceId, kind, cursor.createdAt, cursor.id, limit + 1],
        )
      : await this.client.query<ResourceShapeRow>(
          `select * from ${this.#table}
           where space_id = $1 and kind = $2
             and form_ref_json is null and package_digest is null
           order by created_at asc, id asc limit $3`,
          [spaceId, kind, limit + 1],
        );
    return pageFromProbe(result.rows.map(resourceShapeFromRow), limit);
  }

  async claimObservationCandidate(
    input: ResourceObservationClaimInput,
  ): Promise<ResourceShapeRecord | undefined> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const selected = await this.client.query<{ readonly id: string }>(
        `select id from ${this.#table}
         where phase = 'Ready'
           and observed_generation = generation
           and (last_observation_attempt_at is null
             or last_observation_attempt_at <= $1)
           and (observation_lease_id is null
             or observation_claimed_at is null
             or observation_claimed_at <= $2)
         order by coalesce(last_observation_attempt_at, created_at) asc, id asc
         limit 1`,
        [input.dueBefore, input.staleClaimBefore],
      );
      const id = selected.rows[0]?.id;
      if (!id) return undefined;
      const claimed = await this.client.query(
        `update ${this.#table}
         set observation_lease_id = $1, observation_claimed_at = $2
         where id = $3 and phase = 'Ready'
           and observed_generation = generation
           and (last_observation_attempt_at is null
             or last_observation_attempt_at <= $4)
           and (observation_lease_id is null
             or observation_claimed_at is null
             or observation_claimed_at <= $5)`,
        [
          input.leaseId,
          input.claimedAt,
          id,
          input.dueBefore,
          input.staleClaimBefore,
        ],
      );
      if (claimed.rowCount === 0) continue;
      return await this.get(id);
    }
    return undefined;
  }

  async finishObservationClaim(
    id: ResourceShapeRecordId,
    leaseId: string,
    attemptedAt: string,
  ): Promise<boolean> {
    const result = await this.client.query(
      `update ${this.#table}
       set observation_lease_id = null,
           observation_claimed_at = null,
           last_observation_attempt_at = $1
       where id = $2 and observation_lease_id = $3`,
      [attemptedAt, id, leaseId],
    );
    return result.rowCount > 0;
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
    const result = await this.client.query(
      `update ${this.#table}
       set state_adoption_json = $1::jsonb, updated_at = $2,
           revision = revision + 1
       where id = $3 and updated_at = $4
         and execution_json is null and state_adoption_json is null`,
      [
        JSON.stringify(descriptor),
        descriptor.confirmedAt,
        id,
        expectedUpdatedAt,
      ],
    );
    if (result.rowCount > 0) {
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
      readonly revision?: number;
    },
  ): Promise<
    | { readonly status: "updated"; readonly record: ResourceShapeRecord }
    | { readonly status: "not_found" }
    | { readonly status: "conflict"; readonly record: ResourceShapeRecord }
  > {
    const expectedRevision =
      expected.revision ?? resourceRecordRevision(record);
    const result = await this.client.query(
      `update ${this.#table} set
        space_id = $1, project = $2, environment = $3, kind = $4,
        form_ref_json = $5::jsonb, package_digest = $6, name = $7,
        managed_by = $8, spec_json = $9::jsonb, phase = $10,
        generation = $11, observed_generation = $12,
        outputs_json = $13::jsonb, execution_json = $14::jsonb,
        state_adoption_json = $15::jsonb, conditions_json = $16::jsonb,
        labels_json = $17::jsonb, created_at = $18, updated_at = $19,
        pending_operation_json = $20::jsonb, last_operation_run_id = $21,
        owner_json = $22::jsonb,
        revision = revision + 1
       where id = $23 and generation = $24 and phase = $25
         and updated_at = $26 and revision = $27`,
      [
        ...resourceUpdateParameters(record),
        record.id,
        expected.generation,
        expected.phase,
        expected.updatedAt,
        expectedRevision,
      ],
    );
    if (result.rowCount > 0) {
      const persisted = await this.get(record.id);
      if (!persisted) return { status: "not_found" };
      return { status: "updated", record: persisted };
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
    const expectedRevision = resourceRecordRevision(record);
    const result = await this.client.query(
      `update ${this.#table}
       set phase = $1, conditions_json = $2::jsonb, updated_at = $3,
           pending_operation_json = $4::jsonb, last_operation_run_id = $5,
           revision = revision + 1
       where id = $6 and generation = $7 and managed_by = $8
         and phase != 'Deleting' and revision = $9`,
      [
        record.phase,
        jsonOrNull(record.conditions),
        record.updatedAt,
        jsonOrNull(record.pendingOperation),
        record.lastOperationRunId ?? null,
        record.id,
        expectedGeneration,
        expectedManagedBy,
        expectedRevision,
      ],
    );
    if (result.rowCount > 0) {
      const persisted = await this.get(record.id);
      if (!persisted) return { status: "not_found" };
      return { status: "claimed", record: persisted };
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
    await this.client.query(`delete from ${this.#table} where id = $1`, [id]);
  }
}

class SqlResolutionLockStore implements ResolutionLockStore {
  readonly #table = names.resolutionLocks;

  constructor(private readonly client: SqlClient) {}

  async put(lock: ResolutionLockRecord): Promise<ResolutionLockRecord> {
    await this.client.query(lockUpsertSql(this.#table), lockParameters(lock));
    return lock;
  }

  async get(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResolutionLockRecord | undefined> {
    const result = await this.client.query<ResolutionLockRow>(
      `select * from ${this.#table} where resource_id = $1 limit 1`,
      [resourceId],
    );
    return result.rows[0] ? resolutionLockFromRow(result.rows[0]) : undefined;
  }

  async getMany(
    resourceIds: readonly ResourceShapeRecordId[],
  ): Promise<readonly ResolutionLockRecord[]> {
    const unique = [...new Set(resourceIds)];
    if (unique.length === 0) return [];
    if (unique.length > 100) {
      throw new RangeError("Resolution lock getMany accepts at most 100 ids");
    }
    const result = await this.client.query<ResolutionLockRow>(
      `select * from ${this.#table}
       where resource_id in (${unique.map((_, index) => `$${index + 1}`).join(",")})`,
      unique,
    );
    return result.rows.map(resolutionLockFromRow);
  }

  async delete(resourceId: ResourceShapeRecordId): Promise<void> {
    await this.client.query(
      `delete from ${this.#table} where resource_id = $1`,
      [resourceId],
    );
  }
}

class SqlTargetPoolStore implements TargetPoolStore {
  readonly #table = names.targetPools;

  constructor(private readonly client: SqlClient) {}

  async create(record: TargetPoolRecord): Promise<TargetPoolCreateResult> {
    const result = await this.client.query(
      namedSpecCreateSql(this.#table),
      namedSpecParameters(record),
    );
    if (result.rowCount > 0) return { status: "created", record };
    const existing =
      (await this.getByName(record.spaceId, record.name)) ??
      (await this.get(record.id));
    if (!existing) {
      throw new Error("TargetPool create conflict has no durable winner");
    }
    return { status: "conflict", record: existing };
  }

  async upsert(record: TargetPoolRecord): Promise<TargetPoolRecord> {
    await this.client.query(
      namedSpecUpsertSql(this.#table),
      namedSpecParameters(record),
    );
    return record;
  }

  async get(id: TargetPoolRecordId): Promise<TargetPoolRecord | undefined> {
    const result = await this.client.query<NamedSpecRow>(
      `select * from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    return result.rows[0] ? targetPoolFromRow(result.rows[0]) : undefined;
  }

  async getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined> {
    const result = await this.client.query<NamedSpecRow>(
      `select * from ${this.#table}
       where space_id = $1 and name = $2 limit 1`,
      [spaceId, name],
    );
    return result.rows[0] ? targetPoolFromRow(result.rows[0]) : undefined;
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly TargetPoolRecord[]> {
    const result = await this.client.query<NamedSpecRow>(
      `select * from ${this.#table}
       where space_id = $1 order by name asc, id asc`,
      [spaceId],
    );
    return result.rows.map(targetPoolFromRow);
  }

  async listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<TargetPoolRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const result = cursor
      ? await this.client.query<NamedSpecRow>(
          `select * from ${this.#table}
           where space_id = $1
             and (created_at > $2 or (created_at = $2 and id > $3))
           order by created_at asc, id asc limit $4`,
          [spaceId, cursor.createdAt, cursor.id, limit + 1],
        )
      : await this.client.query<NamedSpecRow>(
          `select * from ${this.#table}
           where space_id = $1 order by created_at asc, id asc limit $2`,
          [spaceId, limit + 1],
        );
    return pageFromProbe(result.rows.map(targetPoolFromRow), limit);
  }

  async delete(id: TargetPoolRecordId): Promise<void> {
    await this.client.query(`delete from ${this.#table} where id = $1`, [id]);
  }
}

class SqlSpacePolicyStore implements SpacePolicyStore {
  readonly #table = names.spacePolicies;

  constructor(private readonly client: SqlClient) {}

  async upsert(record: SpacePolicyRecord): Promise<SpacePolicyRecord> {
    await this.client.query(
      namedSpecUpsertSql(this.#table),
      namedSpecParameters(record),
    );
    return record;
  }

  async get(id: SpacePolicyRecordId): Promise<SpacePolicyRecord | undefined> {
    const result = await this.client.query<NamedSpecRow>(
      `select * from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    return result.rows[0] ? spacePolicyFromRow(result.rows[0]) : undefined;
  }

  async getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<SpacePolicyRecord | undefined> {
    const result = await this.client.query<NamedSpecRow>(
      `select * from ${this.#table}
       where space_id = $1 and name = $2 limit 1`,
      [spaceId, name],
    );
    return result.rows[0] ? spacePolicyFromRow(result.rows[0]) : undefined;
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly SpacePolicyRecord[]> {
    const result = await this.client.query<NamedSpecRow>(
      `select * from ${this.#table}
       where space_id = $1 order by name asc, id asc`,
      [spaceId],
    );
    return result.rows.map(spacePolicyFromRow);
  }

  async listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<SpacePolicyRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const result = cursor
      ? await this.client.query<NamedSpecRow>(
          `select * from ${this.#table}
           where space_id = $1
             and (created_at > $2 or (created_at = $2 and id > $3))
           order by created_at asc, id asc limit $4`,
          [spaceId, cursor.createdAt, cursor.id, limit + 1],
        )
      : await this.client.query<NamedSpecRow>(
          `select * from ${this.#table}
           where space_id = $1 order by created_at asc, id asc limit $2`,
          [spaceId, limit + 1],
        );
    return pageFromProbe(result.rows.map(spacePolicyFromRow), limit);
  }

  async delete(id: SpacePolicyRecordId): Promise<void> {
    await this.client.query(`delete from ${this.#table} where id = $1`, [id]);
  }
}

export function createSqlResourceShapeStores(
  client: SqlClient,
): ResourceShapeStores {
  return {
    persistence: "durable",
    resources: new SqlResourceShapeStore(client),
    locks: new SqlResolutionLockStore(client),
    targetPools: new SqlTargetPoolStore(client),
    spacePolicies: new SqlSpacePolicyStore(client),
    getResourceIdentityFence: (resourceId) =>
      readSqlIdentityFence(client, resourceId),
    putTargetPool: (input) => putSqlTargetPool(client, input),
    deleteTargetPool: (input) => deleteSqlTargetPool(client, input),
    beginApply: (input) => beginSqlApply(client, input),
    commitApply: (input) => commitSqlApply(client, input),
    claimResourceAggregate: (input) =>
      claimSqlResourceAggregate(client, input),
    replaceResourceAggregate: (input) =>
      replaceSqlResourceAggregate(client, input),
    abortApply: (input) => abortSqlApply(client, input),
    removeResource: (input) => removeSqlResource(client, input),
    pinExactFormIdentity: (input) => pinSqlExactFormIdentity(client, input),
  };
}

async function putSqlTargetPool(
  client: SqlClient,
  input: TargetPoolPutInput,
): Promise<TargetPoolPutResult> {
  assertTargetPoolPutInput(input);
  return await client.transaction(async (transaction) => {
    const current = await readSqlTargetPoolByIdentity(
      transaction,
      input.record,
      true,
    );
    if (!matchesExpectedTargetPool(current, input.expected)) {
      return {
        status: "conflict",
        ...(current ? { record: current } : {}),
      };
    }
    if (input.expected && targetPoolSpecsEqual(input.expected, input.record)) {
      return { status: "put", record: current! };
    }
    const reference = await readSqlTargetPoolReference(
      transaction,
      input.expected ?? input.record,
    );
    if (reference) return { status: "in_use", lock: reference };

    if (input.expected === null) {
      const inserted = await transaction.query(
        namedSpecCreateSql(names.targetPools),
        namedSpecParameters(input.record),
      );
      if (inserted.rowCount === 0) {
        const winner = await readSqlTargetPoolByIdentity(
          transaction,
          input.record,
          true,
        );
        return {
          status: "conflict",
          ...(winner ? { record: winner } : {}),
        };
      }
    } else {
      await transaction.query(
        namedSpecUpsertSql(names.targetPools),
        namedSpecParameters(input.record),
      );
    }
    return { status: "put", record: input.record };
  });
}

async function deleteSqlTargetPool(
  client: SqlClient,
  input: TargetPoolDeleteInput,
): Promise<TargetPoolDeleteResult> {
  assertTargetPoolDeleteInput(input);
  return await client.transaction(async (transaction) => {
    const current = await readSqlTargetPoolByIdentity(transaction, input, true);
    if (!current) return { status: "absent" };
    if (!matchesExpectedTargetPool(current, input.expected)) {
      return { status: "conflict", record: current };
    }

    const reference = await readSqlTargetPoolReference(transaction, current);
    if (reference) return { status: "in_use", lock: reference };

    await transaction.query(`delete from ${names.targetPools} where id = $1`, [
      current.id,
    ]);
    return { status: "deleted" };
  });
}

async function pinSqlExactFormIdentity(
  client: SqlClient,
  input: ResourceFormIdentityPinInput,
): Promise<ResourceFormIdentityPinResult> {
  assertResourceFormIdentityPinInput(input);
  return await client.transaction(async (transaction) => {
    const current = await readSqlResource(transaction, input.resourceId, true);
    const currentLock = await readSqlLock(transaction, input.resourceId, true);
    if (!current || !currentLock) return { status: "not_found" };
    if (
      resourceFormIdentitiesEqual(current.form, input.form) &&
      resourceFormIdentitiesEqual(currentLock.form, input.form)
    ) {
      assertNativeResourceFormIdentity(currentLock.nativeResources, input.form);
      return {
        status: "already_pinned",
        record: current,
        lock: currentLock,
      };
    }
    if (
      current.form !== undefined ||
      currentLock.form !== undefined ||
      current.kind !== shapeKindForPortableType(input.form.type) ||
      !matchesVersion(current, input.expectedResource) ||
      !matchesApplyLock(currentLock, input.expectedLock)
    ) {
      return {
        status: "conflict",
        record: current,
        lock: currentLock,
      };
    }
    const resourceUpdate = await transaction.query(
      `update ${names.resourceShapes}
       set form_ref_json = $1::jsonb, package_digest = $2,
           revision = revision + 1
       where id = $3 and form_ref_json is null and package_digest is null`,
      [
        JSON.stringify(formRefOfInstalled(input.form)),
        input.form.packageDigest,
        input.resourceId,
      ],
    );
    if (resourceUpdate.rowCount !== 1) {
      throw new Error("exact Form pin lost the locked Resource row");
    }
    const lockUpdate = await transaction.query(
      `update ${names.resolutionLocks}
       set form_ref_json = $1::jsonb, package_digest = $2,
           native_resources_json = $3::jsonb
       where resource_id = $4 and form_ref_json is null and package_digest is null`,
      [
        JSON.stringify(formRefOfInstalled(input.form)),
        input.form.packageDigest,
        JSON.stringify(
          bindNativeResourceFormIdentity(
            currentLock.nativeResources,
            input.form,
          ) ?? null,
        ),
        input.resourceId,
      ],
    );
    if (lockUpdate.rowCount !== 1) {
      throw new Error("exact Form pin lost the locked ResolutionLock row");
    }
    const record = {
      ...current,
      form: input.form,
      revision: resourceRecordRevision(current) + 1,
    };
    const lock = {
      ...currentLock,
      form: input.form,
      nativeResources: bindNativeResourceFormIdentity(
        currentLock.nativeResources,
        input.form,
      ),
    };
    return { status: "pinned", record, lock };
  });
}

async function beginSqlApply(
  client: SqlClient,
  input: ResourceApplyBeginInput,
): Promise<ResourceApplyBeginResult> {
  assertApplyPair(input.applyingRecord, input.plannedLock, "Applying");
  assertExpectedTargetPool(input);
  try {
    return await client.transaction(async (transaction) => {
      if (input.expectedTargetPool) {
        // TargetPool is always the first aggregate lock. A concurrent pool PUT
        // takes the same lock before inspecting ResolutionLocks, so either the
        // new pool wins and this CAS rejects, or this claim wins and PUT sees the
        // newly committed lock.
        const currentPool = await readSqlTargetPool(
          transaction,
          input.expectedTargetPool.id,
          true,
        );
        if (!matchesTargetPool(currentPool, input.expectedTargetPool)) {
          return {
            status: "target_pool_conflict",
            ...(currentPool ? { record: currentPool } : {}),
          };
        }
      }

      // Keep the aggregate lock order Resource -> ResolutionLock -> identity
      // fence. The same order is used by abort/remove, so a tombstone or
      // rollback cannot deadlock with an in-flight apply claim.
      const current = await readSqlResource(
        transaction,
        input.applyingRecord.id,
        true,
      );
      await readSqlLock(transaction, input.applyingRecord.id, true);
      const currentIdentityFence =
        input.expectedIdentityFence === undefined
          ? undefined
          : await readSqlIdentityFence(
              transaction,
              input.applyingRecord.id,
              true,
            );
      if (
        input.expectedIdentityFence !== undefined &&
        !matchesExpectedResourceIdentityFence(
          currentIdentityFence,
          input.expectedIdentityFence,
        )
      ) {
        return {
          status: "identity_fence_conflict",
          ...(currentIdentityFence ? { fence: currentIdentityFence } : {}),
        };
      }

      if (input.expected === undefined) {
        if (current) {
          if (current.managedBy !== input.applyingRecord.managedBy) {
            return { status: "ownership_conflict", record: current };
          }
          return { status: "conflict", record: current };
        }
        const inserted = await transaction.query(
          resourceInsertSql(names.resourceShapes, "on conflict do nothing"),
          resourceParameters(input.applyingRecord),
        );
        if (inserted.rowCount === 0) {
          const winner = await readSqlResource(
            transaction,
            input.applyingRecord.id,
          );
          if (!winner) {
            throw new Error(
              `resource create conflict did not resolve ${input.applyingRecord.id}`,
            );
          }
          if (winner.managedBy !== input.applyingRecord.managedBy) {
            return { status: "ownership_conflict", record: winner };
          }
          return { status: "conflict", record: winner };
        }
      } else {
        if (!current) return { status: "not_found" };
        if (current.managedBy !== input.applyingRecord.managedBy) {
          return { status: "ownership_conflict", record: current };
        }
        const updated = await updateSqlResource(
          transaction,
          input.applyingRecord,
          {
            ...input.expected,
            revision:
              input.expected.revision ??
              resourceRecordRevision(input.applyingRecord),
          },
          input.applyingRecord.managedBy,
        );
        if (updated.rowCount === 0) {
          const winner = await readSqlResource(
            transaction,
            input.applyingRecord.id,
          );
          if (!winner) return { status: "not_found" };
          if (winner.managedBy !== input.applyingRecord.managedBy) {
            return { status: "ownership_conflict", record: winner };
          }
          return { status: "conflict", record: winner };
        }
      }

      await transaction.query(
        lockUpsertSql(names.resolutionLocks),
        lockParameters(input.plannedLock),
      );
      if (input.expectedIdentityFence !== undefined) {
        await consumeSqlIdentityFence(
          transaction,
          input.applyingRecord.id,
          input.applyingRecord.generation,
          input.expectedIdentityFence,
        );
      }
      const persisted = await readSqlResource(
        transaction,
        input.applyingRecord.id,
      );
      if (!persisted) return { status: "not_found" };
      return {
        status: "begun",
        record: persisted,
        lock: input.plannedLock,
      };
    });
  } catch (error) {
    if (error instanceof SqlIdentityFenceConflict) {
      return {
        status: "identity_fence_conflict",
        ...(error.fence ? { fence: error.fence } : {}),
      };
    }
    throw error;
  }
}

async function commitSqlApply(
  client: SqlClient,
  input: ResourceApplyCommitInput,
): Promise<ResourceApplyCommitResult> {
  assertApplyPair(input.readyRecord, input.finalLock, "Ready");
  return await client.transaction(async (transaction) => {
    const updated = await updateSqlResource(
      transaction,
      input.readyRecord,
      input.expectedApplying,
    );
    if (updated.rowCount === 0) {
      const current = await readSqlResource(transaction, input.readyRecord.id);
      if (!current) return { status: "not_found" };
      return { status: "conflict", record: current };
    }
    await transaction.query(
      lockUpsertSql(names.resolutionLocks),
      lockParameters(input.finalLock),
    );
    const persisted = await readSqlResource(transaction, input.readyRecord.id);
    if (!persisted) return { status: "not_found" };
    return {
      status: "committed",
      record: persisted,
      lock: input.finalLock,
    };
  });
}

async function claimSqlResourceAggregate(
  client: SqlClient,
  input: ResourceAggregateClaimInput,
): Promise<ResourceAggregateClaimResult> {
  assertResourceAggregateClaimInput(input);
  return await client.transaction(async (transaction) => {
    // Preserve the Resource -> ResolutionLock -> identity-fence lock order
    // shared by apply, abort, replace, and remove aggregate mutations.
    const current = await readSqlResource(
      transaction,
      input.record.id,
      true,
    );
    const currentLock = await readSqlLock(
      transaction,
      input.record.id,
      true,
    );
    const currentIdentityFence = await readSqlIdentityFence(
      transaction,
      input.record.id,
      true,
    );
    if (!current && !currentLock) return { status: "not_found" };
    if (
      current &&
      currentLock &&
      matchesClaimedResource(current, input) &&
      matchesApplyLock(currentLock, input.expectedLock) &&
      matchesExpectedResourceIdentityFence(
        currentIdentityFence,
        input.expectedIdentityFence,
      )
    ) {
      return { status: "claimed", record: current };
    }
    if (
      !current ||
      !currentLock ||
      !matchesVersion(current, input.expectedResource) ||
      !matchesApplyLock(currentLock, input.expectedLock) ||
      !matchesExpectedResourceIdentityFence(
        currentIdentityFence,
        input.expectedIdentityFence,
      )
    ) {
      return {
        status: "conflict",
        ...(current ? { record: current } : {}),
        ...(currentLock ? { lock: currentLock } : {}),
        ...(currentIdentityFence
          ? { identityFence: currentIdentityFence }
          : {}),
      };
    }
    const updated = await updateSqlResource(
      transaction,
      input.record,
      input.expectedResource,
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        `Resource ${input.record.id} changed inside aggregate claim`,
      );
    }
    const record = await readSqlResource(transaction, input.record.id);
    return record
      ? { status: "claimed", record }
      : { status: "not_found" };
  });
}

async function replaceSqlResourceAggregate(
  client: SqlClient,
  input: ResourceAggregateReplaceInput,
): Promise<ResourceAggregateReplaceResult> {
  assertResourceAggregateReplaceInput(input);
  try {
    return await client.transaction(async (transaction) => {
      const current = await readSqlResource(
        transaction,
        input.record.id,
        true,
      );
      const currentLock = await readSqlLock(
        transaction,
        input.record.id,
        true,
      );
      const currentIdentityFence = input.identityFenceAdvance
        ? await readSqlIdentityFence(transaction, input.record.id, true)
        : undefined;
      if (!current && !currentLock) return { status: "not_found" };
      if (
        !current ||
        !currentLock ||
        !matchesVersion(current, input.expectedResource) ||
        !matchesApplyLock(currentLock, input.expectedLock) ||
        (input.identityFenceAdvance !== undefined &&
          !matchesExpectedResourceIdentityFence(
            currentIdentityFence,
            input.identityFenceAdvance.expected,
          ))
      ) {
        return {
          status: "conflict",
          ...(current ? { record: current } : {}),
          ...(currentLock ? { lock: currentLock } : {}),
        };
      }
      const updated = await updateSqlResource(
        transaction,
        input.record,
        input.expectedResource,
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `Resource ${input.record.id} changed inside aggregate replacement`,
        );
      }
      await transaction.query(
        lockUpsertSql(names.resolutionLocks),
        lockParameters(input.lock),
      );
      if (input.identityFenceAdvance) {
        await consumeSqlIdentityFence(
          transaction,
          input.record.id,
          input.record.generation,
          input.identityFenceAdvance.expected,
        );
      }
      const record = await readSqlResource(transaction, input.record.id);
      const lock = await readSqlLock(transaction, input.record.id);
      const identityFence = input.identityFenceAdvance
        ? await readSqlIdentityFence(transaction, input.record.id)
        : undefined;
      if (!record || !lock) return { status: "not_found" };
      return {
        status: "replaced",
        record,
        lock,
        ...(identityFence ? { identityFence } : {}),
      };
    });
  } catch (error) {
    if (!(error instanceof SqlIdentityFenceConflict)) throw error;
    const [current, currentLock] = await Promise.all([
      readSqlResource(client, input.record.id),
      readSqlLock(client, input.record.id),
    ]);
    if (!current && !currentLock) return { status: "not_found" };
    return {
      status: "conflict",
      ...(current ? { record: current } : {}),
      ...(currentLock ? { lock: currentLock } : {}),
    };
  }
}

async function abortSqlApply(
  client: SqlClient,
  input: ResourceApplyAbortInput,
): Promise<ResourceApplyAbortResult> {
  assertAbortInput(input);
  return await client.transaction(async (transaction) => {
    // Lock in the same Resource -> ResolutionLock order used by begin/commit.
    const current = await readSqlResource(transaction, input.resourceId, true);
    const currentLock = await readSqlLock(transaction, input.resourceId, true);
    const currentIdentityFence = input.identityFenceRollback
      ? await readSqlIdentityFence(transaction, input.resourceId, true)
      : undefined;
    if (!current && !currentLock) return { status: "not_found" };
    if (
      !current ||
      !currentLock ||
      !matchesVersion(current, input.expectedApplying) ||
      !matchesApplyLock(currentLock, input.expectedPlannedLock) ||
      (input.identityFenceRollback !== undefined &&
        !matchesResourceIdentityFence(
          currentIdentityFence,
          input.identityFenceRollback.expected,
        ))
    ) {
      return {
        status: "conflict",
        ...(current ? { record: current } : {}),
        ...(currentLock ? { lock: currentLock } : {}),
      };
    }

    if (input.replacement) {
      const replaced = await updateSqlResource(
        transaction,
        input.replacement.record,
        input.expectedApplying,
      );
      if (replaced.rowCount !== 1) {
        throw new Error(
          `Resource ${input.resourceId} changed inside abort transaction`,
        );
      }
      if (input.replacement.lock) {
        await transaction.query(
          lockUpsertSql(names.resolutionLocks),
          lockParameters(input.replacement.lock),
        );
      } else {
        await transaction.query(
          `delete from ${names.resolutionLocks} where resource_id = $1`,
          [input.resourceId],
        );
      }
    } else {
      await transaction.query(
        `delete from ${names.resolutionLocks} where resource_id = $1`,
        [input.resourceId],
      );
      await transaction.query(
        `delete from ${names.resourceShapes} where id = $1`,
        [input.resourceId],
      );
    }
    if (input.identityFenceRollback) {
      await replaceSqlIdentityFence(
        transaction,
        input.identityFenceRollback.expected,
        input.identityFenceRollback.replacement,
      );
    }
    return { status: "rolled_back" };
  });
}

async function removeSqlResource(
  client: SqlClient,
  input: ResourceAtomicRemoveInput,
): Promise<ResourceAtomicRemoveResult> {
  assertAtomicRemoveInput(input);
  return await client.transaction(async (transaction) => {
    // Keep the same Resource -> ResolutionLock lock order as the other atomic
    // lifecycle paths. The parent-row lock also fences a concurrent child lock
    // insert through the database foreign-key check.
    const current = await readSqlResource(transaction, input.resourceId, true);
    const currentLock = await readSqlLock(transaction, input.resourceId, true);
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

    const currentIdentityFence = await readSqlIdentityFence(
      transaction,
      input.resourceId,
      true,
    );
    if (
      currentIdentityFence &&
      currentIdentityFence.lastGeneration !== current.generation
    ) {
      return {
        status: "conflict",
        record: current,
        ...(currentLock ? { lock: currentLock } : {}),
      };
    }
    const retiredIdentityFence = retireResourceIdentityFence(
      current,
      currentIdentityFence,
    );

    await transaction.query(
      `delete from ${names.resolutionLocks} where resource_id = $1`,
      [input.resourceId],
    );
    const revisionPredicate =
      input.expected.revision === undefined ? "" : " and revision = $5";
    const removed = await transaction.query(
      `delete from ${names.resourceShapes}
       where id = $1 and generation = $2 and phase = $3 and updated_at = $4${revisionPredicate}`,
      [
        input.resourceId,
        input.expected.generation,
        input.expected.phase,
        input.expected.updatedAt,
        ...(input.expected.revision === undefined
          ? []
          : [input.expected.revision]),
      ],
    );
    if (removed.rowCount !== 1) {
      throw new Error(
        `Resource ${input.resourceId} changed inside remove transaction`,
      );
    }
    await retireSqlIdentityFence(
      transaction,
      currentIdentityFence,
      retiredIdentityFence,
    );
    return { status: "removed" };
  });
}

function updateSqlResource(
  client: SqlClient,
  record: ResourceShapeRecord,
  expected: {
    readonly generation: number;
    readonly phase: ResourcePhase;
    readonly updatedAt: string;
    readonly revision?: number;
  },
  expectedManagedBy?: ResourceManagedBy,
) {
  let nextParameter = 27;
  const revisionPredicate =
    expected.revision === undefined
      ? ""
      : ` and revision = $${nextParameter++}`;
  const managedByPredicate = expectedManagedBy
    ? ` and managed_by = $${nextParameter}`
    : "";
  return client.query(
    `update ${names.resourceShapes} set
      space_id = $1, project = $2, environment = $3, kind = $4,
      form_ref_json = $5::jsonb, package_digest = $6, name = $7,
      managed_by = $8, spec_json = $9::jsonb, phase = $10, generation = $11,
      observed_generation = $12, outputs_json = $13::jsonb,
      execution_json = $14::jsonb, state_adoption_json = $15::jsonb,
      conditions_json = $16::jsonb, labels_json = $17::jsonb,
      created_at = $18, updated_at = $19,
      pending_operation_json = $20::jsonb, last_operation_run_id = $21,
      owner_json = $22::jsonb,
      revision = revision + 1
    where id = $23 and generation = $24 and phase = $25
      and updated_at = $26${revisionPredicate}${managedByPredicate}`,
    [
      ...resourceUpdateParameters(record),
      record.id,
      expected.generation,
      expected.phase,
      expected.updatedAt,
      ...(expected.revision === undefined ? [] : [expected.revision]),
      ...(expectedManagedBy ? [expectedManagedBy] : []),
    ],
  );
}

async function readSqlIdentityFence(
  client: SqlClient,
  resourceId: ResourceShapeRecordId,
  forUpdate = false,
): Promise<ResourceIdentityFenceRecord | undefined> {
  const result = await client.query<ResourceIdentityFenceRow>(
    `select resource_id, last_generation, fence_revision,
            retired_owner_json
       from ${names.resourceIdentityFences}
      where resource_id = $1 limit 1${forUpdate ? " for update" : ""}`,
    [resourceId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const fence: ResourceIdentityFenceRecord = {
    resourceId: row.resource_id,
    lastGeneration: Number(row.last_generation),
    fenceRevision: Number(row.fence_revision),
    ...(parseResourceOwner(row.retired_owner_json) === undefined
      ? {}
      : { retiredOwner: parseResourceOwner(row.retired_owner_json) }),
  };
  assertResourceIdentityFence(fence);
  return fence;
}

/** Consume one exact preview/import fence after Resource and lock writes. */
async function consumeSqlIdentityFence(
  transaction: SqlClient,
  resourceId: ResourceShapeRecordId,
  generation: number,
  expected: ResourceIdentityFenceRecord | null,
): Promise<void> {
  const consumed = consumeResourceIdentityFence(
    resourceId,
    generation,
    expected,
  );
  if (expected === null) {
    const inserted = await transaction.query(
      `insert into ${names.resourceIdentityFences}
        (resource_id, last_generation, fence_revision, retired_owner_json)
       values ($1, $2, $3, $4::jsonb)
       on conflict (resource_id) do nothing`,
      [
        consumed.resourceId,
        consumed.lastGeneration,
        consumed.fenceRevision,
        jsonOrNull(consumed.retiredOwner),
      ],
    );
    if (inserted.rowCount === 1) return;
  } else {
    const updated = await transaction.query(
      `update ${names.resourceIdentityFences}
          set last_generation = $1, fence_revision = $2,
              retired_owner_json = $3::jsonb
        where resource_id = $4
          and last_generation = $5
          and fence_revision = $6`,
      [
        consumed.lastGeneration,
        consumed.fenceRevision,
        jsonOrNull(consumed.retiredOwner),
        consumed.resourceId,
        expected.lastGeneration,
        expected.fenceRevision,
      ],
    );
    if (updated.rowCount === 1) return;
  }

  // A missing-row insert or CAS update can only lose to a transaction that
  // changed this fence after our preflight read. The caller must roll back the
  // already-written Resource/ResolutionLock pair before observing the loser.
  throw new SqlIdentityFenceConflict(
    await readSqlIdentityFence(transaction, resourceId, true),
  );
}

/** Restore the exact fence consumed by an apply that never reached a backend. */
async function replaceSqlIdentityFence(
  transaction: SqlClient,
  expected: ResourceIdentityFenceRecord,
  replacement: ResourceIdentityFenceRecord | null,
): Promise<void> {
  assertResourceIdentityFence(expected);
  if (replacement) {
    assertResourceIdentityFence(replacement);
    const updated = await transaction.query(
      `update ${names.resourceIdentityFences}
          set last_generation = $1, fence_revision = $2,
              retired_owner_json = $3::jsonb
        where resource_id = $4
          and last_generation = $5
          and fence_revision = $6`,
      [
        replacement.lastGeneration,
        replacement.fenceRevision,
        jsonOrNull(replacement.retiredOwner),
        expected.resourceId,
        expected.lastGeneration,
        expected.fenceRevision,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        `Resource ${expected.resourceId} identity fence changed inside abort transaction`,
      );
    }
    return;
  }

  const deleted = await transaction.query(
    `delete from ${names.resourceIdentityFences}
      where resource_id = $1
        and last_generation = $2
        and fence_revision = $3`,
    [expected.resourceId, expected.lastGeneration, expected.fenceRevision],
  );
  if (deleted.rowCount !== 1) {
    throw new Error(
      `Resource ${expected.resourceId} identity fence changed inside abort transaction`,
    );
  }
}

/** Retire the live Resource incarnation while preserving its canonical id. */
async function retireSqlIdentityFence(
  transaction: SqlClient,
  current: ResourceIdentityFenceRecord | undefined,
  replacement: ResourceIdentityFenceRecord,
): Promise<void> {
  if (current) {
    const updated = await transaction.query(
      `update ${names.resourceIdentityFences}
          set last_generation = $1, fence_revision = $2,
              retired_owner_json = $3::jsonb
        where resource_id = $4
          and last_generation = $5
          and fence_revision = $6`,
      [
        replacement.lastGeneration,
        replacement.fenceRevision,
        jsonOrNull(replacement.retiredOwner),
        replacement.resourceId,
        current.lastGeneration,
        current.fenceRevision,
      ],
    );
    if (updated.rowCount === 1) return;
  } else {
    const inserted = await transaction.query(
      `insert into ${names.resourceIdentityFences}
        (resource_id, last_generation, fence_revision, retired_owner_json)
       values ($1, $2, $3, $4::jsonb)
       on conflict (resource_id) do nothing`,
      [
        replacement.resourceId,
        replacement.lastGeneration,
        replacement.fenceRevision,
        jsonOrNull(replacement.retiredOwner),
      ],
    );
    if (inserted.rowCount === 1) return;
  }
  throw new Error(
    `Resource ${replacement.resourceId} identity fence changed inside remove transaction`,
  );
}

async function readSqlResource(
  client: SqlClient,
  resourceId: ResourceShapeRecordId,
  forUpdate = false,
): Promise<ResourceShapeRecord | undefined> {
  const result = await client.query<ResourceShapeRow>(
    `select * from ${names.resourceShapes} where id = $1 limit 1${
      forUpdate ? " for update" : ""
    }`,
    [resourceId],
  );
  return result.rows[0] ? resourceShapeFromRow(result.rows[0]) : undefined;
}

async function readSqlLock(
  client: SqlClient,
  resourceId: ResourceShapeRecordId,
  forUpdate = false,
): Promise<ResolutionLockRecord | undefined> {
  const result = await client.query<ResolutionLockRow>(
    `select * from ${names.resolutionLocks} where resource_id = $1 limit 1${
      forUpdate ? " for update" : ""
    }`,
    [resourceId],
  );
  return result.rows[0] ? resolutionLockFromRow(result.rows[0]) : undefined;
}

async function readSqlTargetPool(
  client: SqlClient,
  id: TargetPoolRecordId,
  forUpdate = false,
): Promise<TargetPoolRecord | undefined> {
  const result = await client.query<NamedSpecRow>(
    `select * from ${names.targetPools} where id = $1 limit 1${
      forUpdate ? " for update" : ""
    }`,
    [id],
  );
  return result.rows[0] ? targetPoolFromRow(result.rows[0]) : undefined;
}

async function readSqlTargetPoolByIdentity(
  client: SqlClient,
  record: Pick<TargetPoolRecord, "id" | "spaceId" | "name">,
  forUpdate = false,
): Promise<TargetPoolRecord | undefined> {
  const result = await client.query<NamedSpecRow>(
    `select * from ${names.targetPools}
     where id = $1 or (space_id = $2 and name = $3)
     order by case when id = $1 then 0 else 1 end limit 1${
       forUpdate ? " for update" : ""
     }`,
    [record.id, record.spaceId, record.name],
  );
  return result.rows[0] ? targetPoolFromRow(result.rows[0]) : undefined;
}

async function readSqlTargetPoolReference(
  client: SqlClient,
  pool: TargetPoolRecord,
): Promise<ResolutionLockRecord | undefined> {
  const result = await client.query<ResolutionLockRow>(
    `select resolution.*
     from ${names.resolutionLocks} resolution
     join ${names.resourceShapes} resource
       on resource.id = resolution.resource_id
     where resource.space_id = $1
       and (
         resolution.target_pool = $2
         or (
           resolution.target_pool is null
           and exists (
             select 1
             from jsonb_array_elements(
               coalesce($3::jsonb -> 'targets', '[]'::jsonb)
             ) as pool_target(value)
             where pool_target.value ->> 'name' = resolution.target
           )
         )
       )
     order by resolution.resource_id asc limit 1`,
    [pool.spaceId, pool.name, JSON.stringify(pool.spec)],
  );
  return result.rows[0] ? resolutionLockFromRow(result.rows[0]) : undefined;
}

function resourceInsertSql(table: string, conflict: string): string {
  return `insert into ${table} (
    id, space_id, project, environment, kind, form_ref_json, package_digest,
    name, managed_by,
    spec_json, phase, generation, observed_generation,
    outputs_json, execution_json, state_adoption_json,
    conditions_json, labels_json, created_at, updated_at,
    pending_operation_json, last_operation_run_id, owner_json, revision
  ) values (
    $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb,
    $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb,
    $17::jsonb, $18::jsonb, $19, $20, $21::jsonb, $22, $23::jsonb, $24
  ) ${conflict}`;
}

function resourceParameters(record: ResourceShapeRecord): readonly SqlValue[] {
  assertResourceFormIdentity(record.form, record.kind);
  return [
    record.id,
    record.spaceId,
    record.project ?? null,
    record.environment ?? null,
    record.kind,
    jsonOrNull(record.form && formRefOfInstalled(record.form)),
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
    jsonOrNull(record.pendingOperation),
    record.lastOperationRunId ?? null,
    jsonOrNull(record.owner),
    resourceRecordRevision(record),
  ];
}

function resourceUpdateParameters(
  record: ResourceShapeRecord,
): readonly SqlValue[] {
  const parameters = resourceParameters(record);
  return [...parameters.slice(1, 20), ...parameters.slice(20, 23)];
}

function lockParameters(lock: ResolutionLockRecord): readonly SqlValue[] {
  const form = exactFormIdentity(
    jsonOrNull(lock.form && formRefOfInstalled(lock.form)),
    lock.form?.packageDigest ?? null,
  );
  return [
    lock.resourceId,
    jsonOrNull(form && formRefOfInstalled(form)),
    form?.packageDigest ?? null,
    lock.selectedImplementation,
    lock.targetPool ?? null,
    lock.target,
    jsonOrNull(lock.targetSnapshot),
    jsonOrNull(lock.implementationSnapshot),
    lock.selectedImplementationPlugin ?? null,
    jsonOrNull(lock.selectedImplementationOptions),
    lock.implementationFingerprint ?? null,
    lock.locked,
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
  ) values ($1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
    $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15::jsonb, $16, $17)
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
  ) values ($1, $2, $3, $4::jsonb, $5, $6)
  on conflict (id) do update set
    space_id = excluded.space_id,
    name = excluded.name,
    spec_json = excluded.spec_json,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`;
}

function namedSpecCreateSql(table: string): string {
  return `insert into ${table} (
    id, space_id, name, spec_json, created_at, updated_at
  ) values ($1, $2, $3, $4::jsonb, $5, $6)
  on conflict do nothing`;
}

function namedSpecParameters(
  record: TargetPoolRecord | SpacePolicyRecord,
): readonly SqlValue[] {
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
  const owner = parseResourceOwner(row.owner_json);
  const pendingOperation = parseJson<ResourceShapePendingOperation>(
    row.pending_operation_json,
  );
  const revision = normalizeStoredRevision(row.revision);
  return {
    id: row.id,
    revision,
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
    ...(pendingOperation === undefined ? {} : { pendingOperation }),
    ...(row.last_operation_run_id === undefined ||
    row.last_operation_run_id === null
      ? {}
      : { lastOperationRunId: row.last_operation_run_id }),
    ...(stateAdoption === undefined ? {} : { stateAdoption }),
    ...(conditions === undefined ? {} : { conditions }),
    ...(labels === undefined ? {} : { labels }),
    ...(owner === undefined ? {} : { owner }),
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function normalizeStoredRevision(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`invalid durable Resource revision ${String(value)}`);
  }
  return revision;
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
    locked: row.locked === true || row.locked === 1,
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

/** Legacy owner rows may be returned as an unquoted scalar by SQL adapters. */
function parseResourceOwner(value: unknown): ResourceOwner | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return value as ResourceOwner;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed === null ? undefined : (parsed as ResourceOwner);
  } catch {
    return value;
  }
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
    ...(parseJson<FormRef>(formRefJson) ?? {}),
    packageDigest,
  };
  if (!isInstalledFormReference(identity)) {
    throw new Error("durable Resource form identity is partial or invalid");
  }
  return identity;
}
