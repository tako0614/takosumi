import {
  TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH,
  takosumiAccountsNotificationPusherPath,
  type TakosumiAccountsNotificationPusher,
  type TakosumiAccountsNotificationPusherList,
} from "@takosjp/takosumi-accounts-contract";
import { apiFetch } from "./http.ts";

/** Devices registered to receive this instance's own notifications. */
export async function listNotificationPushers(): Promise<TakosumiAccountsNotificationPusherList> {
  return await apiFetch<TakosumiAccountsNotificationPusherList>(
    TAKOSUMI_ACCOUNTS_NOTIFICATION_PUSHERS_PATH,
  );
}

export async function deleteNotificationPusher(pusherId: string): Promise<void> {
  await apiFetch(takosumiAccountsNotificationPusherPath(pusherId), {
    method: "DELETE",
  });
}

export type NotificationPusherHealth = "ok" | "failing" | "unused";

/** `failing` while the latest outcome was a failure; `unused` before any send. */
export function notificationPusherHealth(
  pusher: Pick<TakosumiAccountsNotificationPusher, "failing" | "last_success_at">,
): NotificationPusherHealth {
  if (pusher.failing) return "failing";
  return pusher.last_success_at ? "ok" : "unused";
}
