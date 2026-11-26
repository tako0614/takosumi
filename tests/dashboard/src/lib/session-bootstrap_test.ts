import { afterEach, describe, expect, test } from "bun:test";
import { apiFetch } from "../../../../dashboard/src/views/account/lib/http.ts";
import {
  clearSession,
  initialSessionOptions,
  onSessionStateChange,
  readSharedAccountProfile,
  readSession,
  readSessionState,
  refreshSession,
  refreshSessionState,
  signOutSession,
  SessionError,
} from "../../../../dashboard/src/views/account/lib/session.ts";
import {
  clearWorkspaceListCache,
  listWorkspacesCached,
} from "../../../../dashboard/src/lib/workspace-list.ts";
import { handleSharedAuthRouteRequest } from "../../../../worker/src/shared_auth_rpc.ts";
import { appOwnershipAvailable, listAccessibleApps } from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;
const workspaceBootstrapPath =
  "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50";
const hostedSessionPath = "/auth/oidc/session";
const profilePath = "/api/v1/account/session/me?include=profile";
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

  test("shared profile discovery is explicit and ignores a delayed previous account", async () => {
    const calls: string[] = [];
    const oldProfile = Promise.withResolvers<Response>();
    let subject = "tsub_first";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(path);
      if (path === hostedSessionPath) return Response.json({ authenticated: true });
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return Response.json({ session: { subject } });
      }
      if (path === profilePath) {
        expect(init?.credentials).toBe("include");
        expect(init?.method).toBe("GET");
        expect(init?.cache).toBe("no-store");
        expect(init?.redirect).toBe("error");
        return subject === "tsub_first" ? oldProfile.promise : Response.json({
          subject, displayName: "Current person", email: "current@example.test",
        });
      }
      return Response.json({ session: null });
    }) as typeof fetch;

    expect(await refreshSession(initialSessionOptions)).toMatchObject({ subject });
    expect(calls).not.toContain(profilePath);
    const previous = readSharedAccountProfile(subject);
    expect(calls).toContain(profilePath);
    subject = "tsub_second";
    expect(await refreshSession(initialSessionOptions)).toMatchObject({ subject });
    oldProfile.resolve(Response.json({ subject: "tsub_first", email: "old@example.test" }));
    expect(await previous).toBeUndefined();
    expect(await readSharedAccountProfile(subject)).toEqual({
      displayName: "Current person", email: "current@example.test",
    });
    expect(readSession()?.email).toBeUndefined();
  });

  test("the guarded shell authenticates without reading the legacy Workspace list", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === hostedSessionPath) {
        return Response.json({ authenticated: true });
      }
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return Response.json({ session: { subject: "tsub_app_owner" } });
      }
      // A broken legacy listing must not prevent opening the app-owned shell.
      return Response.json({ error: "workspace_listing_unavailable" }, { status: 503 });
    }) as typeof fetch;

    const [first, mounted] = await Promise.all([
      refreshSessionState(initialSessionOptions),
      refreshSessionState(initialSessionOptions),
    ]);
    expect(first).toMatchObject({
      kind: "authenticated", session: { subject: "tsub_app_owner" },
    });
    expect(mounted).toEqual(first);
    expect(calls).toEqual([
      hostedSessionPath,
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
    ]);
  });

  test("the guarded shell still rejects a revoked canonical session after healthy RP status", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === hostedSessionPath) return Response.json({ authenticated: true });
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return new Response(null, { status: 401 });
      }
      return Response.json({ session: { subject: "tsub_stale_fallback" } });
    }) as typeof fetch;

    expect(await refreshSessionState(initialSessionOptions)).toEqual({ kind: "unauthenticated" });
    expect(calls).toEqual([
      hostedSessionPath,
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
    ]);
  });

  test("the guarded shell preserves a session-only bootstrap failure and can retry", async () => {
    const calls: string[] = [];
    let recovered = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path === hostedSessionPath) return Response.json({ authenticated: true });
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") {
        return recovered
          ? Response.json({ session: { subject: "tsub_recovered" } })
          : Response.json({ error: { code: "schema_maintenance" } }, { status: 503 });
      }
      return Response.json({ session: { subject: "tsub_stale_fallback" } });
    }) as typeof fetch;

    expect(await refreshSessionState(initialSessionOptions)).toMatchObject({
      kind: "maintenance", error: { status: 503, code: "schema_maintenance" },
    });
    recovered = true;
    expect(await refreshSessionState(initialSessionOptions)).toMatchObject({
      kind: "authenticated", session: { subject: "tsub_recovered" },
    });
    expect(calls).toEqual([
      hostedSessionPath,
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      hostedSessionPath,
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
    ]);
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
  test("a session probe started before sign-out cannot authenticate the shell afterwards", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : pending
    ) as typeof fetch;
    const states: string[] = [];
    const off = onSessionStateChange((state) => states.push(state.kind));
    try {
      const stale = refreshSession();
      clearSession();
      release(Response.json({ session: { subject: "signed-out-account" } }));
      expect(await stale).toBeNull();
      expect(readSessionState()).toEqual({ kind: "unauthenticated" });
      expect(states).toEqual(["unauthenticated"]);
    } finally { off(); }
  });

  test("explicit sign-out shares one pending request and clears only after confirmation", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    let deletes = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "DELETE") return Response.json({ session: { subject: "account-before-logout" } });
      deletes++;
      return await pending;
    }) as typeof fetch;
    await refreshSession();
    const signOut = signOutSession();
    expect(signOutSession()).toBe(signOut);
    expect(readSession()).toMatchObject({ subject: "account-before-logout" });
    expect(deletes).toBe(1);
    finish(new Response(null, { status: 204 }));
    expect(await signOut).toBe(true);
    expect(readSessionState()).toEqual({ kind: "unauthenticated" });
    expect(deletes).toBe(1);
  });

  test("an old account rejection cannot clear a same-document re-login", async () => {
    const requestStarted = Promise.withResolvers<void>();
    const oldReply = Promise.withResolvers<Response>();
    const previousLocation = globalThis.location;
    const signIns: string[] = [];
    let revocations = 0;
    globalThis.location = {
      pathname: "/account/cli", search: "?from=keys", hash: "",
      assign: (url: string) => signIns.push(url),
    } as unknown as Location;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === hostedSessionPath) return Response.json({ authenticated: true });
      if (path.startsWith("/api/v1/dashboard/bootstrap?")) {
        return Response.json({ session: { subject: "tsub_returning_owner" } });
      }
      if (path === "/api/v1/account/session/me" && init?.method === "DELETE") {
        revocations++;
        return new Response(null, { status: 204 });
      }
      if (path === "/api/v1/account/tokens/scopes") {
        requestStarted.resolve();
        return await oldReply.promise;
      }
      if (path === "/api/v1/account/tokens") return new Response(null, { status: 401 });
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    try {
      await refreshSession(initialSessionOptions);
      const retired = apiFetch("/api/v1/account/tokens/scopes").catch((error) => error);
      await requestStarted.promise;
      await expect(apiFetch("/api/v1/account/tokens")).rejects.toMatchObject({ status: 401 });
      expect(revocations).toBe(1);
      expect(signIns).toEqual(["/sign-in?return=%2Faccount%2Fcli%3Ffrom%3Dkeys"]);

      await refreshSession(initialSessionOptions);
      oldReply.resolve(new Response(null, { status: 401 }));
      expect(await retired).toMatchObject({ status: 401 });
      expect(readSession()?.subject).toBe("tsub_returning_owner");
      expect(revocations).toBe(1);
      expect(signIns).toHaveLength(1);

      await expect(apiFetch("/api/v1/account/tokens")).rejects.toMatchObject({ status: 401 });
      expect(revocations).toBe(2);
      expect(signIns).toHaveLength(2);
    } finally {
      oldReply.resolve(new Response(null, { status: 401 }));
      globalThis.location = previousLocation;
    }
  });

  test("a failed sign-out keeps the active session for an explicit retry", async () => {
    const calls: string[] = [];
    let deletes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "DELETE") return new Response(null, { status: ++deletes === 1 ? 503 : 204 });
      return Response.json({ session: { subject: "account-retry" } });
    }) as typeof fetch;
    await refreshSession();
    expect(await signOutSession()).toBe(false);
    expect(readSession()).toMatchObject({ subject: "account-retry" });
    expect(calls.slice(1)).toEqual(["DELETE /api/v1/account/session/me", "GET /api/v1/account/session/me"]);
    expect(await signOutSession()).toBe(true);
    expect(deletes).toBe(2);
    expect(readSessionState()).toEqual({ kind: "unauthenticated" });
  });

  test("loss of the sign-out response accepts only a verified signed-out readback", async () => {
    let followup = () => Response.json({ session: null }, { status: 404 });
    let deletes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes++;
        throw Error("synthetic lost DELETE response");
      }
      if (String(input) === "/api/v1/account/session/me") {
        expect(init?.cache).toBe("no-store");
        return followup();
      }
      return Response.json({ session: { subject: "account-readback" } });
    }) as typeof fetch;
    await refreshSession();
    for (const response of [
      () => Response.json({ session: null }, { status: 404 }),
      () => Response.json({ session: null }, { status: 401 }),
      () => new Response("<html>not a session</html>", { headers: { "content-type": "text/html" } }),
    ]) {
      followup = response;
      expect(await signOutSession()).toBe(false);
      expect(readSession()).toMatchObject({ subject: "account-readback" });
    }
    followup = () => Response.json({ session: null });
    expect(await signOutSession()).toBe(true);
    expect(deletes).toBe(4);
    expect(readSessionState()).toEqual({ kind: "unauthenticated" });
  });

  test("a late sign-out response does not clear a newer account's cached session", async () => {
    let subject = "account-before";
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "DELETE" ? pending : Response.json({ session: { subject } })
    ) as typeof fetch;
    await refreshSession();
    const signOut = signOutSession();
    subject = "account-after";
    await refreshSession();
    finish(new Response(null, { status: 204 }));
    expect(await signOut).toBe(false);
    expect(readSession()).toMatchObject({ subject: "account-after" });
  });

  test("an old failed probe cannot clear the next account's authenticated session", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<Response>((_resolve, fail) => { reject = fail; });
    let reads = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return ++reads === 1 ? pending : Response.json({ session: { subject: "next-account" } });
    }) as typeof fetch;
    const stale = refreshSession();
    clearSession();
    expect(await refreshSession()).toMatchObject({ subject: "next-account" });
    reject(new Error("old request failed"));
    expect(await stale).toBeNull();
    expect(readSessionState()).toMatchObject({ kind: "authenticated", session: { subject: "next-account" } });
  });

  test("app ownership cache survives same-account refresh and resets on account change and sign-out", async () => {
    let subject = "account-a";
    let appReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/apps") {
        appReads += 1;
        return Response.json({ apps: [{ capsuleId: subject, role: "owner" }] });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/api/v1/dashboard/bootstrap?includeWorkspaces=false") return Response.json({ session: { subject } });
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    await refreshSession();
    expect(await appOwnershipAvailable()).toBe(true);
    await refreshSession();
    expect((await listAccessibleApps())?.[0]?.capsuleId).toBe("account-a");
    expect(appReads).toBe(1);
    subject = "account-b";
    await refreshSession();
    expect((await listAccessibleApps())?.[0]?.capsuleId).toBe("account-b");
    expect(appReads).toBe(2);
    clearSession();
    await appOwnershipAvailable();
    expect(appReads).toBe(3);
  });


});
