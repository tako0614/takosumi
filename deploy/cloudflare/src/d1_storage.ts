import {
  MemoryStorageDriver,
  type MemoryStorageSnapshot,
  type StorageDriver,
  type StorageStatementCatalog,
  storageStatementCatalog,
  type StorageTransaction,
} from "../../../packages/kernel/src/adapters/storage/mod.ts";
import type { D1Database } from "./bindings.ts";

const SNAPSHOT_ID = "default";

export class CloudflareD1SnapshotStorageDriver implements StorageDriver {
  readonly statements: StorageStatementCatalog = storageStatementCatalog;
  #tail: Promise<void> = Promise.resolve();
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {}

  async transaction<T>(
    fn: (transaction: StorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tail = previous.then(() => gate, () => gate);
    await previous;

    try {
      await this.#ensureSchema();
      const snapshot = await this.#loadSnapshot();
      const memory = new MemoryStorageDriver(
        snapshot ? { snapshot } : undefined,
      );
      const result = await memory.transaction(fn);
      await this.#saveSnapshot(memory.snapshot());
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
    const row = await this.db.prepare(
      "select snapshot_json from takosumi_cf_storage_snapshots where id = ?",
    ).bind(SNAPSHOT_ID).first<{ snapshot_json: string }>();
    if (!row) return undefined;
    return JSON.parse(row.snapshot_json) as MemoryStorageSnapshot;
  }

  async #saveSnapshot(snapshot: MemoryStorageSnapshot): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `insert into takosumi_cf_storage_snapshots
        (id, snapshot_json, updated_at)
       values (?, ?, ?)
       on conflict (id) do update set
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at`,
    ).bind(SNAPSHOT_ID, JSON.stringify(snapshot), now).run();
  }
}

export async function ensureD1SnapshotSchema(db: D1Database): Promise<void> {
  await db.prepare(
    `create table if not exists takosumi_cf_storage_snapshots (
      id text primary key,
      snapshot_json text not null,
      updated_at text not null
    )`,
  ).run();
}
