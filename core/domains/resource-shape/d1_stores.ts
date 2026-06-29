// Cloudflare D1 (SQLite) implementations of the Resource Shape stores.
//
// These persist the four Resource Shape entities on the deploy-control D1 plane
// (alongside the Flow A ledger), mirroring the `prepare(...).bind(...)`
// parameter-binding + row<->record mapping of `worker/src/d1_opentofu_store.ts`.
// Complex sub-objects (spec / outputs / conditions / labels / reason / native
// resources) persist as TEXT JSON columns; booleans persist as 0/1 integers.
// The physical tables are created by `ensureD1OpenTofuLedgerSchema`.

import type {
  Condition,
  JsonObject,
  NativeResourceRef,
  ResourceManagedBy,
  ResourcePhase,
  ResourcePortability,
  ResourceShapeKind,
} from "takosumi-contract";
import {
  deployControlD1TableNames as d1Names,
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

/**
 * Minimal structural view of the Cloudflare D1 binding the store uses. The
 * worker's full `D1Database` (and the test `SqliteFakeD1`) satisfy it; declared
 * locally so this core module does not import from the worker shell.
 */
export interface D1Like {
  prepare(query: string): D1LikePreparedStatement;
}
interface D1LikePreparedStatement {
  bind(...values: readonly unknown[]): D1LikePreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ readonly results?: readonly T[] }>;
  run<T = unknown>(): Promise<unknown>;
}

// --- JSON (de)serialization helpers -----------------------------------------

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJson<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value === "") return undefined;
    return JSON.parse(value) as T;
  }
  return value as T;
}

// --- Row shapes (as D1 returns them) ----------------------------------------

