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
import { handleSharedAuthRouteRequest } from "../../../../worker/src/shared_auth_rpc.ts";

const realFetch = globalThis.fetch;
const workspaceBootstrapPath =
  "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50";
const hostedSessionPath = "/auth/oidc/session";
const absenceHeader = "x-takosumi-shared-auth-absent";

afterEach(() => {
  clearSession();
  clearWorkspaceListCache();
  globalThis.fetch = realFetch;
});

describe("dashboard session bootstrap", () => {
  test("the first guarded read completes the Hosted session probe before canonical Workspace bootstrap", async () => {
    const calls: string[] = [];
    let finishProbe!: (response: Response) => void;
    const probe = new Promise<Response>((resolve) => {
      finishProbe = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === hostedSessionPath) {
        expect(init?.credentials).toBe("include");
        expect(init?.method).toBe("GET");
        expect(init?.cache).toBe("no-store");
        return await probe;
      }
      if (path === workspaceBootstrapPath) {
        return Response.json({
          session: { subject: "tsub_canonical" },
          workspaces: [{ id: "space_1", handle: "main" }],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    expect(readSessionState({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    })).toEqual({ kind: "loading" });
    const state = refreshSessionState({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    });
    expect(calls).toEqual([hostedSessionPath]);
    finishProbe(Response.json({ authenticated: true }));
    expect(await state).toMatchObject({
      kind: "authenticated",
      session: { subject: "tsub_canonical" },
    });
    expect(calls).toEqual([hostedSessionPath, workspaceBootstrapPath]);
  });

  test("an absent Hosted route preserves the ordinary Workspace bootstrap", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === hostedSessionPath) {
        return Response.json({ error: "not_found" }, {
          status: 404,
          headers: {
            "cache-control": "no-store",
            [absenceHeader]: "1",
          },
        });
      }
      if (path === workspaceBootstrapPath) {
        return Response.json({
          session: { subject: "tsub_ordinary" },
          workspaces: [{ id: "space_ordinary", handle: "ordinary" }],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    expect((await refreshSession({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    }))?.subject).toBe("tsub_ordinary");
    expect(calls).toEqual([hostedSessionPath, workspaceBootstrapPath]);
  });

  test("a configured RP's forged ordinary 404 cannot start bootstrap or account fallback", async () => {
    const origin = "https://hosted.staging.example.test";
    const forwarded = await handleSharedAuthRouteRequest(
      new Request(origin + hostedSessionPath),
      {
        TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
        TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
        TAKOSUMI_ENVIRONMENT: "staging",
        HOSTED: {
          fetchSharedAuth: async () => Response.json({ error: "not_found" }, {
            status: 404,
            headers: { [absenceHeader]: "1" },
          }),
          authenticateSharedAuth: async () => ({ kind: "unauthenticated" }),
          resolveSharedAuthWorkspace: async () => ({ kind: "forbidden" }),
        },
      },
    );
    expect(forwarded?.status).toBe(404);
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === hostedSessionPath && forwarded) return forwarded;
      if (path === workspaceBootstrapPath) return new Response(null, { status: 401 });
      if (path === "/api/v1/account/session/me") {
        return Response.json({ subject: "tsub_ordinary_fallback" });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const state = await refreshSessionState({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    });
    expect(state.kind).toBe("error");
    expect(calls).toEqual([hostedSessionPath]);
  });

  test("a Hosted 200 cannot turn a denied canonical bootstrap into a session", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === hostedSessionPath) {
        return Response.json({ authenticated: true });
      }
      if (path === workspaceBootstrapPath) return new Response(null, { status: 401 });
      if (path === "/api/v1/account/session/me") {
        return Response.json({ subject: "tsub_forged_fallback" });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    expect(await refreshSessionState({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    })).toEqual({ kind: "unauthenticated" });
    expect(calls).toEqual([hostedSessionPath, workspaceBootstrapPath]);
  });

  test("a negative Hosted status cannot supply identity but current bootstrap still decides", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === hostedSessionPath) {
        return Response.json({ authenticated: false }, { status: 401 });
      }
      if (path === workspaceBootstrapPath) {
        return Response.json({
          session: { subject: "tsub_after_login" },
          workspaces: [{ id: "space_1", handle: "main" }],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    expect((await refreshSession({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    }))?.subject).toBe("tsub_after_login");
    expect(calls).toEqual([hostedSessionPath, workspaceBootstrapPath]);
  });

  test("a Hosted 200 cannot hide the canonical bootstrap 503", async () => {
    const calls: string[] = [];
    const body = { error: "authentication_unavailable" };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === hostedSessionPath) return Response.json({ authenticated: true });
      if (path === workspaceBootstrapPath) {
        return Response.json(body, {
          status: 503,
          headers: { "retry-after": "5" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const state = await refreshSessionState({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    });
    expect(state.kind).toBe("error");
    if (state.kind !== "error") return;
    expect(state.error.status).toBe(503);
    expect(state.error.body).toEqual(body);
    expect(state.error.headers.get("retry-after")).toBe("5");
    expect(calls).toEqual([hostedSessionPath, workspaceBootstrapPath]);
  });

  test("checking and malformed Hosted probes fail closed before bootstrap", async () => {
    const cases = [
      Response.json({ error: { code: "oidc_unavailable" } }, {
        status: 503,
        headers: { "retry-after": "7" },
      }),
      new Response("<html>app shell</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      Response.json({ error: "not found" }, { status: 404 }),
    ];
    for (const response of cases) {
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : String(input);
        calls.push(path);
        if (path === hostedSessionPath) return response;
        throw new Error(`unexpected bootstrap after ${response.status}: ${path}`);
      }) as typeof fetch;
      const state = await refreshSessionState({
        includeWorkspaces: true,
        initialSharedAuthPreflight: true,
      });
      expect(state.kind).toBe("error");
      if (state.kind === "error") {
        expect(state.error.status).toBe(response.status);
        if (response.status === 503) {
          expect(state.error.headers.get("retry-after")).toBe("7");
          expect(state.error.body).toEqual({ error: { code: "oidc_unavailable" } });
        }
      }
      expect(calls).toEqual([hostedSessionPath]);
    }
  });

  test("an unknown Hosted probe result does not start a parallel bootstrap", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      throw new TypeError("network result unknown");
    }) as typeof fetch;

    const state = await refreshSessionState({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    });
    expect(state.kind).toBe("error");
    if (state.kind === "error") expect(state.error.status).toBe(0);
    expect(calls).toEqual([hostedSessionPath]);
  });

  test("a warm guarded session stays cache-first", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      calls.push(path);
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return Response.json({ session: { subject: "tsub_warm" } });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    await refreshSession();
    expect(readSessionState({
      includeWorkspaces: true,
      initialSharedAuthPreflight: true,
    })).toMatchObject({
      kind: "authenticated",
      session: { subject: "tsub_warm" },
    });
    expect(calls).toEqual(["/api/v1/dashboard/bootstrap?includeWorkspaces=false"]);
  });

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
      if (path === "/api/v1/account/session/me") {
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    expect(await refreshSession()).toBeNull();
    expect(readSessionState()).toEqual({ kind: "unauthenticated" });
    expect(calls).toEqual([
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      "/api/v1/account/session/me",
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
      if (path === "/api/v1/account/session/me") {
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
      "/api/v1/account/session/me",
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
      if (path === "/api/v1/account/session/me" && phase === "signed-out") {
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
      "/api/v1/account/session/me",
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
      if (path === "/api/v1/account/session/me") {
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
      "/api/v1/account/session/me",
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
