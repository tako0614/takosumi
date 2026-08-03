import { afterEach, describe, expect, test } from "bun:test";
import { readWorkspaceResourcesView } from "../../../../dashboard/src/lib/workspace-views.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Resources Workspace view client", () => {
  test("uses one bounded view request instead of Resource Shape fan-out", async () => {
    const calls: Array<{ readonly path: string; readonly init?: RequestInit }> =
      [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({
        path: typeof input === "string" ? input : String(input),
        ...(init ? { init } : {}),
      });
      return Response.json({
        view: "resources.v1",
        workspaceId: "workspace_1",
        space: "workspace_1",
        resources: { items: [] },
        workloads: { items: [] },
        forms: { items: [] },
        hasTargetPool: true,
      });
    }) as typeof fetch;

    const view = await readWorkspaceResourcesView("workspace_1", {
      limit: 500,
      cursor: "cursor_next",
    });

    expect(view.hasTargetPool).toBeTrue();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(
      "/api/v1/workspaces/workspace_1/views/resources.v1?limit=100&cursor=cursor_next",
    );
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(calls[0]?.init?.signal).toBeUndefined();
  });

  test("preserves independent page cursors in the projection response", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        view: "resources.v1",
        workspaceId: "workspace_1",
        space: "workspace_1",
        resources: {
          items: [
            {
              id: "resource_1",
              apiVersion: "takosumi.io/v1alpha1",
              kind: "EdgeWorker",
              metadata: {
                name: "app",
                space: "workspace_1",
                managedBy: "opentofu",
              },
            },
          ],
          nextCursor: "r_next",
        },
        workloads: { items: [], nextCursor: "w_next" },
        forms: { items: [], nextCursor: "f_next" },
        hasTargetPool: false,
      })) as typeof fetch;

    const view = await readWorkspaceResourcesView("workspace_1");

    expect(view.resources.nextCursor).toBe("r_next");
    expect(view.workloads.nextCursor).toBe("w_next");
    expect(view.forms.nextCursor).toBe("f_next");
  });

  test("rejects malformed nested rows before UI rendering", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        view: "resources.v1",
        workspaceId: "workspace_1",
        space: "workspace_1",
        resources: {
          items: [{ id: "resource_1", metadata: { name: undefined } }],
        },
        workloads: { items: [] },
        forms: { items: [] },
        hasTargetPool: false,
      })) as typeof fetch;

    await expect(
      readWorkspaceResourcesView("workspace_1"),
    ).rejects.toMatchObject({ status: 502, code: "invalid_response" });
  });
});
