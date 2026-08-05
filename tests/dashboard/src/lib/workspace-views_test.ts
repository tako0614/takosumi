import { afterEach, describe, expect, test } from "bun:test";
import {
  mergeWorkspaceResourcesViews,
  readWorkspaceResourcesView,
} from "../../../../dashboard/src/lib/workspace-views.ts";

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

  test("keeps the initial inventory request to one bounded page", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      return Response.json({
        view: "resources.v1",
        workspaceId: "workspace_1",
        space: "workspace_1",
        nextCursor: "cursor_next",
        resources: {
          items: [
            {
              id: "resource_1",
              apiVersion: "takosumi.io/v1alpha1",
              kind: "EdgeWorker",
              metadata: {
                name: "first",
                space: "workspace_1",
                managedBy: "opentofu",
              },
            },
          ],
        },
        workloads: { items: [] },
        forms: { items: [] },
        hasTargetPool: true,
      });
    }) as typeof fetch;

    const view = await readWorkspaceResourcesView("workspace_1");

    expect(calls).toEqual([
      "/api/v1/workspaces/workspace_1/views/resources.v1?limit=50",
    ]);
    expect(view.resources.items.map((item) => item.metadata.name)).toEqual([
      "first",
    ]);
    expect(view.nextCursor).toBe("cursor_next");
  });

  test("loads and appends a continuation only when requested", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      const second = path.includes("cursor=cursor_next");
      const resource = {
        id: second ? "resource_2" : "resource_1",
        apiVersion: "takosumi.io/v1alpha1",
        kind: "EdgeWorker",
        metadata: {
          name: second ? "second" : "first",
          space: "workspace_1",
          managedBy: "opentofu",
        },
      };
      return Response.json({
        view: "resources.v1",
        workspaceId: "workspace_1",
        space: "workspace_1",
        ...(second ? {} : { nextCursor: "cursor_next" }),
        resources: { items: [resource] },
        workloads: {
          items: [
            {
              id: second ? "workload_2" : "workload_1",
              workspaceId: "workspace_1",
              name: second ? "second" : "first",
              slug: second ? "second" : "first",
              installConfigId: "install_1",
              environment: "production",
              currentStateGeneration: 1,
              status: "active",
              createdAt: "2026-08-03T00:00:00.000Z",
              updatedAt: "2026-08-03T00:00:00.000Z",
            },
          ],
        },
        forms: {
          items: [
            {
              form: {
                type: second ? "Queue" : "ObjectBucket",
                version: "1.0.0",
                schemaDigest: `sha256:${"a".repeat(64)}`,
                packageDigest: `sha256:${"b".repeat(64)}`,
              },
              definitionKnown: true,
              installed: true,
              executable: true,
              activated: true,
              availableToPrincipal: true,
              operations: ["apply"],
              compatibleAdapterIds: ["adapter_1"],
              eligibleTargetPoolClasses: ["standard"],
              deprecated: false,
            },
          ],
        },
        hasTargetPool: true,
      });
    }) as typeof fetch;

    const first = await readWorkspaceResourcesView("workspace_1");
    const second = await readWorkspaceResourcesView("workspace_1", {
      cursor: first.nextCursor,
    });
    const view = mergeWorkspaceResourcesViews(first, second);

    expect(calls).toEqual([
      "/api/v1/workspaces/workspace_1/views/resources.v1?limit=50",
      "/api/v1/workspaces/workspace_1/views/resources.v1?limit=50&cursor=cursor_next",
    ]);
    expect(view.resources.items.map((item) => item.metadata.name)).toEqual([
      "first",
      "second",
    ]);
    expect(view.workloads.items).toHaveLength(2);
    expect(view.forms.items).toHaveLength(2);
    expect(view.nextCursor).toBeUndefined();
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
