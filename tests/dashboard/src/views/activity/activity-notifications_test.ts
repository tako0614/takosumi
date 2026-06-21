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

describe("History and notifications", () => {
  test("keeps raw audit identifiers inside support details", () => {
    const detailsIndex = activitySource.indexOf(
      '<summary>{t("activity.details")}</summary>',
    );
    const actorIndex = activitySource.indexOf(
      "<Show when={props.event.actorId}>",
    );

    expect(detailsIndex).toBeGreaterThan(-1);
    expect(actorIndex).toBeGreaterThan(detailsIndex);
    expect(activitySource).toContain('<span class="muted">action</span>');
    expect(activitySource).toContain('<span class="muted">target</span>');
    expect(en["activity.details"]).toBe("Support details");
    expect(ja["activity.details"]).toBe("サポート詳細");
  });

  test("notifications link to history without advertising raw audit logs", () => {
    expect(notificationsSource).toContain('href="/activity"');
    expect(notificationsSource).toContain('t("notif.supportSummary")');
    expect(notificationsSource).toMatch(
      /<details class="wb-disclosure wc-notif-support">[\s\S]*href="\/activity"/,
    );
    expect(en["notif.supportSummary"]).toBe("Support details");
    expect(ja["notif.supportSummary"]).toBe("サポート詳細");
    expect(en["notif.viewRaw"]).toBe("Open history →");
    expect(ja["notif.viewRaw"]).toBe("履歴を開く →");
    expect(en["notif.viewRaw"].toLowerCase()).not.toContain("raw");
    expect(en["notif.viewRaw"].toLowerCase()).not.toContain("audit");
    expect(en["notif.viewRaw"].toLowerCase()).not.toContain("support");
    expect(ja["notif.viewRaw"]).not.toContain("生");
    expect(ja["notif.viewRaw"]).not.toContain("監査");
    expect(ja["notif.viewRaw"]).not.toContain("サポート");
  });
});
