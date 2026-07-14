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
            id: "workspace_1",
            handle: "prod",
            displayName: "Production",
            type: "personal",
            ownerUserId: "user_1",
            createdAt: "2026-07-02T00:00:00.000Z",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
        workspace: {
          id: "workspace_1",
          handle: "prod",
          displayName: "Production",
          type: "personal",
          ownerUserId: "user_1",
          createdAt: "2026-07-02T00:00:00.000Z",
          updatedAt: "2026-07-02T00:00:00.000Z",
        },
        capsules: [
          {
            id: "capsule_1",
            workspaceId: "workspace_1",
            name: "Yurucommu",
            slug: "yurucommu",
            installConfigId: "cfg_yurucommu",
            environment: "prod",
            currentStateVersionId: "state_1",
            currentStateGeneration: 2,
            status: "active",
            createdAt: "2026-07-02T00:00:00.000Z",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
        currentStateVersions: [
          {
            id: "state_1",
            workspaceId: "workspace_1",
            capsuleId: "capsule_1",
            environment: "prod",
            generation: 2,
            createdByRunId: "apply_1",
            createdAt: "2026-07-02T00:00:00.000Z",
          },
        ],
        activity: [],
        installConfigs: [
          {
            id: "cfg_yurucommu",
            name: "yurucommu",
            sourceKind: "first_party_capsule",
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
  test("shares the in-flight overview request and primes complete list caches", async () => {
    const calls = stubOverviewFetch();

    const [a, b] = await Promise.all([
      getDashboardOverviewCached("workspace_1"),
      getDashboardOverviewCached("workspace_1"),
    ]);

    expect(a).toEqual(b);
    expect(calls()).toEqual([
      "/api/v1/dashboard/overview?workspaceId=workspace_1&includeWorkspaces=false",
    ]);

    expect((await listWorkspacesCached())[0]?.id).toBe("workspace_1");
    expect(
      (
        await listCapsulesCached("workspace_1", {
          includeDestroyed: false,
        })
      )[0]?.id,
    ).toBe("capsule_1");
    expect(
      (
        await listCurrentStateVersionsCached("workspace_1", {
          includeDestroyed: false,
        })
      )[0]?.id,
    ).toBe("state_1");
    expect((await listInstallConfigsCached("workspace_1"))[0]?.id).toBe(
      "cfg_yurucommu",
    );
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toBe("/api/v1/capsule-configs?workspaceId=workspace_1");
  });

  test("does not prime full-list caches from a capped overview page", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path.startsWith("/api/v1/workspaces/workspace_1/capsules")) {
        return new Response(
          JSON.stringify({
            capsules: [
              {
                id: "capsule_full",
                workspaceId: "workspace_1",
                name: "Full list app",
                slug: "full-list-app",
                installConfigId: "cfg_full",
                environment: "prod",
                currentStateGeneration: 0,
                status: "active",
                createdAt: "2026-07-02T00:00:00.000Z",
                updatedAt: "2026-07-02T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          workspaces: [
            {
              id: "workspace_1",
              handle: "prod",
              displayName: "Production",
              type: "personal",
              ownerUserId: "user_1",
              createdAt: "2026-07-02T00:00:00.000Z",
              updatedAt: "2026-07-02T00:00:00.000Z",
            },
          ],
          workspace: {
            id: "workspace_1",
            handle: "prod",
            displayName: "Production",
            type: "personal",
            ownerUserId: "user_1",
            createdAt: "2026-07-02T00:00:00.000Z",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
          capsules: [
            {
              id: "capsule_page",
              workspaceId: "workspace_1",
              name: "First page app",
              slug: "first-page-app",
              installConfigId: "cfg_page",
              environment: "prod",
              currentStateGeneration: 0,
              status: "active",
              createdAt: "2026-07-02T00:00:00.000Z",
              updatedAt: "2026-07-02T00:00:00.000Z",
            },
          ],
          currentStateVersions: [],
          activity: [],
          installConfigs: [],
          nextCapsuleCursor: "cursor_next",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await getDashboardOverviewCached("workspace_1");

    expect(
      (
        await listCapsulesCached("workspace_1", {
          includeDestroyed: false,
        })
      )[0]?.id,
    ).toBe("capsule_full");
    expect(calls).toEqual([
      "/api/v1/dashboard/overview?workspaceId=workspace_1&includeWorkspaces=false",
      "/api/v1/workspaces/workspace_1/capsules?includeDestroyed=false",
    ]);
  });

  test("does not clear the primed Workspace list when overview omits Workspaces", async () => {
    primeWorkspaceListCache([
      {
        id: "workspace_1",
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
            id: "workspace_1",
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

    await getDashboardOverviewCached("workspace_1");

    expect((await listWorkspacesCached())[0]?.id).toBe("workspace_1");
    expect(calls).toEqual([
      "/api/v1/dashboard/overview?workspaceId=workspace_1&includeWorkspaces=false",
    ]);
  });
});
