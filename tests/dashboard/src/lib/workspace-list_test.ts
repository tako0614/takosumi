import { afterEach, describe, expect, test } from "bun:test";
import {
  clearWorkspaceListCache,
  listWorkspacesCached,
  mergeWorkspaceLists,
} from "../../../../dashboard/src/lib/workspace-list.ts";
import {
  listWorkspacePage,
  type Workspace,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

function workspace(id: string): Workspace {
  return {
    id,
    handle: id,
    displayName: id,
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function stubWorkspaceFetch(): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        workspaces: [
          {
            id: "space_1",
            handle: "prod",
            displayName: "Production",
            type: "personal",
            ownerUserId: "user_1",
            createdAt: "2026-06-30T00:00:00.000Z",
            updatedAt: "2026-06-30T00:00:00.000Z",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => {
  clearWorkspaceListCache();
  globalThis.fetch = realFetch;
});

describe("listWorkspacesCached", () => {
  test("shares the initial in-flight Workspace list request", async () => {
    const calls = stubWorkspaceFetch();

    const [a, b] = await Promise.all([
      listWorkspacesCached(),
      listWorkspacesCached(),
    ]);

    expect(calls()).toBe(1);
    expect(a).toEqual(b);
    expect(a[0]?.id).toBe("space_1");
  });

  test("serves fresh cached Workspace lists until invalidated", async () => {
    const calls = stubWorkspaceFetch();

    await listWorkspacesCached();
    await listWorkspacesCached();
    expect(calls()).toBe(1);

    clearWorkspaceListCache();
    await listWorkspacesCached();
    expect(calls()).toBe(2);
  });

  test("passes selected Workspace id to the lightweight bootstrap", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      return new Response(
        JSON.stringify({
          workspaces: [
            {
              id: "space_selected",
              handle: "selected",
              displayName: "Selected",
              type: "personal",
              ownerUserId: "user_1",
              createdAt: "2026-06-30T00:00:00.000Z",
              updatedAt: "2026-06-30T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await listWorkspacesCached({ selectedWorkspaceId: "space_selected" });

    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50&workspaceId=space_selected",
    ]);
  });

  test("uses the bounded page fallback and pins the selected Workspace", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      return new Response(
        JSON.stringify({
          workspaces: [
            {
              id: "space_selected",
              handle: "selected",
              displayName: "Selected",
              type: "personal",
              ownerUserId: "user_1",
              createdAt: "2026-06-30T00:00:00.000Z",
              updatedAt: "2026-06-30T00:00:00.000Z",
            },
          ],
          total: 70,
          returned: 1,
          limit: 50,
          truncated: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await listWorkspacesCached({
      force: true,
      selectedWorkspaceId: "space_selected",
    });

    expect(calls).toEqual([
      "/api/v1/workspaces?limit=50&order=updated_desc&selectedWorkspaceId=space_selected",
    ]);
  });

  test("refreshes a fresh page when it does not contain the selected Workspace", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      const selected = new URL(path, "https://dashboard.test").searchParams.get(
        "workspaceId",
      );
      return Response.json({
        workspaces: [workspace(selected ?? "space_recent")],
      });
    }) as typeof fetch;

    expect((await listWorkspacesCached())[0]?.id).toBe("space_recent");
    expect(
      (
        await listWorkspacesCached({
          selectedWorkspaceId: "space_off_page",
        })
      )[0]?.id,
    ).toBe("space_off_page");
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50",
      "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50&workspaceId=space_off_page",
    ]);
  });

  test("keeps concurrent selected Workspace loads scoped and caches the latest", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const selected = new URL(path, "https://dashboard.test").searchParams.get(
        "workspaceId",
      );
      if (selected !== "space_a" && selected !== "space_b") {
        throw new Error(`unexpected selected Workspace: ${selected}`);
      }
      calls.push(selected);
      await new Promise((resolve) =>
        setTimeout(resolve, selected === "space_a" ? 10 : 1),
      );
      return Response.json({ workspaces: [workspace(selected)] });
    }) as typeof fetch;

    const loadingA = listWorkspacesCached({ selectedWorkspaceId: "space_a" });
    await Promise.resolve();
    const loadingB = listWorkspacesCached({ selectedWorkspaceId: "space_b" });
    const [a, b] = await Promise.all([loadingA, loadingB]);

    expect(a[0]?.id).toBe("space_a");
    expect(b[0]?.id).toBe("space_b");
    expect(calls).toEqual(["space_a", "space_b"]);
    expect(
      (await listWorkspacesCached({ selectedWorkspaceId: "space_b" }))[0]?.id,
    ).toBe("space_b");
    expect(calls).toHaveLength(2);
  });

  test("deduplicates a pinned current Workspace while appending pages", () => {
    expect(
      mergeWorkspaceLists(
        [workspace("space_current"), workspace("space_recent")],
        [workspace("space_current"), workspace("space_older")],
      ).map((item) => item.id),
    ).toEqual(["space_current", "space_recent", "space_older"]);
  });

  test("follows a bounded cursor so the 51st switcher target remains reachable", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path.includes("cursor=cursor_next")) {
        return Response.json({
          workspaces: [workspace("space_51")],
          returned: 1,
          limit: 50,
          truncated: false,
        });
      }
      return Response.json({
        workspaces: [
          workspace("space_current"),
          ...Array.from({ length: 50 }, (_, index) =>
            workspace(`space_${index + 1}`),
          ),
        ],
        returned: 51,
        limit: 50,
        truncated: true,
        nextCursor: "cursor_next",
        pinnedWorkspaceId: "space_current",
      });
    }) as typeof fetch;

    const first = await listWorkspacePage({
      limit: 50,
      order: "updated_desc",
      selectedWorkspaceId: "space_current",
    });
    const second = await listWorkspacePage({
      limit: 50,
      order: "updated_desc",
      cursor: first.nextCursor,
    });
    const merged = mergeWorkspaceLists(first.workspaces, second.workspaces);

    expect(merged.some((item) => item.id === "space_51")).toBe(true);
    expect(merged.filter((item) => item.id === "space_current")).toHaveLength(
      1,
    );
    expect(calls).toEqual([
      "/api/v1/workspaces?limit=50&order=updated_desc&selectedWorkspaceId=space_current",
      "/api/v1/workspaces?limit=50&cursor=cursor_next&order=updated_desc",
    ]);
  });
});
