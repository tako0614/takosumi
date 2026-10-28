import { expect, test } from "bun:test";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

test("all stores advance failed polls without a Run and quarantine broken applied lineage", async () => {
  const postgres = await PGliteSqlClient.create();
  try {
    const stores: readonly [string, OpenTofuControlStore][] = [
      ["memory", new InMemoryOpenTofuControlStore()],
      ["postgres", new SqlOpenTofuControlStore({ client: postgres })],
      ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
    ];
    for (const [label, store] of stores) {
      await store.putWorkspace({
        id: "workspace_poll", handle: "workspace-poll", displayName: "Poll",
        type: "personal", ownerUserId: "owner_poll",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      let sequence = 0;
      const service = new SourcesService({ store,
        now: () => new Date("2026-10-28T00:00:00.000Z"),
        newId: (prefix) => `${prefix}_${String(++sequence).padStart(16, "0")}`,
      });
      const sources = [];
      for (const name of ["first", "next"]) {
        sources.push((await service.createSource({
          workspaceId: "workspace_poll", name, url: "https://github.com/acme/repo.git", autoSync: true,
        })).source);
      }
      const first = sources[0]!;
      const next = sources[1]!;
      // The missing host allocator is retryable and fails before Run creation.
      await expect(service.createReconciliationSyncs(first.id, { scheduled: true })).rejects.toMatchObject({ code: "not_implemented" });
      expect((await store.getSource(first.id))?.status, label).toBe("active");
      expect((await store.getSource(first.id))?.lastAutoSyncAttemptAt, label).toBe("2026-10-28T00:00:00.000Z");
      expect((await store.listAutoSyncSourcesDue(1))[0]?.id, label).toBe(next.id);
      expect((await service.getSource(first.id)).source, label).not.toHaveProperty("lastAutoSyncAttemptAt");
      expect(await store.listSourceSyncRuns(first.id), label).toEqual([]);

      await store.putCapsule({
        id: "cap_broken_poll", workspaceId: first.workspaceId, projectId: "project_poll",
        name: "broken", slug: "broken", sourceId: first.id, installConfigId: "config_poll",
        environment: "production", status: "active", currentStateGeneration: 1,
        currentStateVersionId: "state_missing", createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await expect(service.createReconciliationSyncs(first.id, { scheduled: true })).rejects.toMatchObject({ code: "failed_precondition" });
      expect((await store.getSource(first.id))?.status, label).toBe("error");
      expect((await store.listAutoSyncSourcesDue(25)).map((source) => source.id), label).toEqual([next.id]);
    }
  } finally {
    await postgres.close();
  }
});
