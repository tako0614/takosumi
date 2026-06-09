/**
 * Narrow Drizzle-backed D1 store slice for Source / SourceSnapshot /
 * SourceSyncRun records.
 *
 * This is intentionally NOT a full replacement for
 * CloudflareD1OpenTofuDeploymentStore. It proves the Drizzle path against the
 * live D1 schema while keeping state-generation guards, deployment writes, and
 * other transaction-sensitive code on the raw SQL store until each slice has
 * parity tests.
 */
import { and, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type {
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";

import * as schema from "../../src/service/adapters/storage/drizzle/schema/d1.ts";
import type {
  StoredSource,
} from "../../src/service/domains/deploy-control/store.ts";
import type { D1Database, D1Result } from "./bindings.ts";
import { ensureD1OpenTofuLedgerSchema } from "./d1_opentofu_store.ts";

const RUN_KIND_SOURCE_SYNC = "source_sync";

export interface D1SourceStoreSlice {
  putSource(source: StoredSource): Promise<StoredSource>;
  getSource(id: string): Promise<StoredSource | undefined>;
  listSources(spaceId?: string): Promise<readonly StoredSource[]>;
  deleteSource(id: string): Promise<boolean>;

  putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot>;
  getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined>;
  listSourceSnapshots(sourceId: string): Promise<readonly SourceSnapshot[]>;

  putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun>;
  getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined>;
  listSourceSyncRuns(sourceId: string): Promise<readonly SourceSyncRun[]>;
}

export class CloudflareD1DrizzleSourceStore implements D1SourceStoreSlice {
  readonly #db: DrizzleD1Database<typeof schema>;
  #initialized?: Promise<void>;

  constructor(private readonly binding: D1Database) {
    this.#db = drizzle(binding, { schema });
  }

  async putSource(source: StoredSource): Promise<StoredSource> {
    await this.#ensureSchema();
    await this.#db
      .insert(schema.sources)
      .values({
        id: source.id,
        spaceId: source.spaceId,
        status: source.status,
        recordJson: source,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.sources.id,
        set: {
          spaceId: source.spaceId,
          status: source.status,
          recordJson: source,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        },
      })
      .run();
    return source;
  }

  async getSource(id: string): Promise<StoredSource | undefined> {
    await this.#ensureSchema();
    const row = await this.#db
      .select({ recordJson: schema.sources.recordJson })
      .from(schema.sources)
      .where(eq(schema.sources.id, id))
      .get();
    return row?.recordJson as StoredSource | undefined;
  }

  async listSources(spaceId?: string): Promise<readonly StoredSource[]> {
    await this.#ensureSchema();
    const query = this.#db
      .select({ recordJson: schema.sources.recordJson })
      .from(schema.sources)
      .$dynamic();
    const rows = await (spaceId === undefined
      ? query.orderBy(schema.sources.createdAt, schema.sources.id)
      : query
        .where(eq(schema.sources.spaceId, spaceId))
        .orderBy(schema.sources.createdAt, schema.sources.id));
    return rows.map((row) => row.recordJson as StoredSource);
  }

  async deleteSource(id: string): Promise<boolean> {
    await this.#ensureSchema();
    const result = await this.#db
      .delete(schema.sources)
      .where(eq(schema.sources.id, id))
      .run();
    return changes(result) > 0;
  }

  async putSourceSnapshot(
    snapshot: SourceSnapshot,
  ): Promise<SourceSnapshot> {
    await this.#ensureSchema();
    await this.#db
      .insert(schema.sourceSnapshots)
      .values({
        id: snapshot.id,
        sourceId: snapshot.sourceId,
        recordJson: snapshot,
        fetchedAt: snapshot.fetchedAt,
      })
      .onConflictDoUpdate({
        target: schema.sourceSnapshots.id,
        set: {
          sourceId: snapshot.sourceId,
          recordJson: snapshot,
          fetchedAt: snapshot.fetchedAt,
        },
      })
      .run();
    return snapshot;
  }

  async getSourceSnapshot(
    id: string,
  ): Promise<SourceSnapshot | undefined> {
    await this.#ensureSchema();
    const row = await this.#db
      .select({ recordJson: schema.sourceSnapshots.recordJson })
      .from(schema.sourceSnapshots)
      .where(eq(schema.sourceSnapshots.id, id))
      .get();
    return row?.recordJson as SourceSnapshot | undefined;
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<readonly SourceSnapshot[]> {
    await this.#ensureSchema();
    const rows = await this.#db
      .select({ recordJson: schema.sourceSnapshots.recordJson })
      .from(schema.sourceSnapshots)
      .where(eq(schema.sourceSnapshots.sourceId, sourceId))
      .orderBy(schema.sourceSnapshots.fetchedAt, schema.sourceSnapshots.id);
    return rows.map((row) => row.recordJson as SourceSnapshot);
  }

  async putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun> {
    await this.#ensureSchema();
    await this.#db
      .insert(schema.runs)
      .values({
        id: run.id,
        runGroupId: null,
        spaceId: run.spaceId,
        sourceId: run.sourceId,
        installationId: null,
        environment: null,
        type: RUN_KIND_SOURCE_SYNC,
        status: run.status,
        runJson: run,
        createdAt: String(run.createdAt),
      })
      .onConflictDoUpdate({
        target: schema.runs.id,
        set: {
          runGroupId: null,
          spaceId: run.spaceId,
          sourceId: run.sourceId,
          installationId: null,
          environment: null,
          type: RUN_KIND_SOURCE_SYNC,
          status: run.status,
          runJson: run,
          createdAt: String(run.createdAt),
        },
      })
      .run();
    return run;
  }

  async getSourceSyncRun(
    id: string,
  ): Promise<SourceSyncRun | undefined> {
    await this.#ensureSchema();
    const row = await this.#db
      .select({ runJson: schema.runs.runJson })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, id), eq(schema.runs.type, RUN_KIND_SOURCE_SYNC)))
      .get();
    return row?.runJson as SourceSyncRun | undefined;
  }

  async listSourceSyncRuns(
    sourceId: string,
  ): Promise<readonly SourceSyncRun[]> {
    await this.#ensureSchema();
    const currentRows = await this.#db
      .select({ runJson: schema.runs.runJson })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.type, RUN_KIND_SOURCE_SYNC),
          eq(schema.runs.sourceId, sourceId),
        ),
      )
      .orderBy(schema.runs.createdAt, schema.runs.id);
    const legacyRows = await this.#db
      .select({ runJson: schema.runs.runJson })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.type, RUN_KIND_SOURCE_SYNC),
          eq(schema.runs.installationId, sourceId),
        ),
      )
      .orderBy(schema.runs.createdAt, schema.runs.id);
    const byId = new Map<string, SourceSyncRun>();
    for (const row of [...currentRows, ...legacyRows]) {
      const parsed = row.runJson as SourceSyncRun;
      byId.set(parsed.id, parsed);
    }
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async #ensureSchema(): Promise<void> {
    this.#initialized ??= ensureD1OpenTofuLedgerSchema(this.binding);
    await this.#initialized;
  }
}

function changes(result: unknown): number {
  return (result as D1Result).meta?.changes ?? 0;
}
