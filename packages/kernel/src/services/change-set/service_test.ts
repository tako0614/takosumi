import assert from "node:assert/strict";
import { DomainError } from "../../shared/errors.ts";
import { buildChangeSetPartialSuccessResult, ChangeSetPlanner } from "./mod.ts";

Deno.test("change-set planner orders groups before publication/event/resource changes", () => {
  const plan = new ChangeSetPlanner().plan({
    id: "plan-ordering",
    changes: [
      change({ id: "event-consumer", kind: "event", groupId: "api" }),
      change({ id: "group-api", kind: "group", groupId: "api" }),
      change({
        id: "resource-db",
        kind: "resource",
        groupId: "api",
        dependsOn: ["publication-api"],
      }),
      change({ id: "publication-api", kind: "publication", groupId: "api" }),
    ],
  });

  assert.deepEqual(plan.topologicalOrder, [
    "group-api",
    "event-consumer",
    "publication-api",
    "resource-db",
  ]);
  assert.equal(plan.executionSemantics.distributedTransaction, false);
  assert.equal(plan.executionSemantics.atomic, false);
  assert.equal(
    plan.executionSemantics.failureMode,
    "failed-change-blocks-dependents-only",
  );
  assert.deepEqual(
    plan.nodes.find((node) => node.change.id === "resource-db")?.dependencies,
    ["group-api", "publication-api"],
  );
});

Deno.test("change-set planner blocks dependency cycles", () => {
  assert.throws(
    () =>
      new ChangeSetPlanner().plan({
        changes: [
          change({
            id: "publication-api",
            kind: "publication",
            dependsOn: ["event-api"],
          }),
          change({
            id: "event-api",
            kind: "event",
            dependsOn: ["publication-api"],
          }),
        ],
      }),
    (error) => isDomainConflict(error, "Change-set dependency cycle detected"),
  );
});

Deno.test("change-set partial success result keeps succeeded changes and skips dependents", () => {
  const planner = new ChangeSetPlanner();
  const plan = planner.plan({
    id: "plan-partial",
    changes: [
      change({ id: "group-api", kind: "group", groupId: "api" }),
      change({ id: "publication-api", kind: "publication", groupId: "api" }),
      change({
        id: "event-api",
        kind: "event",
        groupId: "api",
        dependsOn: ["publication-api"],
      }),
      change({ id: "resource-cache", kind: "resource" }),
    ],
  });

  const result = buildChangeSetPartialSuccessResult(plan, [
    { changeId: "group-api", status: "succeeded" },
    {
      changeId: "publication-api",
      status: "failed",
      message: "contract rejected",
    },
    { changeId: "resource-cache", status: "succeeded" },
  ]);

  assert.equal(result.distributedTransaction, false);
  assert.equal(result.status, "partial_success");
  assert.deepEqual(result.summary, {
    succeeded: 2,
    failed: 1,
    skipped: 1,
    pending: 0,
  });
  assert.deepEqual(
    result.changes.map((
      entry,
    ) => [entry.changeId, entry.status, entry.blockedBy]),
    [
      ["group-api", "succeeded", []],
      ["publication-api", "failed", []],
      ["event-api", "skipped", ["publication-api"]],
      ["resource-cache", "succeeded", []],
    ],
  );
});

function change(
  overrides: {
    readonly id: string;
    readonly kind: "group" | "publication" | "event" | "resource";
    readonly groupId?: string;
    readonly dependsOn?: readonly string[];
  },
) {
  return {
    operation: "update" as const,
    ...overrides,
  };
}

function isDomainConflict(error: unknown, messageIncludes: string): boolean {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "conflict");
  assert.match(error.message, new RegExp(messageIncludes));
  return true;
}
