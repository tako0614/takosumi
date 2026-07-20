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
const workspaceBootstrapPath =
  "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50";

afterEach(() => {
  clearSession();
  clearWorkspaceListCache();
  globalThis.fetch = realFetch;
});

describe("dashboard session bootstrap", () => {
  test("refreshSession uses the fast dashboard session bootstrap without waiting for Workspaces", async () => {
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
      if (path === workspaceBootstrapPath) {
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
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
    ]);

    expect((await listWorkspacesCached())[0]?.id).toBe("space_1");

    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      workspaceBootstrapPath,
    ]);
  });

  test("shares concurrent session bootstrap requests", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(
          JSON.stringify({
            session: { subject: "tsub_1" },
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
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
    ]);
  });

  test("shares one bootstrap between shell session proof and its workspace list", async () => {
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
      if (path === workspaceBootstrapPath) {
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
      refreshSession({ includeWorkspaces: true }),
      listWorkspacesCached(),
    ]);

    expect(session?.subject).toBe("tsub_1");
    expect(workspaces[0]?.id).toBe("space_1");
    expect(calls).toEqual([workspaceBootstrapPath]);
  });

  test("shares the workspace bootstrap when the workspace list starts first", async () => {
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
      if (path === workspaceBootstrapPath) {
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
    const sessionPromise = refreshSession({ includeWorkspaces: true });
    const [workspaces, session] = await Promise.all([
      workspacePromise,
      sessionPromise,
    ]);

    expect(workspaces[0]?.id).toBe("space_1");
    expect(session?.subject).toBe("tsub_1");
    expect(calls).toEqual([workspaceBootstrapPath]);
  });
});
