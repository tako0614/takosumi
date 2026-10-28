import { expect, test } from "bun:test";

import { InMemoryOpenTofuControlStore, type OpenTofuControlStore, type StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type { SourceSyncRun } from "takosumi-contract/sources";
import type { Workspace } from "takosumi-contract/workspaces";
import type { Capsule } from "takosumi-contract/capsules";
import { InMemoryGitInstallPlanStore } from "../../../../core/domains/install-plans/store.ts";

function workspace(id: string): Workspace {
  return { id, handle: id.replaceAll("_", "-"), displayName: id, type: "personal",
    ownerUserId: `owner_${id}`, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z" };
}

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
    const memory = new InMemoryOpenTofuControlStore();
    memory.attachGitInstallPlanStore(new InMemoryGitInstallPlanStore(memory));
    const stores: ReadonlyArray<[string, OpenTofuControlStore]> = [
      ["memory", memory],
      ["postgres", new SqlOpenTofuControlStore({ client: postgres })],
      ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
    ];
    for (const [label, store] of stores) {
      await store.putWorkspace(workspace("workspace_due"));
      for (const state of ["draining", "frozen", "released"] as const) {
        const workspaceId = `workspace_${state}`;
        await store.putWorkspace(workspace(workspaceId));
        await store.putSource(source(`src_${state}`, { workspaceId,
          createdAt: "2026-01-01T00:00:00.000Z" }));
        const drained = await store.beginWorkspaceDraining(workspaceId, {
          workspaceId, managementState: "active", managementEpoch: 1,
        });
        expect(drained.status, label).toBe("started");
        if (state === "frozen") {
          expect((await store.freezeWorkspaceManagementIfQuiescent({
            workspaceId, managementState: "draining", managementEpoch: 2,
          })).status, label).toBe("frozen");
        } else if (state === "released") {
          // The public lifecycle removes the Workspace row at release; retain a
          // seeded Source to verify the scheduler cannot resurrect it.
          await store.deleteWorkspace(workspaceId);
        }
      }
      await store.putSource(source("src_orphan", { workspaceId: "workspace_missing",
        createdAt: "2026-01-01T00:00:00.000Z" }));
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
      const observed = (await store.getSource("src_02"))!;
      expect((await store.writeSourceConfiguration({ expectedSource: observed,
        source: { ...observed, lastAutoSyncAttemptAt: "2026-02-08T00:00:00.000Z" },
        expectedWorkspaceManagementAuthority: {
          workspaceId: "workspace_due", managementState: "active", managementEpoch: 1,
        },
      })).status, label).toBe("updated");
      expect((await store.listAutoSyncSourcesDue(2)).map((row) => row.id), label).toEqual(["src_04", "src_05"]);
      expect((await store.listAutoSyncSourcesDue(0)).length, label).toBe(0);
    }
  } finally {
    await postgres.close();
  }
});

test("all stores poll only applied eligible app-owned Sources and preserve ownerless legacy polling", async () => {
  const postgres = await PGliteSqlClient.create();
  try {
    const stores: ReadonlyArray<[string, OpenTofuControlStore]> = [
      ["memory", new InMemoryOpenTofuControlStore()],
      ["postgres", new SqlOpenTofuControlStore({ client: postgres })],
      ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
    ];
    const ownerCases = [
      { id: "active", status: "active", applied: true },
      { id: "stale", status: "stale", applied: true },
      { id: "missing", status: "active", applied: true, omitCapsule: true },
      { id: "pending", status: "pending", applied: false },
      { id: "disabled", status: "disabled", applied: true },
      { id: "uninstalled", status: "uninstalled", applied: true },
      { id: "destroyed", status: "destroyed", applied: true },
      { id: "wrong_workspace", status: "active", applied: true, wrongWorkspace: true },
      { id: "wrong_source", status: "active", applied: true, wrongSource: true },
    ] as const;
    for (const [label, store] of stores) {
      await store.putWorkspace(workspace("workspace_due"));
      await store.putWorkspace(workspace("workspace_due_foreign"));
      await store.putSource(source("src_due_legacy", { createdAt: "2026-01-01T00:00:00.000Z" }));
      await store.putSource(source("src_due_other", { autoSync: false,
        createdAt: "2026-01-01T00:00:00.000Z" }));
      for (const entry of ownerCases) {
        const sourceId = `src_due_owned_${entry.id}`;
        const capsuleId = `cap_due_${entry.id}`;
        await store.putSource(source(sourceId, { ownerCapsuleId: capsuleId,
          createdAt: "2026-01-01T00:00:00.000Z" }));
        if ("omitCapsule" in entry) continue;
        const capsule: Capsule = {
          id: capsuleId,
          workspaceId: "wrongWorkspace" in entry ? "workspace_due_foreign" : "workspace_due",
          projectId: `project_due_${entry.id}`, name: entry.id, slug: entry.id,
          sourceId: "wrongSource" in entry ? "src_due_other" : sourceId,
          installConfigId: `config_due_${entry.id}`,
          installingPrincipalId: "principal_due", environment: "production",
          currentStateGeneration: entry.applied ? 1 : 0,
          ...(entry.applied ? { currentStateVersionId: `state_due_${entry.id}` } : {}),
          status: entry.status, createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        await store.putCapsule(capsule);
      }
      expect((await store.listAutoSyncSourcesDue(20)).map((row) => row.id), label).toEqual([
        "src_due_legacy", "src_due_owned_active", "src_due_owned_stale",
      ]);
    }
  } finally {
    await postgres.close();
  }
});
