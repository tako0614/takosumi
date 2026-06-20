/**
 * Source / SourceSnapshot / SourceSyncRun store symmetry: the in-memory twin and
 * the D1-shaped store must behave identically for the source-domain methods.
 */
import { expect, test } from "bun:test";

import {
  InMemoryOpenTofuDeploymentStore,
  type StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuDeploymentStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type {
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { Page, PageParams } from "takosumi-contract/pagination";

interface D1SourceStoreSlice {
  putSource(source: StoredSource): Promise<StoredSource>;
  getSource(id: string): Promise<StoredSource | undefined>;
  listSources(spaceId?: string): Promise<readonly StoredSource[]>;
  deleteSource(id: string): Promise<boolean>;

  putSourceSnapshot(snapshot: SourceSnapshot): Promise<SourceSnapshot>;
  getSourceSnapshot(id: string): Promise<SourceSnapshot | undefined>;
  listSourceSnapshots(sourceId: string): Promise<readonly SourceSnapshot[]>;
  listSourceSnapshotsPage(
    sourceId: string,
    params: PageParams,
  ): Promise<Page<SourceSnapshot>>;

  putSourceSyncRun(run: SourceSyncRun): Promise<SourceSyncRun>;
  getSourceSyncRun(id: string): Promise<SourceSyncRun | undefined>;
  listSourceSyncRuns(sourceId: string): Promise<readonly SourceSyncRun[]>;
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

const STORES: ReadonlyArray<[string, () => D1SourceStoreSlice]> = [
  ["in-memory", () => new InMemoryOpenTofuDeploymentStore()],
  ["d1", () => new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1())],
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

  test(`${name}: source snapshot keyset page caps + round-trips the fetchedAt cursor`, async () => {
    const store = make();
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      const seq = String(i).padStart(4, "0");
      await store.putSourceSnapshot(
        snapshot({
          id: `snap_${"0".repeat(11)}${seq}`,
          // Keyset column is fetchedAt (NOT createdAt): monotonic ascending.
          fetchedAt: `2026-06-06T00:00:00.${seq}Z`,
        }),
      );
    }
    // A second source's snapshots must never leak into the page.
    await store.putSourceSnapshot(
      snapshot({ id: "snap_other00000000", sourceId: "src_other00000000" }),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await store.listSourceSnapshotsPage(
        "src_abcdef0123456789",
        cursor === undefined ? {} : { cursor },
      );
      expect(page.items.length).toBeLessThanOrEqual(100);
      seen.push(...page.items.map((s) => s.id));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      if (pages > 10) throw new Error("cursor never terminated");
    }
    expect(pages).toBe(3); // 100 + 100 + 50
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total); // no dupes
    const expected = Array.from(
      { length: total },
      (_, i) => `snap_${"0".repeat(11)}${String(i).padStart(4, "0")}`,
    );
    expect(seen).toEqual(expected); // ordered by fetchedAt, no gaps

    // An explicit ?limit= is honoured and emits a cursor mid-stream.
    const limited = await store.listSourceSnapshotsPage(
      "src_abcdef0123456789",
      { limit: 3 },
    );
    expect(limited.items).toHaveLength(3);
    expect(limited.nextCursor).toBeDefined();
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
