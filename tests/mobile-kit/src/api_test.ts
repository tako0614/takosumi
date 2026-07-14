import { expect, test } from "bun:test";
import {
  createMobileApiClient,
  MobileApiError,
  NOTIFICATION_PUSHER_REGISTRATION_PATH,
  registerNotificationPusherWithHost,
  resolveNotificationPusherEndpoint,
  unregisterNotificationPusherWithHost,
  type MobileSession,
  type NotificationPusher,
} from "../../../mobile-kit/src/index.ts";

const pusher = {
  kind: "http",
  app_id: "jp.example.mobile",
  app_display_name: "Example",
  pushkey: "push-token",
  data: {
    url: "https://push.example/_matrix/push/v1/notify",
    format: "event_id_only",
    provider: "fcm",
    environment: "production",
  },
} satisfies NotificationPusher;

test("createMobileApiClient sends bearer auth to host API", async () => {
  const requests: Request[] = [];
  const client = createMobileApiClient({
    session: session(),
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return json({ ok: true });
    },
  });

  const result = await client.json<{ ok: boolean }>("/api/auth/me");

  expect(result.ok).toBe(true);
  expect(requests[0].url).toBe("https://host.example/api/auth/me");
  expect(requests[0].headers.get("authorization")).toBe("Bearer access-1");
});

test("createMobileApiClient exposes authorization failures as typed errors", async () => {
  const client = createMobileApiClient({
    session: session(),
    fetch: async () => new Response("forbidden", { status: 403 }),
  });

  try {
    await client.json("/api/spaces");
    throw new Error("expected request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MobileApiError);
    expect((error as MobileApiError).status).toBe(403);
    expect((error as MobileApiError).path).toBe("/api/spaces");
  }
});

test("registerNotificationPusherWithHost posts the product-neutral pusher", async () => {
  const requests: Request[] = [];

  await registerNotificationPusherWithHost({
    session: session({
      productEndpoints: { notificationPushers: "/custom/pushers" },
    }),
    pusher,
    scope: "account:user-1",
    fetch: collect(requests),
  });

  expect(requests[0].url).toBe("https://host.example/custom/pushers");
  expect(requests[0].method).toBe("POST");
  expect(requests[0].headers.get("authorization")).toBe("Bearer access-1");
  expect(requests[0].headers.get("content-type")).toBe("application/json");
  expect(await requests[0].json()).toEqual({
    product: "takos",
    scope: "account:user-1",
    pusher,
  });
});

test("registerNotificationPusherWithHost accepts a same-origin advertised endpoint", async () => {
  const requests: Request[] = [];

  await registerNotificationPusherWithHost({
    session: session({
      productEndpoints: {
        notificationPushers: "https://host.example/api/notifications/pushers",
      },
    }),
    pusher,
    fetch: collect(requests),
  });

  expect(requests[0].url).toBe(
    "https://host.example/api/notifications/pushers",
  );
});

test("unregisterNotificationPusherWithHost deletes by app id and pushkey", async () => {
  const requests: Request[] = [];

  await unregisterNotificationPusherWithHost({
    session: session(),
    appId: pusher.app_id,
    pushkey: pusher.pushkey,
    fetch: collect(requests),
  });

  expect(requests[0].url).toBe(
    "https://host.example/api/notifications/pushers",
  );
  expect(requests[0].method).toBe("DELETE");
  expect(requests[0].headers.get("authorization")).toBe("Bearer access-1");
  expect(await requests[0].json()).toEqual({
    product: "takos",
    app_id: "jp.example.mobile",
    pushkey: "push-token",
  });
});

test("notification pusher helper rejects cross-origin host endpoints", async () => {
  await expect(
    registerNotificationPusherWithHost({
      session: session({
        productEndpoints: {
          notificationPushers: "https://evil.example/pushers",
        },
      }),
      pusher,
      fetch: async () => {
        throw new Error("must not send request");
      },
    }),
  ).rejects.toThrow("Host endpoint must stay on the connected host.");
});

test("notification pusher helper rejects insecure remote gateways before fetch", async () => {
  await expect(
    registerNotificationPusherWithHost({
      session: session(),
      pusher: {
        ...pusher,
        data: { ...pusher.data, url: "http://push.example/notify" },
      },
      fetch: async () => {
        throw new Error("must not send request");
      },
    }),
  ).rejects.toThrow("Notification pusher is invalid (pusher.data)");
});

test("resolveNotificationPusherEndpoint falls back to the standard path", () => {
  expect(resolveNotificationPusherEndpoint(session())).toBe(
    NOTIFICATION_PUSHER_REGISTRATION_PATH,
  );
});

function session(input: Partial<MobileSession> = {}): MobileSession {
  return {
    hostUrl: "https://host.example",
    product: "takos",
    oidcIssuer: "https://host.example",
    accessToken: "access-1",
    tokenType: "Bearer",
    createdAt: "2026-06-30T00:00:00.000Z",
    ...input,
  };
}

function collect(requests: Request[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return json({ ok: true });
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
