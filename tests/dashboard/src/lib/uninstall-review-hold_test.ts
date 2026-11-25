import { expect, test } from "bun:test";
import { holdUninstallReview, isUninstallReviewHeld, reservedUninstallReview } from "../../../../dashboard/src/lib/uninstall-review-hold.ts";

test("only the request that added an exact uninstall review hold can release it", () => {
  const saved = new Map<string, string>();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    sessionStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  } });
  const scope = ["principal", "account", "workspace", "app", "plan_previous"] as const;
  const hold = holdUninstallReview(scope);
  try {
    const other = holdUninstallReview(scope);
    other.release();
    expect(isUninstallReviewHeld(scope)).toBe(true);
    hold.recordReservation("plan_invalid/path");
    hold.recordReservation(scope[4]);
    expect(reservedUninstallReview(scope)).toBeUndefined();
    hold.recordReservation("plan_reserved");
    other.recordReservation("plan_unowned");
    expect(reservedUninstallReview(scope)).toMatchObject({ planRunId: "plan_reserved" });
    for (const [index, value] of scope.entries()) {
      const different = [...scope] as [string, string, string, string, string];
      different[index] = value + "-different";
      expect(isUninstallReviewHeld(different)).toBe(false);
      expect(reservedUninstallReview(different)).toBeUndefined();
    }
    expect(saved.size).toBe(1);
    hold.release();
    expect(isUninstallReviewHeld(scope)).toBe(false);
    expect(saved.size).toBe(0);

    const replacement = holdUninstallReview(scope);
    try {
      const [key] = saved.keys();
      saved.set(key!, "legacy-hold-token");
      replacement.recordReservation("plan_stale_owner");
      replacement.release();
      expect(saved.get(key!)).toBe("legacy-hold-token");
      expect(isUninstallReviewHeld(scope)).toBe(true);
      expect(reservedUninstallReview(scope)).toBeUndefined();
    } finally { replacement.release(); }

    const followup = holdUninstallReview(scope);
    followup.recordReservation("plan_from_legacy");
    followup.release();
    expect(reservedUninstallReview(scope)).toMatchObject({ planRunId: "plan_from_legacy" });

    const pendingScope = ["principal", "account", "workspace", "app", "plan_pending"] as const;
    const first = holdUninstallReview(pendingScope);
    const second = holdUninstallReview(pendingScope);
    const concurrent = holdUninstallReview(pendingScope);
    second.recordReservation("plan_from_second");
    concurrent.recordReservation("plan_competing");
    first.release();
    second.release();
    expect(reservedUninstallReview(pendingScope)).toMatchObject({ planRunId: "plan_from_second" });
  } finally {
    hold.release();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
