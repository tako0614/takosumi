import { expect, test } from "bun:test";

import { InMemoryOpenTofuControlStore, type OpenTofuControlStore, type StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type { SourceSyncRun } from "takosumi-contract/sources";

function source(id: string, overrides: Partial<StoredSource> = {}): StoredSource {
  return {
    id, workspaceId: "workspace_due", name: id,
    url: "https://github.com/acme/repo.git", defaultRef: "main", defaultPath: ".",
    status: "active", createdAt: `2026-01-01T00:00:${id.slice(-2)}.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z", hookSecretHash: "hash", autoSync: true,
    ...overrides,
  };
}

function run(sourceId: string, i: number, createdAt: string): SourceSyncRun {
  const id = `ssr_${String(i).padStart(16, "0")}`;
  return {
    id, kind: "source_sync", workspaceId: "workspace_due", sourceId,
    url: "https://github.com/acme/repo.git", ref: "main", path: ".",
    archiveRef: `archive-${i}`, status: "failed", createdAt, updatedAt: createdAt,
  };
}

test("all stores return a fair due batch and exclude already observed pinned commits", async () => {
  const postgres = await PGliteSqlClient.create();
  try {
    const stores: ReadonlyArray<[string, OpenTofuControlStore]> = [
      ["memory", new InMemoryOpenTofuControlStore()],
      ["postgres", new SqlOpenTofuControlStore({ client: postgres })],
      ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
    ];
    for (const [label, store] of stores) {
      for (const id of ["src_01", "src_02", "src_03", "src_04", "src_05"])
        await store.putSource(source(id));
      const pinned = "a".repeat(40);
      await store.putSource(source("src_pinned", { defaultRef: pinned, lastSeenCommit: pinned }));
      await store.putSource(source("src_disabled", { status: "disabled" }));
      await store.putSource(source("src_manual", { autoSync: false }));
      await store.putSourceSyncRun(run("src_01", 1, "2026-02-01T00:00:00.000Z"));
      await store.putSourceSyncRun(run("src_02", 2, "2026-02-03T00:00:00.000Z"));
      await store.putSourceSyncRun(run("src_03", 3, "2026-02-02T00:00:00.000Z"));

      const first = await store.listAutoSyncSourcesDue(2);
      expect(first.map((row) => row?.id), label).toEqual(["src_04", "src_05"]);
      await store.putSourceSyncRun(run("src_04", 4, "2026-02-04T00:00:00.000Z"));
      await store.putSourceSyncRun(run("src_05", 5, "2026-02-05T00:00:00.000Z"));
      const second = await store.listAutoSyncSourcesDue(2);
      expect(second.map((row) => row.id), label).toEqual(["src_01", "src_03"]);
      await store.putSourceSyncRun(run("src_01", 6, "2026-02-06T00:00:00.000Z"));
      await store.putSourceSyncRun(run("src_03", 7, "2026-02-07T00:00:00.000Z"));
      expect((await store.listAutoSyncSourcesDue(2)).map((row) => row.id), label).toEqual(["src_02", "src_04"]);
      expect((await store.listAutoSyncSourcesDue(0)).length, label).toBe(0);
    }
  } finally {
    await postgres.close();
  }
});
