import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const activitySource = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/activity/ActivityView.tsx",
  ),
  "utf8",
);
const notificationsSource = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/notifications/NotificationsView.tsx",
  ),
  "utf8",
);
const topBarSource = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/account/components/shell/TopBar.tsx",
  ),
  "utf8",
);
const notificationsLibSource = readFileSync(
  resolve(import.meta.dir, "../../../../../dashboard/src/lib/notifications.ts"),
  "utf8",
);

describe("History and notifications", () => {
  test("keeps raw audit identifiers inside nested debug details", () => {
    const detailsIndex = activitySource.indexOf(
      '<summary>{t("activity.details")}</summary>',
    );
    const debugIndex = activitySource.indexOf(
      '<summary>{t("activity.debug")}</summary>',
    );
    const actorIndex = activitySource.indexOf(
      "<Show when={props.event.actorId}>",
    );

    expect(detailsIndex).toBeGreaterThan(-1);
    expect(debugIndex).toBeGreaterThan(detailsIndex);
    expect(actorIndex).toBeGreaterThan(debugIndex);
    expect(activitySource).toContain('<span class="muted">action</span>');
    expect(activitySource).toContain('<span class="muted">target</span>');
    expect(activitySource).toContain('t("activity.recorded")');
    expect(en["activity.details"]).toBe("Reference info");
    expect(ja["activity.details"]).toBe("参照情報");
    expect(en["activity.debug"]).toBe("Reference ID");
    expect(ja["activity.debug"]).toBe("参照 ID");
    expect(en["activity.recorded"]).toBe("Recorded activity");
    expect(ja["activity.recorded"]).toBe("記録された操作");
  });

  test("notifications link to history without advertising raw audit logs", () => {
    expect(notificationsSource).toContain('href="/activity"');
    expect(notificationsSource).toContain('t("notif.supportSummary")');
    expect(notificationsSource).toContain('t("notif.event.recorded")');
    expect(notificationsSource).not.toContain("title: event.action");
    expect(notificationsSource).toMatch(
      /<details class="wb-disclosure wc-notif-support">[\s\S]*href="\/activity"/,
    );
    expect(en["notif.supportSummary"]).toBe("Reference info");
    expect(ja["notif.supportSummary"]).toBe("参照情報");
    expect(en["notif.viewRaw"]).toBe("Open history →");
    expect(ja["notif.viewRaw"]).toBe("履歴を開く →");
    expect(en["notif.viewRaw"].toLowerCase()).not.toContain("raw");
    expect(en["notif.viewRaw"].toLowerCase()).not.toContain("audit");
    expect(en["notif.viewRaw"].toLowerCase()).not.toContain("support");
    expect(ja["notif.viewRaw"]).not.toContain("生");
    expect(ja["notif.viewRaw"]).not.toContain("監査");
    expect(ja["notif.viewRaw"]).not.toContain("サポート");
    expect(en["notif.event.recorded"]).toBe("Recorded activity");
    expect(ja["notif.event.recorded"]).toBe("記録された操作");
  });

  test("topbar badge and /notifications derive the SAME 要対応 count from the SAME feed", () => {
    // One derivation, owned by lib/notifications.ts: the shared cross-Workspace
    // feed snapshot + attentionCount. The badge previously counted capsule
    // statuses from a 5s-TTL cache — it disagreed with the page and vanished
    // on views that fetch nothing.
    expect(notificationsLibSource).toContain("export function attentionCount");
    expect(notificationsLibSource).toContain(
      "export async function refreshNotificationFeed",
    );
    expect(notificationsLibSource).toContain(
      "isFailureAction(entry.event.action)",
    );
    // TopBar: refresh on navigation (TTL-throttled, no polling loop), count via
    // the shared derivation.
    expect(topBarSource).toContain("refreshNotificationFeed()");
    expect(topBarSource).toContain("attentionCount(notificationFeed())");
    expect(topBarSource).toContain("loc.pathname");
    expect(topBarSource).not.toContain("peekCapsulesCached");
    expect(topBarSource).not.toContain("setInterval");
    // NotificationsView: same feed (forced fresh), same count.
    expect(notificationsSource).toContain(
      "refreshNotificationFeed({ force: true })",
    );
    expect(notificationsSource).toContain("attentionCount(feed())");
    expect(notificationsSource).not.toMatch(
      /filter\(\(e\) => isFailureAction\(e\.event\.action\)\)\.length/,
    );
    expect(notificationsLibSource).not.toContain(
      "const spaces = await listSpaces()",
    );
    expect(notificationsLibSource).not.toContain("tg_notif_seen_at");
  });

  test("run/service notification lines name the service when the payload allows", () => {
    // The recorded Capsule id (metadata installationId / capsuleId or the
    // event target) resolves to its name — never an invented value.
    expect(notificationsSource).toContain("function eventCapsuleId(");
    expect(notificationsSource).toContain('metaString(m, "installationId")');
    expect(notificationsSource).toContain("loadCapsuleNameIndex");
    expect(notificationsSource).toContain("serviceNameFor(entry.event)");
    expect(notificationsSource).toContain('t("notif.event.planReadyNamed"');
    expect(notificationsSource).toContain('t("notif.event.failedNamed"');
    for (const key of [
      "notif.event.planReadyNamed",
      "notif.event.approvedNamed",
      "notif.event.appliedNamed",
      "notif.event.destroyedNamed",
      "notif.event.failedNamed",
      "notif.event.driftNamed",
      "notif.event.staleNamed",
      "notif.event.autoUpdateFailedNamed",
    ] as const) {
      expect(ja[key]).toContain("{name}");
      expect(en[key]).toContain("{name}");
    }
  });

  test("activity trail paging is honest: load more + end-of-list note", () => {
    expect(activitySource).toContain("ACTIVITY_PAGE_SIZE");
    expect(activitySource).toContain("ACTIVITY_MAX_LIMIT");
    expect(activitySource).toContain('t("common.loadMore")');
    expect(activitySource).toContain(
      't("common.showingRecent", { n: list().length })',
    );
  });
});
