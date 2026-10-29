import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  classifyNotificationWebPushResponse,
  createNotificationPusherId,
  createNotificationPushGatewayRequest,
  createNotificationWebPushPayload,
  MAX_NOTIFICATION_PUSHER_DATA_BYTES,
  MAX_NOTIFICATION_WEB_PUSH_PLAINTEXT_BYTES,
  normalizeNotificationWebPushUrl,
  notificationWebPushPusherNeedsActivation,
  NOTIFICATION_PUSHER_ACK_ERROR_STATUS,
  NOTIFICATION_PUSHER_ACK_PATH,
  NOTIFICATION_PUSHER_ACK_TOKEN_LIFETIME_SECONDS,
  NOTIFICATION_PUSHER_CAPABILITIES_PATH,
  NOTIFICATION_PUSHER_CAPABILITIES_VERSION,
  NOTIFICATION_PUSHER_REGISTRATION_PATH,
  NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES,
  NOTIFICATION_WEB_PUSH_CONTENT_ENCODING,
  NOTIFICATION_WEB_PUSH_DEFAULT_TTL_SECONDS,
  parseNotificationPushGatewayRequest,
  parseNotificationPusherAckRequest,
  parseNotificationPusherCapabilities,
  parseNotificationPusherCapabilitiesResponse,
  parseNotificationPusherDeleteRequest,
  parseNotificationPusherSetRequest,
  parseNotificationPusherSetRequestV2,
  toNotificationWebPushPusherPublicData,
  type NotificationHttpPusherListEntry,
  type NotificationPushDeliveryOutcome,
  type NotificationPusher,
  type NotificationPusherAckError,
  type NotificationPusherAckResponse,
  type NotificationPusherCapabilities,
  type NotificationPusherKind,
  type NotificationPusherKindCapabilities,
  type NotificationPusherListResponse,
  type NotificationPusherRegistration,
  type NotificationPusherSetRequestV2,
  type NotificationPusherSetRequestV2Options,
  type NotificationPusherSetResponseV2,
  type NotificationWebPushActivationMessage,
  type NotificationWebPushPusher,
  type NotificationWebPushPusherListEntry,
  type NotificationWebPushPusherPublicData,
} from "../../contract/notification-pushers.ts";

// Public sample keys from RFC 8291 Appendix A: the user agent's ECDH public
// key and auth secret, and the application server's public key.
const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const VAPID_PUBLIC_KEY =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const VAPID_KEY_ID = "vapid-2026-10";
const PUSH_URL = "https://fcm.googleapis.com/fcm/send/example-subscription-id";
const ACK_TOKEN = "6fc76b70-5fad-4eb7-93ea-a1af7a03258b";

const HOST_KINDS = {
  http: {},
  webpush: {
    vapid_public_key: VAPID_PUBLIC_KEY,
    vapid_key_id: VAPID_KEY_ID,
    content_encoding: "aes128gcm",
  },
} satisfies NotificationPusherKindCapabilities;

function base64Url(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString("base64url");
}

function webPushPusher(
  overrides: { readonly [key: string]: unknown } = {},
  data: { readonly [key: string]: unknown } = {},
): Record<string, unknown> {
  return {
    kind: "webpush",
    app_id: "jp.yurucommu.web",
    pushkey: P256DH,
    data: {
      url: PUSH_URL,
      auth: AUTH,
      format: "event_id_only",
      vapid_key_id: VAPID_KEY_ID,
      ...data,
    },
    ...overrides,
  };
}

function parseWebPush(
  body: unknown,
  options: Partial<NotificationPusherSetRequestV2Options> = {},
): NotificationWebPushPusher {
  const parsed = parseNotificationPusherSetRequestV2(body, {
    kinds: HOST_KINDS,
    ...options,
  });
  if (!parsed.ok || parsed.value.kind !== "webpush") {
    throw new Error(`expected a webpush pusher: ${JSON.stringify(parsed)}`);
  }
  return parsed.value.pusher;
}

function expectSetError(
  body: unknown,
  field: string | undefined,
  options: Partial<NotificationPusherSetRequestV2Options> = {},
): string {
  const parsed = parseNotificationPusherSetRequestV2(body, {
    kinds: HOST_KINDS,
    ...options,
  });
  expect(parsed.ok, JSON.stringify(body)).toBe(false);
  if (parsed.ok) return "";
  expect(parsed.error.code).toBe("BAD_REQUEST");
  expect(parsed.error.field, JSON.stringify(body)).toBe(field);
  return parsed.error.error;
}

test("pushers v2 type assertions are checked by the compiler", () => {
  // The production tsconfig excludes tests and Bun only transpiles this file,
  // so compile it to enforce the @ts-expect-error assertions at the bottom.
  const root = resolve(import.meta.dir, "../..");
  const compiled = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--allowImportingTsExtensions",
      "--module",
      "Preserve",
      "--moduleResolution",
      "Bundler",
      "--target",
      "ESNext",
      "--lib",
      "ESNext,DOM,DOM.Iterable",
      "--types",
      "bun,node",
      "--pretty",
      "false",
      import.meta.path,
    ],
    { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  if (compiled.error) throw compiled.error;
  expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
}, 65_000);

