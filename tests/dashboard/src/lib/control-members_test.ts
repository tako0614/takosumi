/**
 * Tests for the Workspace-membership client functions on the session
 * `/api/v1/*` surface (Members 画面). Pure-logic fetch-stub tests in the
 * same style as the other control-client tests: they lock in the EXACT path +
 * method + request body each client fn sends, so a drift from the server route
 * contract in accounts/service/src/control-routes.ts fails loudly.
 *
 *   GET    /api/v1/workspaces/:id/members            -> { members: [...] }
 *   POST   /api/v1/workspaces/:id/members            -> { member: {...} }  (201)
 *   PATCH  /api/v1/workspaces/:id/members/:subject   -> { member: {...} }
 *   DELETE /api/v1/workspaces/:id/members/:subject   -> { member: {...} }
 *
 * The workspaceId is ALWAYS a path segment (never a body field) — the server
 * re-resolves and gates it; these tests assert it never leaks into the body.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  ControlApiError,
  inviteMember,
  listMembers,
  type PublicWorkspaceMember,
  removeMember,
  setMemberRole,
} from "../../../../dashboard/src/lib/control-api.ts";

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const realFetch = globalThis.fetch;

/** Install a fetch stub that records the request and replies with `body`. */
function stubFetch(body: unknown, status = 200): () => Captured {
  let captured: Captured | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let parsed: unknown;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    captured = {
      url: typeof input === "string" ? input : String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: parsed,
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    if (!captured) throw new Error("fetch was not called");
    return captured;
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const MEMBER: PublicWorkspaceMember = {
  id: "mem_1",
  workspaceId: "workspace_1",
  accountId: "acct_alice",
  roles: ["owner"],
  status: "active",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

describe("listMembers", () => {
  test("GETs the members route and unwraps `members`", async () => {
    const captured = stubFetch({ members: [MEMBER] });
    const rows = await listMembers("workspace 1");
    const req = captured();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/api/v1/workspaces/workspace%201/members");
    expect(req.body).toBeUndefined();
    expect(rows).toEqual([MEMBER]);
  });

  test("defaults to an empty list when the body omits `members`", async () => {
    stubFetch({});
    expect(await listMembers("workspace_1")).toEqual([]);
  });
});

describe("inviteMember", () => {
  test("POSTs email + role to the members route and returns the member", async () => {
    const captured = stubFetch({ member: MEMBER }, 201);
    const got = await inviteMember("workspace 1", {
      email: "alice@example.test",
      role: "admin",
    });
    const req = captured();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/v1/workspaces/workspace%201/members");
    // The workspaceId is the path, NOT the body — the server re-resolves it.
    expect(req.body).toEqual({ email: "alice@example.test", role: "admin" });
    expect(got).toEqual(MEMBER);
  });

  test("omits role when not given (server defaults to member)", async () => {
    const captured = stubFetch({ member: MEMBER }, 201);
    await inviteMember("workspace_1", { email: "bob@example.test" });
    expect(captured().body).toEqual({ email: "bob@example.test" });
  });

  test("can still send accountId for operator/debug callers", async () => {
    const captured = stubFetch({ member: MEMBER }, 201);
    await inviteMember("workspace_1", { accountId: "acct_bob" });
    expect(captured().body).toEqual({ accountId: "acct_bob" });
  });
});

describe("setMemberRole", () => {
  test("PATCHes the member-subject route with the roles field", async () => {
    const captured = stubFetch({ member: MEMBER });
    await setMemberRole("workspace_1", "acct alice", "admin");
    const req = captured();
    expect(req.method).toBe("PATCH");
    // Both the workspaceId and target subject are URL-encoded path segments.
    expect(req.url).toBe(
      "/api/v1/workspaces/workspace_1/members/acct%20alice",
    );
    expect(req.body).toEqual({ roles: "admin" });
  });

  test("accepts a role array", async () => {
    const captured = stubFetch({ member: MEMBER });
    await setMemberRole("workspace_1", "acct_alice", ["admin", "member"]);
    expect(captured().body).toEqual({ roles: ["admin", "member"] });
  });

  test("surfaces the backend last-owner 403 as a ControlApiError", async () => {
    stubFetch(
      { error: "forbidden", error_description: "Cannot demote the last owner" },
      403,
    );
    await expect(
      setMemberRole("workspace_1", "acct_alice", "member"),
    ).rejects.toBeInstanceOf(ControlApiError);
  });
});

describe("removeMember", () => {
  test("DELETEs the member-subject route with no body", async () => {
    const captured = stubFetch({ member: { ...MEMBER, status: "suspended" } });
    const got = await removeMember("workspace_1", "acct alice");
    const req = captured();
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(
      "/api/v1/workspaces/workspace_1/members/acct%20alice",
    );
    expect(req.body).toBeUndefined();
    // The backend soft-removes (status: suspended) and returns the projection.
    expect(got.status).toBe("suspended");
  });

  test("surfaces the backend last-owner 403 as a ControlApiError", async () => {
    stubFetch(
      { error: "forbidden", error_description: "Cannot remove the last owner" },
      403,
    );
    await expect(
      removeMember("workspace_1", "acct_alice"),
    ).rejects.toBeInstanceOf(ControlApiError);
  });
});
