/**
 * End-to-end test for the membership control facade through the REAL membership
 * domain (`createMembershipDomainServices`), not the in-memory roster fake the
 * accounts-service control-routes test uses.
 *
 * It drives the account-plane `/v1/control/spaces/:id/members` surface
 * (`handleControlRoute`) against a `ControlPlaneOperations` whose `members` is
 * `createMembershipControlFacade` over the real
 * `MembershipRoleEntitlementService`. This proves the two preconditions that the
 * route layer's implicit-owner projection alone could NOT satisfy
 * (`requireMembershipSpace` + `canManageSpace`) are bridged, so a brand-new
 * Space's owner can bootstrap the first member and add/role-change/remove all
 * succeed — and that the access-control gates still hold on the real path.
 */

import { expect, test } from "bun:test";

import { InMemoryAccountsStore } from "@takosjp/takosumi-accounts-service";
// `handleControlRoute` is the account-plane control surface entry. It is not on
// the package barrel (the public entry is the composed accounts handler), so the
// test reaches it through its source module — the same allowed direction the
// host worker wiring uses (src/service consumes packages/, never the reverse).
import {
  type ControlPlaneOperations,
  handleControlRoute,
} from "../../../../packages/accounts-service/src/control-routes.ts";
import type { Space } from "takosumi-contract/spaces";

import {
  createInMemoryMembershipDomainDependencies,
  createMembershipDomainServices,
} from "./mod.ts";
import { createMembershipControlFacade } from "./control_facade.ts";

const ORIGIN = "https://app.takosumi.test";

interface Harness {
  readonly store: InMemoryAccountsStore;
  readonly operations: ControlPlaneOperations;
  readonly call: (
    method: string,
    path: string,
    options?: { subject?: string; body?: unknown },
  ) => Promise<{ status: number; body: any }>;
}

/**
 * Builds a control surface backed by the REAL membership domain. `spaceOwner` is
 * the namespace owner (`Space.ownerUserId`); the namespace gate passes when the
 * session subject equals it (or owns the accounts-ledger account — not used
 * here). `getSpace` returns a Core-Spec Space; the membership domain starts EMPTY
 * (no MembershipSpace row, no ledger), exactly as a freshly created Space.
 */
