import { afterEach, describe, expect, test } from "bun:test";
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
  test("refreshSession uses the lightweight dashboard session bootstrap", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return new Response(
          JSON.stringify({
            session: { subject: "tsub_1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const session = await refreshSession();
    expect(session?.subject).toBe("tsub_1");

    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
    ]);
  });
});
