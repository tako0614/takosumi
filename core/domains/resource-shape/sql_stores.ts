// Postgres implementations of the Resource Shape stores.
//
// These persist the four Resource Shape entities on the deploy-control Postgres
// plane (alongside the Flow A ledger), mirroring the row<->record mapping +
// JSON-column conventions of `deploy-control/store_sql.ts`. Complex sub-objects
// (spec / outputs / conditions / labels / reason / native resources) are stored
// as `jsonb` columns; a JSON-text bound parameter coerces into jsonb on write,
// and jsonb reads round-trip as parsed JS values (with a string fallback so a
// driver that hands back text still parses).

import type {
  Condition,
  JsonObject,
  NativeResourceRef,
  ResourceManagedBy,
  ResourcePhase,
  ResourcePortability,
  ResourceShapeKind,
} from "takosumi-contract";
import type { SqlClient } from "../../adapters/storage/sql.ts";
import {
  deployControlPostgresTableNames as pgNames,
} from "../../adapters/storage/drizzle/schema/logical.ts";
import type { SpaceId } from "../../shared/ids.ts";
import type { IsoTimestamp } from "../../shared/time.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
  ResourceShapeRecordId,
  SpacePolicyRecord,
  SpacePolicyRecordId,
  TargetPoolRecord,
  TargetPoolRecordId,
} from "./records.ts";
import type {
  ResolutionLockStore,
  ResourceShapeStore,
  ResourceShapeStores,
  SpacePolicyStore,
  TargetPoolStore,
} from "./stores.ts";

// --- JSON (de)serialization helpers -----------------------------------------

/** Serialize an optional JSON sub-object to a bound jsonb-text param or null. */
function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Tolerant jsonb read: accept already-parsed JS values or a JSON-text string. */
function parseJson<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value === "") return undefined;
    return JSON.parse(value) as T;
  }
  return value as T;
}

// --- Row shapes (as the SQL driver returns them) ----------------------------

// Declared as `type` (not `interface`) so each row shape satisfies the
// `Row extends Record<string, unknown>` constraint on `SqlClient.query`.
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
  readonly conditions_json: unknown;
  readonly labels_json: unknown;
  readonly created_at: string;
  readonly updated_at: string;
};

