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
  listMembers,
  type PublicWorkspaceMember,
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

  test("passes through the display name and the role-gated email", async () => {
    const named = {
      ...MEMBER,
      displayName: "Alice",
      email: "alice@example.test",
    };
    stubFetch({ members: [named, { ...MEMBER, accountId: "acct_bob" }] });
    const rows = await listMembers("workspace_1");
    expect(rows[0]?.displayName).toBe("Alice");
    expect(rows[0]?.email).toBe("alice@example.test");
    // The server omits both when it has no name or the caller may not see it.
    expect(rows[1]?.displayName).toBeUndefined();
    expect(rows[1]?.email).toBeUndefined();
  });

  test("defaults to an empty list when the body omits `members`", async () => {
    stubFetch({});
    expect(await listMembers("workspace_1")).toEqual([]);
  });
});
