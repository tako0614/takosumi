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
      expect(friendly.message).toBe(
        "プランの完了を待つのを停止しました。サーバー側では処理が続いている可能性があります。もう一度始める前に実行状況を確認してください。",
      );
      expect(friendly.detail).toBeUndefined();
    });

    test(`${code} explains the request may still be running in English`, () => {
      const error = new ControlApiError(
        504,
        code,
        "The plan did not become reviewable in time. It may still be running; retry the same request to resume.",
      );

      const friendly = friendlyError(error, (key) => en[key]);
      expect(friendly.message).toBe(
        "We stopped waiting for the plan. It may still be running on the server; check its execution status before starting again.",
      );
      expect(friendly.detail).toBeUndefined();
    });
  }
});
