import assert from "node:assert/strict";
import {
  type CoreRole,
  InMemorySpaceMembershipStore,
} from "../../domains/core/mod.ts";
import { DomainError } from "../../shared/errors.ts";
import { EntitlementPolicyService } from "./mod.ts";

Deno.test("EntitlementPolicyService grants owner full mutation capabilities", async () => {
  const service = await serviceForRole("owner");

  const effective = await service.getEffectiveEntitlements({
    spaceId: "space_a",
    groupId: "group_a",
    accountId: "acct_owner",
  });
  assert.ok(effective);
  assert.equal(effective.limits.deploysPerDay, 1000);
  assert.ok(effective.capabilities.includes("deploy.apply"));
  assert.ok(effective.capabilities.includes("resource.restore"));
  assert.ok(effective.capabilities.includes("runtime-agent.revoke"));

  const decision = await service.decideMutationBoundary({
    spaceId: "space_a",
    groupId: "group_a",
    accountId: "acct_owner",
    operation: "runtime-agent.revoke",
  });
  assert.equal(decision.allowed, true);
});

Deno.test("EntitlementPolicyService grants admin deploy/resource/runtime-agent mutations except revoke", async () => {
  const service = await serviceForRole("admin");

  assert.equal(
    (await service.decideMutationBoundary({
      spaceId: "space_a",
      accountId: "acct_admin",
      operation: "deploy.apply",
    })).allowed,
    true,
  );
  assert.equal(
    (await service.decideMutationBoundary({
      spaceId: "space_a",
      accountId: "acct_admin",
      operation: "resource.create",
    })).allowed,
    true,
  );
  assert.equal(
    (await service.decideMutationBoundary({
      spaceId: "space_a",
      accountId: "acct_admin",
      operation: "runtime-agent.enqueue",
    })).allowed,
    true,
  );
  assert.equal(
    (await service.decideMutationBoundary({
      spaceId: "space_a",
      accountId: "acct_admin",
      operation: "runtime-agent.revoke",
    })).allowed,
    false,
  );
});

Deno.test("EntitlementPolicyService limits member to non-mutating plan/read capability", async () => {
  const service = await serviceForRole("member");

  const plan = await service.decideMutationBoundary({
    spaceId: "space_a",
    groupId: "group_a",
    accountId: "acct_member",
    operation: "deploy.plan",
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.entitlements?.limits.deploysPerDay, 25);

  const apply = await service.decideMutationBoundary({
    spaceId: "space_a",
    groupId: "group_a",
    accountId: "acct_member",
    operation: "deploy.apply",
  });
  assert.equal(apply.allowed, false);
  assert.equal(apply.reason, "missing capability: deploy.apply");

  await assert.rejects(
    () =>
      service.requireMutationBoundary({
        spaceId: "space_a",
        groupId: "group_a",
        accountId: "acct_member",
        operation: "resource.create",
      }),
    (error) =>
      error instanceof DomainError && error.code === "permission_denied",
  );
});

Deno.test("EntitlementPolicyService keeps viewer read-only", async () => {
  const service = await serviceForRole("viewer");

  const effective = await service.getEffectiveEntitlements({
    spaceId: "space_a",
    accountId: "acct_viewer",
  });
  assert.deepEqual(effective?.roles, ["viewer"]);
  assert.deepEqual(effective?.capabilities, [
    "deploy.read",
    "resource.read",
    "runtime-agent.read",
    "runtime.read",
  ]);

  const decision = await service.decideMutationBoundary({
    spaceId: "space_a",
    accountId: "acct_viewer",
    operation: "resource.migrate",
  });
  assert.equal(decision.allowed, false);
});

Deno.test("EntitlementPolicyService applies space and group policy overlays", async () => {
  const stores = new InMemorySpaceMembershipStore();
  await putMembership(stores, "member");
  const service = new EntitlementPolicyService({
    memberships: stores,
    policy: {
      spaces: {
        space_a: {
          limits: { deploysPerDay: 40 },
          addCapabilities: ["resource.create"],
        },
      },
      groups: {
        "space_a:restricted": {
          removeCapabilities: ["deploy.plan"],
          limits: { resourceInstances: 3 },
        },
      },
    },
  });

  const effective = await service.getEffectiveEntitlements({
    spaceId: "space_a",
    groupId: "restricted",
    accountId: "acct_member",
  });

  assert.ok(effective?.capabilities.includes("resource.create"));
  assert.ok(!effective?.capabilities.includes("deploy.plan"));
  assert.equal(effective?.limits.deploysPerDay, 40);
  assert.equal(effective?.limits.resourceInstances, 3);
});

async function serviceForRole(
  role: CoreRole,
): Promise<EntitlementPolicyService> {
  const stores = new InMemorySpaceMembershipStore();
  await putMembership(stores, role);
  return new EntitlementPolicyService({ memberships: stores });
}

async function putMembership(
  stores: InMemorySpaceMembershipStore,
  role: CoreRole,
): Promise<void> {
  await stores.upsert({
    id: `membership_${role}`,
    spaceId: "space_a",
    accountId: `acct_${role}`,
    roles: [role],
    status: "active",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  });
}
