import {
  MemoryStorageDriver,
  type MemoryStorageSnapshot,
  type StorageDriver,
  type StorageTransaction,
} from "../../core/adapters/storage/mod.ts";
import { eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  ServiceBinding,
  ServiceExport,
  ServiceGrant,
} from "takosumi-contract/service-graph";
import {
  assertValidServiceBinding,
  assertValidServiceExport,
  assertValidServiceGrant,
} from "takosumi-contract/service-graph";
import type { D1Database } from "./bindings.ts";

const SNAPSHOT_ID = "default";

const storageSnapshots = sqliteTable("takosumi_cf_storage_snapshots", {
  id: text("id").primaryKey(),
  snapshotJson: text("snapshot_json", { mode: "json" })
    .$type<MemoryStorageSnapshot>()
    .notNull(),
  updatedAt: text("updated_at").notNull(),
});

const d1StorageSchema = { storageSnapshots };

export class CloudflareD1SnapshotStorageDriver implements StorageDriver {
  readonly #orm: DrizzleD1Database<typeof d1StorageSchema>;
  #tail: Promise<void> = Promise.resolve();
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {
    this.#orm = drizzle(db, { schema: d1StorageSchema });
  }

  async transaction<T>(
    fn: (transaction: StorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tail = previous.then(
      () => gate,
      () => gate,
    );
    await previous;

    try {
      await this.#ensureSchema();
      const snapshot = await this.#loadSnapshotWithServiceGraphTables();
      const memory = new MemoryStorageDriver(
        snapshot ? { snapshot } : undefined,
      );
      const result = await memory.transaction(fn);
      const nextSnapshot = memory.snapshot();
      await this.#saveSnapshot(nextSnapshot);
      await this.#saveServiceGraphTables(nextSnapshot);
      return result;
    } finally {
      release();
    }
  }

  async #ensureSchema(): Promise<void> {
    this.#initialized ??= ensureD1SnapshotSchema(this.db);
    await this.#initialized;
  }

  async #loadSnapshot(): Promise<MemoryStorageSnapshot | undefined> {
    const row = await this.#orm
      .select({ snapshotJson: storageSnapshots.snapshotJson })
      .from(storageSnapshots)
      .where(eq(storageSnapshots.id, SNAPSHOT_ID))
      .get();
    return row?.snapshotJson;
  }

  async #loadSnapshotWithServiceGraphTables(): Promise<
    MemoryStorageSnapshot | undefined
  > {
    const snapshot = await this.#loadSnapshot();
    const serviceGraph = await loadServiceGraphTables(this.db);
    if (
      !snapshot &&
      serviceGraph.exports.length === 0 &&
      serviceGraph.bindings.length === 0 &&
      serviceGraph.grants.length === 0
    ) {
      return undefined;
    }
    return {
      ...(snapshot ?? emptyMemoryStorageSnapshot()),
      serviceGraphExports: serviceGraph.exports,
      serviceGraphBindings: serviceGraph.bindings,
      serviceGraphGrants: serviceGraph.grants,
    };
  }

  async #saveSnapshot(snapshot: MemoryStorageSnapshot): Promise<void> {
    const now = new Date().toISOString();
    await this.#orm
      .insert(storageSnapshots)
      .values({
        id: SNAPSHOT_ID,
        snapshotJson: snapshot,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: storageSnapshots.id,
        set: {
          snapshotJson: snapshot,
          updatedAt: now,
        },
      })
      .run();
  }

  async #saveServiceGraphTables(
    snapshot: MemoryStorageSnapshot,
  ): Promise<void> {
    await saveServiceGraphTables(this.db, {
      exports: snapshot.serviceGraphExports ?? [],
      bindings: snapshot.serviceGraphBindings ?? [],
      grants: snapshot.serviceGraphGrants ?? [],
    });
  }
}