test("pushers v2 registers a webpush pusher in the MSC4174 layout", () => {
  const parsed = parseNotificationPusherSetRequestV2(
    {
      product: "yurucommu",
      scope: "account:user-1",
      pusher: webPushPusher({
        device_display_name: "iPhone",
        lang: "ja-JP",
      }),
    },
    { product: "yurucommu", kinds: HOST_KINDS },
  );

  expect(parsed).toEqual({
    ok: true,
    value: {
      kind: "webpush",
      pusher: {
        kind: "webpush",
        app_id: "jp.yurucommu.web",
        pushkey: P256DH,
        device_display_name: "iPhone",
        lang: "ja-JP",
        data: {
          url: PUSH_URL,
          auth: AUTH,
          format: "event_id_only",
          vapid_key_id: VAPID_KEY_ID,
        },
      },
      product: "yurucommu",
      scope: "account:user-1",
      pushResourceUrl: PUSH_URL,
      append: false,
    },
  });
});

test("webpush data normalizes the push URL like v1 and preserves extra JSON safely", () => {
  const extra = JSON.parse(`{
    "subscribed_from": "home-screen",
    "__proto__": { "polluted": true }
  }`) as Record<string, unknown>;
  const pusher = parseWebPush({
    pusher: webPushPusher(
      {},
      {
        url: " https://FCM.googleapis.com:443/fcm/send/id ",
        format: null,
        ...extra,
      },
    ),
  });

  expect(pusher.data.url).toBe("https://fcm.googleapis.com/fcm/send/id");
  expect(pusher.data.format).toBe("event_id_only");
  expect(pusher.data.subscribed_from).toBe("home-screen");
  expect(
    Object.getOwnPropertyDescriptor(pusher.data, "__proto__")?.value,
  ).toEqual({ polluted: true });
  expect(Object.getPrototypeOf(pusher.data)).toBe(Object.prototype);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test("webpush push URLs must be public HTTPS push service URLs", () => {
  const long = `https://wns2-par02p.notify.windows.com/w/?token=${"A".repeat(2048 - "https://wns2-par02p.notify.windows.com/w/?token=".length)}`;
  const accepted: readonly (readonly [string, string])[] = [
    [PUSH_URL, PUSH_URL],
    [
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample",
    ],
    [
      "https://web.push.apple.com/QGexampleSubscriptionToken",
      "https://web.push.apple.com/QGexampleSubscriptionToken",
    ],
    [
      "https://ntfy.sh/upExampleTopic?up=1",
      "https://ntfy.sh/upExampleTopic?up=1",
    ],
    [
      "https://FCM.googleapis.com:443/fcm/send/id",
      "https://fcm.googleapis.com/fcm/send/id",
    ],
    // Push endpoints are not bounded by browsers; the data budget excludes
    // `url`, as v1 does for gateway URLs.
    [long, long],
  ];
  for (const [input, normalized] of accepted) {
    expect(normalizeNotificationWebPushUrl(input), input).toBe(normalized);
    const pusher = parseWebPush({ pusher: webPushPusher({}, { url: input }) });
    expect(pusher.data.url).toBe(normalized);
  }

  const rejected: readonly unknown[] = [
    "http://fcm.googleapis.com/fcm/send/id",
    // Unlike v1 gateways, there is no loopback exception.
    "http://127.0.0.1:8787/push",
    "http://localhost:8787/push",
    "wss://fcm.googleapis.com/fcm/send/id",
    "file:///tmp/push",
    "https://user:secret@fcm.googleapis.com/fcm/send/id",
    "https://fcm.googleapis.com:8443/fcm/send/id",
    "https://fcm.googleapis.com/fcm/send/id#fragment",
    "https://fcm.googleapis.com/fcm/send/id#",
    "https://0x7f.1/push",
    "https://2130706433/push",
    "https://127.0.0.1/push",
    "https://10.0.0.8/push",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/push",
    "https://[fd00::1]/push",
    "https://[2001:db8::1]/push",
    "https://localhost/push",
    "https://push.localhost/push",
    "https://pushserver/push",
    "https://printer.local/push",
    "https://metadata.google.internal/push",
    "https://router.home.arpa/push",
    "https://nas.lan/push",
    "https://fcm.googleapis.com./fcm/send/id",
    "https://push_service.example.com/push",
    `${long}A`,
    "",
    42,
    null,
    undefined,
  ];
  for (const url of rejected) {
    expect(normalizeNotificationWebPushUrl(url), String(url)).toBeNull();
    expectSetError({ pusher: webPushPusher({}, { url }) }, "pusher.data.url");
  }
});

test("webpush pushkey is the canonical p256dh key", () => {
  const point = [...Buffer.from(P256DH, "base64url")];
  const cases: readonly (readonly [string, unknown])[] = [
    ["padded", `${P256DH}=`],
    // The last of 87 characters carries 2 unused bits: "4" and "5" decode to
    // the same bytes, but only "4" is canonical.
    ["unused bits set", `${P256DH.slice(0, -1)}5`],
    ["64 bytes", base64Url(point.slice(0, 64))],
    ["compressed", base64Url([0x02, ...point.slice(1, 33)])],
    ["no uncompressed prefix", base64Url([0x05, ...point.slice(1)])],
    [
      "standard base64 alphabet",
      P256DH.replace(/-/gu, "+").replace(/_/gu, "/"),
    ],
    ["surrounding whitespace", ` ${P256DH}`],
    // The earlier draft of ADR 0026 used the endpoint here.
    ["endpoint", PUSH_URL],
    ["auth secret", AUTH],
    ["number", 65],
    ["missing", undefined],
  ];
  for (const [label, pushkey] of cases) {
    const error = expectSetError(
      { pusher: webPushPusher({ pushkey }) },
      "pusher.pushkey",
    );
    expect(error, label).toContain("p256dh");
  }
});

test("webpush data.auth is a canonical 16-byte secret", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["15 bytes", base64Url(Array(15).fill(7))],
    ["17 bytes", base64Url(Array(17).fill(7))],
    ["padded", `${AUTH}==`],
    ["unused bits set", `${AUTH.slice(0, -1)}h`],
    [
      "standard base64 alphabet",
      base64Url(Array(16).fill(0xfb)).replace(/_/gu, "/"),
    ],
    ["number", 16],
    ["missing", undefined],
  ];
  for (const [label, auth] of cases) {
    const parsed = parseNotificationPusherSetRequestV2(
      { pusher: webPushPusher({}, { auth }) },
      { kinds: HOST_KINDS },
    );
    expect(parsed.ok, label).toBe(false);
    if (!parsed.ok) expect(parsed.error.field, label).toBe("pusher.data.auth");
  }
});

