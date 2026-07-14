import { expect, test } from "bun:test";
import {
  beginMobileOidcSignIn,
  clearMobileSession,
  completeMobileOidcSignIn,
  isOidcCallbackPayload,
  loadMobileSession,
  mobileAuthRequestStorageKey,
  mobileSessionStorageKey,
  persistMobileSession,
  refreshMobileSession,
  type FetchLike,
  type MobileProductAdapter,
  type NativeBridge,
} from "../../../mobile-kit/src/index.ts";

const adapter: MobileProductAdapter = {
  product: "takos",
  appName: "Takos",
  hostNoun: "Takos host",
  hostCenterLabel: "Host Takos",
  hostCenterUrl: "https://operator.example/install",
  hostCenterSource: {
    git: "https://github.com/acme/takos.git",
    path: "deploy/opentofu",
  },
  urlPlaceholder: "https://workspace.example.com",
  primaryActionLabel: "Connect",
  accentColor: "#166534",
  mobileScheme: "takos",
};

test("beginMobileOidcSignIn stores request and returns authorize URL", async () => {
  const bridge = memoryBridge();
  const result = await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      oidcDiscoveryUrl: "https://host.example/.well-known/openid-configuration",
      product: {
        product: "takos",
        endpoints: {
          notificationPushers: "https://host.example/api/notifications/pushers",
        },
      },
    },
    nativeBridge: bridge,
    fetch: oidcFetch(),
  });

  const url = new URL(result.authorizationUrl);
  expect(url.origin + url.pathname).toBe(
    "https://host.example/oauth/authorize",
  );
  expect(url.searchParams.get("client_id")).toBe("takos-mobile-host-example");
  expect(url.searchParams.get("redirect_uri")).toBe("takos://oauth/callback");
  expect(
    await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter)),
  ).toContain('"hostUrl":"https://host.example"');
  expect(result.request.oidcClientId).toBe("takos-mobile-host-example");
  expect(
    await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter)),
  ).toContain('"notificationPushers"');
});

test("beginMobileOidcSignIn requires a discovery-advertised client id", async () => {
  await expect(
    beginMobileOidcSignIn({
      adapter,
      discovery: {
        hostUrl: "https://host.example",
        oidcIssuer: "https://accounts.example",
        oidcDiscoveryUrl:
          "https://accounts.example/.well-known/openid-configuration",
      },
      nativeBridge: memoryBridge(),
      fetch: oidcFetch(),
    }),
  ).rejects.toThrow("Host does not advertise a mobile OIDC client id.");
});

test("completeMobileOidcSignIn exchanges code and stores session", async () => {
  const bridge = memoryBridge();
  await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      oidcDiscoveryUrl: "https://host.example/.well-known/openid-configuration",
      product: {
        product: "takos",
        endpoints: {
          notificationPushers: "/api/notifications/pushers",
        },
      },
    },
    nativeBridge: bridge,
    fetch: oidcFetch(),
  });
  const pending = JSON.parse(
    (await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter))) ?? "",
  ) as { state: string };

  const session = await completeMobileOidcSignIn({
    adapter,
    nativeBridge: bridge,
    callbackUrl: `takos://oauth/callback?code=code-1&state=${pending.state}`,
    fetch: oidcFetch(),
    now: () => new Date("2026-06-30T00:00:00.000Z"),
  });

  expect(session.accessToken).toBe("access-1");
  expect(session.oidcClientId).toBe("takos-mobile-host-example");
  expect(session.productEndpoints?.notificationPushers).toBe(
    "/api/notifications/pushers",
  );
  expect(session.expiresAt).toBe("2026-06-30T01:00:00.000Z");
  expect(
    (await loadMobileSession({ adapter, nativeBridge: bridge }))?.hostUrl,
  ).toBe("https://host.example");
});

test("completeMobileOidcSignIn can return a session without persisting it", async () => {
  const bridge = memoryBridge();
  await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      oidcDiscoveryUrl: "https://host.example/.well-known/openid-configuration",
    },
    nativeBridge: bridge,
    fetch: oidcFetch(),
  });
  const pending = JSON.parse(
    (await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter))) ?? "",
  ) as { state: string };

  const session = await completeMobileOidcSignIn({
    adapter,
    nativeBridge: bridge,
    callbackUrl: `takos://oauth/callback?code=code-1&state=${pending.state}`,
    persistSession: false,
    fetch: oidcFetch(),
  });

  expect(session.accessToken).toBe("access-1");
  expect(
    await loadMobileSession({ adapter, nativeBridge: bridge }),
  ).toBeUndefined();
  expect(
    await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter)),
  ).toBeUndefined();
});

