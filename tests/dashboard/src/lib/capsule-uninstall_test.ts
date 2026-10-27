import { expect, test } from "bun:test";
import type { Capsule } from "../../../../dashboard/src/lib/control-api.ts";
import { capsuleUninstallBanner, capsuleUninstallDependencyWarning, uninstallCancellable, uninstallDependencyReadWarning, uninstallTeardownFailed } from "../../../../dashboard/src/lib/capsule-uninstall.ts";
import { t } from "../../../../dashboard/src/i18n/index.ts";
const base = { id: "cap_a", name: "App", status: "uninstalled", uninstall: { phase: "scheduled", scheduledDestroyAt: "2099-01-01T00:00:00Z" } } as Capsule;
test("only a scheduled or blocked uninstalled Capsule can cancel deletion", () => {
  expect(uninstallCancellable(base)).toBe(true);
  expect(uninstallCancellable({ ...base, status: "active" })).toBe(false);
  const destroying = { ...base, uninstall: { ...base.uninstall!, phase: "destroying" as const } };
  expect(uninstallCancellable(destroying)).toBe(false);
  expect(uninstallCancellable({ ...destroying, uninstall: { ...destroying.uninstall, blockedReason: "dependency_check_failed" } })).toBe(true);
  expect(uninstallCancellable({ ...destroying, status: "error" })).toBe(false);
});
test("failed and blocked teardown use actual failure banners rather than a scheduled date", () => {
  const failed = { ...base, status: "error" as const, uninstall: { ...base.uninstall!, phase: "destroying" as const } };
  expect(uninstallTeardownFailed(failed)).toBe(true);
  expect(capsuleUninstallBanner(failed)).toBe(t("app.uninstall.bannerFailed", { name: "App" }));
  const blocked = { ...base, uninstall: { ...base.uninstall!, blockedReason: "dependency_check_failed" } };
  expect(capsuleUninstallBanner(blocked)).toBe(t("app.uninstall.bannerBlocked", { name: "App" }));
});
test("uninstall confirmation preserves dependent services and unreadable graph warnings", () => {
  expect(capsuleUninstallDependencyWarning("App", ["Consumer A", "Consumer B"])).toContain("Consumer A, Consumer B");
  expect(capsuleUninstallDependencyWarning("App", [])).toBeUndefined();
  expect(uninstallDependencyReadWarning("failed")).toBe(t("app.uninstall.dependencyCheckFailed"));
  expect(uninstallDependencyReadWarning("loading")).toBe(t("app.uninstall.dependencyCheckLoading"));
  expect(uninstallDependencyReadWarning("ready")).toBeUndefined();
});
