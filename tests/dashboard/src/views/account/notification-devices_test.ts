/**
 * アカウント > 通知を受け取る端末: the Takosumi Mobile devices registered for
 * this instance's own notifications, with removal and a visible failing state.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { notificationPusherHealth } from "../../../../../dashboard/src/views/account/lib/notification-pushers.ts";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const read = (relativePath: string) =>
  readFileSync(
    resolve(import.meta.dir, "../../../../../dashboard/src/views/account", relativePath),
    "utf8",
  );

const view = read("AccountView.tsx");
const card = read("components/NotificationDevicesCard.tsx");
const client = read("lib/notification-pushers.ts");

describe("notification devices", () => {
  test("is an account section listing devices from the Accounts API", () => {
    expect(view).toContain('href: "/account/devices", labelKey: "account.section.devices"');
    expect(view).toContain("<NotificationDevicesCard />");
    expect(client).toContain("TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH");
    expect(client).toContain("takosumiAccountsNotificationPusherPath(pusherId)");
    expect(client).toContain('method: "DELETE"');
    expect(ja["account.section.devices"]).toBe("通知を受け取る端末");
    expect(en["account.section.devices"]).toBe("Notification devices");
  });

  test("removal is confirmed inline and a failing device says what to do", () => {
    expect(card).toContain("setConfirming(pusher.id)");
    expect(card).toContain('t("account.devices.removeConsequence")');
    expect(card).toContain("void remove(pusher.id)");
    expect(card).toContain('t("account.devices.failingHelp")');
    expect(card).toContain("web_push_unavailable_reason");
    for (const key of ["account.devices.unavailable.secret", "account.devices.unavailable.relay", "account.devices.unavailable.issuer"] as const) {
      expect(card).toContain(`"${key}"`);
      expect(ja[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
    // Device secrets never reach the dashboard: only display fields are read.
    expect(card).not.toContain(".auth");
    expect(card).not.toContain("pushkey");
  });

  test("health follows the latest outcome", () => {
    expect(notificationPusherHealth({ failing: true, last_success_at: "2026-10-30T00:00:00.000Z" })).toBe("failing");
    expect(notificationPusherHealth({ failing: false, last_success_at: "2026-10-30T00:00:00.000Z" })).toBe("ok");
    expect(notificationPusherHealth({ failing: false, last_success_at: null })).toBe("unused");
  });

  test("the new Activity kinds read plainly in the bell", () => {
    const copy = readFileSync(resolve(import.meta.dir, "../../../../../dashboard/src/lib/activity-copy.ts"), "utf8");
    expect(copy).toContain('case "run.approval_required"');
    expect(copy).toContain('case "interface_link.approval_requested"');
    for (const key of [
      "notif.event.approvalRequired",
      "notif.event.approvalRequiredNamed",
      "notif.event.interfaceLinkRequested",
      "notif.event.interfaceLinkRequestedNamed",
    ] as const) {
      expect(ja[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });
});