type ResolutionLockRow = {
  readonly resource_id: string;
  readonly selected_implementation: string;
  readonly target: string;
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

// --- Row -> record mappers (shared with the D1 store's expectations) ----------

function resourceShapeFromRow(row: ResourceShapeRow): ResourceShapeRecord {
  return {
    id: row.id,
    spaceId: row.space_id as SpaceId,
    ...(row.project === null ? {} : { project: row.project }),
    ...(row.environment === null ? {} : { environment: row.environment }),
    kind: row.kind as ResourceShapeKind,
    name: row.name,
    managedBy: row.managed_by as ResourceManagedBy,
    spec: parseJson<JsonObject>(row.spec_json) ?? {},
    phase: row.phase as ResourcePhase,
    generation: Number(row.generation),
    observedGeneration: Number(row.observed_generation),
    ...(parseJson<JsonObject>(row.outputs_json) === undefined
      ? {}
      : { outputs: parseJson<JsonObject>(row.outputs_json) }),
    ...(parseJson<readonly Condition[]>(row.conditions_json) === undefined
      ? {}
      : { conditions: parseJson<readonly Condition[]>(row.conditions_json) }),
    ...(parseJson<Record<string, string>>(row.labels_json) === undefined
      ? {}
      : { labels: parseJson<Record<string, string>>(row.labels_json) }),
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function resolutionLockFromRow(row: ResolutionLockRow): ResolutionLockRecord {
  return {
    resourceId: row.resource_id,
    selectedImplementation: row.selected_implementation,
    target: row.target,
    locked: row.locked === true || row.locked === 1,
    reason: parseJson<readonly string[]>(row.reason_json) ?? [],
    ...(row.portability === null
      ? {}
      : { portability: row.portability as ResourcePortability }),
    ...(parseJson<readonly NativeResourceRef[]>(row.native_resources_json) ===
    undefined
      ? {}
      : {
          nativeResources: parseJson<readonly NativeResourceRef[]>(
            row.native_resources_json,
          ),
        }),
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

// --- Stores ------------------------------------------------------------------

class SqlResourceShapeStore implements ResourceShapeStore {
  readonly #client: SqlClient;
  readonly #table = pgNames.resourceShapes;

  constructor(client: SqlClient) {
    this.#client = client;
  }

  async upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord> {
    await this.#client.query(
      `insert into ${this.#table} (
        id, space_id, project, environment, kind, name, managed_by,
        spec_json, phase, generation, observed_generation,
        outputs_json, conditions_json, labels_json, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
        $12::jsonb, $13::jsonb, $14::jsonb, $15, $16
      )
      on conflict (id) do update set
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
        conditions_json = excluded.conditions_json,
        labels_json = excluded.labels_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      [
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
        jsonOrNull(record.conditions),
        jsonOrNull(record.labels),
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  async get(
    id: ResourceShapeRecordId,
  ): Promise<ResourceShapeRecord | undefined> {
    const result = await this.#client.query<ResourceShapeRow>(
      `select * from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : resourceShapeFromRow(row);
  }

  async getByName(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ResourceShapeRecord | undefined> {
    const result = await this.#client.query<ResourceShapeRow>(
      `select * from ${this.#table}
       where space_id = $1 and kind = $2 and name = $3 limit 1`,
      [spaceId, kind, name],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : resourceShapeFromRow(row);
  }

  async listBySpace(
    spaceId: SpaceId,
  ): Promise<readonly ResourceShapeRecord[]> {
    const result = await this.#client.query<ResourceShapeRow>(
      `select * from ${this.#table}
       where space_id = $1 order by kind asc, name asc, id asc`,
      [spaceId],
    );
    return result.rows.map(resourceShapeFromRow);
  }

  async delete(id: ResourceShapeRecordId): Promise<void> {
    await this.#client.query(`delete from ${this.#table} where id = $1`, [id]);
  }
}

class SqlResolutionLockStore implements ResolutionLockStore {
  readonly #client: SqlClient;
  readonly #table = pgNames.resolutionLocks;

  constructor(client: SqlClient) {
    this.#client = client;
  }

  async put(lock: ResolutionLockRecord): Promise<ResolutionLockRecord> {
    await this.#client.query(
      `insert into ${this.#table} (
        resource_id, selected_implementation, target, locked, reason_json,
        portability, native_resources_json, locked_at, updated_at
      ) values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)
      on conflict (resource_id) do update set
        selected_implementation = excluded.selected_implementation,
        target = excluded.target,
        locked = excluded.locked,
        reason_json = excluded.reason_json,
        portability = excluded.portability,
        native_resources_json = excluded.native_resources_json,
        locked_at = excluded.locked_at,
        updated_at = excluded.updated_at`,
      [
        lock.resourceId,
        lock.selectedImplementation,
        lock.target,
        lock.locked,
        JSON.stringify(lock.reason),
        lock.portability ?? null,
        jsonOrNull(lock.nativeResources),
        lock.lockedAt,
        lock.updatedAt,
      ],
    );
    return lock;
  }

  async get(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResolutionLockRecord | undefined> {
    const result = await this.#client.query<ResolutionLockRow>(
      `select * from ${this.#table} where resource_id = $1 limit 1`,
      [resourceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : resolutionLockFromRow(row);
  }

  async delete(resourceId: ResourceShapeRecordId): Promise<void> {
    await this.#client.query(
      `delete from ${this.#table} where resource_id = $1`,
      [resourceId],
    );
  }
}

class SqlTargetPoolStore implements TargetPoolStore {
  readonly #client: SqlClient;
  readonly #table = pgNames.targetPools;

  constructor(client: SqlClient) {
    this.#client = client;
  }

  async upsert(record: TargetPoolRecord): Promise<TargetPoolRecord> {
    await this.#client.query(
      `insert into ${this.#table} (
        id, space_id, name, spec_json, created_at, updated_at
      ) values ($1, $2, $3, $4::jsonb, $5, $6)
      on conflict (id) do update set
        space_id = excluded.space_id,
        name = excluded.name,
        spec_json = excluded.spec_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      [
        record.id,
        record.spaceId,
        record.name,
        JSON.stringify(record.spec),
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  async get(id: TargetPoolRecordId): Promise<TargetPoolRecord | undefined> {
    const result = await this.#client.query<NamedSpecRow>(
      `select * from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : targetPoolFromRow(row);
  }

  async getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined> {
    const result = await this.#client.query<NamedSpecRow>(
      `select * from ${this.#table}
       where space_id = $1 and name = $2 limit 1`,
      [spaceId, name],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : targetPoolFromRow(row);
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly TargetPoolRecord[]> {
    const result = await this.#client.query<NamedSpecRow>(
      `select * from ${this.#table}
       where space_id = $1 order by name asc, id asc`,
      [spaceId],
    );
    return result.rows.map(targetPoolFromRow);
  }

  async delete(id: TargetPoolRecordId): Promise<void> {
    await this.#client.query(`delete from ${this.#table} where id = $1`, [id]);
  }
}

class SqlSpacePolicyStore implements SpacePolicyStore {
  readonly #client: SqlClient;
  readonly #table = pgNames.spacePolicies;

  constructor(client: SqlClient) {
    this.#client = client;
  }

  async upsert(record: SpacePolicyRecord): Promise<SpacePolicyRecord> {
    await this.#client.query(
      `insert into ${this.#table} (
        id, space_id, name, spec_json, created_at, updated_at
      ) values ($1, $2, $3, $4::jsonb, $5, $6)
      on conflict (id) do update set
        space_id = excluded.space_id,
        name = excluded.name,
        spec_json = excluded.spec_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      [
        record.id,
        record.spaceId,
        record.name,
        JSON.stringify(record.spec),
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  async get(id: SpacePolicyRecordId): Promise<SpacePolicyRecord | undefined> {
    const result = await this.#client.query<NamedSpecRow>(
      `select * from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : spacePolicyFromRow(row);
  }

  async getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<SpacePolicyRecord | undefined> {
    const result = await this.#client.query<NamedSpecRow>(
      `select * from ${this.#table}
       where space_id = $1 and name = $2 limit 1`,
      [spaceId, name],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : spacePolicyFromRow(row);
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly SpacePolicyRecord[]> {
    const result = await this.#client.query<NamedSpecRow>(
      `select * from ${this.#table}
       where space_id = $1 order by name asc, id asc`,
      [spaceId],
    );
    return result.rows.map(spacePolicyFromRow);
  }

  async delete(id: SpacePolicyRecordId): Promise<void> {
    await this.#client.query(`delete from ${this.#table} where id = $1`, [id]);
  }
}

/**
 * Construct the four Postgres-backed Resource Shape stores over one
 * {@link SqlClient}. The same client is the deploy-control plane's connection,
 * so these projections live in the same database/transactional plane as the
 * Flow A ledger.
 */
export function createSqlResourceShapeStores(
  client: SqlClient,
): ResourceShapeStores {
  return {
    resources: new SqlResourceShapeStore(client),
    locks: new SqlResolutionLockStore(client),
    targetPools: new SqlTargetPoolStore(client),
    spacePolicies: new SqlSpacePolicyStore(client),
  };
}
