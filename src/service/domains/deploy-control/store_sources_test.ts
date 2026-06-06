/**
 * Source / SourceSnapshot / SourceSyncRun store symmetry: the in-memory twin and
 * the D1-shaped store must behave identically for the source-domain methods.
 */
import { expect, test } from "bun:test";

import {
  InMemoryOpenTofuDeploymentStore,
  type OpenTofuDeploymentStore,
  type StoredSource,
} from "./store.ts";
import { CloudflareD1OpenTofuDeploymentStore } from "../../../../worker/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../worker/src/bindings.ts";
import type {
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";

interface LedgerRow {
  namespace: string;
  key: string;
  space_id: string | null;
  installation_id: string | null;
  status: string | null;
  record_json: string;
  created_at: number;
  updated_at: number;
}

class FakeLedgerD1 implements D1Database {
  readonly rows = new Map<string, LedgerRow>();
  prepare(query: string): D1PreparedStatement {
    return new FakeLedgerStatement(this, query);
  }
}

class FakeLedgerStatement implements D1PreparedStatement {
  #bound: readonly unknown[] = [];
  constructor(
    private readonly db: FakeLedgerD1,
    private readonly query: string,
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    this.#bound = values;
    return this;
  }

  first<T = unknown>(): Promise<T | null> {
    const q = normalize(this.query);
    if (q.includes("where namespace = ? and key = ?")) {
      const [namespace, key] = this.#bound as [string, string];
      const row = this.db.rows.get(rowKey(namespace, key));
      return Promise.resolve(row ? ({ record_json: row.record_json } as T) : null);
    }
    return Promise.resolve(null);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    const q = normalize(this.query);
    if (q.includes("space_id = ?")) {
      const [namespace, spaceId] = this.#bound as [string, string];
      return Promise.resolve({ results: this.#scan(namespace, "space_id", spaceId) as T[], success: true });
    }
    if (q.includes("installation_id = ?")) {
      const [namespace, id] = this.#bound as [string, string];
      return Promise.resolve({ results: this.#scan(namespace, "installation_id", id) as T[], success: true });
    }
    if (q.includes("where namespace = ?")) {
      const [namespace] = this.#bound as [string];
      const matched = [...this.db.rows.values()]
        .filter((row) => row.namespace === namespace)
        .sort((a, b) => a.created_at - b.created_at || a.key.localeCompare(b.key))
        .map((row) => ({ record_json: row.record_json }) as T);
      return Promise.resolve({ results: matched, success: true });
    }
    return Promise.resolve({ results: [], success: true });
  }

  #scan(
    namespace: string,
    column: "space_id" | "installation_id",
    value: string,
  ): { record_json: string }[] {
    return [...this.db.rows.values()]
      .filter((row) => row.namespace === namespace && row[column] === value)
      .sort((a, b) => a.created_at - b.created_at || a.key.localeCompare(b.key))
      .map((row) => ({ record_json: row.record_json }));
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    const q = normalize(this.query);
    if (q.startsWith("create table") || q.startsWith("create index")) {
      return Promise.resolve({ success: true, meta: { changes: 0 } });
    }
    if (q.startsWith("insert into")) {
      const [
        namespace,
        key,
        space_id,
        installation_id,
        status,
        record_json,
        created_at,
        updated_at,
      ] = this.#bound as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
        number,
        number,
      ];
      this.db.rows.set(rowKey(namespace, key), {
        namespace,
        key,
        space_id,
        installation_id,
        status,
        record_json,
        created_at,
        updated_at,
      });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (q.startsWith("delete from")) {
      const [namespace, key] = this.#bound as [string, string];
      const existed = this.db.rows.delete(rowKey(namespace, key));
      return Promise.resolve({ success: true, meta: { changes: existed ? 1 : 0 } });
    }
    return Promise.resolve({ success: true, meta: { changes: 0 } });
  }
}

function rowKey(namespace: string, key: string): string {
  return `${namespace}\0${key}`;
}

function normalize(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function source(overrides: Partial<StoredSource> = {}): StoredSource {
  return {
    id: "src_abcdef0123456789",
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    hookSecretHash: "deadbeef",
    autoSync: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    id: "snap_0000000000000001",
    sourceId: "src_abcdef0123456789",
    url: "https://github.com/acme/repo.git",
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: "spaces/space_1/sources/src_abcdef0123456789/snapshots/snap_0000000000000001/source.tar.zst",
    archiveDigest: "sha256:" + "a".repeat(64),
    archiveSizeBytes: 1024,
    fetchedByRunId: "ssr_0000000000000001",
    fetchedAt: "2026-06-06T00:01:00.000Z",
    ...overrides,
  };
}

function syncRun(overrides: Partial<SourceSyncRun> = {}): SourceSyncRun {
  return {
    id: "ssr_0000000000000001",
    kind: "source_sync",
    spaceId: "space_1",
    sourceId: "src_abcdef0123456789",
    url: "https://github.com/acme/repo.git",
    ref: "main",
    path: ".",
    archiveObjectKey: "spaces/space_1/sources/src_abcdef0123456789/snapshots/snap_x/source.tar.zst",
    status: "queued",
    createdAt: "2026-06-06T00:00:30.000Z",
    updatedAt: "2026-06-06T00:00:30.000Z",
    ...overrides,
  };
}

const STORES: ReadonlyArray<[string, () => OpenTofuDeploymentStore]> = [
  ["in-memory", () => new InMemoryOpenTofuDeploymentStore()],
  ["d1", () => new CloudflareD1OpenTofuDeploymentStore(new FakeLedgerD1())],
];

for (const [name, make] of STORES) {
  test(`${name}: source put/get/list/delete round-trip`, async () => {
    const store = make();
    const s = source();
    await store.putSource(s);
    expect(await store.getSource(s.id)).toEqual(s);

    const other = source({ id: "src_zzzzzzzz11111111", spaceId: "space_2" });
    await store.putSource(other);

    const inSpace1 = await store.listSources("space_1");
    expect(inSpace1.map((x) => x.id)).toEqual([s.id]);

    const all = await store.listSources();
    expect(all.length).toBe(2);

    expect(await store.deleteSource(s.id)).toBe(true);
    expect(await store.getSource(s.id)).toBeUndefined();
    expect(await store.deleteSource(s.id)).toBe(false);
  });

  test(`${name}: source snapshot put/get/list by source`, async () => {
    const store = make();
    const a = snapshot({ id: "snap_0000000000000001" });
    const b = snapshot({
      id: "snap_0000000000000002",
      fetchedAt: "2026-06-06T00:02:00.000Z",
    });
    const otherSource = snapshot({
      id: "snap_0000000000000003",
      sourceId: "src_other00000000",
    });
    await store.putSourceSnapshot(a);
    await store.putSourceSnapshot(b);
    await store.putSourceSnapshot(otherSource);

    expect(await store.getSourceSnapshot(a.id)).toEqual(a);
    const list = await store.listSourceSnapshots("src_abcdef0123456789");
    expect(list.map((x) => x.id)).toEqual([a.id, b.id]);
  });

  test(`${name}: source sync run put/get/list by source`, async () => {
    const store = make();
    const r1 = syncRun({ id: "ssr_0000000000000001" });
    const r2 = syncRun({
      id: "ssr_0000000000000002",
      createdAt: "2026-06-06T00:01:30.000Z",
    });
    const other = syncRun({
      id: "ssr_0000000000000003",
      sourceId: "src_other00000000",
    });
    await store.putSourceSyncRun(r1);
    await store.putSourceSyncRun(r2);
    await store.putSourceSyncRun(other);

    expect(await store.getSourceSyncRun(r1.id)).toEqual(r1);
    const list = await store.listSourceSyncRuns("src_abcdef0123456789");
    expect(list.map((x) => x.id)).toEqual([r1.id, r2.id]);
  });
}
