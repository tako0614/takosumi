import { afterEach, describe, expect, test } from "bun:test";
import {
  clearSession,
  readSession,
  readSessionState,
  refreshSession,
  refreshSessionState,
  SessionError,
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

  test("keeps a 401 unauthenticated and allows the account-session fallback", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return new Response(null, { status: 401 });
      }
      if (path === "/v1/account/session/me") {
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    expect(await refreshSession()).toBeNull();
    expect(readSessionState()).toEqual({ kind: "unauthenticated" });
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      "/v1/account/session/me",
    ]);
  });

  test("treats a successful empty account session as unauthenticated", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return new Response(null, { status: 401 });
      }
      if (path === "/v1/account/session/me") {
        return new Response(JSON.stringify({ session: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    expect(await refreshSession()).toBeNull();
    expect(readSessionState()).toEqual({ kind: "unauthenticated" });
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      "/v1/account/session/me",
    ]);
  });

  test("clears the prior user's workspace cache when the session becomes empty", async () => {
    const calls: string[] = [];
    let phase: "old" | "signed-out" | "new" = "old";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === workspaceBootstrapPath) {
        if (phase === "old") {
          return new Response(
            JSON.stringify({
              session: { subject: "tsub_old" },
              workspaces: [{ id: "space_old", handle: "old-private" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (phase === "new") {
          return new Response(
            JSON.stringify({
              session: { subject: "tsub_new" },
              workspaces: [{ id: "space_new", handle: "new-private" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return new Response(null, { status: 401 });
      }
      if (path === "/v1/account/session/me" && phase === "signed-out") {
        return new Response(JSON.stringify({ session: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch during ${phase}: ${path}`);
    }) as typeof fetch;

    expect((await refreshSession({ includeWorkspaces: true }))?.subject).toBe(
      "tsub_old",
    );
    expect((await listWorkspacesCached())[0]?.id).toBe("space_old");

    phase = "signed-out";
    expect(await refreshSession()).toBeNull();

    phase = "new";
    expect((await listWorkspacesCached())[0]?.id).toBe("space_new");
    expect(calls).toEqual([
      workspaceBootstrapPath,
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      "/v1/account/session/me",
      workspaceBootstrapPath,
    ]);
  });

  test("keeps malformed successful account session responses as errors", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return new Response(null, { status: 401 });
      }
      if (path === "/v1/account/session/me") {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    let failure: unknown;
    try {
      await refreshSession();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SessionError);
    if (!(failure instanceof SessionError)) return;
    expect(failure.status).toBe(200);
    expect(failure.body).toEqual({});
    expect(readSessionState()).toMatchObject({ kind: "error" });
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      "/v1/account/session/me",
    ]);
  });

  test("keeps schema maintenance 503 typed, including headers/body, without a fallback", async () => {
    const calls: string[] = [];
    const body = {
      error: {
        code: "schema_maintenance",
        message: "Control schema maintenance is in progress.",
      },
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return new Response(JSON.stringify(body), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
            "x-takosumi-maintenance": "d1-blue-green",
          },
        });
      }
      throw new Error(`unexpected fallback fetch: ${path}`);
    }) as typeof fetch;

    let failure: unknown;
    try {
      await refreshSession();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SessionError);
    if (!(failure instanceof SessionError)) return;
    expect(failure.kind).toBe("maintenance");
    expect(failure.status).toBe(503);
    expect(failure.code).toBe("schema_maintenance");
    expect(failure.headers.get("retry-after")).toBe("30");
    expect(failure.headers.get("x-takosumi-maintenance")).toBe("d1-blue-green");
    expect(failure.body).toEqual(body);
    expect(readSessionState()).toMatchObject({ kind: "maintenance" });
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
    ]);
  });

  test("keeps non-maintenance failures typed instead of authoritative empty", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return new Response(JSON.stringify({ error: "capacity_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fallback fetch: ${path}`);
    }) as typeof fetch;

    const state = await refreshSessionState();
    expect(state.kind).toBe("error");
    if (state.kind !== "error") return;
    expect(state.error).toBeInstanceOf(SessionError);
    expect(state.error.status).toBe(503);
    expect(readSession()).toBeNull();
    expect(readSessionState().kind).toBe("error");
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
    ]);
  });
});
