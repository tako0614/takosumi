import { afterEach, describe, expect, test } from "bun:test";
import {
  clearWorkspaceListCache,
  listWorkspacesCached,
} from "../../../../dashboard/src/lib/workspace-list.ts";

const realFetch = globalThis.fetch;

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
});
