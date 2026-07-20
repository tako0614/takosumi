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
    // The raw actor CHIP (actor=<code>…</code>) stays in the nested debug
    // layer; the friendly per-row actor line lives on the row (next test).
    const actorChipIndex = activitySource.indexOf(
      '<span class="muted">actor</span>',
    );

    expect(detailsIndex).toBeGreaterThan(-1);
    expect(debugIndex).toBeGreaterThan(detailsIndex);
    expect(actorChipIndex).toBeGreaterThan(debugIndex);
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

  test("activity rows surface WHO acted, honoring the page's だれが claim", () => {
    // The recorded actorId renders on the row itself (backend data, never
    // invented), before the details disclosure — not only in the debug layer.
    const rowActorIndex = activitySource.indexOf('t("activity.actorLine"');
    const detailsIndex = activitySource.indexOf(
      '<summary>{t("activity.details")}</summary>',
    );
    expect(rowActorIndex).toBeGreaterThan(-1);
    expect(rowActorIndex).toBeLessThan(detailsIndex);
    expect(activitySource).toContain("<Show when={props.event.actorId}>");
    expect(ja["activity.actorLine"]).toContain("{actor}");
    expect(en["activity.actorLine"]).toContain("{actor}");
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

  test("topbar badge and /notifications share the same failure-count derivation without a navigation fanout", () => {
    // One derivation, owned by lib/notifications.ts: attentionCount. The
    // notifications page may load its cross-Workspace feed, while ordinary
    // TopBar navigation is strictly scoped to the selected Workspace.
    expect(notificationsLibSource).toContain("export function attentionCount");
    expect(notificationsLibSource).toContain(
      "export async function refreshNotificationFeed",
    );
    expect(notificationsLibSource).toContain(
      "isFailureAction(entry.event.action)",
    );
    // TopBar: one Workspace Activity request on navigation (TTL-throttled, no
    // polling loop), count via the shared derivation.
    expect(topBarSource).toContain(
      "refreshWorkspaceNotificationFeed(workspaceId)",
    );
    expect(topBarSource).toContain("workspaceNotificationFeed(workspaceId)");
    expect(topBarSource).toContain("loc.pathname");
    expect(topBarSource).not.toContain("peekCapsulesCached");
    expect(topBarSource).not.toContain("refreshNotificationFeed()");
    expect(topBarSource).not.toContain("setInterval");
    // NotificationsView: same feed (revalidated in the background), same count.
    expect(notificationsSource).toContain(
      "refreshNotificationFeed({ force: true })",
    );
    expect(notificationsSource).toContain(
      "attentionCount(feed(), currentWorkspaceId() || undefined)",
    );
    expect(notificationsSource).not.toMatch(
      /filter\(\(e\) => isFailureAction\(e\.event\.action\)\)\.length/,
    );
    expect(notificationsLibSource).not.toContain(
      "const spaces = await listSpaces()",
    );
    expect(notificationsLibSource).toContain(
      "export async function refreshWorkspaceNotificationFeed",
    );
    expect(notificationsLibSource).not.toContain("tg_notif_seen_at");
  });

  test("badge/banner count is scoped to the CURRENT workspace; the feed is not", () => {
    // Live-verified defect: after a Workspace switch the bell kept the
    // previous Workspace's count. The COUNT filters on the current Workspace
    // (badge == banner stays intact — both call the same scoped derivation);
    // the page keeps cross-Workspace entries and labels the foreign ones.
    expect(notificationsLibSource).toContain("workspaceId?: string");
    expect(notificationsLibSource).toContain(
      "(!workspaceId || entry.event.workspaceId === workspaceId)",
    );
    expect(notificationsSource).toContain('t("notif.otherWorkspace"');
    expect(ja["notif.otherWorkspace"]).toContain("{handle}");
    expect(en["notif.otherWorkspace"]).toContain("{handle}");
  });

  test("the bell opens onto the existing snapshot, not a full skeleton", () => {
    // /notifications renders the shared feed snapshot immediately and only
    // REVALIDATES in the background — skeleton/error are for the first-ever
    // load (no snapshot yet).
    expect(notificationsSource).toContain(
      "const feed = () => notificationFeed();",
    );
    expect(notificationsSource).toContain(
      "const loading = () => feed() === undefined && refreshed.loading;",
    );
    expect(notificationsSource).toMatch(
      /const error = \(\) =>\s*\n?\s*feed\(\) === undefined/,
    );
  });

  test("run/service notification lines name the service when the payload allows", () => {
    // The recorded Capsule id (metadata capsuleId or the
    // event target) resolves to its name — never an invented value.
    expect(notificationsSource).toContain("function eventCapsuleId(");
    expect(notificationsSource).toContain('metaString(m, "capsuleId")');
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