test("webpush data refuses PushSubscription.toJSON keys and checks format, key id and size", () => {
  const keysError = expectSetError(
    {
      pusher: webPushPusher(
        {},
        { auth: undefined, keys: { p256dh: P256DH, auth: AUTH } },
      ),
    },
    "pusher.data.keys",
  );
  expect(keysError).toContain("data.auth");

  expectSetError(
    { pusher: webPushPusher({}, { vapid_key_id: undefined }) },
    "pusher.data.vapid_key_id",
  );
  expectSetError(
    { pusher: webPushPusher({}, { vapid_key_id: "not a key id" }) },
    "pusher.data.vapid_key_id",
  );
  const rotated = expectSetError(
    { pusher: webPushPusher({}, { vapid_key_id: "vapid-2026-01" }) },
    "pusher.data.vapid_key_id",
  );
  expect(rotated).toContain("current VAPID key");

  expectSetError(
    { pusher: webPushPusher({}, { format: "full" }) },
    "pusher.data.format",
  );
  expectSetError({ pusher: webPushPusher({ data: "url" }) }, "pusher.data");
  expectSetError({ pusher: webPushPusher({ data: [] }) }, "pusher.data");
  expectSetError(
    {
      pusher: webPushPusher(
        {},
        { padding: "x".repeat(MAX_NOTIFICATION_PUSHER_DATA_BYTES) },
      ),
    },
    "pusher.data",
  );
  expectSetError(
    { pusher: webPushPusher({ device_display_name: "x".repeat(129) }) },
    "pusher.device_display_name",
  );
  expectSetError(
    { pusher: webPushPusher({ app_id: "not an app id" }) },
    "pusher.app_id",
  );
});

test("pushers v2 registers only the kinds this host advertises", () => {
  const webPushOnHttpHost = expectSetError(
    { pusher: webPushPusher() },
    "pusher.kind",
    { kinds: { http: {} } },
  );
  expect(webPushOnHttpHost).toBe(
    "pusher.kind webpush is not available on this host",
  );
  expectSetError(
    {
      pusher: {
        kind: "http",
        app_id: "jp.takos.mobile",
        pushkey: "device-token",
        data: { url: "https://push.example/_matrix/push/v1/notify" },
      },
    },
    "pusher.kind",
    { kinds: { webpush: HOST_KINDS.webpush } },
  );
  expect(
    expectSetError({ pusher: webPushPusher({ kind: "email" }) }, "pusher.kind"),
  ).toBe("pusher.kind must be http or webpush");
  expectSetError({ pusher: webPushPusher({ kind: undefined }) }, "pusher.kind");
  expectSetError({ pusher: webPushPusher() }, "pusher.kind", { kinds: {} });
  expectSetError({ pusher: "webpush" }, undefined);
  expectSetError("pusher", undefined);
});

test("webpush push URLs honour the operator allowlist but never gateway_hosts", () => {
  const options = {
    kinds: {
      http: { gateway_hosts: ["push.example"] },
      webpush: HOST_KINDS.webpush,
    },
    pushResourceHosts: ["FCM.googleapis.com", "*.notify.windows.com"],
  };
  for (const url of [
    PUSH_URL,
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ]) {
    const parsed = parseNotificationPusherSetRequestV2(
      { pusher: webPushPusher({}, { url }) },
      options,
    );
    expect(parsed.ok, url).toBe(true);
  }
  for (const url of [
    "https://notify.windows.com/w/?token=abc",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://push.example/_matrix/push/v1/notify",
  ]) {
    expectSetError(
      { pusher: webPushPusher({}, { url }) },
      "pusher.data.url",
      options,
    );
  }

  // Without an allowlist, http's gateway_hosts does not narrow webpush.
  const parsed = parseNotificationPusherSetRequestV2(
    { pusher: webPushPusher() },
    { kinds: options.kinds },
  );
  expect(parsed.ok).toBe(true);
});

