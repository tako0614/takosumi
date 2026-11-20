import type { Capsule, CapsuleAppView } from "./control-api.ts";
import { isAppRemovalRun } from "./app-access.ts";
import { formatDateTime, t, type MessageKey } from "../i18n/index.ts";

export function appUninstallConnectionNotice(
  app: Pick<CapsuleAppView, "uninstall" | "problems">,
): MessageKey | undefined {
  if (app.uninstall.mode === "discard") return;
  const record = app.uninstall.scheduled;
  if (record?.phase === "destroying" && !record.blocked &&
    !app.problems.some((problem) => problem.code === "uninstall_failed")) return;
  const issues = app.problems.filter((problem) => problem.code === "connection_unavailable");
  if (issues.some((problem) => problem.connectionStatus === "missing" || problem.connectionStatus === "revoked")) {
    return "app.uninstall.connectionRemoved";
  }
  if (issues.length > 0) return "app.uninstall.connectionUnavailable";
}

/** Connections an owner can replace in a reviewed uninstall plan. */
export function appUninstallRecoveryConnections(
  app: Pick<CapsuleAppView, "problems">,
): Array<{
  readonly connectionId: string;
  readonly provider: string;
  readonly connectionStatus: NonNullable<CapsuleAppView["problems"][number]["connectionStatus"]>;
}> {
  const seen = new Set<string>();
  return app.problems.flatMap((problem) => {
    const status = problem.connectionStatus;
    if (problem.code !== "connection_unavailable" || !problem.connectionId || !problem.provider ||
      status === undefined || seen.has(problem.connectionId)) return [];
    seen.add(problem.connectionId);
    return [{ connectionId: problem.connectionId, provider: problem.provider, connectionStatus: status }];
  });
}

export function appUninstallFailure(app: Pick<CapsuleAppView, "problems">) {
  return app.problems.find((problem) =>
    problem.code === "uninstall_failed" ||
    (problem.code === "run_failed" && isAppRemovalRun(problem.runType)),
  );
}

export function appUninstallRecoveryMode(
  app: Pick<CapsuleAppView, "applied" | "state" | "progress" | "uninstall" | "problems" | "latestRun">,
): "unavailable" | "failed" | undefined {
  if (app.uninstall.mode === "discard" || app.progress.run || app.progress.review) return;
  if (appUninstallConnectionNotice(app) && appUninstallRecoveryConnections(app).length > 0) return "unavailable";

  // A failed teardown can leave the connected key marked verified. Let the
  // owner try another key without guessing which provider caused the failure.
  const run = app.latestRun;
  if (!app.applied || app.state !== "needs_attention" || run?.status !== "failed" ||
    !isAppRemovalRun(run.type) || run.errorCode === "runner_mutation_indeterminate" ||
    run.errorCode === "policy_denied" || app.problems.some((problem) =>
      problem.code === "policy_blocked" && problem.runId === run.id)) return;
  return "failed";
}

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
  const notice = appUninstallConnectionNotice(app);
  if (notice === "app.uninstall.connectionRemoved") return t("app.uninstall.bannerConnectionRemoved", { name });
  if (notice === "app.uninstall.connectionUnavailable") return t("app.uninstall.bannerConnection", { name });
  if (appUninstallFailure(app)) {
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

/** Public readback facts, never evidence that this caller created a reservation. */
export function observeUninstallReadback(
  kind: "schedule" | "cancel",
  before: Pick<Capsule, "id" | "workspaceId" | "status" | "uninstall">,
  current: Pick<Capsule, "id" | "workspaceId" | "status" | "uninstall">,
  app: Pick<CapsuleAppView, "capsuleId" | "workspaceId" | "state" | "applied" | "uninstall">,
): "removed" | "reservation" | "cancelled" | "unverified" {
  if (current.id !== before.id || app.capsuleId !== before.id ||
    current.workspaceId !== before.workspaceId || app.workspaceId !== before.workspaceId) return "unverified";
  if (kind === "schedule" && current.status === "destroyed" && app.state === "uninstalled") return "removed";
  const previous = before.uninstall;
  const record = current.uninstall;
  if (typeof record?.id !== "string" || !record.id.trim() || !Number.isSafeInteger(record.revision) || record.revision < 1) return "unverified";
  if (kind === "cancel") {
    return previous?.phase === "scheduled" && previous.id === record.id &&
        Number.isSafeInteger(previous.revision) && previous.revision > 0 && record.revision === previous.revision + 1 &&
        record.phase === "cancelled" && typeof record.cancelledAt === "string" && Number.isFinite(Date.parse(record.cancelledAt)) &&
        ["active", "stale", "error"].includes(record.previousStatus) &&
        record.previousStatus === previous.previousStatus && current.status === previous.previousStatus &&
        app.applied && !app.uninstall.scheduled && app.state !== "uninstalled" &&
        app.state !== "uninstalling" && app.state !== "uninstall_scheduled"
      ? "cancelled" : "unverified";
  }
  const scheduled = app.uninstall.scheduled;
  return current.status === "uninstalled" && record.id !== previous?.id &&
      (previous === undefined || previous.phase === "cancelled") &&
      (record.phase === "scheduled" || record.phase === "destroying") &&
      scheduled?.phase === record.phase && scheduled.requestedAt === record.requestedAt &&
      scheduled.deleteAfter === record.scheduledDestroyAt &&
      (app.state === "uninstall_scheduled" || app.state === "uninstalling")
    ? "reservation" : "unverified";
}
