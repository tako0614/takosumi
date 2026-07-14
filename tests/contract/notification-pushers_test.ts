import { expect, test } from "bun:test";
import {
  createNotificationPusherId,
  createNotificationPushGatewayRequest,
  MAX_NOTIFICATION_PUSHER_DATA_BYTES,
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

test("notification pusher data preserves bounded JSON without prototype mutation", () => {
  const data = JSON.parse(`{
    "url": "https://push.example/_matrix/push/v1/notify",
    "format": "full",
    "provider": "fcm",
    "nested": { "values": [null, true, 42, "ok"] },
    "__proto__": { "polluted": true }
  }`) as unknown;
  const parsed = parseNotificationPusherSetRequest({
    product: "takos",
    pusher: {
      kind: "http",
      app_id: "jp.takos.mobile",
      pushkey: "device-token",
      data,
    },
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.pusher.data.url).toBe(
    "https://push.example/_matrix/push/v1/notify",
  );
  expect(parsed.value.pusher.data.format).toBe("full");
  expect(parsed.value.pusher.data.provider).toBe("fcm");
  expect(parsed.value.pusher.data.nested).toEqual({
    values: [null, true, 42, "ok"],
  });
  expect(
    Object.prototype.hasOwnProperty.call(parsed.value.pusher.data, "__proto__"),
  ).toBe(true);
  expect(
    Object.getOwnPropertyDescriptor(parsed.value.pusher.data, "__proto__")
      ?.value,
  ).toEqual({ polluted: true });
  expect(Object.getPrototypeOf(parsed.value.pusher.data)).toBe(
    Object.prototype,
  );
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test("notification pusher data rejects oversized or structurally unsafe JSON", () => {
  const cyclic: Record<string, unknown> = {
    url: "https://push.example/_matrix/push/v1/notify",
  };
  cyclic.self = cyclic;

  let tooDeep: Record<string, unknown> = { leaf: true };
  for (let depth = 0; depth < 10; depth += 1) {
    tooDeep = { nested: tooDeep };
  }

  let getterRead = false;
  const accessorData: Record<string, unknown> = {
    url: "https://push.example/_matrix/push/v1/notify",
  };
  Object.defineProperty(accessorData, "secret", {
    enumerable: true,
    get() {
      getterRead = true;
      return "must-not-run";
    },
  });

  const inheritedData = Object.assign(Object.create({ inherited: true }), {
    url: "https://push.example/_matrix/push/v1/notify",
    provider: "fcm",
  }) as Record<string, unknown>;
  const symbolData: Record<string | symbol, unknown> = {
    url: "https://push.example/_matrix/push/v1/notify",
  };
  symbolData[Symbol("hidden")] = true;
  const sparseArray = Array(2) as unknown[];
  sparseArray[1] = "present";

  const cases: readonly (readonly [string, unknown])[] = [
    [
      "serialized bytes",
      {
        url: "https://push.example/_matrix/push/v1/notify",
        first: "x".repeat(MAX_NOTIFICATION_PUSHER_DATA_BYTES / 2),
        second: "y".repeat(MAX_NOTIFICATION_PUSHER_DATA_BYTES / 2),
      },
    ],
    [
      "entry count",
      {
        url: "https://push.example/_matrix/push/v1/notify",
        ...Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`key_${index}`, index]),
        ),
      },
    ],
    [
      "array length",
      {
        url: "https://push.example/_matrix/push/v1/notify",
        values: Array.from({ length: 65 }, () => null),
      },
    ],
    ["depth", { url: "https://push.example", nested: tooDeep }],
    ["cycle", cyclic],
    ["non-finite number", { url: "https://push.example", value: NaN }],
    ["undefined", { url: "https://push.example", value: undefined }],
    ["bigint", { url: "https://push.example", value: 1n }],
    ["accessor", accessorData],
    ["inherited prototype", inheritedData],
    ["symbol property", symbolData],
    ["non-JSON object", { url: "https://push.example", value: new Date() }],
    ["sparse array", { url: "https://push.example", value: sparseArray }],
  ];

  for (const [label, unsafeData] of cases) {
    const parsed = parseNotificationPusherSetRequest({
      product: "takos",
      pusher: {
        kind: "http",
        app_id: "jp.takos.mobile",
        pushkey: `device-token-${label}`,
        data: unsafeData,
      },
    });
    expect(parsed.ok, label).toBe(false);
    if (!parsed.ok) expect(parsed.error.field, label).toBe("pusher.data");
  }
  expect(getterRead).toBe(false);
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

test("notification pusher gateways require credential-free HTTPS outside loopback", () => {
  for (const url of [
    "http://push.example/_matrix/push/v1/notify",
    "https://user:secret@push.example/_matrix/push/v1/notify",
    "https://push.example:8443/_matrix/push/v1/notify",
    "https://push.example/_matrix/push/v1/notify#fragment",
  ]) {
    const parsed = parseNotificationPusherSetRequest({
      product: "takos",
      pusher: {
        kind: "http",
        app_id: "jp.takos.mobile",
        pushkey: "device-token",
        data: { url },
      },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.field).toBe("pusher.data");
  }

  const loopback = parseNotificationPusherSetRequest({
    product: "takos",
    pusher: {
      kind: "http",
      app_id: "jp.takos.mobile",
      pushkey: "device-token",
      data: { url: "http://127.0.0.1:8787/_matrix/push/v1/notify" },
    },
  });
  expect(loopback.ok).toBe(true);
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