test("pushers v2 http registrations normalize exactly like v1 and honour gateway_hosts", () => {
  const body = {
    product: "takos",
    scope: "account:user-1",
    pusher: {
      kind: "http",
      app_id: "jp.takos.mobile",
      app_display_name: "Takos",
      pushkey: "  device-token  ",
      data: {
        url: "https://push.example/_matrix/push/v1/notify",
        format: "event_id_only",
        provider: "fcm",
      },
    },
  };
  const v1 = parseNotificationPusherSetRequest(body, { product: "takos" });
  const v2 = parseNotificationPusherSetRequestV2(body, {
    product: "takos",
    kinds: HOST_KINDS,
  });
  expect(v1.ok).toBe(true);
  expect(v2.ok).toBe(true);
  if (!v1.ok || !v2.ok) return;
  expect(v2.value).toEqual({ ...v1.value, kind: "http", append: false });

  const listedHosts = {
    kinds: { http: { gateway_hosts: ["PUSH.example", "*.gateway.example"] } },
    // The webpush allowlist does not apply to http.
    pushResourceHosts: ["fcm.googleapis.com"],
  };
  for (const url of [
    "https://push.example/_matrix/push/v1/notify",
    "https://eu.gateway.example/_matrix/push/v1/notify",
  ]) {
    const parsed = parseNotificationPusherSetRequestV2(
      { pusher: { ...body.pusher, data: { url } } },
      listedHosts,
    );
    expect(parsed.ok, url).toBe(true);
  }
  for (const url of [
    "https://gateway.example/_matrix/push/v1/notify",
    "https://other.example/_matrix/push/v1/notify",
    "https://push.example.attacker.example/_matrix/push/v1/notify",
  ]) {
    expectSetError(
      { pusher: { ...body.pusher, data: { url } } },
      "pusher.data.url",
      listedHosts,
    );
  }
  // URL problems keep the v1 field.
  expectSetError(
    { pusher: { ...body.pusher, data: { url: "file:///tmp/socket" } } },
    "pusher.data",
  );
});

test("pushers v2 carries Matrix append and defaults it to false", () => {
  for (const [append, expected] of [
    [undefined, false],
    [null, false],
    [false, false],
    [true, true],
  ] as const) {
    const parsed = parseNotificationPusherSetRequestV2(
      { append, pusher: webPushPusher() },
      { kinds: HOST_KINDS },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.append).toBe(expected);
  }
  expectSetError({ append: "true", pusher: webPushPusher() }, "append");
  expectSetError({ append: 1, pusher: webPushPusher() }, "append");
});

test("pushers v2 checks product and scope like v1", () => {
  const mismatch = parseNotificationPusherSetRequestV2(
    { product: "yurume", pusher: webPushPusher() },
    { product: "yurucommu", kinds: HOST_KINDS },
  );
  expect(mismatch).toEqual({
    ok: false,
    error: {
      code: "BAD_REQUEST",
      error: "product must be yurucommu",
      field: "product",
    },
  });
  expectSetError({ scope: "not a scope", pusher: webPushPusher() }, "scope");
});

test("the v1 parser still accepts only http pushers", () => {
  expect(
    parseNotificationPusherSetRequest({ pusher: webPushPusher() }),
  ).toEqual({
    ok: false,
    error: {
      code: "BAD_REQUEST",
      error: "pusher.kind must be http",
      field: "pusher.kind",
    },
  });
});

test("webpush pushers delete by app id and p256dh with the unchanged delete parser", () => {
  expect(
    parseNotificationPusherDeleteRequest({
      app_id: "jp.yurucommu.web",
      pushkey: P256DH,
    }),
  ).toEqual({
    ok: true,
    value: {
      appId: "jp.yurucommu.web",
      pushkey: P256DH,
      product: null,
      scope: null,
    },
  });
  expect(
    createNotificationPusherId({ app_id: "jp.yurucommu.web", pushkey: P256DH }),
  ).toBe(`jp.yurucommu.web\0${P256DH}`);
});

test("webpush pushers leave the host without data.auth and say whether they are activated", () => {
  const pusher = parseWebPush({
    pusher: webPushPusher({}, { subscribed_from: "home-screen" }),
  });
  const publicData = toNotificationWebPushPusherPublicData(pusher.data);
  expect(publicData).toEqual({
    subscribed_from: "home-screen",
    url: PUSH_URL,
    format: "event_id_only",
    vapid_key_id: VAPID_KEY_ID,
  });
  expect(Object.prototype.hasOwnProperty.call(publicData, "auth")).toBe(false);
  expect(pusher.data.auth).toBe(AUTH);

  const registration = {
    id: createNotificationPusherId(pusher),
    kind: "webpush",
    app_id: pusher.app_id,
    data: publicData,
    activated: false,
    registered_at: "2026-10-29T00:00:00.000Z",
    last_seen_at: "2026-10-29T00:00:00.000Z",
  } as const;
  const setResponse: NotificationPusherSetResponseV2 = {
    pusher: registration,
  };
  const entry: NotificationWebPushPusherListEntry = {
    ...registration,
    pushkey: pusher.pushkey,
    activated: true,
  };
  const listResponse: NotificationPusherListResponse = { pushers: [entry] };
  for (const body of [setResponse, listResponse]) {
    expect(JSON.stringify(body)).not.toContain(AUTH);
  }
  expect(JSON.stringify(listResponse)).toContain(P256DH);
});

