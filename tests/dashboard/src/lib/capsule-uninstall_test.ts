import { expect, test } from "bun:test";
import type { CapsuleAppView } from "../../../../dashboard/src/lib/control-api.ts";
import {
  observeUninstallReadback,
  appUninstallBanner,
  appUninstallConnectionNotice,
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
  const rows = appUninstallRecoveryConnections({ problems: [
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
