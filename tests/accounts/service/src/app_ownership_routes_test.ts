import { describe, expect, test } from "bun:test";
import {
  AppOwnershipError,
  handleAppOwnership,
  type AppOwnershipOperations,
} from "../../../../accounts/service/src/control/app-ownership.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";

const accounts = {
  owner: { subject: "owner", displayName: "Owner", email: "owner@example.test", emailVerified: true },
  member: { subject: "member", displayName: "Member", email: "member@example.test", emailVerified: true },
  unverified: { subject: "unverified", displayName: "Unverified", email: "unverified@example.test", emailVerified: false },
};

function port(overrides: Partial<AppOwnershipOperations> = {}): AppOwnershipOperations {
  return {
    resolveAppAccess: async (accountId, capsuleId) =>
      accountId === "owner" || accountId === "member"
        ? { capsuleId, role: accountId === "owner" ? "owner" : "member", ownerAccountId: "owner", ownershipEpoch: 4 }
        : undefined,
    listAccessibleApps: async () => ({ apps: [] }),
    listMembers: async () => ({ ownerAccountId: "owner", ownershipEpoch: 4, members: [
      { accountId: "member", status: "active" },
      { accountId: "unverified", status: "invited" },
    ] }),
    addMember: async ({ accountId }) => ({ accountId, status: "active" }),
    removeMember: async () => {},
    createTransfer: async () => ({ transferId: "tx1", state: "pending" }),
    getTransfer: async () => ({ transferId: "tx1", capsuleId: "cap1", fromAccountId: "owner", toAccountId: "member", state: "pending" }),
    acceptTransfer: async () => ({ transferId: "tx1", state: "accepted" }),
    cancelTransfer: async () => {},
    ...overrides,
  };
}