test("webpush activation is needed for a new pusher, a changed url or auth, or one never activated", () => {
  const next = parseWebPush({ pusher: webPushPusher() });
  const otherAuth = base64Url(Array(16).fill(9));
  const cases: readonly (readonly [
    string,
    Parameters<typeof notificationWebPushPusherNeedsActivation>[0],
    boolean,
  ])[] = [
    ["new pusher", undefined, true],
    ["new pusher (null)", null, true],
    [
      "activated and unchanged",
      { activated: true, data: { url: PUSH_URL, auth: AUTH } },
      false,
    ],
    [
      "url changed",
      {
        activated: true,
        data: { url: `${PUSH_URL}-old`, auth: AUTH },
      },
      true,
    ],
    [
      "auth changed",
      { activated: true, data: { url: PUSH_URL, auth: otherAuth } },
      true,
    ],
    [
      "never activated",
      { activated: false, data: { url: PUSH_URL, auth: AUTH } },
      true,
    ],
  ];
  for (const [label, previous, expected] of cases) {
    expect(
      notificationWebPushPusherNeedsActivation(previous, next),
      label,
    ).toBe(expected);
  }

  // A display-name change on an activated pusher keeps it activated, even
  // when the URL was sent in another spelling of the same address.
  const renamed = parseWebPush({
    pusher: webPushPusher(
      { device_display_name: "iPad" },
      {
        url: "https://FCM.googleapis.com:443/fcm/send/example-subscription-id",
      },
    ),
  });
  expect(
    notificationWebPushPusherNeedsActivation(
      { activated: true, data: next.data },
      renamed,
    ),
  ).toBe(false);
});

test("activation acks carry app_id and an opaque ack_token", () => {
  const message: NotificationWebPushActivationMessage = {
    app_id: "jp.yurucommu.web",
    ack_token: ACK_TOKEN,
  };
  // The service worker posts the activation plaintext unchanged.
  expect(
    parseNotificationPusherAckRequest(JSON.parse(JSON.stringify(message))),
  ).toEqual({
    ok: true,
    value: { appId: "jp.yurucommu.web", ackToken: ACK_TOKEN },
  });
  for (const token of [
    "0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ._~abcdefghijklmnopqrstuvwxyz",
    "a",
    "x".repeat(255),
    crypto.randomUUID(),
  ]) {
    const parsed = parseNotificationPusherAckRequest({
      app_id: "jp.yurucommu.web",
      ack_token: token,
    });
    expect(parsed.ok, token).toBe(true);
  }

  const invalidTokens: readonly unknown[] = [
    "",
    " ",
    ` ${ACK_TOKEN}`,
    "token/with/slash",
    "token+plus",
    "token=",
    "トークン",
    "x".repeat(256),
    42,
    null,
    undefined,
  ];
  for (const ackToken of invalidTokens) {
    expect(
      parseNotificationPusherAckRequest({
        app_id: "jp.yurucommu.web",
        ack_token: ackToken,
      }),
      String(ackToken),
    ).toEqual({
      ok: false,
      error: {
        code: "BAD_REQUEST",
        error: "ack_token is invalid",
        field: "ack_token",
      },
    });
  }
  expect(
    parseNotificationPusherAckRequest({
      app_id: "bad id",
      ack_token: ACK_TOKEN,
    }),
  ).toEqual({
    ok: false,
    error: { code: "BAD_REQUEST", error: "app_id is invalid", field: "app_id" },
  });
  expect(parseNotificationPusherAckRequest([ACK_TOKEN])).toEqual({
    ok: false,
    error: { code: "BAD_REQUEST", error: "body must be an object" },
  });
});

test("ack failures use MSC4174 statuses and the v1 error-code style", () => {
  expect(NOTIFICATION_PUSHER_ACK_ERROR_STATUS).toEqual({
    NOT_FOUND: 404,
    EXPIRED_ACTIVATION_TOKEN: 400,
    UNKNOWN_ACTIVATION_TOKEN: 400,
  });
  expect(Object.isFrozen(NOTIFICATION_PUSHER_ACK_ERROR_STATUS)).toBe(true);
  const expired: NotificationPusherAckError = {
    code: "EXPIRED_ACTIVATION_TOKEN",
    error: "ack_token has expired",
  };
  expect(NOTIFICATION_PUSHER_ACK_ERROR_STATUS[expired.code]).toBe(400);
  expect(NOTIFICATION_PUSHER_ACK_TOKEN_LIFETIME_SECONDS).toBe(5 * 60);
  expect(NOTIFICATION_PUSHER_ACK_PATH).toBe("/api/notifications/pushers/ack");
});

test("the webpush plaintext is the v1 gateway body for that one pusher", () => {
  const pusher = parseWebPush({
    pusher: webPushPusher({}, { subscribed_from: "home-screen" }),
  });
  const event = {
    id: "notif_1",
    scopeId: "room_1",
    type: "jp.yurucommu.mention",
    sender: "user_2",
    senderDisplayName: "Bob",
    priority: "high",
    content: { body: "never sent in event_id_only" },
    counts: { unread: 3, missed_calls: 0 },
  } as const;
  const now = new Date("2026-07-01T00:00:00.000Z");
  const payload = createNotificationWebPushPayload({
    event,
    pusher,
    now,
    tweaks: { sound: "default" },
  });

  expect(payload).toEqual({
    notification: {
      event_id: "notif_1",
      room_id: "room_1",
      counts: { unread: 3 },
      devices: [
        {
          app_id: "jp.yurucommu.web",
          pushkey: P256DH,
          pushkey_ts: 1782864000,
          data: {
            subscribed_from: "home-screen",
            format: "event_id_only",
            vapid_key_id: VAPID_KEY_ID,
          },
          tweaks: { sound: "default" },
        },
      ],
    },
  });
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain(AUTH);
  expect(serialized).not.toContain(PUSH_URL);
  expect(serialized).not.toContain("never sent");
  expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(
    MAX_NOTIFICATION_WEB_PUSH_PLAINTEXT_BYTES,
  );

  // It is exactly what the v1 builder produces for the equivalent gateway
  // pusher, and a service worker can read it with the v1 gateway parser.
  const gatewayPusher: NotificationPusher = {
    kind: "http",
    app_id: pusher.app_id,
    pushkey: pusher.pushkey,
    data: { ...toNotificationWebPushPusherPublicData(pusher.data) },
  };
  expect(payload).toEqual(
    createNotificationPushGatewayRequest({
      event,
      pushers: [gatewayPusher],
      now,
      tweaks: { sound: "default" },
    }),
  );
  expect(parseNotificationPushGatewayRequest(JSON.parse(serialized))).toEqual({
    ok: true,
    value: { request: JSON.parse(serialized) },
  });
});

