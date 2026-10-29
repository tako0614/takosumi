import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  classifyNotificationWebPushResponse,
  createNotificationPusherId,
  MAX_NOTIFICATION_PUSHER_DATA_BYTES,
  normalizeNotificationWebPushEndpoint,
  NOTIFICATION_PUSHER_CAPABILITIES_PATH,
  NOTIFICATION_PUSHER_CAPABILITIES_VERSION,
  NOTIFICATION_PUSHER_REGISTRATION_PATH,
  NOTIFICATION_PUSHER_V1_HOST_CAPABILITIES,
  NOTIFICATION_WEB_PUSH_CONTENT_ENCODING,
  parseNotificationPusherCapabilities,
  parseNotificationPusherCapabilitiesResponse,
  parseNotificationPusherDeleteRequest,
  parseNotificationPusherSetRequest,
  parseNotificationPusherSetRequestV2,
  toNotificationWebPushPusherPublicData,
  type NotificationHttpPusherListEntry,
  type NotificationPusher,
  type NotificationPusherCapabilities,
  type NotificationPusherKind,
  type NotificationPusherKindCapabilities,
  type NotificationPushDeliveryOutcome,
  type NotificationPusherListResponse,
  type NotificationPusherRegistration,
  type NotificationPusherSetRequestV2,
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
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/example-subscription-id";

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
    pushkey: ENDPOINT,
    data: {
      format: "event_id_only",
      keys: { p256dh: P256DH, auth: AUTH },
      vapid_key_id: VAPID_KEY_ID,
      ...data,
    },
    ...overrides,
  };
}

function expectSetError(
  body: unknown,
  field: string | undefined,
  kinds: NotificationPusherKindCapabilities = HOST_KINDS,
): string {
  const parsed = parseNotificationPusherSetRequestV2(body, { kinds });
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

test("pushers v2 registers a webpush pusher from a browser PushSubscription", () => {
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
        pushkey: ENDPOINT,
        device_display_name: "iPhone",
        lang: "ja-JP",
        data: {
          format: "event_id_only",
          keys: { p256dh: P256DH, auth: AUTH },
          vapid_key_id: VAPID_KEY_ID,
        },
      },
      product: "yurucommu",
      scope: "account:user-1",
      endpoint: ENDPOINT,
      append: false,
    },
  });
});

test("webpush registration canonicalizes format and keys but never the endpoint", () => {
  const extra = JSON.parse(`{
    "subscribed_from": "home-screen",
    "__proto__": { "polluted": true }
  }`) as Record<string, unknown>;
  const parsed = parseNotificationPusherSetRequestV2(
    {
      pusher: webPushPusher(
        {},
        {
          format: null,
          // Correct `=` padding, and a final character whose unused bits are
          // set, decode to the same bytes as the canonical spelling.
          keys: { p256dh: `${P256DH}=`, auth: "BTBZMqHH6r4Tts7J_aSIgh==" },
          ...extra,
        },
      ),
    },
    { kinds: HOST_KINDS },
  );

  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.value.kind !== "webpush") return;
  const data = parsed.value.pusher.data;
  expect(data.format).toBe("event_id_only");
  expect(data.keys).toEqual({ p256dh: P256DH, auth: AUTH });
  expect(data.subscribed_from).toBe("home-screen");
  expect(Object.getOwnPropertyDescriptor(data, "__proto__")?.value).toEqual({
    polluted: true,
  });
  expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  expect(parsed.value.pusher.pushkey).toBe(ENDPOINT);
  expect(parsed.value.endpoint).toBe(ENDPOINT);
});

