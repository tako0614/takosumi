import { afterEach, describe, expect, test } from "bun:test";
import {
  clearDashboardOverviewCache,
  getDashboardOverviewCached,
} from "../../../../dashboard/src/lib/dashboard-overview.ts";
import {
  clearCapsuleListCache,
  listCapsulesCached,
} from "../../../../dashboard/src/lib/capsule-list.ts";
import {
  clearCurrentStateVersionCache,
  listCurrentStateVersionsCached,
} from "../../../../dashboard/src/lib/current-state-versions.ts";
import {
  clearInstallConfigListCache,
  listInstallConfigsCached,
} from "../../../../dashboard/src/lib/install-config-list.ts";
import {
  clearWorkspaceListCache,
  listWorkspacesCached,
  primeWorkspaceListCache,
} from "../../../../dashboard/src/lib/workspace-list.ts";

const realFetch = globalThis.fetch;

function stubOverviewFetch(): () => readonly string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(path);
    return new Response(
      JSON.stringify({
        workspaces: [
          {
            id: "space_1",
            handle: "prod",
            displayName: "Production",
            type: "personal",
            ownerUserId: "user_1",
            createdAt: "2026-07-02T00:00:00.000Z",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
        workspace: {
          id: "space_1",
          handle: "prod",
          displayName: "Production",
          type: "personal",
          ownerUserId: "user_1",
          createdAt: "2026-07-02T00:00:00.000Z",
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
        capsules: [
          {
            id: "inst_1",
            workspaceId: "space_1",
            name: "Yurucommu",
            slug: "yurucommu",
            installConfigId: "cfg_yurucommu",
            environment: "prod",
            currentStateVersionId: "dep_1",
            currentStateGeneration: 2,
            status: "active",
            createdAt: "2026-07-02T00:00:00.000Z",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
        currentStateVersions: [
          {
            id: "dep_1",
            spaceId: "space_1",
            installationId: "inst_1",
            environment: "prod",
            applyRunId: "apply_1",
            sourceSnapshotId: "snap_1",
            stateGeneration: 2,
            outputsPublic: { launch_url: "https://yuru.example.test" },
            status: "active",
            createdAt: "2026-07-02T00:00:00.000Z",
          },
        ],
        activity: [],
        installConfigs: [
          {
            id: "cfg_yurucommu",
            name: "yurucommu",
            sourceKind: "first_party_capsule",
            trustLevel: "official",
            createdAt: "2026-07-02T00:00:00.000Z",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => {
  clearDashboardOverviewCache();
  clearWorkspaceListCache();
  clearCapsuleListCache();
  clearCurrentStateVersionCache();
  clearInstallConfigListCache();
  globalThis.fetch = realFetch;
});

describe("getDashboardOverviewCached", () => {
  test("shares the in-flight overview request and primes list caches", async () => {
    const calls = stubOverviewFetch();

    const [a, b] = await Promise.all([
      getDashboardOverviewCached("space_1"),
      getDashboardOverviewCached("space_1"),
    ]);

    expect(a).toEqual(b);
    expect(calls()).toEqual([
      "/api/v1/dashboard/overview?workspaceId=space_1&includeWorkspaces=false",
    ]);

    expect((await listWorkspacesCached())[0]?.id).toBe("space_1");
    expect(
      (
        await listCapsulesCached("space_1", {
          includeDestroyed: false,
        })
      )[0]?.id,
    ).toBe("inst_1");
    expect(
      (
        await listCurrentStateVersionsCached("space_1", {
          includeDestroyed: false,
        })
      )[0]?.id,
    ).toBe("dep_1");
    expect((await listInstallConfigsCached("space_1"))[0]?.id).toBe(
      "cfg_yurucommu",
    );
    expect(calls()).toHaveLength(1);
  });

  test("does not clear the primed Workspace list when overview omits Workspaces", async () => {
    primeWorkspaceListCache([
      {
        id: "space_1",
        handle: "prod",
        displayName: "Production",
        type: "personal",
        ownerUserId: "user_1",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ]);
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      return new Response(
        JSON.stringify({
          workspaces: [],
          workspace: {
            id: "space_1",
            handle: "prod",
            displayName: "Production",
            type: "personal",
            ownerUserId: "user_1",
            createdAt: "2026-07-02T00:00:00.000Z",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
          capsules: [],
          currentStateVersions: [],
          activity: [],
          installConfigs: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await getDashboardOverviewCached("space_1");

    expect((await listWorkspacesCached())[0]?.id).toBe("space_1");
    expect(calls).toEqual([
      "/api/v1/dashboard/overview?workspaceId=space_1&includeWorkspaces=false",
    ]);
  });
});
