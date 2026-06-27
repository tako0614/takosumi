import {
  MemoryStorageDriver,
  type MemoryStorageSnapshot,
  type StorageDriver,
  type StorageTransaction,
} from "../../core/adapters/storage/mod.ts";
import { eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { applyD1GuardedTableRenames } from "./d1_opentofu_store.ts";
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

/**
 * Retired Service Graph tables (deploy decision D3). The OSS Service Graph
 * ledger is removed; the tables are renamed aside to `*_retired` (recoverable)
 * rather than dropped, and are no longer created or read.
 */
const D1_SNAPSHOT_RETIRED_TABLE_RENAMES: readonly {
  readonly from: string;
  readonly to: string;
}[] = [
  {
    from: "takosumi_service_graph_exports",
    to: "takosumi_service_graph_exports_retired",
  },
  {
    from: "takosumi_service_graph_bindings",
    to: "takosumi_service_graph_bindings_retired",
  },
  {
    from: "takosumi_service_graph_grants",
    to: "takosumi_service_graph_grants_retired",
  },
];

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
      const snapshot = await this.#loadSnapshot();
      const memory = new MemoryStorageDriver(
        snapshot ? { snapshot } : undefined,
      );
      const result = await memory.transaction(fn);
      const nextSnapshot = memory.snapshot();
      await this.#saveSnapshot(nextSnapshot);
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
}

export async function ensureD1SnapshotSchema(db: D1Database): Promise<void> {
  // Retire the legacy Service Graph tables aside before ensuring the snapshot
  // table (idempotent no-op on fresh / already-renamed databases). The DDL that
  // used to create these tables is removed so the rename-aside is not undone.
  await applyD1GuardedTableRenames(db, D1_SNAPSHOT_RETIRED_TABLE_RENAMES);
  await db
    .prepare(
      `create table if not exists takosumi_cf_storage_snapshots (
      id text primary key,
      snapshot_json text not null,
      updated_at text not null
    )`,
    )
    .run();
}