test("webpush pushers accept only public HTTPS push service endpoints", () => {
  const accepted = [
    ENDPOINT,
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample",
    "https://web.push.apple.com/QGexampleSubscriptionToken",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAexample%3d",
    "https://ntfy.sh/upExampleTopic?up=1",
    `https://fcm.googleapis.com/fcm/send/${"a".repeat(512 - "https://fcm.googleapis.com/fcm/send/".length)}`,
  ];
  for (const endpoint of accepted) {
    expect(normalizeNotificationWebPushEndpoint(endpoint), endpoint).toBe(
      endpoint,
    );
    const parsed = parseNotificationPusherSetRequestV2(
      { pusher: webPushPusher({ pushkey: endpoint }) },
      { kinds: HOST_KINDS },
    );
    expect(parsed.ok, endpoint).toBe(true);
  }
  expect(normalizeNotificationWebPushEndpoint(`  ${ENDPOINT}  `)).toBe(
    ENDPOINT,
  );

  const rejected: readonly unknown[] = [
    "http://fcm.googleapis.com/fcm/send/id",
    "http://127.0.0.1:8787/push",
    "wss://fcm.googleapis.com/fcm/send/id",
    "file:///tmp/push",
    "https://user:secret@fcm.googleapis.com/fcm/send/id",
    "https://fcm.googleapis.com:8443/fcm/send/id",
    "https://fcm.googleapis.com/fcm/send/id#fragment",
    "https://fcm.googleapis.com/fcm/send/id#",
    // Not the canonical serialization, so the pushkey would differ from the
    // URL the host fetches.
    "https://FCM.googleapis.com/fcm/send/id",
    "https://fcm.googleapis.com:443/fcm/send/id",
    "https://0x7f.1/push",
    "https://2130706433/push",
    // IP literals, loopback, link-local, private and reverse-DNS names.
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
    `https://fcm.googleapis.com/fcm/send/${"a".repeat(513 - "https://fcm.googleapis.com/fcm/send/".length)}`,
    "",
    42,
    null,
  ];
  for (const endpoint of rejected) {
    expect(
      normalizeNotificationWebPushEndpoint(endpoint),
      String(endpoint),
    ).toBeNull();
    expectSetError(
      { pusher: webPushPusher({ pushkey: endpoint }) },
      "pusher.pushkey",
    );
  }
});

test("webpush subscription keys must decode to a P-256 point and a 16-byte secret", () => {
  const point = [...Buffer.from(P256DH, "base64url")];
  const cases: readonly (readonly [string, unknown, string])[] = [
    ["missing keys", undefined, "pusher.data.keys"],
    ["array keys", [P256DH, AUTH], "pusher.data.keys"],
    [
      "extra key field",
      { p256dh: P256DH, auth: AUTH, expirationTime: null },
      "pusher.data.keys",
    ],
    ["missing p256dh", { auth: AUTH }, "pusher.data.keys.p256dh"],
    [
      "64-byte p256dh",
      { p256dh: base64Url(point.slice(0, 64)), auth: AUTH },
      "pusher.data.keys.p256dh",
    ],
    [
      "compressed p256dh",
      { p256dh: base64Url([0x02, ...point.slice(1, 33)]), auth: AUTH },
      "pusher.data.keys.p256dh",
    ],
    [
      "p256dh without the uncompressed prefix",
      { p256dh: base64Url([0x05, ...point.slice(1)]), auth: AUTH },
      "pusher.data.keys.p256dh",
    ],
    [
      "standard base64 alphabet",
      { p256dh: P256DH.replace(/-/gu, "+").replace(/_/gu, "/"), auth: AUTH },
      "pusher.data.keys.p256dh",
    ],
    [
      "whitespace",
      { p256dh: `${P256DH.slice(0, 40)}\n${P256DH.slice(40)}`, auth: AUTH },
      "pusher.data.keys.p256dh",
    ],
    [
      "wrong padding",
      { p256dh: `${P256DH}==`, auth: AUTH },
      "pusher.data.keys.p256dh",
    ],
    [
      "15-byte auth",
      { p256dh: P256DH, auth: base64Url(Array(15).fill(7)) },
      "pusher.data.keys.auth",
    ],
    [
      "17-byte auth",
      { p256dh: P256DH, auth: base64Url(Array(17).fill(7)) },
      "pusher.data.keys.auth",
    ],
    ["numeric auth", { p256dh: P256DH, auth: 16 }, "pusher.data.keys.auth"],
  ];

  for (const [label, keys, field] of cases) {
    const data: Record<string, unknown> = {
      format: "event_id_only",
      vapid_key_id: VAPID_KEY_ID,
    };
    if (keys !== undefined) data.keys = keys;
    const parsed = parseNotificationPusherSetRequestV2(
      { pusher: { ...webPushPusher(), data } },
      { kinds: HOST_KINDS },
    );
    expect(parsed.ok, label).toBe(false);
    if (!parsed.ok) expect(parsed.error.field, label).toBe(field);
  }
});

