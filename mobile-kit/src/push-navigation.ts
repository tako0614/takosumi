import type { MobilePushNotificationCallbackInput } from "./client.ts";

export function resolvePushNotificationPath(
  input: MobilePushNotificationCallbackInput,
): string | undefined {
  const value = firstString(
    input.notification.data.path,
    input.notification.data.route,
    input.notification.data.url,
    input.notification.data.href,
  );
  if (!value) {
    return typeof input.notification.data.event_id === "string" &&
      input.notification.data.event_id.trim()
      ? "/notifications"
      : undefined;
  }
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    if (url.origin !== new URL(input.session.hostUrl).origin) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}