test("persistMobileSession explicitly saves an exchanged session", async () => {
  const bridge = dualStoreBridge();
  await bridge.storage?.set(mobileSessionStorageKey(adapter), "legacy-session");
  await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      oidcDiscoveryUrl: "https://host.example/.well-known/openid-configuration",
    },
    nativeBridge: bridge,
    fetch: oidcFetch(),
  });
  const pending = JSON.parse(
    (await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter))) ?? "",
  ) as { state: string };
  const session = await completeMobileOidcSignIn({
    adapter,
    nativeBridge: bridge,
    callbackUrl: `takos://oauth/callback?code=code-1&state=${pending.state}`,
    persistSession: false,
    fetch: oidcFetch(),
  });

  await persistMobileSession({ adapter, nativeBridge: bridge, session });

  expect(
    (await loadMobileSession({ adapter, nativeBridge: bridge }))?.accessToken,
  ).toBe("access-1");
  expect(
    await bridge.secureStore?.get(mobileSessionStorageKey(adapter)),
  ).toContain('"accessToken":"access-1"');
  expect(await bridge.storage?.get(mobileSessionStorageKey(adapter))).toBe(
    "legacy-session",
  );
});

test("completeMobileOidcSignIn rejects and clears an expired pending request", async () => {
  const bridge = memoryBridge();
  await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      oidcDiscoveryUrl: "https://host.example/.well-known/openid-configuration",
    },
    nativeBridge: bridge,
    fetch: oidcFetch(),
    now: () => new Date("2026-06-30T00:00:00.000Z"),
  });
  const pending = JSON.parse(
    (await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter))) ?? "",
  ) as { state: string };

  await expect(
    completeMobileOidcSignIn({
      adapter,
      nativeBridge: bridge,
      callbackUrl: `takos://oauth/callback?code=code-1&state=${pending.state}`,
      fetch: oidcFetch(),
      now: () => new Date("2026-06-30T00:10:01.000Z"),
    }),
  ).rejects.toThrow("Pending mobile sign-in request has expired.");
  expect(
    await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter)),
  ).toBeUndefined();
});

test("mobile auth prefers secureStore and clears legacy persistent storage", async () => {
  const bridge = dualStoreBridge();
  await bridge.storage?.set(mobileSessionStorageKey(adapter), "legacy-session");

  await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      oidcDiscoveryUrl: "https://host.example/.well-known/openid-configuration",
    },
    nativeBridge: bridge,
    fetch: oidcFetch(),
  });
  const pending = JSON.parse(
    (await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter))) ?? "",
  ) as { state: string };
  await completeMobileOidcSignIn({
    adapter,
    nativeBridge: bridge,
    callbackUrl: `takos://oauth/callback?code=code-1&state=${pending.state}`,
    fetch: oidcFetch(),
    now: () => new Date("2026-06-30T00:00:00.000Z"),
  });

  expect(
    await bridge.secureStore?.get(mobileSessionStorageKey(adapter)),
  ).toContain('"accessToken":"access-1"');
  expect(await bridge.storage?.get(mobileSessionStorageKey(adapter))).toBe(
    "legacy-session",
  );
  expect(
    (await loadMobileSession({ adapter, nativeBridge: bridge }))?.accessToken,
  ).toBe("access-1");
  await clearMobileSession({ adapter, nativeBridge: bridge });
  expect(
    await bridge.secureStore?.get(mobileSessionStorageKey(adapter)),
  ).toBeUndefined();
  expect(
    await bridge.storage?.get(mobileSessionStorageKey(adapter)),
  ).toBeUndefined();
});

test("refreshMobileSession rotates an expired mobile session", async () => {
  const bridge = memoryBridge();
  const session = await refreshMobileSession({
    adapter,
    nativeBridge: bridge,
    session: {
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      accessToken: "expired-access",
      tokenType: "Bearer",
      refreshToken: "refresh-1",
      productEndpoints: {
        notificationPushers: "/api/notifications/pushers",
      },
      createdAt: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-06-30T00:30:00.000Z",
    },
    fetch: oidcFetch(),
    now: () => new Date("2026-06-30T01:00:00.000Z"),
  });

  expect(session.accessToken).toBe("access-refreshed");
  expect(session.refreshToken).toBe("refresh-2");
  expect(session.productEndpoints?.notificationPushers).toBe(
    "/api/notifications/pushers",
  );
  expect(session.expiresAt).toBe("2026-06-30T02:00:00.000Z");
  expect(
    (await loadMobileSession({ adapter, nativeBridge: bridge }))?.accessToken,
  ).toBe("access-refreshed");
});

