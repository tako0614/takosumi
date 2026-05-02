import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  ApprovalService,
  InMemoryApprovalStore,
  subjectDigest,
} from "./mod.ts";

const actor = { accountId: "acct_member", roles: ["member"] as const };
const owner = { accountId: "acct_owner", roles: ["owner"] as const };

Deno.test("subjectDigest is stable for object key order", async () => {
  assertEquals(
    await subjectDigest({ b: 2, a: { d: 4, c: 3 } }),
    await subjectDigest({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

Deno.test("ApprovalService invalidates stored approval when subject digest changes", async () => {
  const store = new InMemoryApprovalStore();
  const service = new ApprovalService({
    store,
    idFactory: () => "approval_1",
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
  });

  const approval = await service.recordManualApproval({
    spaceId: "space_a",
    groupId: "group_a",
    operation: "deploy.apply",
    subjectId: "plan_1",
    subject: { image: "app:v1", env: { A: "1" } },
    actor: owner,
  });

  assertEquals(approval.status, "valid");

  const changed = await service.checkApplyGate({
    spaceId: "space_a",
    groupId: "group_a",
    subjectId: "plan_1",
    subject: { image: "app:v2", env: { A: "1" } },
    actor,
    requirement: { manual: true },
    checkedAt: "2026-04-27T00:01:00.000Z",
  });

  assertEquals(changed.allowed, false);
  assertEquals(changed.reason, "manual approval required");
  const stored = await store.get("approval_1");
  assertEquals(stored?.status, "invalidated");
  assertEquals(stored?.invalidationReason, "subject-digest-changed");
});

Deno.test("ApprovalService accepts manual approval for matching plan subject", async () => {
  const service = new ApprovalService({ idFactory: () => "approval_1" });
  const subject = { resources: [{ type: "kv", name: "cache" }] };

  await service.recordManualApproval({
    spaceId: "space_a",
    operation: "deploy.plan",
    subjectId: "plan_1",
    subject,
    actor: owner,
  });

  const decision = await service.checkPlanGate({
    spaceId: "space_a",
    subjectId: "plan_1",
    subject,
    actor,
    requirement: { manual: true },
  });

  assertEquals(decision.allowed, true);
  assertEquals(decision.reason, "manual approval valid");
  assertEquals(decision.approval?.kind, "manual");
});

Deno.test("ApprovalService checks role gates for apply", async () => {
  const service = new ApprovalService({ idFactory: () => "approval_1" });
  const subject = { activation: "act_1" };

  const denied = await service.checkApplyGate({
    spaceId: "space_a",
    subjectId: "plan_1",
    subject,
    actor,
    requirement: { roles: ["owner"] },
  });
  assertEquals(denied.allowed, false);
  assertEquals(denied.missingRoles, ["owner"]);

  const allowed = await service.checkApplyGate({
    spaceId: "space_a",
    subjectId: "plan_1",
    subject,
    actor: owner,
    requirement: { roles: ["owner"] },
  });
  assertEquals(allowed.allowed, true);
  assertEquals(allowed.reason, "actor role satisfies approval gate");

  await assertRejects(
    () =>
      service.recordRoleApproval({
        spaceId: "space_a",
        operation: "deploy.apply",
        subjectId: "plan_1",
        subject,
        actor,
        requiredRoles: ["owner"],
      }),
    TypeError,
    "actor is missing approval role: owner",
  );

  await service.recordRoleApproval({
    spaceId: "space_a",
    operation: "deploy.apply",
    subjectId: "plan_1",
    subject,
    actor: owner,
    requiredRoles: ["owner"],
  });

  const storedApprovalAllows = await service.checkApplyGate({
    spaceId: "space_a",
    subjectId: "plan_1",
    subject,
    actor,
    requirement: { roles: ["owner"] },
  });
  assert(storedApprovalAllows.allowed);
  assertEquals(storedApprovalAllows.reason, "stored role approval valid");
});
