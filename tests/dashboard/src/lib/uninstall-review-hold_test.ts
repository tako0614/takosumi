import { expect, test } from "bun:test";
import { holdUninstallReview, isUninstallReviewHeld } from "../../../../dashboard/src/lib/uninstall-review-hold.ts";

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
  const scope = ["principal", "account", "workspace", "app", "plan"] as const;
  const release = holdUninstallReview(scope);
  try {
    holdUninstallReview(scope)();
    expect(isUninstallReviewHeld(scope)).toBe(true);
    for (const [index, value] of scope.entries()) {
      const different = [...scope] as [string, string, string, string, string];
      different[index] = value + "-different";
      expect(isUninstallReviewHeld(different)).toBe(false);
    }
    expect(saved.size).toBe(1);
    release();
    expect(isUninstallReviewHeld(scope)).toBe(false);
    expect(saved.size).toBe(0);
  } finally {
    release();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
