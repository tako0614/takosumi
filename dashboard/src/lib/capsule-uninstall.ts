import type { CapsuleAppView } from "./control-api.ts";
import { formatDateTime, t } from "../i18n/index.ts";

/**
 * The one sentence that says where an app's uninstall stands, from the
 * control plane's app view: a teardown that failed or was stopped says so
 * rather than repeating the scheduled date.
 */
export function appUninstallBanner(
  app: Pick<CapsuleAppView, "uninstall" | "problems">,
  name: string,
  now: number = Date.now(),
): string {
  const record = app.uninstall.scheduled;
  if (app.problems.some((problem) => problem.code === "uninstall_failed")) {
    return t("app.uninstall.bannerFailed", { name });
  }
  if (record?.blocked || app.problems.some((problem) => problem.code === "uninstall_blocked")) {
    return t("app.uninstall.bannerBlocked", { name });
  }
  if (!record) return t("app.uninstall.bannerDue", { name });
  if (record.phase === "destroying") return t("app.uninstall.bannerDestroying", { name });
  return Date.parse(record.deleteAfter) > now
    ? t("app.uninstall.banner", { name, date: formatDateTime(record.deleteAfter) })
    : t("app.uninstall.bannerDue", { name });
}

/** What happened to the app's data before its teardown, when recorded. */
export function appUninstallExportNote(
  app: Pick<CapsuleAppView, "uninstall">,
): string | undefined {
  const exported = app.uninstall.scheduled?.preDestroyExport;
  switch (exported?.status) {
    case "exported":
      return exported.includesServiceData === false
        ? t("app.uninstall.exportExportedLedgerOnly")
        : t("app.uninstall.exportExported");
    case "failed":
      return t("app.uninstall.exportFailed");
    case "skipped":
      return t("app.uninstall.exportSkipped");
    default:
      return undefined;
  }
}
