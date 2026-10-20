import { expect, test } from "bun:test";
import { createDerivedWorkspaceBillingEnrollment, workspaceBillingOrganizationRef } from "../../../../accounts/service/src/workspace-billing-organization.ts";

const authority = "takoserver.hosted.staging-test.v1";
// Independently computed: "org_wb_" + sha256(JSON.stringify([contract, authority, workspaceRef])).slice(0, 32).
const vector = { workspaceRef: "wsr_FixtureWorkspaceRef01", organizationRef: "org_wb_74aab142a9dfdb81262158d1a8e7a171" };
const intent = {
  intentId: "wbi_fixture", workspaceId: "ws_fixture", billingAuthority: authority, workspaceRef: vector.workspaceRef,
  workspaceCreatedAt: "2026-10-20T00:00:00.000Z", actorAccountId: "acct_fixture", managementEpoch: 1, createdAt: "2026-10-20T00:00:01.000Z",
};

test("the Workspace billing Organization reference matches Financial's published vectors", async () => {
  expect(await workspaceBillingOrganizationRef("takoserver.hosted.staging-test.v1", "ws_personal_01")).toBe("org_wb_66d254b5377f25b587a88e7551d7018c");
  expect(await workspaceBillingOrganizationRef("authority.synthetic", "wsr:example-1")).toBe("org_wb_472638c25c95f6bd8d64d08ab89620d9");
});

test("the Workspace billing Organization reference follows the Financial contract vector", async () => {
  expect(await workspaceBillingOrganizationRef(authority, vector.workspaceRef)).toBe(vector.organizationRef);
  expect(await workspaceBillingOrganizationRef("takoserver.hosted.other.v1", vector.workspaceRef)).not.toBe(vector.organizationRef);
});

test("derived enrollment acknowledges the exact intent the same way every time", async () => {
  const enrollment = createDerivedWorkspaceBillingEnrollment(authority);
  const first = await enrollment.ensureOrganization(intent as never);
  expect(first).toEqual({
    intentId: intent.intentId, workspaceId: intent.workspaceId, billingAuthority: authority, workspaceRef: vector.workspaceRef,
    organizationRef: vector.organizationRef, ownerAcknowledgementRef: expect.stringMatching(/^wbo_ack_[0-9a-f]{32}$/u),
  });
  expect(await enrollment.ensureOrganization(intent as never)).toEqual(first);
  expect(await enrollment.ensureOrganization({ ...intent, billingAuthority: "takoserver.hosted.other.v1" } as never)).toBeNull();
  expect(() => createDerivedWorkspaceBillingEnrollment("")).toThrow("An exact billing authority is required");
  expect(() => createDerivedWorkspaceBillingEnrollment("-leading.dash")).toThrow("An exact billing authority is required");
  for (const workspaceRef of ["_leading", "has space", "x".repeat(129), ""]) {
    expect(await enrollment.ensureOrganization({ ...intent, workspaceRef } as never)).toBeNull();
  }
});
