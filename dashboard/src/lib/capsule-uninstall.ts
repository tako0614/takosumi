import type { Capsule } from "./control-api.ts";
import { formatDateTime, t } from "../i18n/index.ts";

export function uninstallCancellable(capsule: Capsule): boolean {
  return capsule.status === "uninstalled" &&
    (capsule.uninstall?.phase === "scheduled" ||
      (capsule.uninstall?.phase === "destroying" && capsule.uninstall.blockedReason !== undefined));
}

export function uninstallTeardownFailed(capsule: Capsule): boolean {
  return capsule.status === "error" && capsule.uninstall?.phase === "destroying";
}

export function capsuleUninstallBanner(capsule: Capsule, name = capsule.name): string {
  const uninstall = capsule.uninstall;
  if (uninstallTeardownFailed(capsule)) return t("app.uninstall.bannerFailed", { name });
  if (!uninstall) return t("app.uninstall.bannerDue", { name });
  if (uninstall.blockedReason) return t("app.uninstall.bannerBlocked", { name });
  if (uninstall.phase === "destroying") return t("app.uninstall.bannerDestroying", { name });
  return Date.parse(uninstall.scheduledDestroyAt) > Date.now()
    ? t("app.uninstall.banner", { name, date: formatDateTime(uninstall.scheduledDestroyAt) })
    : t("app.uninstall.bannerDue", { name });
}

export function capsuleUninstallDependencyWarning(name: string, dependentNames: readonly string[]): string | undefined {
  return dependentNames.length ? t("app.uninstall.dependencyWarning", { name, apps: dependentNames.join(", ") }) : undefined;
}

export function uninstallDependencyReadWarning(status: "ready" | "loading" | "failed"): string | undefined {
  return status === "failed" ? t("app.uninstall.dependencyCheckFailed") :
    status === "loading" ? t("app.uninstall.dependencyCheckLoading") : undefined;
}