test("webpush data names this host's VAPID key and only the event_id_only format", () => {
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
  expectSetError(
    {
      pusher: webPushPusher(
        {},
        { url: "https://push.example/_matrix/push/v1/notify" },
      ),
    },
    "pusher.data.url",
  );
  expectSetError({ pusher: webPushPusher({ data: "keys" }) }, "pusher.data");
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
    { http: {} },
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
    { webpush: HOST_KINDS.webpush },
  );
  expect(
    expectSetError({ pusher: webPushPusher({ kind: "email" }) }, "pusher.kind"),
  ).toBe("pusher.kind must be http or webpush");
  expectSetError({ pusher: webPushPusher({ kind: undefined }) }, "pusher.kind");
  expectSetError({ pusher: webPushPusher() }, "pusher.kind", {});
  expectSetError({ pusher: "webpush" }, undefined);
  expectSetError("pusher", undefined);
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
    http: { gateway_hosts: ["PUSH.example", "*.gateway.example"] },
  };
  for (const url of [
    "https://push.example/_matrix/push/v1/notify",
    "https://eu.gateway.example/_matrix/push/v1/notify",
  ]) {
    const parsed = parseNotificationPusherSetRequestV2(
      { pusher: { ...body.pusher, data: { url } } },
      { kinds: listedHosts },
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

test("webpush pushers delete by app id and endpoint with the unchanged delete parser", () => {
  expect(
    parseNotificationPusherDeleteRequest({
      app_id: "jp.yurucommu.web",
      pushkey: ENDPOINT,
    }),
  ).toEqual({
    ok: true,
    value: {
      appId: "jp.yurucommu.web",
      pushkey: ENDPOINT,
      product: null,
      scope: null,
    },
  });
  expect(
    createNotificationPusherId({
      app_id: "jp.yurucommu.web",
      pushkey: ENDPOINT,
    }),
  ).toBe(`jp.yurucommu.web\0${ENDPOINT}`);
});

test("webpush pushers leave the host without their subscription keys", () => {
  const parsed = parseNotificationPusherSetRequestV2(
    { pusher: webPushPusher({}, { subscribed_from: "home-screen" }) },
    { kinds: HOST_KINDS },
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.value.kind !== "webpush") return;

  const publicData = toNotificationWebPushPusherPublicData(
    parsed.value.pusher.data,
  );
  expect(publicData).toEqual({
    subscribed_from: "home-screen",
    format: "event_id_only",
    vapid_key_id: VAPID_KEY_ID,
  });
  expect(Object.prototype.hasOwnProperty.call(publicData, "keys")).toBe(false);
  expect(parsed.value.pusher.data.keys).toEqual({ p256dh: P256DH, auth: AUTH });

  const entry: NotificationWebPushPusherListEntry = {
    id: createNotificationPusherId(parsed.value.pusher),
    kind: "webpush",
    app_id: parsed.value.pusher.app_id,
    pushkey: parsed.value.pusher.pushkey,
    data: publicData,
    registered_at: "2026-10-29T00:00:00.000Z",
    last_seen_at: "2026-10-29T00:00:00.000Z",
  };
  const response: NotificationPusherListResponse = { pushers: [entry] };
  expect(JSON.stringify(response)).not.toContain(AUTH);
  expect(JSON.stringify(response)).not.toContain(P256DH);
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
  expectSetError(
    { pusher: webPushPusher() },
    "pusher.kind",
    v1Host.value.kinds,
  );

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
  expect(NOTIFICATION_PUSHER_CAPABILITIES_PATH).toBe(
    "/api/notifications/pushers/capabilities",
  );
  expect(
    NOTIFICATION_PUSHER_CAPABILITIES_PATH.startsWith(
      `${NOTIFICATION_PUSHER_REGISTRATION_PATH}/`,
    ),
  ).toBe(true);
  expect(NOTIFICATION_PUSHER_CAPABILITIES_VERSION).toBe(2);
  expect(NOTIFICATION_WEB_PUSH_CONTENT_ENCODING).toBe("aes128gcm");
});

// Compile-time assertions, enforced by the first test in this file.

const v1Kind: NotificationPusher["kind"] = "http";
// @ts-expect-error v1 pushers stay http pushers; webpush has its own type.
const v1KindWebPush: NotificationPusher["kind"] = "webpush";
const v1RegistrationKind: NotificationPusherRegistration["kind"] = "http";
// @ts-expect-error the v1 registration response stays http-only.
const v1RegistrationWebPush: NotificationPusherRegistration["kind"] = "webpush";
const kinds: readonly NotificationPusherKind[] = ["http", "webpush"];

const leakedKeys: NotificationWebPushPusherPublicData = {
  format: "event_id_only",
  vapid_key_id: VAPID_KEY_ID,
  // @ts-expect-error data returned to clients never carries subscription keys.
  keys: { p256dh: P256DH, auth: AUTH },
};

const futureVersion: NotificationPusherCapabilities = {
  // @ts-expect-error a v2 host serves exactly version 2.
  version: 3,
  formats: [],
  kinds: {},
};

const v2Request = {
  append: true,
  pusher: {
    kind: "webpush",
    app_id: "jp.yurucommu.web",
    pushkey: ENDPOINT,
    data: {
      format: "event_id_only",
      keys: { p256dh: P256DH, auth: AUTH },
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
  leakedKeys,
  futureVersion,
  v2Request,
  httpListEntry,
];
