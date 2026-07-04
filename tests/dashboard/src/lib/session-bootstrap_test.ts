import { afterEach, describe, expect, test } from "bun:test";
import {
  clearSession,
  refreshSession,
} from "../../../../dashboard/src/views/account/lib/session.ts";
import {
  clearWorkspaceListCache,
  listWorkspacesCached,
} from "../../../../dashboard/src/lib/workspace-list.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  clearSession();
  clearWorkspaceListCache();
  globalThis.fetch = realFetch;
});

describe("dashboard session bootstrap", () => {
  test("refreshSession uses the dashboard session bootstrap and primes workspaces", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=true") {
        return new Response(
          JSON.stringify({
            session: { subject: "tsub_1" },
            workspaces: [{ id: "space_1", handle: "main" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const session = await refreshSession();
    expect(session?.subject).toBe("tsub_1");
    expect((await listWorkspacesCached())[0]?.id).toBe("space_1");

    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=true",
    ]);
  });

  test("shares concurrent session bootstrap requests", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=true") {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(
          JSON.stringify({
            session: { subject: "tsub_1" },
            workspaces: [{ id: "space_1", handle: "main" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);

    expect(a).toEqual(b);
    expect(a?.subject).toBe("tsub_1");
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=true",
    ]);
  });

  test("shares session bootstrap workspaces with the shell workspace list", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=true") {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(
          JSON.stringify({
            session: { subject: "tsub_1" },
            workspaces: [{ id: "space_1", handle: "main" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const [session, workspaces] = await Promise.all([
      refreshSession(),
      listWorkspacesCached(),
    ]);

    expect(session?.subject).toBe("tsub_1");
    expect(workspaces[0]?.id).toBe("space_1");
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=true",
    ]);
  });

  test("lets the workspace list start the shared bootstrap before session refresh", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=true") {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(
          JSON.stringify({
            session: { subject: "tsub_1" },
            workspaces: [{ id: "space_1", handle: "main" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const workspacePromise = listWorkspacesCached();
    const sessionPromise = refreshSession();
    const [workspaces, session] = await Promise.all([
      workspacePromise,
      sessionPromise,
    ]);

    expect(workspaces[0]?.id).toBe("space_1");
    expect(session?.subject).toBe("tsub_1");
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=true",
    ]);
  });
});
