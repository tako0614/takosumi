import { describe, expect, test } from "bun:test";
import { en } from "../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../dashboard/src/i18n/ja.ts";
import { ControlApiError } from "../../../../dashboard/src/lib/control-api.ts";
import { friendlyError } from "../../../../dashboard/src/lib/error-copy.ts";

describe("friendlyError plan deadline copy", () => {
  const timeoutCodes = [
    "install_plan_reconcile_timeout",
    "revision_plan_reconcile_timeout",
  ] as const;

  for (const code of timeoutCodes) {
    test(`${code} explains the request may still be running in Japanese`, () => {
      const error = new ControlApiError(
        504,
        code,
        "The plan did not become reviewable in time. It may still be running; retry the same request to resume.",
      );

      const friendly = friendlyError(error, (key) => ja[key]);
      expect(friendly.message).toBe(ja["error.planReconcileTimeout"]);
      // The review step is 変更の確認 everywhere else; the internal "plan"
      // noun must not resurface in the timeout copy.
      expect(friendly.message).not.toMatch(/プラン|Plan/u);
      expect(friendly.message).toContain("デプロイ履歴");
      expect(friendly.detail).toBeUndefined();
    });

    test(`${code} explains the request may still be running in English`, () => {
      const error = new ControlApiError(
        504,
        code,
        "The plan did not become reviewable in time. It may still be running; retry the same request to resume.",
      );

      const friendly = friendlyError(error, (key) => en[key]);
      expect(friendly.message).toBe(en["error.planReconcileTimeout"]);
      expect(friendly.message).not.toMatch(/\bplan\b/iu);
      expect(friendly.message).toContain("Deploy history");
      expect(friendly.detail).toBeUndefined();
    });
  }
});

describe("friendlyError for dashboard-raised 4xx errors", () => {
  test("plan failures and pending fetches read in the UI language", () => {
    const cases = [
      [
        new ControlApiError(
          409,
          "install_plan_failed",
          "The install plan did not produce a reviewable Run.",
        ),
        "controlError.planFailed",
      ],
      [
        new ControlApiError(
          409,
          "source_sync_required",
          "Source contents are still being fetched.",
        ),
        "controlError.sourceSyncPending",
      ],
      // A plan diagnostic carries its code, not a reason.
      [
        new ControlApiError(409, "slot_limit_reached", "Slot limit reached."),
        "controlError.slotLimitReached",
      ],
    ] as const;
    for (const [error, key] of cases) {
      expect(friendlyError(error, (k) => ja[k]).message).toBe(ja[key]);
      expect(friendlyError(error, (k) => en[k]).message).toBe(en[key]);
    }
  });
});
