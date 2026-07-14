// Postgres implementations of the Resource Shape stores over Takosumi's
// runtime-neutral SqlClient.

import type {
  Condition,
  JsonObject,
  NativeResourceRef,
  ResourceManagedBy,
  ResourcePhase,
  ResourcePortability,
  ResourceShapeKind,
  TargetImplementationDescriptor,
  TargetPoolEntry,
} from "takosumi-contract";
import { parseResourceShapeKind } from "takosumi-contract";
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
  ResourceShapeExecutionRecord,
  ResourceShapeRecord,
  ResourceShapeRecordId,
  ResourceShapeStateAdoptionDescriptor,
  SpacePolicyRecord,
  SpacePolicyRecordId,
  TargetPoolRecord,
  TargetPoolRecordId,
} from "./records.ts";
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

type ResourceShapeRow = {
  readonly id: string;
  readonly space_id: string;
  readonly project: string | null;
  readonly environment: string | null;
  readonly kind: string;
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
};

type ResolutionLockRow = {
  readonly resource_id: string;
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
    if (result.rowCount > 0) return { status: "created", record };
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
      resourceParameters(record),
    );
    return record;
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
    },
  ): Promise<boolean> {
    const result = await this.client.query(
      `delete from ${this.#table}
       where id = $1 and generation = $2 and phase = $3 and updated_at = $4`,
      [id, expected.generation, expected.phase, expected.updatedAt],
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
       set state_adoption_json = $1::jsonb, updated_at = $2
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
    },
  ): Promise<
    | { readonly status: "updated"; readonly record: ResourceShapeRecord }
    | { readonly status: "not_found" }
    | { readonly status: "conflict"; readonly record: ResourceShapeRecord }
  > {
    const result = await this.client.query(
      `update ${this.#table} set
        space_id = $1, project = $2, environment = $3, kind = $4, name = $5,
        managed_by = $6, spec_json = $7::jsonb, phase = $8, generation = $9,
        observed_generation = $10, outputs_json = $11::jsonb,
        execution_json = $12::jsonb, state_adoption_json = $13::jsonb,
        conditions_json = $14::jsonb, labels_json = $15::jsonb,
        created_at = $16, updated_at = $17
       where id = $18 and generation = $19 and phase = $20 and updated_at = $21`,
      [
        ...resourceParameters(record).slice(1),
        record.id,
        expected.generation,
        expected.phase,
        expected.updatedAt,
      ],
    );
    if (result.rowCount > 0) return { status: "updated", record };
    const current = await this.get(record.id);
    return current
      ? { status: "conflict", record: current }
      : { status: "not_found" };
  }

  async claimDelete(
    record: ResourceShapeRecord,
    expectedGeneration: number,
  ): Promise<ResourceDeleteClaimResult> {
    const result = await this.client.query(
      `update ${this.#table}
       set phase = $1, conditions_json = $2::jsonb, updated_at = $3
       where id = $4 and generation = $5 and phase != 'Deleting'`,
      [
        record.phase,
        jsonOrNull(record.conditions),
        record.updatedAt,
        record.id,
        expectedGeneration,
      ],
    );
    if (result.rowCount > 0) return { status: "claimed", record };
    const current = await this.get(record.id);
    if (!current) return { status: "not_found" };
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
    beginApply: (input) => beginSqlApply(client, input),
    commitApply: (input) => commitSqlApply(client, input),
    abortApply: (input) => abortSqlApply(client, input),
    removeResource: (input) => removeSqlResource(client, input),
  };
}

async function beginSqlApply(
  client: SqlClient,
  input: ResourceApplyBeginInput,
): Promise<ResourceApplyBeginResult> {
  assertApplyPair(input.applyingRecord, input.plannedLock, "Applying");
  return await client.transaction(async (transaction) => {
    if (input.expected === undefined) {
      const inserted = await transaction.query(
        resourceInsertSql(names.resourceShapes, "on conflict do nothing"),
        resourceParameters(input.applyingRecord),
      );
      if (inserted.rowCount === 0) {
        const current = await readSqlResource(
          transaction,
          input.applyingRecord.id,
        );
        if (!current) {
          throw new Error(
            `resource create conflict did not resolve ${input.applyingRecord.id}`,
          );
        }
        return { status: "conflict", record: current };
      }
    } else {
      const updated = await updateSqlResource(
        transaction,
        input.applyingRecord,
        input.expected,
      );
      if (updated.rowCount === 0) {
        const current = await readSqlResource(
          transaction,
          input.applyingRecord.id,
        );
        if (!current) return { status: "not_found" };
        return { status: "conflict", record: current };
      }
    }
    await transaction.query(
      lockUpsertSql(names.resolutionLocks),
      lockParameters(input.plannedLock),
    );
    return {
      status: "begun",
      record: input.applyingRecord,
      lock: input.plannedLock,
    };
  });
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
    return {
      status: "committed",
      record: input.readyRecord,
      lock: input.finalLock,
    };
  });
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

    await transaction.query(
      `delete from ${names.resolutionLocks} where resource_id = $1`,
      [input.resourceId],
    );
    const removed = await transaction.query(
      `delete from ${names.resourceShapes}
       where id = $1 and generation = $2 and phase = $3 and updated_at = $4`,
      [
        input.resourceId,
        input.expected.generation,
        input.expected.phase,
        input.expected.updatedAt,
      ],
    );
    if (removed.rowCount !== 1) {
      throw new Error(
        `Resource ${input.resourceId} changed inside remove transaction`,
      );
    }
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
  },
) {
  return client.query(
    `update ${names.resourceShapes} set
      space_id = $1, project = $2, environment = $3, kind = $4, name = $5,
      managed_by = $6, spec_json = $7::jsonb, phase = $8, generation = $9,
      observed_generation = $10, outputs_json = $11::jsonb,
      execution_json = $12::jsonb, state_adoption_json = $13::jsonb,
      conditions_json = $14::jsonb, labels_json = $15::jsonb,
      created_at = $16, updated_at = $17
    where id = $18 and generation = $19 and phase = $20 and updated_at = $21`,
    [
      ...resourceParameters(record).slice(1),
      record.id,
      expected.generation,
      expected.phase,
      expected.updatedAt,
    ],
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

function resourceInsertSql(table: string, conflict: string): string {
  return `insert into ${table} (
    id, space_id, project, environment, kind, name, managed_by,
    spec_json, phase, generation, observed_generation,
    outputs_json, execution_json, state_adoption_json,
    conditions_json, labels_json, created_at, updated_at
  ) values (
    $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
    $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17, $18
  ) ${conflict}`;
}

function resourceParameters(record: ResourceShapeRecord): readonly SqlValue[] {
  return [
    record.id,
    record.spaceId,
    record.project ?? null,
    record.environment ?? null,
    record.kind,
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

function lockParameters(lock: ResolutionLockRecord): readonly SqlValue[] {
  return [
    lock.resourceId,
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
    resource_id, selected_implementation, target_pool, target,
    target_snapshot_json, implementation_snapshot_json,
    implementation_plugin, implementation_options_json,
    implementation_fingerprint, locked, reason_json, portability,
    native_resources_json, locked_at, updated_at
  ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb,
    $9, $10, $11::jsonb, $12, $13::jsonb, $14, $15)
  on conflict (resource_id) do update set
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
    kind: parseResourceShapeKind(row.kind),
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
