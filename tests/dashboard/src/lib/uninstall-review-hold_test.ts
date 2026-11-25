import { expect, test } from "bun:test";
import {
  holdUninstallReview,
  isUninstallReviewHeld,
  reservedUninstallReview,
  submittedUninstallReview,
  trackSubmittedUninstallReview,
} from "../../../../dashboard/src/lib/uninstall-review-hold.ts";

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

test("standalone receipts follow only the current submitted attempt and never hold a Plan", () => {
  const scope = ["principal", "account", "workspace", "app_standalone"] as const;
  const superseded = trackSubmittedUninstallReview(scope);
  const first = trackSubmittedUninstallReview(scope);
  first({ reservedPlanRunId: "plan_first" });
  superseded({ saved: true });
  expect(submittedUninstallReview(scope)).toMatchObject({ planRunId: "plan_first" });
  expect(isUninstallReviewHeld([...scope, "plan_first"])).toBe(false);
  for (const [index, value] of scope.entries()) {
    const different = [...scope] as [string, string, string, string];
    different[index] = value + "-different";
    expect(submittedUninstallReview(different)).toBeUndefined();
    trackSubmittedUninstallReview(different)({ saved: true });
  }
  trackSubmittedUninstallReview(scope)({ reservedPlanRunId: "plan_invalid/path" });
  trackSubmittedUninstallReview(scope)();
  expect(submittedUninstallReview(scope)).toMatchObject({ planRunId: "plan_first" });

  const second = trackSubmittedUninstallReview(scope);
  second({ reservedPlanRunId: "plan_second" });
  expect(submittedUninstallReview(scope)).toMatchObject({ planRunId: "plan_second" });
  trackSubmittedUninstallReview(scope)({ saved: true });
  expect(submittedUninstallReview(scope)).toBeUndefined();
  second({ reservedPlanRunId: "plan_stale" });
  expect(submittedUninstallReview(scope)).toBeUndefined();
});

test("standalone receipt supersession respects readable storage when its writes fail", () => {
  const saved = new Map<string, string>();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let denyWrites = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem(key: string, value: string) {
      if (denyWrites) throw Error("quota");
      saved.set(key, value);
    },
    removeItem(key: string) {
      if (denyWrites) throw Error("denied");
      saved.delete(key);
    },
  } } });
  const scope = ["principal", "account", "workspace", "app_quota"] as const;
  try {
    trackSubmittedUninstallReview(scope)({ reservedPlanRunId: "plan_old" });
    const [key] = saved.keys();
    denyWrites = true;
    trackSubmittedUninstallReview(scope)({ reservedPlanRunId: "plan_current" });
    expect(saved.get(key!)).toEndWith(":plan_old");
    expect(submittedUninstallReview(scope)).toMatchObject({ planRunId: "plan_current" });
    trackSubmittedUninstallReview(scope)({ saved: true });
    expect(submittedUninstallReview(scope)).toBeUndefined();

    const stale = trackSubmittedUninstallReview(scope);
    saved.set(key!, "new-token:plan_other");
    stale({ saved: true });
    expect(submittedUninstallReview(scope)).toEqual({ token: "new-token", planRunId: "plan_other" });
    denyWrites = false;
    trackSubmittedUninstallReview(scope)({ saved: true });
    expect(saved.size).toBe(0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