test("refreshMobileSession can return a rotation without persisting it", async () => {
  const bridge = memoryBridge();
  const session = await refreshMobileSession({
    adapter,
    nativeBridge: bridge,
    session: {
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      accessToken: "expired-access",
      tokenType: "Bearer",
      refreshToken: "refresh-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-06-30T00:30:00.000Z",
    },
    persistSession: false,
    fetch: oidcFetch(),
    now: () => new Date("2026-06-30T01:00:00.000Z"),
  });

  expect(session.accessToken).toBe("access-refreshed");
  expect(
    await bridge.secureStore?.get(mobileSessionStorageKey(adapter)),
  ).toBeUndefined();
});

test("refreshMobileSession does not invent a client id for a legacy session", async () => {
  await expect(
    refreshMobileSession({
      adapter,
      nativeBridge: memoryBridge(),
      session: {
        hostUrl: "https://host.example",
        product: "takos",
        oidcIssuer: "https://accounts.example",
        accessToken: "expired-access",
        tokenType: "Bearer",
        refreshToken: "refresh-1",
        createdAt: "2026-06-30T00:00:00.000Z",
      },
      fetch: () => {
        throw new Error("refresh must fail before fetching metadata");
      },
    }),
  ).rejects.toThrow("Mobile session is missing its OIDC client id.");
});

test("isOidcCallbackPayload detects callback payloads", () => {
  expect(isOidcCallbackPayload("takos://oauth/callback?code=c&state=s")).toBe(
    true,
  );
  expect(isOidcCallbackPayload("https://host.example")).toBe(false);
});

function oidcFetch(): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: "https://host.example",
          authorization_endpoint: "https://host.example/oauth/authorize",
          token_endpoint: "https://host.example/oauth/token",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/oauth/token")) {
      const body = String(init?.body ?? "");
      if (body.includes("grant_type=refresh_token")) {
        expect(body).toContain("client_id=takos-mobile-host-example");
        expect(body).toContain("refresh_token=refresh-1");
        return new Response(
          JSON.stringify({
            access_token: "access-refreshed",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-2",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      expect(body).toContain("client_id=takos-mobile-host-example");
      return new Response(
        JSON.stringify({
          access_token: "access-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-1",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 404 });
  };
}

function memoryBridge(): NativeBridge {
  const storage = new Map<string, string>();
  return {
    capabilities: {
      launchPayload: false,
      launchPayloadEvents: false,
      externalBrowser: false,
      inAppBrowser: false,
      qrScanner: false,
      localNotifications: false,
      pushNotifications: false,
      biometricAuth: false,
      callIntent: false,
      clipboardText: false,
      secureStorage: true,
      persistentStorage: true,
    },
    secureStore: {
      kind: "secure",
      async get(key) {
        return storage.get(key);
      },
      async set(key, value) {
        storage.set(key, value);
      },
      async delete(key) {
        storage.delete(key);
      },
    },
    async getLaunchPayload() {
      return undefined;
    },
    async openExternalUrl() {},
  };
}

function dualStoreBridge(): NativeBridge {
  const persistent = new Map<string, string>();
  const secure = new Map<string, string>();
  return {
    capabilities: {
      launchPayload: false,
      launchPayloadEvents: false,
      externalBrowser: false,
      inAppBrowser: false,
      qrScanner: false,
      localNotifications: false,
      pushNotifications: false,
      biometricAuth: false,
      callIntent: false,
      clipboardText: false,
      secureStorage: true,
      persistentStorage: true,
    },
    storage: {
      kind: "device-persistent",
      async get(key) {
        return persistent.get(key);
      },
      async set(key, value) {
        persistent.set(key, value);
      },
      async delete(key) {
        persistent.delete(key);
      },
    },
    secureStore: {
      kind: "secure",
      async get(key) {
        return secure.get(key);
      },
      async set(key, value) {
        secure.set(key, value);
      },
      async delete(key) {
        secure.delete(key);
      },
    },
    async getLaunchPayload() {
      return undefined;
    },
    async openExternalUrl() {},
  };
}
