import { expect, test } from "bun:test";
import type { CapsuleAppView } from "../../../../dashboard/src/lib/control-api.ts";
import {
  observeUninstallReadback,
  appUninstallBanner,
  appUninstallConnectionNotice,
  appUninstallRecoveryMode,
  appUninstallRecoveryConnections,
  appUninstallExportNote,
} from "../../../../dashboard/src/lib/capsule-uninstall.ts";
import { formatDateTime, t } from "../../../../dashboard/src/i18n/index.ts";

type Terms = Pick<CapsuleAppView, "uninstall" | "problems">;
const scheduled: Terms = {
  uninstall: {
    impact: { usedBy: [] },
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

test("a broken bound connection takes precedence over the countdown only when teardown can use it", () => {
  const needsConnection: Terms = {
    ...scheduled,
    problems: [{ code: "connection_unavailable", severity: "error", connectionStatus: "missing" }, ...scheduled.problems],
  };
  expect(appUninstallBanner(needsConnection, "App")).toBe(t("app.uninstall.bannerConnectionRemoved", { name: "App" }));
  expect(appUninstallConnectionNotice(needsConnection)).toBe("app.uninstall.connectionRemoved");
  const expired: Terms = {
    ...needsConnection,
    problems: [{ code: "connection_unavailable", severity: "error", connectionStatus: "expired" }],
  };
  expect(appUninstallConnectionNotice(expired)).toBe("app.uninstall.connectionUnavailable");
  expect(appUninstallBanner(expired, "App")).toBe(t("app.uninstall.bannerConnection", { name: "App" }));
  expect(appUninstallConnectionNotice({
    ...needsConnection,
    uninstall: { ...scheduled.uninstall, scheduled: { ...scheduled.uninstall.scheduled!, phase: "destroying" } },
  })).toBeUndefined();
  expect(appUninstallConnectionNotice({
    ...needsConnection,
    uninstall: { mode: "discard", impact: { usedBy: [] } },
  })).toBeUndefined();
});

test("actionable uninstall recovery rows cover unavailable bound connection statuses only", () => {
  const rows = appUninstallRecoveryConnections({ ...scheduled, problems: [
    ...(["missing", "revoked", "expired", "error"] as const).map((connectionStatus) => ({
      code: "connection_unavailable" as const,
      severity: "error" as const,
      connectionId: `connection-${connectionStatus}`,
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      connectionStatus,
    })),
    { code: "connection_unavailable", severity: "error", connectionStatus: "expired" },
    { code: "run_failed", severity: "error" },
  ] });
  expect(rows.map(({ connectionId, connectionStatus }) => [connectionId, connectionStatus])).toEqual([
    ["connection-missing", "missing"],
    ["connection-revoked", "revoked"],
    ["connection-expired", "expired"],
    ["connection-error", "error"],
  ]);
});

test("uninstall recovery rows honor the applied binding projection without hiding general issues", () => {
  const provider = "registry.opentofu.org/cloudflare/cloudflare";
  const problems: CapsuleAppView["problems"] = [
    { code: "connection_unavailable", severity: "error", connectionId: "used", provider, connectionStatus: "revoked" },
    { code: "connection_unavailable", severity: "error", connectionId: "unused", provider, connectionStatus: "expired" },
  ];
  const app = {
    problems,
    uninstall: { ...scheduled.uninstall, recoveryConnectionIds: ["used"] },
  } as CapsuleAppView;
  expect(app.problems).toHaveLength(2);
  expect(appUninstallRecoveryConnections(app).map(({ connectionId }) => connectionId)).toEqual(["used"]);
  expect(appUninstallRecoveryConnections({
    ...app,
    uninstall: { ...app.uninstall, recoveryConnectionIds: [] },
  })).toEqual([]);
  // Older hosts that omit the optional projection retain their existing chooser behavior.
  expect(appUninstallRecoveryConnections({
    problems,
    uninstall: scheduled.uninstall,
  } as CapsuleAppView).map(({ connectionId }) => connectionId)).toEqual(["used", "unused"]);
});

test("only exact applied-Destroy IDs make unavailable connections block uninstall", () => {
  const provider = "registry.opentofu.org/cloudflare/cloudflare";
  const unusedIssue = {
    code: "connection_unavailable",
    severity: "error",
    connectionId: "unused",
    provider,
    connectionStatus: "expired",
  } as const;
  const usedIssue = { ...unusedIssue, connectionId: "used", connectionStatus: "revoked" } as const;
  const app: Terms = {
    uninstall: { ...scheduled.uninstall, requiredConnectionIds: ["used"] },
    problems: [unusedIssue],
  };

  // The UI keeps the general issue visible, while the exact projection says
  // this saved alias is not needed to destroy the applied state.
  expect(app.problems).toHaveLength(1);
  expect(appUninstallConnectionNotice(app)).toBeUndefined();
  expect(appUninstallBanner(app, "App")).not.toBe(t("app.uninstall.bannerConnection", { name: "App" }));
  expect(appUninstallConnectionNotice({ ...app, problems: [usedIssue] })).toBe("app.uninstall.connectionRemoved");
  expect(appUninstallConnectionNotice({ ...app, uninstall: { ...app.uninstall, requiredConnectionIds: [] } })).toBeUndefined();
  expect(appUninstallConnectionNotice({ ...app, problems: [{ ...unusedIssue, connectionId: undefined }] })).toBe("app.uninstall.connectionUnavailable");
  // An older host without exact applied-Destroy evidence keeps the old guard.
  expect(appUninstallConnectionNotice({ uninstall: scheduled.uninstall, problems: [unusedIssue] })).toBe("app.uninstall.connectionUnavailable");
});

test("replacement can be offered after a failed removal even with verified connection status", () => {
  const latestRun = { id: "run_destroy", type: "destroy_apply", status: "failed", createdAt: "2026-10-01T00:00:00.000Z", errorCode: "apply_failed" } as const;
  const failed = {
    ...scheduled,
    applied: true,
    state: "needs_attention",
    progress: { revisionPreparing: false },
    problems: [{ code: "run_failed", severity: "error", runId: latestRun.id, runType: latestRun.type }],
    latestRun,
  } as const;
  expect(appUninstallRecoveryMode(failed)).toBe("failed");
  expect(appUninstallBanner(failed, "App")).toBe(t("app.uninstall.bannerFailed", { name: "App" }));
  expect(appUninstallRecoveryMode({ ...failed, latestRun: { ...latestRun, type: "destroy_plan" } })).toBe("failed");
  expect(appUninstallRecoveryMode({ ...failed, latestRun: { ...latestRun, type: "apply" } })).toBeUndefined();
  expect(appUninstallRecoveryMode({ ...failed, latestRun: { ...latestRun, errorCode: "runner_mutation_indeterminate" } })).toBeUndefined();
  expect(appUninstallRecoveryMode({ ...failed, latestRun: { ...latestRun, errorCode: "policy_denied" } })).toBeUndefined();
  expect(appUninstallRecoveryMode({
    ...failed,
    progress: { revisionPreparing: false, review: { runId: "new_plan", runType: "destroy_plan" } },
  })).toBeUndefined();
  const withUnavailableBinding = {
    ...failed,
    problems: [...failed.problems, {
      code: "connection_unavailable", severity: "error", connectionId: "old", provider: "registry.opentofu.org/cloudflare/cloudflare", connectionStatus: "expired",
    }],
  } as const;
  expect(appUninstallRecoveryMode(withUnavailableBinding)).toBe("failed");
  expect(appUninstallRecoveryMode({ ...withUnavailableBinding, latestRun: undefined })).toBe("unavailable");
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

test("uninstall readback separates current reservations from exact cancellation and terminal removal", () => {
  type Cap = Parameters<typeof observeUninstallReadback>[1];
  type View = Parameters<typeof observeUninstallReadback>[3];
  const active: Cap = { id: "cap_a", workspaceId: "ws_a", status: "active" };
  const record = { id: "uninstall_a", revision: 1, phase: "scheduled" as const,
    previousStatus: "active" as const, requestedAt: "2026-11-18T00:00:00Z", scheduledDestroyAt: "2026-11-25T00:00:00Z" };
  const pending: Cap = { ...active, status: "uninstalled", uninstall: record };
  const view: View = { capsuleId: active.id, workspaceId: "ws_a", applied: true,
    state: "uninstall_scheduled", uninstall: { impact: { usedBy: [] }, mode: "scheduled", scheduled: {
      phase: "scheduled", requestedAt: record.requestedAt, deleteAfter: record.scheduledDestroyAt, cancellable: true, blocked: false,
    } } };
  const cancelled: Cap = { ...active, uninstall: { ...record, revision: 2, phase: "cancelled", cancelledAt: "2026-11-18T00:01:00Z" } };
  const restored: View = { ...view, state: "installed", uninstall: { mode: "scheduled", impact: { usedBy: [] } } };
  expect(observeUninstallReadback("schedule", active, pending, view)).toBe("reservation");
  // Seeing the same pre-existing reservation never proves our new request was accepted.
  expect(observeUninstallReadback("schedule", pending, pending, view)).toBe("unverified");
  expect(observeUninstallReadback("cancel", pending, cancelled, restored)).toBe("cancelled");
  for (const changed of [
    { ...cancelled, uninstall: undefined },
    { ...cancelled, uninstall: { ...cancelled.uninstall!, id: "other" } },
    { ...cancelled, uninstall: { ...cancelled.uninstall!, revision: 1 } },
    { ...cancelled, uninstall: { ...cancelled.uninstall!, revision: 3 } },
    { ...cancelled, uninstall: { ...cancelled.uninstall!, cancelledAt: undefined } },
    { ...cancelled, uninstall: { ...cancelled.uninstall!, cancelledAt: "invalid" } },
    { ...cancelled, status: "destroyed" as const },
    { ...cancelled, workspaceId: "other" },
    { ...cancelled, id: "other" },
  ]) expect(observeUninstallReadback("cancel", pending, changed, restored)).toBe("unverified");
  expect(observeUninstallReadback("cancel", pending, cancelled, view)).toBe("unverified");
  expect(observeUninstallReadback("cancel", pending, cancelled, { ...restored, workspaceId: "other" })).toBe("unverified");
  const removed: Cap = { ...active, status: "destroyed" };
  const gone: View = { ...restored, state: "uninstalled", applied: false };
  expect(observeUninstallReadback("schedule", active, removed, gone)).toBe("removed");
  expect(observeUninstallReadback("cancel", pending, removed, gone)).toBe("unverified");
  expect(observeUninstallReadback("schedule", active, removed, { ...gone, capsuleId: "other" })).toBe("unverified");
});
