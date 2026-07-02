import { afterEach, describe, expect, test } from "bun:test";
import { listWorkspacesCached } from "../../../../dashboard/src/lib/workspace-list.ts";
import {
  clearSession,
  refreshSession,
} from "../../../../dashboard/src/views/account/lib/session.ts";
import { clearWorkspaceListCache } from "../../../../dashboard/src/lib/workspace-list.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  clearSession();
  clearWorkspaceListCache();
  globalThis.fetch = realFetch;
});

describe("dashboard session bootstrap", () => {
  test("refreshSession primes the Workspace cache from bootstrap", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap") {
        return new Response(
          JSON.stringify({
            session: { subject: "tsub_1" },
            workspaces: [
              {
                id: "space_1",
                handle: "prod",
                displayName: "Production",
                type: "personal",
                ownerUserId: "tsub_1",
                createdAt: "2026-07-02T00:00:00.000Z",
                updatedAt: "2026-07-02T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const session = await refreshSession();
    expect(session?.subject).toBe("tsub_1");

    const workspaces = await listWorkspacesCached();
    expect(workspaces[0]?.id).toBe("space_1");
    expect(calls).toEqual(["/api/v1/dashboard/bootstrap"]);
  });
});
