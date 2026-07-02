import { expect, test } from "bun:test";
import {
  beginMobileOidcSignIn,
  clearMobileSession,
  completeMobileOidcSignIn,
  isOidcCallbackPayload,
  loadMobileSession,
  mobileAuthRequestStorageKey,
  mobileSessionStorageKey,
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
  hostCenterSource: {
    git: "https://github.com/acme/takos.git",
    path: "deploy/opentofu",
  },
  urlPlaceholder: "https://workspace.example.com",
  primaryActionLabel: "Connect",
  accentColor: "#166534",
  mobileScheme: "takos",
  oidcClientId: "takos-mobile",
};

test("beginMobileOidcSignIn stores request and returns authorize URL", async () => {
  const bridge = memoryBridge();
  const result = await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
      oidcDiscoveryUrl: "https://host.example/.well-known/openid-configuration",
      product: {
        product: "takos",
        endpoints: {
          mobilePushRegistrations:
            "https://host.example/api/mobile/push-registrations",
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
  expect(url.searchParams.get("client_id")).toBe("takos-mobile");
  expect(url.searchParams.get("redirect_uri")).toBe("takos://oauth/callback");
  expect(
    await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter)),
  ).toContain('"hostUrl":"https://host.example"');
  expect(
    await bridge.secureStore?.get(mobileAuthRequestStorageKey(adapter)),
  ).toContain('"mobilePushRegistrations"');
});

test("completeMobileOidcSignIn exchanges code and stores session", async () => {
  const bridge = memoryBridge();
  await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
      oidcDiscoveryUrl: "https://host.example/.well-known/openid-configuration",
      product: {
        product: "takos",
        endpoints: {
          mobilePushRegistrations: "/api/mobile/push-registrations",
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
  expect(session.productEndpoints?.mobilePushRegistrations).toBe(
    "/api/mobile/push-registrations",
  );
  expect(session.expiresAt).toBe("2026-06-30T01:00:00.000Z");
  expect(
    (await loadMobileSession({ adapter, nativeBridge: bridge }))?.hostUrl,
  ).toBe("https://host.example");
});

test("mobile auth prefers secureStore and clears legacy persistent storage", async () => {
  const bridge = dualStoreBridge();
  await bridge.storage?.set(mobileSessionStorageKey(adapter), "legacy-session");

  await beginMobileOidcSignIn({
    adapter,
    discovery: {
      hostUrl: "https://host.example",
      oidcIssuer: "https://host.example",
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
      accessToken: "expired-access",
      tokenType: "Bearer",
      refreshToken: "refresh-1",
      productEndpoints: {
        mobilePushRegistrations: "/api/mobile/push-registrations",
      },
      createdAt: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-06-30T00:30:00.000Z",
    },
    fetch: oidcFetch(),
    now: () => new Date("2026-06-30T01:00:00.000Z"),
  });

  expect(session.accessToken).toBe("access-refreshed");
  expect(session.refreshToken).toBe("refresh-2");
  expect(session.productEndpoints?.mobilePushRegistrations).toBe(
    "/api/mobile/push-registrations",
  );
  expect(session.expiresAt).toBe("2026-06-30T02:00:00.000Z");
  expect(
    (await loadMobileSession({ adapter, nativeBridge: bridge }))?.accessToken,
  ).toBe("access-refreshed");
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
        expect(body).toContain("client_id=takos-mobile");
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
