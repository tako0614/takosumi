import assert from "node:assert/strict";
import type { TakosumiActorContext } from "takosumi-contract";
import {
  createCoreDomainServices,
  createInMemoryCoreDomainDependencies,
} from "./services.ts";

Deno.test("core creates a space, grants owner membership, and permits owner group creation", async () => {
  const deps = createInMemoryCoreDomainDependencies({
    clock: { now: () => new Date("2026-04-27T00:00:00.000Z") },
    idGenerator: { create: (prefix) => `${prefix}_test` },
  });
  const services = createCoreDomainServices(deps);
  const actor = actorContext("acct_owner", "req_owner");

  const createdSpace = await services.spaces.createSpace({
    actor,
    spaceId: "space_core",
    name: "  Core Space  ",
    metadata: { purpose: "unit-test" },
  });

  assert.equal(createdSpace.ok, true);
  if (!createdSpace.ok) throw new Error("space creation failed");
  assert.equal(createdSpace.value.name, "Core Space");
  assert.equal(createdSpace.value.createdByAccountId, "acct_owner");

  const ownerMembership = await deps.memberships.get(
    "space_core",
    "acct_owner",
  );
  assert.deepEqual(ownerMembership?.roles, ["owner"]);
  assert.equal(ownerMembership?.status, "active");

  const group = await services.groups.createGroup({
    actor,
    spaceId: "space_core",
    groupId: "group_core",
    slug: "Web-App",
    displayName: " Web App ",
  });

  assert.equal(group.ok, true);
  if (!group.ok) throw new Error("group creation failed");
  assert.equal(group.value.slug, "web-app");
  assert.equal(group.value.displayName, "Web App");

  assert.deepEqual(
    (await services.groupQueries.listGroups({ actor, spaceId: "space_core" }))
      .map((item) => item.id),
    ["group_core"],
  );

  const entitlement = await services.memberships.checkEntitlement({
    actor,
    spaceId: "space_core",
    key: "groups.manage",
  });
  assert.deepEqual(entitlement, {
    allowed: true,
    key: "groups.manage",
    reason: "owner/admin role grants entitlement",
  });
});

Deno.test("core denies group creation and entitlement for non-admin members", async () => {
  const deps = createInMemoryCoreDomainDependencies({
    clock: { now: () => new Date("2026-04-27T00:00:00.000Z") },
    idGenerator: { create: (prefix) => `${prefix}_${crypto.randomUUID()}` },
  });
  const services = createCoreDomainServices(deps);
  const owner = actorContext("acct_owner", "req_owner");
  const member = actorContext("acct_member", "req_member");

  const space = await services.spaces.createSpace({
    actor: owner,
    spaceId: "space_permissions",
    name: "Permissions",
  });
  assert.equal(space.ok, true);

  const membership = await services.memberships.upsertSpaceMembership({
    actor: owner,
    spaceId: "space_permissions",
    accountId: "acct_member",
    roles: ["member"],
    status: "active",
  });
  assert.equal(membership.ok, true);

  const deniedGroup = await services.groups.createGroup({
    actor: member,
    spaceId: "space_permissions",
    groupId: "group_denied",
    slug: "denied",
  });
  assert.equal(deniedGroup.ok, false);
  if (deniedGroup.ok) throw new Error("group creation unexpectedly succeeded");
  assert.equal(deniedGroup.error.code, "permission_denied");

  const entitlement = await services.memberships.checkEntitlement({
    actor: member,
    spaceId: "space_permissions",
    key: "groups.manage",
  });
  assert.deepEqual(entitlement, {
    allowed: false,
    key: "groups.manage",
    reason: "entitlement requires owner/admin role",
  });
});

function actorContext(
  actorAccountId: string,
  requestId: string,
): TakosumiActorContext {
  return {
    actorAccountId,
    roles: ["owner"],
    requestId,
    principalKind: "account",
  };
}