test("capabilities parse the advertised kinds into canonical values", () => {
  const document = {
    version: 2,
    formats: ["event_id_only"],
    kinds: {
      http: {
        gateway_hosts: ["Push.Example.com", "push.example.com", "*.gw.example"],
      },
      webpush: {
        vapid_public_key: `${VAPID_PUBLIC_KEY}=`,
        vapid_key_id: VAPID_KEY_ID,
        content_encoding: "aes128gcm",
      },
    },
  };
  expect(parseNotificationPusherCapabilities(document)).toEqual({
    ok: true,
    value: {
      version: 2,
      formats: ["event_id_only"],
      kinds: {
        http: { gateway_hosts: ["push.example.com", "*.gw.example"] },
        webpush: {
          vapid_public_key: VAPID_PUBLIC_KEY,
          vapid_key_id: VAPID_KEY_ID,
          content_encoding: "aes128gcm",
        },
      },
    },
  });

  // A host can pass its own document's kinds straight to the set parser.
  const served = {
    version: NOTIFICATION_PUSHER_CAPABILITIES_VERSION,
    formats: ["event_id_only", "full"],
    kinds: HOST_KINDS,
  } satisfies NotificationPusherCapabilities;
  const reparsed = parseNotificationPusherCapabilities(
    JSON.parse(JSON.stringify(served)),
  );
  expect(reparsed).toEqual({ ok: true, value: served });
  expect(
    parseNotificationPusherCapabilities({ version: 2, formats: [], kinds: {} }),
  ).toEqual({ ok: true, value: { version: 2, formats: [], kinds: {} } });
});

test("capabilities ignore unknown kinds and formats for forward compatibility", () => {
  const parsed = parseNotificationPusherCapabilities(
    JSON.parse(`{
      "version": 3,
      "formats": ["event_id_only", "rich", "full"],
      "kinds": {
        "http": {},
        "webpush": {
          "vapid_public_key": "${VAPID_PUBLIC_KEY}",
          "vapid_key_id": "${VAPID_KEY_ID}",
          "content_encoding": "aes128gcm",
          "rotates_at": "2027-01-01T00:00:00Z"
        },
        "email": { "from": "notify@example.com" },
        "__proto__": { "fcm": {} }
      },
      "push_rules": true
    }`),
  );
  expect(parsed).toEqual({
    ok: true,
    value: {
      version: 3,
      formats: ["event_id_only", "full"],
      kinds: {
        http: {},
        webpush: {
          vapid_public_key: VAPID_PUBLIC_KEY,
          vapid_key_id: VAPID_KEY_ID,
          content_encoding: "aes128gcm",
        },
      },
    },
  });

  // A kind listed only through the prototype is not advertised.
  const inherited = parseNotificationPusherCapabilities(
    JSON.parse('{"version":2,"formats":[],"kinds":{"__proto__":{"http":{}}}}'),
  );
  expect(inherited).toEqual({
    ok: true,
    value: { version: 2, formats: [], kinds: {} },
  });
});

test("capabilities drop a known kind this client cannot use and keep the rest", () => {
  const webpush = HOST_KINDS.webpush;
  const unusableWebPush: readonly unknown[] = [
    { ...webpush, content_encoding: "aesgcm" },
    { ...webpush, content_encoding: undefined },
    { ...webpush, vapid_public_key: P256DH.slice(0, 43) },
    { ...webpush, vapid_public_key: undefined },
    { ...webpush, vapid_key_id: "" },
    "enabled",
  ];
  for (const candidate of unusableWebPush) {
    const parsed = parseNotificationPusherCapabilities({
      version: 2,
      formats: ["event_id_only"],
      kinds: { http: {}, webpush: candidate },
    });
    expect(parsed, JSON.stringify(candidate)).toEqual({
      ok: true,
      value: { version: 2, formats: ["event_id_only"], kinds: { http: {} } },
    });
  }

  const unusableHttp: readonly unknown[] = [
    { gateway_hosts: "push.example.com" },
    { gateway_hosts: ["https://push.example.com"] },
    { gateway_hosts: ["push.example.com:8443"] },
    { gateway_hosts: [42] },
    { gateway_hosts: Array.from({ length: 65 }, (_, i) => `p${i}.example`) },
    [],
  ];
  for (const candidate of unusableHttp) {
    const parsed = parseNotificationPusherCapabilities({
      version: 2,
      formats: ["event_id_only"],
      kinds: { http: candidate, webpush },
    });
    expect(parsed, JSON.stringify(candidate)).toEqual({
      ok: true,
      value: { version: 2, formats: ["event_id_only"], kinds: { webpush } },
    });
  }
  expect(
    parseNotificationPusherCapabilities({
      version: 2,
      formats: [],
      kinds: { http: { gateway_hosts: null } },
    }),
  ).toEqual({
    ok: true,
    value: { version: 2, formats: [], kinds: { http: {} } },
  });
});