interface ResourceShapeRow {
  readonly id: string;
  readonly space_id: string;
  readonly project: string | null;
  readonly environment: string | null;
  readonly kind: string;
  readonly name: string;
  readonly managed_by: string;
  readonly spec_json: string;
  readonly phase: string;
  readonly generation: number;
  readonly observed_generation: number;
  readonly outputs_json: string | null;
  readonly conditions_json: string | null;
  readonly labels_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ResolutionLockRow {
  readonly resource_id: string;
  readonly selected_implementation: string;
  readonly target: string;
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

// --- Row -> record mappers ---------------------------------------------------

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
    locked: row.locked === 1,
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

class D1ResourceShapeStore implements ResourceShapeStore {
  readonly #db: D1Like;
  readonly #table = d1Names.resourceShapes;

  constructor(db: D1Like) {
    this.#db = db;
  }

  async upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord> {
    await this.#db
      .prepare(
        `insert into ${this.#table} (
          id, space_id, project, environment, kind, name, managed_by,
          spec_json, phase, generation, observed_generation,
          outputs_json, conditions_json, labels_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      )
      .bind(
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
      )
      .run();
    return record;
  }

  async get(
    id: ResourceShapeRecordId,
  ): Promise<ResourceShapeRecord | undefined> {
    const row = await this.#db
      .prepare(`select * from ${this.#table} where id = ? limit 1`)
      .bind(id)
      .first<ResourceShapeRow>();
    return row === null ? undefined : resourceShapeFromRow(row);
  }

  async getByName(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ResourceShapeRecord | undefined> {
    const row = await this.#db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? and kind = ? and name = ? limit 1`,
      )
      .bind(spaceId, kind, name)
      .first<ResourceShapeRow>();
    return row === null ? undefined : resourceShapeFromRow(row);
  }

  async listBySpace(
    spaceId: SpaceId,
  ): Promise<readonly ResourceShapeRecord[]> {
    const result = await this.#db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? order by kind asc, name asc, id asc`,
      )
      .bind(spaceId)
      .all<ResourceShapeRow>();
    return (result.results ?? []).map(resourceShapeFromRow);
  }

  async delete(id: ResourceShapeRecordId): Promise<void> {
    await this.#db
      .prepare(`delete from ${this.#table} where id = ?`)
      .bind(id)
      .run();
  }
}

class D1ResolutionLockStore implements ResolutionLockStore {
  readonly #db: D1Like;
  readonly #table = d1Names.resolutionLocks;

  constructor(db: D1Like) {
    this.#db = db;
  }

  async put(lock: ResolutionLockRecord): Promise<ResolutionLockRecord> {
    await this.#db
      .prepare(
        `insert into ${this.#table} (
          resource_id, selected_implementation, target, locked, reason_json,
          portability, native_resources_json, locked_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (resource_id) do update set
          selected_implementation = excluded.selected_implementation,
          target = excluded.target,
          locked = excluded.locked,
          reason_json = excluded.reason_json,
          portability = excluded.portability,
          native_resources_json = excluded.native_resources_json,
          locked_at = excluded.locked_at,
          updated_at = excluded.updated_at`,
      )
      .bind(
        lock.resourceId,
        lock.selectedImplementation,
        lock.target,
        lock.locked ? 1 : 0,
        JSON.stringify(lock.reason),
        lock.portability ?? null,
        jsonOrNull(lock.nativeResources),
        lock.lockedAt,
        lock.updatedAt,
      )
      .run();
    return lock;
  }

  async get(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResolutionLockRecord | undefined> {
    const row = await this.#db
      .prepare(`select * from ${this.#table} where resource_id = ? limit 1`)
      .bind(resourceId)
      .first<ResolutionLockRow>();
    return row === null ? undefined : resolutionLockFromRow(row);
  }

  async delete(resourceId: ResourceShapeRecordId): Promise<void> {
    await this.#db
      .prepare(`delete from ${this.#table} where resource_id = ?`)
      .bind(resourceId)
      .run();
  }
}

class D1TargetPoolStore implements TargetPoolStore {
  readonly #db: D1Like;
  readonly #table = d1Names.targetPools;

  constructor(db: D1Like) {
    this.#db = db;
  }

  async upsert(record: TargetPoolRecord): Promise<TargetPoolRecord> {
    await this.#db
      .prepare(
        `insert into ${this.#table} (
          id, space_id, name, spec_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?)
        on conflict (id) do update set
          space_id = excluded.space_id,
          name = excluded.name,
          spec_json = excluded.spec_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.spaceId,
        record.name,
        JSON.stringify(record.spec),
        record.createdAt,
        record.updatedAt,
      )
      .run();
    return record;
  }

  async get(id: TargetPoolRecordId): Promise<TargetPoolRecord | undefined> {
    const row = await this.#db
      .prepare(`select * from ${this.#table} where id = ? limit 1`)
      .bind(id)
      .first<NamedSpecRow>();
    return row === null ? undefined : targetPoolFromRow(row);
  }

  async getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined> {
    const row = await this.#db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? and name = ? limit 1`,
      )
      .bind(spaceId, name)
      .first<NamedSpecRow>();
    return row === null ? undefined : targetPoolFromRow(row);
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly TargetPoolRecord[]> {
    const result = await this.#db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? order by name asc, id asc`,
      )
      .bind(spaceId)
      .all<NamedSpecRow>();
    return (result.results ?? []).map(targetPoolFromRow);
  }

  async delete(id: TargetPoolRecordId): Promise<void> {
    await this.#db
      .prepare(`delete from ${this.#table} where id = ?`)
      .bind(id)
      .run();
  }
}

class D1SpacePolicyStore implements SpacePolicyStore {
  readonly #db: D1Like;
  readonly #table = d1Names.spacePolicies;

  constructor(db: D1Like) {
    this.#db = db;
  }

  async upsert(record: SpacePolicyRecord): Promise<SpacePolicyRecord> {
    await this.#db
      .prepare(
        `insert into ${this.#table} (
          id, space_id, name, spec_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?)
        on conflict (id) do update set
          space_id = excluded.space_id,
          name = excluded.name,
          spec_json = excluded.spec_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.spaceId,
        record.name,
        JSON.stringify(record.spec),
        record.createdAt,
        record.updatedAt,
      )
      .run();
    return record;
  }

  async get(id: SpacePolicyRecordId): Promise<SpacePolicyRecord | undefined> {
    const row = await this.#db
      .prepare(`select * from ${this.#table} where id = ? limit 1`)
      .bind(id)
      .first<NamedSpecRow>();
    return row === null ? undefined : spacePolicyFromRow(row);
  }

  async getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<SpacePolicyRecord | undefined> {
    const row = await this.#db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? and name = ? limit 1`,
      )
      .bind(spaceId, name)
      .first<NamedSpecRow>();
    return row === null ? undefined : spacePolicyFromRow(row);
  }

  async listBySpace(spaceId: SpaceId): Promise<readonly SpacePolicyRecord[]> {
    const result = await this.#db
      .prepare(
        `select * from ${this.#table}
         where space_id = ? order by name asc, id asc`,
      )
      .bind(spaceId)
      .all<NamedSpecRow>();
    return (result.results ?? []).map(spacePolicyFromRow);
  }

  async delete(id: SpacePolicyRecordId): Promise<void> {
    await this.#db
      .prepare(`delete from ${this.#table} where id = ?`)
      .bind(id)
      .run();
  }
}

/**
 * Construct the four Cloudflare D1-backed Resource Shape stores over one D1
 * binding (the deploy-control D1 database). The physical tables are provisioned
 * by `ensureD1OpenTofuLedgerSchema`.
 */
export function createD1ResourceShapeStores(db: D1Like): ResourceShapeStores {
  return {
    resources: new D1ResourceShapeStore(db),
    locks: new D1ResolutionLockStore(db),
    targetPools: new D1TargetPoolStore(db),
    spacePolicies: new D1SpacePolicyStore(db),
  };
}