function harness(options: { spaceId: string; spaceOwner: string }): Harness {
  const store = new InMemoryAccountsStore();
  const space = (id: string): Space => ({
    id,
    handle: "team",
    displayName: "Team",
    type: "personal",
    ownerUserId: options.spaceOwner,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  // Build the membership services and the facade over the SAME raw stores so the
  // facade's bootstrap writes are visible to the services' gate reads.
  const deps = createInMemoryMembershipDomainDependencies();
  const realMembership = createMembershipDomainServices(deps);
  const members = createMembershipControlFacade({
    membership: realMembership,
    membershipSpaceStore: deps.spaces,
    membershipLedgerStore: deps.memberships,
    resolveSpace: async (spaceId) => {
      const s = space(spaceId);
      return {
        ownerUserId: s.ownerUserId,
        displayName: s.displayName,
        handle: s.handle,
      };
    },
  });

  const operations = {
    spaces: {
      listSpaces: async () => [space(options.spaceId)],
      getSpace: async (id: string) => space(id),
      createSpace: async () => space(options.spaceId),
      updateSpace: async (id: string) => space(id),
    },
    members,
  } as unknown as ControlPlaneOperations;

  let sessionSeq = 0;
  const ensureSession = (subject: string): string => {
    const now = Date.now();
    store.saveAccount({ subject, createdAt: now, updatedAt: now });
    const sessionId = `sess_${subject}_${sessionSeq++}`;
    store.saveAccountSession({
      sessionId,
      subject,
      createdAt: now,
      expiresAt: now + 60_000,
    });
    return sessionId;
  };

  const call = async (
    method: string,
    path: string,
    callOptions: { subject?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (callOptions.subject) {
      headers.authorization = `Bearer ${ensureSession(callOptions.subject)}`;
    }
    if (callOptions.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const url = new URL(`${ORIGIN}${path}`);
    const response = await handleControlRoute({
      request: new Request(url, {
        method,
        headers,
        ...(callOptions.body !== undefined
          ? { body: JSON.stringify(callOptions.body) }
          : {}),
      }),
      url,
      store,
      operations,
    });
    if (!response) throw new Error(`route not owned: ${path}`);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
    };
  };

  return { store, operations, call };
}

const OWNER = "tsub_owner";
const SPACE = "space_real";

test("real path: owner bootstraps the first member on a brand-new Space", async () => {
  const h = harness({ spaceId: SPACE, spaceOwner: OWNER });

  // Pre-bootstrap, the ledger is EMPTY but the list still shows the implicit
  // owner (route projection), so the owner is not locked out.
  const list0 = await h.call("GET", `/v1/control/spaces/${SPACE}/members`, {
    subject: OWNER,
  });
  expect(list0.status).toEqual(200);
  expect(list0.body.members).toHaveLength(1);
  expect(list0.body.members[0].accountId).toEqual(OWNER);
  expect(list0.body.members[0].roles).toEqual(["owner"]);

  // The owner's FIRST add must SUCCEED on the real path (this is exactly the
  // case that previously 404'd then 403'd through the real domain).
  const add = await h.call("POST", `/v1/control/spaces/${SPACE}/members`, {
    subject: OWNER,
    body: { accountId: "tsub_alice", role: "member" },
  });
  expect(add.status).toEqual(201);
  expect(add.body.member.accountId).toEqual("tsub_alice");
  expect(add.body.member.roles).toEqual(["member"]);
  expect(add.body.member.status).toEqual("active");

  // The persisted roster now contains a CONCRETE owner row (seeded by the
  // bootstrap bridge) plus the new member — proving the real ledger was written.
  const list1 = await h.call("GET", `/v1/control/spaces/${SPACE}/members`, {
    subject: OWNER,
  });
  const accounts = list1.body.members.map((m: any) => m.accountId).sort();
  expect(accounts).toEqual(["tsub_alice", OWNER].sort());
  const ownerRow = list1.body.members.find((m: any) => m.accountId === OWNER);
  expect(ownerRow.id.startsWith("implicit-owner:")).toEqual(false);
  expect(ownerRow.roles).toEqual(["owner"]);
});

test("real path: add then role-change then remove all succeed", async () => {
  const h = harness({ spaceId: SPACE, spaceOwner: OWNER });

  expect(
    (
      await h.call("POST", `/v1/control/spaces/${SPACE}/members`, {
        subject: OWNER,
        body: { accountId: "tsub_bob", role: "member" },
      })
    ).status,
  ).toEqual(201);

  const promote = await h.call(
    "PATCH",
    `/v1/control/spaces/${SPACE}/members/tsub_bob`,
    { subject: OWNER, body: { roles: ["admin"] } },
  );
  expect(promote.status).toEqual(200);
  expect(promote.body.member.roles).toEqual(["admin"]);

  const remove = await h.call(
    "DELETE",
    `/v1/control/spaces/${SPACE}/members/tsub_bob`,
    { subject: OWNER },
  );
  expect(remove.status).toEqual(200);
  expect(remove.body.member.status).toEqual("suspended");

  // A suspended member no longer appears as active in the roster's active set.
  const list = await h.call("GET", `/v1/control/spaces/${SPACE}/members`, {
    subject: OWNER,
  });
  const bob = list.body.members.find((m: any) => m.accountId === "tsub_bob");
  expect(bob.status).toEqual("suspended");
});

test("access control: a non-owner non-member cannot mutate on the real path", async () => {
  const h = harness({ spaceId: SPACE, spaceOwner: OWNER });

  // Owner seeds a plain member first (so the member has an account/session).
  await h.call("POST", `/v1/control/spaces/${SPACE}/members`, {
    subject: OWNER,
    body: { accountId: "tsub_carol", role: "member" },
  });

  // A plain member (carol) is NOT owner/admin: the route role-gate rejects an
  // add. The namespace gate would already reject a true stranger; carol passes
  // the namespace check only if she owns the space — she does not — so this is a
  // 403 from the namespace gate OR the role gate. Either way: not 2xx.
  const memberAdd = await h.call(
    "POST",
    `/v1/control/spaces/${SPACE}/members`,
    { subject: "tsub_carol", body: { accountId: "tsub_dave", role: "member" } },
  );
  expect(memberAdd.status).toEqual(403);
});

test("access control: last-owner cannot be demoted or removed on the real path", async () => {
  const h = harness({ spaceId: SPACE, spaceOwner: OWNER });

  // Bootstrap by adding a member so the owner row is persisted.
  await h.call("POST", `/v1/control/spaces/${SPACE}/members`, {
    subject: OWNER,
    body: { accountId: "tsub_eve", role: "member" },
  });

  // The owner is the SOLE owner: demoting self must be rejected.
  const demote = await h.call(
    "PATCH",
    `/v1/control/spaces/${SPACE}/members/${OWNER}`,
    { subject: OWNER, body: { roles: ["member"] } },
  );
  expect(demote.status).toEqual(403);
  expect(demote.body.error_description).toContain("last owner");

  // Removing the sole owner must be rejected too.
  const remove = await h.call(
    "DELETE",
    `/v1/control/spaces/${SPACE}/members/${OWNER}`,
    { subject: OWNER },
  );
  expect(remove.status).toEqual(403);
  expect(remove.body.error_description).toContain("last owner");
});

test("access control: spaceId is server-resolved, not taken from the body", async () => {
  const h = harness({ spaceId: SPACE, spaceOwner: OWNER });

  // Even if the client tries to smuggle a different spaceId in the body, the
  // route uses the PATH spaceId (server-resolved). The added member lands in
  // SPACE, never in the smuggled one.
  const add = await h.call("POST", `/v1/control/spaces/${SPACE}/members`, {
    subject: OWNER,
    body: { accountId: "tsub_frank", role: "member", spaceId: "space_other" },
  });
  expect(add.status).toEqual(201);
  expect(add.body.member.spaceId).toEqual(SPACE);
});

test("access control: role injection is rejected (unknown role -> 400)", async () => {
  const h = harness({ spaceId: SPACE, spaceOwner: OWNER });
  const add = await h.call("POST", `/v1/control/spaces/${SPACE}/members`, {
    subject: OWNER,
    body: { accountId: "tsub_grace", role: "superadmin" },
  });
  expect(add.status).toEqual(400);
});