function context(
  method: string,
  path: string,
  subject: string,
  ownership?: AppOwnershipOperations,
  body?: unknown,
  workspaceId?: string,
  appIds?: readonly string[],
): ControlDispatchContext {
  const request = new Request(`https://example.test/api/v1/${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    request,
    url: new URL(request.url),
    session: { subject, ...(workspaceId ? { workspaceId } : {}), ...(appIds ? { appIds } : {}) },
    operations: {
      ...(ownership ? { appAuthorization: ownership, appAccess: ownership } : {}),
      listCapsuleRunsPage: async () => ({ items: [] }),
      capsules: { getCapsule: async (id: string) => ({ id, workspaceId: "ws1" }) },
    },
    store: {
      findAccount: async (subject: string) => Object.values(accounts).find((account) => account.subject === subject),
      findAccountByVerifiedEmail: async (email: string) =>
        Object.values(accounts).find((account) => account.emailVerified && account.email === email),
    },
  } as unknown as ControlDispatchContext;
}

async function call(ctx: ControlDispatchContext, segments: string[]): Promise<Response> {
  const response = await handleAppOwnership(ctx, segments, ctx.request.method);
  expect(response).toBeDefined();
  return response!;
}

describe("per-app ownership routes", () => {
  test("fails closed without a real ownership port and for Workspace-scoped bearers", async () => {
    expect((await call(context("GET", "capsules/cap1/members", "owner"), ["capsules", "cap1", "members"])).status).toBe(503);
    const scoped = await call(context("GET", "capsules/cap1/members", "owner", port(), undefined, "ws1"), ["capsules", "cap1", "members"]);
    expect(scoped.status).toBe(403);
    expect((await scoped.json()).error.code).toBe("app_access_denied");
  });

  test("appIds attenuates member routes and filters app listing before any app read", async () => {
    const member = await call(context("GET", "capsules/cap1/members", "owner", port(), undefined, undefined, ["cap2"]), ["capsules", "cap1", "members"]);
    expect(member.status).toBe(403);
    let capsuleReads = 0;
    const ownership = port({
      listAccessibleApps: async () => ({
        apps: [{ capsuleId: "cap1", role: "owner", ownerAccountId: "owner", ownershipEpoch: 4 }],
      }),
    });
    const ctx = context("GET", "apps", "owner", ownership, undefined, undefined, ["cap2"]);
    (ctx.operations as unknown as { capsules: { getCapsule: () => Promise<never> } }).capsules = {
      getCapsule: async () => { capsuleReads++; throw new Error("unexpected app read"); },
    };
    const apps = await call(ctx, ["apps"]);
    expect(await apps.json()).toEqual({ apps: [] });
    expect(capsuleReads).toBe(0);
  });

  test("converted Workspace PAT may manage only its matching app and Workspace", async () => {
    const ownership = port();
    const route = ["capsules", "cap1", "members"];
    const allowed = await call(context("GET", "capsules/cap1/members", "owner", ownership, undefined, "ws1", ["cap1"]), route);
    expect(allowed.status).toBe(200);

    const wrongWorkspace = context("GET", "capsules/cap1/members", "owner", ownership, undefined, "ws2", ["cap1"]);
    let profileReads = 0;
    (wrongWorkspace.store as unknown as { findAccount: () => Promise<undefined> }).findAccount = async () => {
      profileReads++;
      return undefined;
    };
    const refused = await call(wrongWorkspace, route);
    expect(refused.status).toBe(403);
    expect(profileReads).toBe(0);

    const wrongApp = await call(context("GET", "capsules/cap1/members", "owner", ownership, undefined, "ws1", ["cap2"]), route);
    expect(wrongApp.status).toBe(403);
  });

  test("converted Workspace PAT cannot accept a transfer for another Workspace", async () => {
    const response = await call(context("POST", "ownership-transfers/tx1/accept", "member", port(), undefined, "ws2", ["cap1"]),
      ["ownership-transfers", "tx1", "accept"]);
    expect(response.status).toBe(403);
  });

  test("member roster hides emails from members and unverified accounts", async () => {
    const route = ["capsules", "cap1", "members"];
    const owner = await call(context("GET", "capsules/cap1/members", "owner", port()), route);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({
      owner: { accountId: "owner", displayName: "Owner", email: "owner@example.test" },
      members: [
        { accountId: "member", displayName: "Member", email: "member@example.test", status: "active" },
        { accountId: "unverified", displayName: "Unverified", status: "invited" },
      ],
    });
    const member = await call(context("GET", "capsules/cap1/members", "member", port()), route);
    expect(JSON.stringify(await member.json())).not.toContain("@example.test");
  });

  test("roster read refuses an ownership epoch change before profiles are projected", async () => {
    let accountReads = 0;
    const ownership = port({ listMembers: async () => ({
      ownerAccountId: "owner",
      ownershipEpoch: 5,
      members: [{ accountId: "member", status: "active" }],
    }) });
    const ctx = context("GET", "capsules/cap1/members", "owner", ownership);
    (ctx.store as unknown as { findAccount: () => Promise<undefined> }).findAccount = async () => {
      accountReads++;
      return undefined;
    };
    const response = await call(ctx, ["capsules", "cap1", "members"]);
    expect(response.status).toBe(409);
    expect(accountReads).toBe(0);
  });

  test("revocation during profile reads suppresses owner-only email response", async () => {
    let accessReads = 0;
    const ownership = port({ resolveAppAccess: async (_, capsuleId) => {
      accessReads++;
      return { capsuleId, role: accessReads === 1 ? "owner" : "member", ownerAccountId: "owner", ownershipEpoch: 4 };
    } });
    const response = await call(context("GET", "capsules/cap1/members", "owner", ownership), ["capsules", "cap1", "members"]);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("@example.test");
  });

  test("only owner with explicit consent may add a verified email", async () => {
    const calls: unknown[] = [];
    const ownership = port({ addMember: async (input) => {
      calls.push(input);
      return { accountId: input.accountId, status: "active" };
    } });
    const route = ["capsules", "cap1", "members"];
    const body = { email: "member@example.test", consent: "connections_and_code" };
    expect((await call(context("POST", "capsules/cap1/members", "member", ownership, body), route)).status).toBe(403);
    expect((await call(context("POST", "capsules/cap1/members", "owner", ownership, { email: body.email }), route)).status).toBe(400);
    expect((await call(context("POST", "capsules/cap1/members", "owner", ownership, { ...body, email: "unverified@example.test" }), route)).status).toBe(404);
    const accepted = await call(context("POST", "capsules/cap1/members", "owner", ownership, body), route);
    expect(accepted.status).toBe(201);
    expect(calls).toEqual([{ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 }]);
  });

  test("a member may leave but cannot remove another member", async () => {
    const calls: unknown[] = [];
    const ownership = port({ removeMember: async (input) => { calls.push(input); } });
    expect((await call(context("DELETE", "capsules/cap1/members/unverified", "member", ownership), ["capsules", "cap1", "members", "unverified"])).status).toBe(403);
    expect((await call(context("DELETE", "capsules/cap1/members/member", "member", ownership), ["capsules", "cap1", "members", "member"])).status).toBe(204);
    expect(calls).toEqual([{ capsuleId: "cap1", actorAccountId: "member", accountId: "member", expectedOwnershipEpoch: 4 }]);
  });

  test("missing management access prevents mutation calls", async () => {
    let mutations = 0;
    const ownership = port({
      addMember: async () => { mutations++; throw new Error("not reached"); },
      removeMember: async () => { mutations++; throw new Error("not reached"); },
      createTransfer: async () => { mutations++; throw new Error("not reached"); },
    });
    const attempts = [
      ["POST", "capsules/cap1/members", ["capsules", "cap1", "members"], { email: "member@example.test", consent: "connections_and_code" }],
      ["DELETE", "capsules/cap1/members/member", ["capsules", "cap1", "members", "member"], undefined],
      ["POST", "capsules/cap1/ownership-transfers", ["capsules", "cap1", "ownership-transfers"], { toAccountId: "member" }],
    ] as const;
    for (const [method, path, segments, body] of attempts) {
      const response = await call(context(method, path, "outsider", ownership, body), [...segments]);
      expect(response.status).toBe(403);
    }
    expect(mutations).toBe(0);
  });

  test("transfer creation, recipient acceptance and owner cancellation delegate to atomic port", async () => {
    const calls: unknown[] = [];
    const ownership = port({
      createTransfer: async (input) => { calls.push(["create", input]); return { transferId: "tx1", state: "pending" }; },
      acceptTransfer: async (input) => { calls.push(["accept", input]); return { transferId: "tx1", state: "accepted" }; },
      cancelTransfer: async (input) => { calls.push(["cancel", input]); },
    });
    expect((await call(context("POST", "capsules/cap1/ownership-transfers", "member", ownership, { toAccountId: "owner" }), ["capsules", "cap1", "ownership-transfers"])).status).toBe(403);
    expect((await call(context("POST", "capsules/cap1/ownership-transfers", "owner", ownership, { toAccountId: "member" }), ["capsules", "cap1", "ownership-transfers"])).status).toBe(201);
    expect((await call(context("POST", "ownership-transfers/tx1/accept", "owner", ownership), ["ownership-transfers", "tx1", "accept"])).status).toBe(403);
    expect((await call(context("POST", "ownership-transfers/tx1/accept", "member", ownership), ["ownership-transfers", "tx1", "accept"])).status).toBe(200);
    expect((await call(context("DELETE", "ownership-transfers/tx1", "owner", ownership), ["ownership-transfers", "tx1"])).status).toBe(204);
    expect(calls).toEqual([
      ["create", { capsuleId: "cap1", actorAccountId: "owner", toAccountId: "member", expectedOwnershipEpoch: 4 }],
      ["accept", { transferId: "tx1", actorAccountId: "member" }],
      ["cancel", { transferId: "tx1", actorAccountId: "owner" }],
    ]);
  });

  test("maps atomic port conflicts to the standard envelope", async () => {
    const ownership = port({ createTransfer: async () => {
      throw new AppOwnershipError("ownership_transfer_pending", "Transfer already pending.");
    } });
    const response = await call(context("POST", "capsules/cap1/ownership-transfers", "owner", ownership, { toAccountId: "member" }), ["capsules", "cap1", "ownership-transfers"]);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ownership_transfer_pending");
  });

  test("accept returns pending while the durable drain has active Runs", async () => {
    const ownership = port({ acceptTransfer: async () => ({ transferId: "tx1", state: "pending" }) });
    const response = await call(context("POST", "ownership-transfers/tx1/accept", "member", ownership), ["ownership-transfers", "tx1", "accept"]);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ownership_transfer_pending");
  });

  test("apps list is bounded and empty without access", async () => {
    const response = await call(context("GET", "apps", "owner", port()), ["apps"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apps: [] });
    expect((await call(context("GET", "apps?limit=0", "owner", port()), ["apps"])).status).toBe(400);
  });
});