export async function ensureD1SnapshotSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `create table if not exists takosumi_cf_storage_snapshots (
      id text primary key,
      snapshot_json text not null,
      updated_at text not null
    )`,
    )
    .run();
  await db
    .prepare(
      `create table if not exists takosumi_service_graph_exports (
        id text primary key,
        space_id text not null,
        producer_installation_id text not null,
        name text not null,
        capabilities_json text not null,
        visibility text not null,
        status text not null,
        deployment_id text,
        output_snapshot_id text,
        record_json text not null,
        updated_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_exports_space_idx
        on takosumi_service_graph_exports (space_id)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_exports_producer_idx
        on takosumi_service_graph_exports (producer_installation_id)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_exports_status_idx
        on takosumi_service_graph_exports (space_id, status)`,
    )
    .run();
  await db
    .prepare(
      `create table if not exists takosumi_service_graph_bindings (
        id text primary key,
        space_id text not null,
        consumer_installation_id text not null,
        selected_service_export_id text,
        selector_json text not null,
        status text not null,
        dependency_snapshot_id text,
        record_json text not null,
        updated_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_bindings_space_idx
        on takosumi_service_graph_bindings (space_id)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_bindings_consumer_idx
        on takosumi_service_graph_bindings (consumer_installation_id)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_bindings_export_idx
        on takosumi_service_graph_bindings (selected_service_export_id)`,
    )
    .run();
  await db
    .prepare(
      `create table if not exists takosumi_service_graph_grants (
        id text primary key,
        space_id text not null,
        binding_id text not null,
        service_export_id text not null,
        consumer_installation_id text not null,
        status text not null,
        expires_at text,
        record_json text not null,
        created_at text not null
      )`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_grants_binding_idx
        on takosumi_service_graph_grants (binding_id)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_grants_export_idx
        on takosumi_service_graph_grants (service_export_id)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_service_graph_grants_consumer_idx
        on takosumi_service_graph_grants (consumer_installation_id, status)`,
    )
    .run();
}

async function loadServiceGraphTables(db: D1Database): Promise<{
  readonly exports: readonly ServiceExport[];
  readonly bindings: readonly ServiceBinding[];
  readonly grants: readonly ServiceGrant[];
}> {
  const exportRows = await db
    .prepare("select record_json from takosumi_service_graph_exports")
    .all<ServiceGraphJsonRow>();
  const bindingRows = await db
    .prepare("select record_json from takosumi_service_graph_bindings")
    .all<ServiceGraphJsonRow>();
  const grantRows = await db
    .prepare("select record_json from takosumi_service_graph_grants")
    .all<ServiceGraphJsonRow>();
  const exports = (exportRows.results ?? []).map((row) =>
    parseServiceGraphRecord(row, assertValidServiceExport),
  );
  const bindings = (bindingRows.results ?? []).map((row) =>
    parseServiceGraphRecord(row, assertValidServiceBinding),
  );
  const grants = (grantRows.results ?? []).map((row) =>
    parseServiceGraphRecord(row, assertValidServiceGrant),
  );
  return { exports, bindings, grants };
}

async function saveServiceGraphTables(
  db: D1Database,
  records: {
    readonly exports: readonly ServiceExport[];
    readonly bindings: readonly ServiceBinding[];
    readonly grants: readonly ServiceGrant[];
  },
): Promise<void> {
  await db.prepare("delete from takosumi_service_graph_grants").run();
  await db.prepare("delete from takosumi_service_graph_bindings").run();
  await db.prepare("delete from takosumi_service_graph_exports").run();
  for (const record of records.exports) {
    assertValidServiceExport(record);
    await db
      .prepare(
        `insert into takosumi_service_graph_exports (
          id,
          space_id,
          producer_installation_id,
          name,
          capabilities_json,
          visibility,
          status,
          deployment_id,
          output_snapshot_id,
          record_json,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.producerCapsuleId,
        record.name,
        JSON.stringify(record.capabilities),
        record.visibility,
        record.status,
        record.applyRunId ?? null,
        record.outputId ?? null,
        JSON.stringify(record),
        record.updatedAt,
      )
      .run();
  }
  for (const record of records.bindings) {
    assertValidServiceBinding(record);
    await db
      .prepare(
        `insert into takosumi_service_graph_bindings (
          id,
          space_id,
          consumer_installation_id,
          selected_service_export_id,
          selector_json,
          status,
          dependency_snapshot_id,
          record_json,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.consumerCapsuleId,
        record.selectedServiceExportId ?? null,
        JSON.stringify(record.selector),
        record.status,
        record.dependencySnapshotId ?? null,
        JSON.stringify(record),
        record.updatedAt,
      )
      .run();
  }
  for (const record of records.grants) {
    assertValidServiceGrant(record);
    await db
      .prepare(
        `insert into takosumi_service_graph_grants (
          id,
          space_id,
          binding_id,
          service_export_id,
          consumer_installation_id,
          status,
          expires_at,
          record_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.bindingId,
        record.serviceExportId,
        record.consumerCapsuleId,
        record.status,
        record.expiresAt ?? null,
        JSON.stringify(record),
        record.createdAt,
      )
      .run();
  }
}

interface ServiceGraphJsonRow {
  readonly record_json: string;
}

function parseServiceGraphRecord<T>(
  row: ServiceGraphJsonRow,
  assertValid: (record: T) => void,
): T {
  const record = JSON.parse(row.record_json) as T;
  assertValid(record);
  return record;
}

function emptyMemoryStorageSnapshot(): MemoryStorageSnapshot {
  return {
    spaces: [],
    groups: [],
    spaceMemberships: [],
    runtimeDesiredStates: [],
    runtimeObservedStates: [],
    providerObservations: [],
    resourceInstances: [],
    resourceBindings: [],
    bindingSetRevisions: [],
    migrationLedgerEntries: [],
    packageDescriptors: [],
    packageResolutions: [],
    trustRecords: [],
    auditEvents: [],
    serviceEndpoints: [],
    serviceTrustRecords: [],
    serviceGrants: [],
    serviceGraphExports: [],
    serviceGraphBindings: [],
    serviceGraphGrants: [],
    runtimeAgents: [],
    runtimeAgentWorkItems: [],
  };
}