test("capabilities reject documents that are not a v2 capabilities object", () => {
  const cases: readonly (readonly [unknown, string | undefined])[] = [
    [null, undefined],
    [[], undefined],
    [{ formats: [], kinds: {} }, "version"],
    [{ version: 1, formats: [], kinds: {} }, "version"],
    [{ version: "2", formats: [], kinds: {} }, "version"],
    [{ version: 2.5, formats: [], kinds: {} }, "version"],
    [{ version: 2, kinds: {} }, "formats"],
    [{ version: 2, formats: "event_id_only", kinds: {} }, "formats"],
    [{ version: 2, formats: [1], kinds: {} }, "formats"],
    [{ version: 2, formats: Array(17).fill("full"), kinds: {} }, "formats"],
    [{ version: 2, formats: [] }, "kinds"],
    [{ version: 2, formats: [], kinds: [] }, "kinds"],
  ];
  for (const [document, field] of cases) {
    const parsed = parseNotificationPusherCapabilities(document);
    expect(parsed.ok, JSON.stringify(document)).toBe(false);
    if (!parsed.ok) expect(parsed.error.field).toBe(field);
  }
});

test("a 404 from the capabilities path means a v1 host that accepts only http", () => {
  const v1Host = parseNotificationPusherCapabilitiesResponse(404, {
    error: "not found",
  });
  expect(v1Host).toEqual({
    ok: true,
    value: {
      version: 1,
      formats: ["event_id_only", "full"],
      kinds: { http: {} },
    },
  });
  if (!v1Host.ok) return;
  expect(v1Host.value).toBe(NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES);
  expect(Object.isFrozen(NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES)).toBe(true);
  expect(Object.isFrozen(NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES.kinds)).toBe(
    true,
  );
  expect(
    Object.isFrozen(NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES.formats),
  ).toBe(true);

  // A client choosing a kind from those capabilities finds no webpush.
  expectSetError({ pusher: webPushPusher() }, "pusher.kind", {
    kinds: v1Host.value.kinds,
  });

  expect(
    parseNotificationPusherCapabilitiesResponse(200, {
      version: 2,
      formats: ["event_id_only"],
      kinds: { webpush: HOST_KINDS.webpush },
    }),
  ).toEqual({
    ok: true,
    value: {
      version: 2,
      formats: ["event_id_only"],
      kinds: { webpush: HOST_KINDS.webpush },
    },
  });
  for (const status of [204, 401, 403, 405, 500, 503]) {
    expect(parseNotificationPusherCapabilitiesResponse(status, {})).toEqual({
      ok: false,
      error: {
        code: "BAD_REQUEST",
        error: `capabilities request returned status ${status}`,
        field: "status",
      },
    });
  }
  expect(parseNotificationPusherCapabilitiesResponse(200, "<html>").ok).toBe(
    false,
  );
});

test("Web Push service responses map onto the v1 outcome channels", () => {
  const cases: readonly (readonly [number, NotificationPushDeliveryOutcome])[] =
    [
      [201, "delivered"],
      [202, "delivered"],
      [200, "delivered"],
      [204, "delivered"],
      [404, "rejected"],
      [410, "rejected"],
      [408, "retryable"],
      [429, "retryable"],
      [500, "retryable"],
      [502, "retryable"],
      [503, "retryable"],
      [504, "retryable"],
      [400, "failed"],
      [401, "failed"],
      // Deliberately not MSC4174's delete; see the function's comment.
      [403, "failed"],
      [413, "failed"],
      [301, "failed"],
      [302, "failed"],
      [101, "failed"],
      [0, "failed"],
      [600, "failed"],
      [201.5, "failed"],
      [Number.NaN, "failed"],
    ];
  for (const [status, outcome] of cases) {
    expect(
      classifyNotificationWebPushResponse({ status }),
      String(status),
    ).toEqual({ outcome });
  }
  expect(
    classifyNotificationWebPushResponse({ transportError: "timeout" }),
  ).toEqual({ outcome: "retryable" });
  expect(
    classifyNotificationWebPushResponse({ transportError: "network" }),
  ).toEqual({ outcome: "retryable" });
});

