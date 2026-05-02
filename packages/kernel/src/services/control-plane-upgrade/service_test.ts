import assert from "node:assert/strict";
import type { TakosumiActorContext } from "takosumi-contract";
import { DomainError } from "../../shared/errors.ts";
import { ControlPlaneUpgradePlanner } from "./mod.ts";

const fixedClock = () => new Date("2026-04-27T00:00:00.000Z");

Deno.test("ControlPlaneUpgradePlanner blocks non-operator actors", () => {
  const planner = new ControlPlaneUpgradePlanner({ clock: fixedClock });

  assert.throws(
    () =>
      planner.plan({
        actor: actor(["member"]),
        targetVersion: "2026.04.27",
        backupAvailable: true,
      }),
    (error) =>
      error instanceof DomainError && error.code === "permission_denied",
  );
});

Deno.test("ControlPlaneUpgradePlanner reports preflight results and migration skeleton", () => {
  const planner = new ControlPlaneUpgradePlanner({
    idFactory: () => "upgrade_plan_1",
    clock: fixedClock,
  });

  const plan = planner.plan({
    actor: actor(["operator"]),
    currentVersion: "2026.04.26",
    targetVersion: "2026.04.27",
    backupAvailable: false,
    extraPreflightChecks: [
      {
        id: "runtime-compatibility",
        label: "Runtime compatibility checked",
        status: "warning",
        required: false,
        message:
          "Runtime rollout can continue after control-plane verification.",
      },
    ],
  });

  assert.equal(plan.id, "upgrade_plan_1");
  assert.equal(plan.kind, "control-plane-upgrade-plan");
  assert.equal(plan.ok, false);
  assert.equal(plan.backupRequired, true);
  assert.equal(plan.operation.operatorOnly, true);
  assert.equal(plan.operation.requestedAt, "2026-04-27T00:00:00.000Z");
  assert.equal(plan.operation.requestedBy.actorAccountId, "acct_operator");
  assert.deepEqual(
    plan.preflightChecks.map((
      check,
    ) => [check.id, check.status, check.required]),
    [
      ["target-version", "pass", true],
      ["backup-ready", "fail", true],
      ["migration-steps", "pass", true],
      ["runtime-compatibility", "warning", false],
    ],
  );
  assert.ok(plan.migrationSteps.some((step) => step.destructive));
  assert.ok(
    plan.rollbackNotes.some((note) =>
      note.stepId === "apply-control-plane-migrations"
    ),
  );

  const migration = planner.createMigration(plan);
  assert.equal(migration.kind, "control-plane-migration");
  assert.equal(migration.planId, plan.id);
  assert.equal(migration.status, "planned");
  assert.equal(migration.backupRequired, true);
  assert.deepEqual(migration.steps, plan.migrationSteps);
});

function actor(roles: string[]): TakosumiActorContext {
  return {
    actorAccountId: roles.includes("operator") ? "acct_operator" : "acct_user",
    roles,
    requestId: "req_1",
  };
}
