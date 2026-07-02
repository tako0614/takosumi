import { expect, test } from "bun:test";
import {
  createNotificationPusherId,
  createNotificationPushGatewayRequest,
  MATRIX_PUSH_GATEWAY_NOTIFY_PATH,
  NOTIFICATION_PUSHER_REGISTRATION_PATH,
  parseNotificationPushGatewayRequest,
  parseNotificationPusherDeleteRequest,
  parseNotificationPusherSetRequest,
  type NotificationPusher,
} from "../../contract/notification-pushers.ts";

test("notification pusher contract parses Matrix-style HTTP pushers", () => {
  const parsed = parseNotificationPusherSetRequest(
    {
      product: "takos",
      scope: "account:user-1",
      pusher: {
        kind: "http",
        app_id: "jp.takos.mobile",
        app_display_name: "Takos",
        device_display_name: "Alice's phone",
        profile_tag: "default",
        lang: "ja-JP",
        pushkey: "device-token",
        data: {
          url: "https://push.example/_matrix/push/v1/notify",
          format: "event_id_only",
          provider: "fcm",
        },
      },
    },
    { product: "takos" },
  );

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.gatewayUrl).toBe(
    "https://push.example/_matrix/push/v1/notify",
  );
  expect(parsed.value.pusher.data).toEqual({
    url: "https://push.example/_matrix/push/v1/notify",
    format: "event_id_only",
    provider: "fcm",
  });
});

test("notification pusher contract rejects invalid gateway URLs and product mismatches", () => {
  const invalidUrl = parseNotificationPusherSetRequest({
    product: "takos",
    pusher: {
      kind: "http",
      app_id: "jp.takos.mobile",
      pushkey: "device-token",
      data: {
        url: "file:///tmp/socket",
      },
    },
  });
  expect(invalidUrl.ok).toBe(false);
  if (!invalidUrl.ok) expect(invalidUrl.error.field).toBe("pusher.data");

  const mismatch = parseNotificationPusherSetRequest(
    {
      product: "yurucommu",
      pusher: {
        kind: "http",
        app_id: "jp.takos.mobile",
        pushkey: "device-token",
        data: {
          url: "https://push.example/_matrix/push/v1/notify",
        },
      },
    },
    { product: "takos" },
  );
  expect(mismatch.ok).toBe(false);
  if (!mismatch.ok) expect(mismatch.error.field).toBe("product");
});

test("notification pusher contract parses delete requests by app id and pushkey", () => {
  const parsed = parseNotificationPusherDeleteRequest(
    {
      product: "takos",
      app_id: "jp.takos.mobile",
      pushkey: "device-token",
    },
    { product: "takos" },
  );

  expect(parsed).toEqual({
    ok: true,
    value: {
      appId: "jp.takos.mobile",
      pushkey: "device-token",
      product: "takos",
      scope: null,
    },
  });
});

test("notification push gateway request supports event-id-only delivery", () => {
  const pusher = {
    kind: "http",
    app_id: "jp.takos.mobile",
    pushkey: "device-token",
    data: {
      url: "https://push.example/_matrix/push/v1/notify",
      format: "event_id_only",
      provider: "fcm",
    },
  } satisfies NotificationPusher;

  const request = createNotificationPushGatewayRequest({
    now: new Date("2026-07-01T00:00:00.000Z"),
    pushers: [pusher],
    event: {
      id: "notif_1",
      scopeId: "workspace_1",
      type: "takos.notification",
      sender: "user_1",
      content: { title: "Hidden in event_id_only mode" },
      counts: { unread: 2, missed_calls: 0 },
    },
  });

  expect(request).toEqual({
    notification: {
      event_id: "notif_1",
      room_id: "workspace_1",
      counts: { unread: 2 },
      devices: [
        {
          app_id: "jp.takos.mobile",
          pushkey: "device-token",
          pushkey_ts: 1782864000,
          data: {
            format: "event_id_only",
            provider: "fcm",
          },
        },
      ],
    },
  });
});

test("notification push gateway parser accepts Matrix-style notify payloads", () => {
  const parsed = parseNotificationPushGatewayRequest({
    notification: {
      event_id: "notif_1",
      room_id: "workspace_1",
      counts: { unread: 2, missed_calls: 0 },
      devices: [
        {
          app_id: "jp.takos.mobile",
          pushkey: "opaque-gateway-pushkey",
          pushkey_ts: 1782864000,
          data: {
            format: "event_id_only",
            provider: "webhook",
          },
          tweaks: {
            sound: "default",
          },
        },
      ],
    },
  });

  expect(parsed).toEqual({
    ok: true,
    value: {
      request: {
        notification: {
          event_id: "notif_1",
          room_id: "workspace_1",
          counts: { unread: 2, missed_calls: 0 },
          devices: [
            {
              app_id: "jp.takos.mobile",
              pushkey: "opaque-gateway-pushkey",
              pushkey_ts: 1782864000,
              data: {
                format: "event_id_only",
                provider: "webhook",
              },
              tweaks: {
                sound: "default",
              },
            },
          ],
        },
      },
    },
  });
});

test("notification push gateway parser rejects leaked gateway URLs", () => {
  const parsed = parseNotificationPushGatewayRequest({
    notification: {
      devices: [
        {
          app_id: "jp.takos.mobile",
          pushkey: "opaque-gateway-pushkey",
          data: {
            url: "https://push.example/_matrix/push/v1/notify",
            provider: "webhook",
          },
        },
      ],
    },
  });

  expect(parsed).toEqual({
    ok: false,
    error: {
      code: "BAD_REQUEST",
      error: "device.data is invalid",
      field: "notification.devices.0.data",
    },
  });
});

test("notification pusher constants keep the host route and Matrix gateway path separate", () => {
  expect(NOTIFICATION_PUSHER_REGISTRATION_PATH).toBe(
    "/api/notifications/pushers",
  );
  expect(MATRIX_PUSH_GATEWAY_NOTIFY_PATH).toBe("/_matrix/push/v1/notify");
  expect(
    createNotificationPusherId({
      app_id: "jp.takos.mobile",
      pushkey: "device-token",
    }),
  ).toBe("jp.takos.mobile\0device-token");
});
