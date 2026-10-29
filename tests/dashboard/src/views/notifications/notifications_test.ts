import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";
import type { ActivityEvent } from "../../../../../dashboard/src/lib/control-api.ts";
import {
  activityServiceName,
  describeActivityEvent,
} from "../../../../../dashboard/src/lib/activity-copy.ts";
import { activityEventHref } from "../../../../../dashboard/src/lib/activity-links.ts";
import { isFailureAction } from "../../../../../dashboard/src/lib/notifications.ts";
import { locale, setLocale } from "../../../../../dashboard/src/i18n/index.ts";

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
const activityCopySource = readFileSync(
  resolve(import.meta.dir, "../../../../../dashboard/src/lib/activity-copy.ts"),
  "utf8",
);
const serviceNamesSource = readFileSync(
  resolve(import.meta.dir, "../../../../../dashboard/src/lib/service-names.ts"),
  "utf8",
);
const notificationsLibSource = readFileSync(
  resolve(import.meta.dir, "../../../../../dashboard/src/lib/notifications.ts"),
  "utf8",
);

describe("Notifications", () => {
  test("does not credit a dependency when the app's own source changed", () => {
    expect(activityCopySource).toContain(
      'metaString(m, "reason") === "source_ref_changed"',
    );
    expect(ja["notif.event.staleSourceNamed"]).toContain("{name}");
    expect(en["notif.event.staleSourceNamed"]).toContain("{name}");
    const previousLocale = locale();
    const event: ActivityEvent = {
      id: "stale-source-event",
      workspaceId: "ws_alpha",
      action: "capsule.stale",
      targetType: "capsule",
      targetId: "cap_app",
      metadata: {
        reason: "source_ref_changed",
        producerCapsuleName: "Upstream service",
      },
      createdAt: "2026-10-13T00:00:00.000Z",
    };
    try {
      setLocale("en");
      expect(describeActivityEvent(event, "App service").title).toBe(
        "A new version of “App service” is available",
      );
      setLocale("ja");
      expect(describeActivityEvent(event, "アプリ").title).toBe(
        "「アプリ」の新しい版があります",
      );
    } finally {
      setLocale(previousLocale);
    }
  });

  test("a provider's link decisions read as plain sentences, never raw actions", () => {
    const previousLocale = locale();
    const event = (action: string): ActivityEvent => ({
      id: `evt_${action}`, workspaceId: "ws_alpha", action, targetType: "interface_link", targetId: "ifl_a",
      metadata: { interfaceLinkId: "ifl_a", consumerCapsuleId: "cap_consumer", providerCapsuleId: "cap_provider" },
      createdAt: "2026-10-29T00:00:00.000Z",
    });
    try {
      setLocale("ja");
      expect(describeActivityEvent(event("interface_link.approved")).title).toBe("連携の依頼を承認しました");
      expect(describeActivityEvent(event("interface_link.declined")).title).toBe("連携の依頼を断りました");
      setLocale("en");
      expect(describeActivityEvent(event("interface_link.approved")).title).toBe("Approved a link request");
      expect(describeActivityEvent(event("interface_link.declined")).title).toBe("Declined a link request");
    } finally {
      setLocale(previousLocale);
    }
  });

  test("notifications link to where each event is acted on, with no raw history screen", () => {
    expect(notificationsSource).not.toContain('href="/activity"');
    expect(notificationsSource).not.toContain("notif.viewRaw");
    expect(notificationsSource).toContain("describeActivityEvent(");
    expect(notificationsSource).toContain("activityEventHref");
    expect(activityCopySource).toContain('t("notif.event.recorded")');
    expect(notificationsSource).not.toContain("title: event.action");
    // An empty feed offers the next behavior: finding an app.
    expect(notificationsSource).toContain('t("notif.empty.cta")');
    expect(notificationsSource).toContain('href="/new"');
    expect(en["notif.event.recorded"]).toBe("Recorded activity");
    expect(ja["notif.event.recorded"]).toBe("記録された操作");
    const base = {
      id: "act",
      workspaceId: "ws_alpha",
      action: "run.applied",
      metadata: {},
      createdAt: "2026-10-27T00:00:00.000Z",
    };
    expect(activityEventHref({ ...base, targetType: "run", targetId: "run_1" })).toBe("/runs/run_1");
    expect(activityEventHref({ ...base, targetType: "capsule", targetId: "cap_1" })).toBe("/apps/cap_1");
    expect(activityEventHref({ ...base, targetType: "connection", targetId: "pc_1" })).toBe("/connections");
    // Value sharing between workspaces has no screen any more.
    expect(activityEventHref({ ...base, targetType: "output_share", targetId: "share_1" })).toBeUndefined();
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
    // A badge nobody can clear stops being a signal — both the count and the
    // "mark all read" action come from the shared module, so the bell drops
    // the moment the page acknowledges.
    expect(notificationsLibSource).toContain(
      "export function acknowledgeNotifications",
    );
    expect(notificationsLibSource).toContain(
      "isAcknowledged(entry, seenBefore)",
    );
    expect(topBarSource).toContain("onNotificationsAcknowledged(");
    expect(notificationsSource).toContain("acknowledgeNotifications(feed())");
    expect(topBarSource).toContain("loc.pathname");
    expect(topBarSource).not.toContain("peekCapsulesCached");
    expect(topBarSource).not.toContain("refreshNotificationFeed()");
    expect(topBarSource).not.toContain("setInterval");
    // NotificationsView: same feed (revalidated in the background), same count.
    expect(notificationsSource).toContain("refreshNotificationFeed({");
    expect(notificationsSource).toContain("selectedWorkspaceId:");
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
    expect(notificationsLibSource).toContain("NOTIF_WORKSPACE_LIMIT = 12");
    expect(notificationsLibSource).toContain("NOTIF_FANOUT_CONCURRENCY = 4");
    expect(notificationsLibSource).not.toContain("Promise.allSettled(");
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
    // Named by the workspace's name, never its generated handle / id, and only
    // when there is more than one workspace to tell apart.
    expect(ja["notif.otherWorkspace"]).toContain("{name}");
    expect(en["notif.otherWorkspace"]).toContain("{name}");
    expect(ja["notif.otherWorkspace"]).not.toContain("スペース");
    expect(notificationsSource).toContain("workspaceName(workspace)");
    expect(notificationsSource).toContain("showWorkspace={multipleWorkspaces()}");
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

  test("run and app notification lines name the app when the payload allows", () => {
    // The batched projection carries only a recorded name; the page never
    // opens a second per-Workspace Capsule-list fan-out.
    expect(notificationsLibSource).toContain("includeNotifications: true");
    expect(notificationsSource).not.toContain(
      "loadNotificationCapsuleNameIndex",
    );
    expect(activityCopySource).toContain(
      'metaString(metadata, "capsuleName")',
    );
    expect(notificationsSource).toContain("serviceNameFor(entry.event)");
    expect(notificationsSource).toContain("activityServiceName(event)");
    expect(activityCopySource).toContain('t("notif.event.planReadyNamed"');
    expect(activityCopySource).toContain('t("notif.event.failedNamed"');
    // Billing usage rows resolve app ids over removed apps the same way.
    expect(serviceNamesSource).toContain(
      "listCapsulesCached(key.workspaceId, { includeDestroyed: true })",
    );
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

  test("a dead-lettered screen publication reads as a failure that opens its app", () => {
    // Recorded by core/domains/interfaces/materialization_intent_drain.ts.
    // It used to render as the neutral "Recorded activity" line with no link,
    // so the only screen that can retry it was reachable only through
    // Settings > Manage.
    const deadLettered: ActivityEvent = {
      id: "act_dead_letter",
      workspaceId: "ws_alpha",
      action: "interface_materialization.dead_lettered",
      targetType: "capsule_interface_materialization_intent",
      targetId: "cimi_1",
      metadata: { capsuleId: "cap_app", errorCode: "store_unavailable" },
      createdAt: "2026-10-20T00:00:00.000Z",
    };
    const retryRequested: ActivityEvent = {
      ...deadLettered,
      id: "act_retry",
      action: "interface_materialization.retry_requested",
    };
    expect(isFailureAction(deadLettered.action)).toBe(true);
    expect(isFailureAction(retryRequested.action)).toBe(false);
    // The app's page owns the retry; without an app id the link opens ホーム.
    expect(activityEventHref(deadLettered)).toBe("/apps/cap_app");
    expect(activityEventHref(retryRequested)).toBe("/apps/cap_app");
    expect(
      activityEventHref({ ...deadLettered, metadata: { errorCode: "x" } }),
    ).toBe("/");
    expect(
      activityServiceName(deadLettered, new Map([["cap_app", "App service"]])),
    ).toBe("App service");
    const previousLocale = locale();
    try {
      setLocale("en");
      expect(describeActivityEvent(deadLettered, "App service")).toEqual({
        title: "The screen for “App service” couldn't be set up",
        detail: "Try again from the app's page",
      });
      expect(describeActivityEvent(retryRequested).title).toBe(
        "Retrying an app's screen setup",
      );
      setLocale("ja");
      expect(describeActivityEvent(deadLettered, "アプリ")).toEqual({
        title: "「アプリ」の画面を用意できませんでした",
        detail: "アプリのページから、もう一度試してください",
      });
      expect(describeActivityEvent(deadLettered).title).not.toBe(
        ja["notif.event.recorded"],
      );
      // The detail names where the link goes.
      expect(ja["notif.event.interfaceDeadLetteredDetail"]).toContain(
        "アプリのページ",
      );
    } finally {
      setLocale(previousLocale);
    }
  });
});
