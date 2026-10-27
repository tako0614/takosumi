/**
 * Member list profile projection (`GET /api/v1/workspaces/:id/members`).
 *
 * Every member who may read the roster sees each member's display name. Only
 * an active owner or admin of the Workspace sees member email addresses; a
 * member or viewer never receives another member's address.
 */
import { expect, test } from "bun:test";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

type Role = "owner" | "admin" | "member" | "viewer";

const WORKSPACE = {
  id: "ws_members",
  handle: "members",
  displayName: "Members",
  type: "organization" as const,
  ownerUserId: "tsub_owner",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function member(accountId: string, role: Role, status = "active") {
  return {
    id: `wsm_${accountId}`,
    workspaceId: WORKSPACE.id,
    accountId,
    roles: [role],
    status,
    createdAt: WORKSPACE.createdAt,
    updatedAt: WORKSPACE.updatedAt,
  };
}

function seededStore(callerSubject: string): {
  readonly store: InMemoryAccountsStore;
  readonly token: string;
} {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const accounts = [
    {
      subject: "tsub_owner",
      displayName: "Owner Person",
      email: "owner@example.test",
      emailVerified: true,
    },
    {
      subject: "tsub_admin",
      displayName: "Admin Person",
      email: "admin@example.test",
      emailVerified: true,
    },
    {
      subject: "tsub_member",
      displayName: "  Member Person  ",
      email: "member@example.test",
    },
    {
      subject: "tsub_viewer",
      displayName: "Viewer Person",
      email: "viewer@example.test",
      emailVerified: true,
    },
    {
      subject: "tsub_unverified",
      displayName: "Unverified Person",
      email: "unverified@example.test",
      emailVerified: false,
    },
    // tsub_noprofile intentionally has no account record.
  ];
  for (const account of accounts) {
    store.saveAccount({ ...account, createdAt: now, updatedAt: now } as never);
  }
  const token = `sess_${callerSubject}`;
  store.saveAccountSession({
    sessionId: token,
    subject: callerSubject,
    createdAt: now,
    expiresAt: now + 60_000,
  } as never);
  return { store, token };
}

const ROSTER = [
  member("tsub_owner", "owner"),
  member("tsub_admin", "admin"),
  member("tsub_member", "member"),
  member("tsub_viewer", "viewer"),
  member("tsub_unverified", "member"),
  member("tsub_noprofile", "member"),
];

function operations(roster: readonly ReturnType<typeof member>[]) {
  return {
    workspaces: {
      getWorkspace: async () => WORKSPACE,
      listWorkspacesForAccount: async () => [WORKSPACE],
    },
    members: {
      listMembers: async () => roster,
      getMember: async (_workspaceId: string, accountId: string) =>
        roster.find((row) => row.accountId === accountId),
    },
  } as unknown as ControlPlaneOperations;
}

async function listAs(
  callerSubject: string,
  roster: readonly ReturnType<typeof member>[] = ROSTER,
): Promise<{
  readonly status: number;
  readonly members: readonly Record<string, unknown>[];
}> {
  const { store, token } = seededStore(callerSubject);
  const url = new URL(
    `https://app.example.test/api/v1/workspaces/${WORKSPACE.id}/members`,
  );
  const response = await handleControlRoute({
    request: new Request(url, {
      headers: { authorization: `Bearer ${token}` },
    }),
    url,
    store,
    operations: operations(roster),
  });
  expect(response).toBeDefined();
  const body = (await response!.json()) as {
    readonly members?: readonly Record<string, unknown>[];
  };
  return { status: response!.status, members: body.members ?? [] };
}

function byAccount(
  members: readonly Record<string, unknown>[],
  accountId: string,
): Record<string, unknown> | undefined {
  return members.find((row) => row.accountId === accountId);
}

for (const role of ["owner", "admin"] as const) {
  test(`an active ${role} reads member display names and verified emails`, async () => {
    const { status, members } = await listAs(`tsub_${role}`);
    expect(status).toBe(200);
    expect(byAccount(members, "tsub_owner")).toMatchObject({
      displayName: "Owner Person",
      email: "owner@example.test",
    });
    expect(byAccount(members, "tsub_viewer")).toMatchObject({
      displayName: "Viewer Person",
      email: "viewer@example.test",
    });
    // Unknown verification still shows; trimmed names never carry padding.
    expect(byAccount(members, "tsub_member")).toMatchObject({
      displayName: "Member Person",
      email: "member@example.test",
    });
    // An address the identity provider marked unverified is never shown.
    const unverified = byAccount(members, "tsub_unverified");
    expect(unverified?.displayName).toBe("Unverified Person");
    expect(unverified).not.toHaveProperty("email");
    // No account profile: the row keeps only membership fields.
    const noProfile = byAccount(members, "tsub_noprofile");
    expect(noProfile).not.toHaveProperty("displayName");
    expect(noProfile).not.toHaveProperty("email");
  });
}

for (const role of ["member", "viewer"] as const) {
  test(`a ${role} reads display names but cannot read any member email`, async () => {
    const { status, members } = await listAs(`tsub_${role}`);
    expect(status).toBe(200);
    expect(members).toHaveLength(ROSTER.length);
    expect(byAccount(members, "tsub_owner")?.displayName).toBe("Owner Person");
    expect(byAccount(members, "tsub_admin")?.displayName).toBe("Admin Person");
    for (const row of members) {
      expect(row).not.toHaveProperty("email");
    }
    expect(JSON.stringify(members)).not.toContain("@example.test");
  });
}

test("a suspended admin cannot read the roster or its emails", async () => {
  const roster = [
    member("tsub_owner", "owner"),
    member("tsub_admin", "admin", "suspended"),
    member("tsub_member", "member"),
  ];
  const { status, members } = await listAs("tsub_admin", roster);
  expect(status).toBe(403);
  expect(members).toEqual([]);
});

test("the namespace owner without a durable row still reads emails", async () => {
  // A creation/repair race can leave the namespace owner's member row
  // missing; ordinary sessions keep the owner's role view for the roster.
  const roster = [member("tsub_member", "member")];
  const { status, members } = await listAs("tsub_owner", roster);
  expect(status).toBe(200);
  expect(byAccount(members, "tsub_member")).toMatchObject({
    displayName: "Member Person",
    email: "member@example.test",
  });
});

test("the member list returns no profile fields beyond name and email", async () => {
  const { members } = await listAs("tsub_owner");
  const allowed = new Set([
    "id",
    "workspaceId",
    "accountId",
    "roles",
    "status",
    "createdAt",
    "updatedAt",
    "displayName",
    "email",
  ]);
  for (const row of members) {
    for (const key of Object.keys(row)) {
      expect({ key, allowed: allowed.has(key) }).toEqual({ key, allowed: true });
    }
  }
});
