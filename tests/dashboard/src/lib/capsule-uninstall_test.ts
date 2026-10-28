import { expect, test } from "bun:test";
import type { CapsuleAppView } from "../../../../dashboard/src/lib/control-api.ts";
import {
  appUninstallBanner,
  appUninstallExportNote,
} from "../../../../dashboard/src/lib/capsule-uninstall.ts";
import { formatDateTime, t } from "../../../../dashboard/src/i18n/index.ts";

type Terms = Pick<CapsuleAppView, "uninstall" | "problems">;
const scheduled: Terms = {
  uninstall: {
    mode: "scheduled",
    graceDays: 7,
    scheduled: {
      phase: "scheduled",
      requestedAt: "2026-10-01T00:00:00.000Z",
      deleteAfter: "2099-01-01T00:00:00.000Z",
      cancellable: true,
      blocked: false,
    },
  },
  problems: [{ code: "uninstall_scheduled", severity: "warning" }],
};

test("a scheduled uninstall names its date; a passed date says it runs shortly", () => {
  expect(appUninstallBanner(scheduled, "App")).toBe(
    t("app.uninstall.banner", { name: "App", date: formatDateTime("2099-01-01T00:00:00.000Z") }),
  );
  expect(appUninstallBanner(scheduled, "App", Date.parse("2099-01-02T00:00:00.000Z"))).toBe(
    t("app.uninstall.bannerDue", { name: "App" }),
  );
});

test("failed and blocked teardown use actual failure banners rather than a scheduled date", () => {
  const failed: Terms = {
    uninstall: { ...scheduled.uninstall, scheduled: { ...scheduled.uninstall.scheduled!, phase: "destroying" } },
    problems: [{ code: "uninstall_failed", severity: "error", runId: "run_destroy", runType: "destroy_apply" }],
  };
  expect(appUninstallBanner(failed, "App")).toBe(t("app.uninstall.bannerFailed", { name: "App" }));
  const blocked: Terms = {
    uninstall: { ...scheduled.uninstall, scheduled: { ...scheduled.uninstall.scheduled!, blocked: true } },
    problems: [{ code: "uninstall_blocked", severity: "error", reason: "teardown_unconfirmed" }],
  };
  expect(appUninstallBanner(blocked, "App")).toBe(t("app.uninstall.bannerBlocked", { name: "App" }));
  const destroying: Terms = {
    uninstall: { ...scheduled.uninstall, scheduled: { ...scheduled.uninstall.scheduled!, phase: "destroying" } },
    problems: [],
  };
  expect(appUninstallBanner(destroying, "App")).toBe(t("app.uninstall.bannerDestroying", { name: "App" }));
});

test("the export note reports what was exported, and nothing when unrecorded", () => {
  expect(appUninstallExportNote(scheduled)).toBeUndefined();
  const exported = (status: "exported" | "failed" | "skipped", includesServiceData?: boolean): Terms => ({
    ...scheduled,
    uninstall: {
      ...scheduled.uninstall,
      scheduled: {
        ...scheduled.uninstall.scheduled!,
        preDestroyExport: { status, ...(includesServiceData === undefined ? {} : { includesServiceData }) },
      },
    },
  });
  expect(appUninstallExportNote(exported("exported"))).toBe(t("app.uninstall.exportExported"));
  expect(appUninstallExportNote(exported("exported", false))).toBe(t("app.uninstall.exportExportedLedgerOnly"));
  expect(appUninstallExportNote(exported("failed"))).toBe(t("app.uninstall.exportFailed"));
  expect(appUninstallExportNote(exported("skipped"))).toBe(t("app.uninstall.exportSkipped"));
});
