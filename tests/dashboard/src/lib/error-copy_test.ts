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
      expect(friendly.message).toContain("アプリの履歴");
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
      expect(friendly.message).toContain("the app's history");
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

describe("friendlyError for a version change refused while another is prepared", () => {
  test("revision_in_progress reads in the UI language, not the server's English", () => {
    const message = "Another version change for this app is still being prepared.";
    const error = new ControlApiError(409, "failed_precondition", message, {
      error: {
        code: "failed_precondition",
        message,
        details: { reason: "revision_in_progress", revisionPlanId: "rp_1" },
      },
    });
    expect(friendlyError(error, (k) => ja[k]).message).toBe(ja["controlError.revisionInProgress"]);
    expect(friendlyError(error, (k) => en[k]).message).toBe(en["controlError.revisionInProgress"]);
    expect(friendlyError(error, (k) => en[k]).message).not.toBe(message);
  });
});

describe("friendlyError for a Plan blocked by retired app links", () => {
  test("dependency_retired explains the migration and operator cleanup in both locales", () => {
    const error = new ControlApiError(
      412,
      "failed_precondition",
      "dependency_retired: Capsule cap_app has retired dependencies; remove them before re-planning",
      {
        error: {
          code: "failed_precondition",
          message: "dependency_retired: Capsule cap_app has retired dependencies; remove them before re-planning",
          details: { reason: "dependency_retired" },
        },
      },
    );
    expect(friendlyError(error, (key) => ja[key]).message).toBe(ja["controlError.dependencyRetired"]);
    expect(friendlyError(error, (key) => en[key]).message).toBe(en["controlError.dependencyRetired"]);
  });
});

test("ownership errors explain app authority in the selected UI language", () => {
  const cases = [
    ["app_access_denied", "controlError.appAccessDenied"],
    ["app_owner_only", "controlError.appOwnerOnly"],
    ["connection_not_owned_by_app_owner", "controlError.connectionNotOwned"],
    ["ownership_transfer_pending", "controlError.ownershipTransferPending"],
    ["workspace_frozen", "controlError.retiredManagement"],
    ["interface_link_approval_required", "controlError.interfaceLinkApprovalRequired"],
  ] as const;
  for (const [code, key] of cases) {
    const error = new ControlApiError(409, code, "Internal compatibility management policy");
    expect(friendlyError(error, (name) => ja[name]).message).toBe(ja[key]);
    expect(friendlyError(error, (name) => en[name]).message).toBe(en[key]);
  }
});

test("an operator pause of member and transfer writes is explained, not shown raw", () => {
  const error = new ControlApiError(409, "failed_precondition", "App member and ownership changes are temporarily paused by the operator.", {
    error: { code: "failed_precondition", message: "paused", details: { reason: "app_ownership_mutations_frozen" } },
  });
  expect(friendlyError(error, (name) => ja[name]).message).toBe(ja["controlError.appOwnershipMutationsFrozen"]);
  expect(friendlyError(error, (name) => en[name]).message).toBe(en["controlError.appOwnershipMutationsFrozen"]);
});
