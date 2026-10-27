import { describe, expect, test } from "bun:test";
import { locale, setLocale, t } from "../../../../dashboard/src/i18n/index.ts";
import type { RunPlanResource } from "../../../../dashboard/src/lib/control-api.ts";
import {
  isActionablePlanResource,
  planResourceActionKind,
  planResourceActionLabel,
  planResourceDisplayLabel,
  planResourceScopeLabel,
  planResourceTone,
  reviewablePlanResources,
} from "../../../../dashboard/src/lib/run-plan-resources.ts";

function resource(
  address: string,
  actions: readonly string[],
  type = "cloudflare_workers_script",
): RunPlanResource {
  return { address, type, actions };
}

describe("plan resource classification", () => {
  test("a delete + create pair is a replace in either order", () => {
    for (const actions of [["delete", "create"], ["create", "delete"]]) {
      const row = resource("a", actions);
      expect(planResourceActionKind(row)).toBe("replace");
      expect(planResourceTone(row)).toBe("danger");
    }
  });

  test("keeps the tone each action had in the Run review", () => {
    expect(planResourceTone(resource("a", ["delete"]))).toBe("danger");
    expect(planResourceTone(resource("a", ["update"]))).toBe("warn");
    expect(planResourceTone(resource("a", ["create"]))).toBe("ok");
    expect(planResourceTone(resource("a", ["read"]))).toBe("muted");
  });

  test("labels each action and falls back to the raw action list", () => {
    const previousLocale = locale();
    try {
      setLocale("en");
      expect(planResourceActionLabel(resource("a", ["create", "delete"]))).toBe(
        t("run.resources.actionReplace"),
      );
      expect(planResourceActionLabel(resource("a", ["delete"]))).toBe(
        t("run.resources.actionDelete"),
      );
      expect(planResourceActionLabel(resource("a", ["update"]))).toBe(
        t("run.resources.actionUpdate"),
      );
      expect(planResourceActionLabel(resource("a", ["create"]))).toBe(
        t("run.resources.actionCreate"),
      );
      expect(planResourceActionLabel(resource("a", ["read"]))).toBe("read");
      expect(planResourceActionLabel(resource("a", []))).toBe(
        t("common.unknown"),
      );
    } finally {
      setLocale(previousLocale);
    }
  });

  test("no-op rows are not actionable", () => {
    expect(isActionablePlanResource(resource("a", ["no-op"]))).toBe(false);
    expect(isActionablePlanResource(resource("a", ["update"]))).toBe(true);
  });
});

describe("plan resource display", () => {
  test("turns the resource type tail into a readable label", () => {
    expect(planResourceDisplayLabel(resource("a", ["create"]))).toBe(
      "Cloudflare Workers Script",
    );
    expect(
      planResourceDisplayLabel(resource("module.app.x", ["create"], "")),
    ).toBe("module.app.x");
  });

  test("renders scope facts in a stable order", () => {
    expect(
      planResourceScopeLabel({ facts: { zone: "example.com", account: "a1" } }),
    ).toBe("account: a1 / zone: example.com");
    expect(planResourceScopeLabel({ facts: {} })).toBeUndefined();
    expect(planResourceScopeLabel(undefined)).toBeUndefined();
  });
});

describe("reviewablePlanResources", () => {
  const rows = [
    resource("delete-1", ["delete"]),
    resource("noop", ["no-op"]),
    resource("create-1", ["create"]),
    resource("replace-1", ["delete", "create"]),
    resource("update-1", ["update"]),
    resource("create-2", ["create"]),
  ];

  test("keeps plan order and drops no-op rows by default", () => {
    expect(reviewablePlanResources(rows).map((row) => row.address)).toEqual([
      "delete-1",
      "create-1",
      "replace-1",
      "update-1",
      "create-2",
    ]);
  });

  test("optionally orders by action, keeping plan order within each", () => {
    expect(
      reviewablePlanResources(rows, { sortByAction: true }).map(
        (row) => row.address,
      ),
    ).toEqual(["create-1", "create-2", "update-1", "replace-1", "delete-1"]);
    // The caller's array is never reordered.
    expect(rows[0]?.address).toBe("delete-1");
  });
});