test("retryable Web Push outcomes honour Retry-After seconds and IMF-fixdate", () => {
  const now = new Date("2026-10-29T00:00:00.000Z");
  const retryAfter = (status: number, value: string | null | undefined) =>
    classifyNotificationWebPushResponse({ status, retryAfter: value }, { now });

  expect(retryAfter(429, "120")).toEqual({
    outcome: "retryable",
    retryAfterSeconds: 120,
  });
  expect(retryAfter(503, " 30 ")).toEqual({
    outcome: "retryable",
    retryAfterSeconds: 30,
  });
  expect(retryAfter(408, "0")).toEqual({
    outcome: "retryable",
    retryAfterSeconds: 0,
  });
  expect(retryAfter(503, "Thu, 29 Oct 2026 00:02:00 GMT")).toEqual({
    outcome: "retryable",
    retryAfterSeconds: 120,
  });
  expect(retryAfter(429, "Thu, 29 Oct 2026 00:00:00 GMT")).toEqual({
    outcome: "retryable",
    retryAfterSeconds: 0,
  });
  expect(retryAfter(429, "Wed, 28 Oct 2026 23:00:00 GMT")).toEqual({
    outcome: "retryable",
    retryAfterSeconds: 0,
  });

  for (const invalid of [
    undefined,
    null,
    "",
    "soon",
    "-5",
    "1.5",
    "12345678901",
    "Sat, 31 Feb 2026 00:00:00 GMT",
    "Thu, 29 Oct 2026 24:00:00 GMT",
    "Thursday, 29-Oct-26 00:02:00 GMT",
    "Thu Oct 29 00:02:00 2026",
    "2026-10-29T00:02:00Z",
  ]) {
    expect(retryAfter(429, invalid), String(invalid)).toEqual({
      outcome: "retryable",
    });
  }

  // Retry-After never turns a terminal outcome into a retry.
  expect(retryAfter(410, "60")).toEqual({ outcome: "rejected" });
  expect(retryAfter(400, "60")).toEqual({ outcome: "failed" });
  expect(retryAfter(201, "60")).toEqual({ outcome: "delivered" });
});

test("pushers v2 constants extend the v1 registration path", () => {
  for (const path of [
    NOTIFICATION_PUSHER_CAPABILITIES_PATH,
    NOTIFICATION_PUSHER_ACK_PATH,
  ]) {
    expect(path.startsWith(`${NOTIFICATION_PUSHER_REGISTRATION_PATH}/`)).toBe(
      true,
    );
  }
  expect(NOTIFICATION_PUSHER_CAPABILITIES_PATH).toBe(
    "/api/notifications/pushers/capabilities",
  );
  expect(NOTIFICATION_PUSHER_CAPABILITIES_VERSION).toBe(2);
  expect(NOTIFICATION_WEB_PUSH_CONTENT_ENCODING).toBe("aes128gcm");
  expect(NOTIFICATION_WEB_PUSH_DEFAULT_TTL_SECONDS).toBe(2 * 24 * 60 * 60);
  expect(MAX_NOTIFICATION_WEB_PUSH_PLAINTEXT_BYTES).toBe(4096 - 86 - 16 - 1);
});

// Compile-time assertions, enforced by the first test in this file.

const v1Kind: NotificationPusher["kind"] = "http";
// @ts-expect-error v1 pushers stay http pushers; webpush has its own type.
const v1KindWebPush: NotificationPusher["kind"] = "webpush";
const v1RegistrationKind: NotificationPusherRegistration["kind"] = "http";
// @ts-expect-error the v1 registration response stays http-only.
const v1RegistrationWebPush: NotificationPusherRegistration["kind"] = "webpush";
const kinds: readonly NotificationPusherKind[] = ["http", "webpush"];

const leakedAuth: NotificationWebPushPusherPublicData = {
  url: PUSH_URL,
  format: "event_id_only",
  vapid_key_id: VAPID_KEY_ID,
  // @ts-expect-error data returned to clients never carries the auth secret.
  auth: AUTH,
};

// @ts-expect-error webpush list entries always say whether they are activated.
const missingActivated: NotificationWebPushPusherListEntry = {
  id: `jp.yurucommu.web\0${P256DH}`,
  kind: "webpush",
  app_id: "jp.yurucommu.web",
  pushkey: P256DH,
  data: { url: PUSH_URL, format: "event_id_only", vapid_key_id: VAPID_KEY_ID },
  registered_at: "2026-10-29T00:00:00.000Z",
  last_seen_at: "2026-10-29T00:00:00.000Z",
};

const futureVersion: NotificationPusherCapabilities = {
  // @ts-expect-error a v2 host serves exactly version 2.
  version: 3,
  formats: [],
  kinds: {},
};

const ackResponse: NotificationPusherAckResponse = {};
const ackResponseWithBody: NotificationPusherAckResponse = {
  // @ts-expect-error a successful ack answers an empty object.
  ok: true,
};

const v2Request = {
  append: true,
  pusher: {
    kind: "webpush",
    app_id: "jp.yurucommu.web",
    pushkey: P256DH,
    data: {
      url: PUSH_URL,
      auth: AUTH,
      format: "event_id_only",
      vapid_key_id: VAPID_KEY_ID,
    },
  },
} satisfies NotificationPusherSetRequestV2;

const httpListEntry = {
  id: "jp.takos.mobile\0device-token",
  kind: "http",
  app_id: "jp.takos.mobile",
  pushkey: "device-token",
  data: { format: "event_id_only" },
  gateway_url: "https://push.example/_matrix/push/v1/notify",
  registered_at: "2026-10-29T00:00:00.000Z",
  last_seen_at: "2026-10-29T00:00:00.000Z",
} satisfies NotificationHttpPusherListEntry;

void [
  v1Kind,
  v1KindWebPush,
  v1RegistrationKind,
  v1RegistrationWebPush,
  kinds,
  leakedAuth,
  missingActivated,
  futureVersion,
  ackResponse,
  ackResponseWithBody,
  v2Request,
  httpListEntry,
];
