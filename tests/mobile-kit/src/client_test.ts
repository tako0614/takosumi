import { expect, test } from "bun:test";
import {
  createMobileClientController,
  mobileKnownHostsStorageKey,
  mobileSessionStorageKey,
  type FetchLike,
  type MobileProductAdapter,
  type NativeBridge,
} from "../../../mobile-kit/src/index.ts";

const adapter: MobileProductAdapter = {
  product: "takos",
  appName: "Takos",
  hostNoun: "Takos host",
  hostCenterLabel: "Host Takos",
  urlPlaceholder: "https://workspace.example.com",
  primaryActionLabel: "Connect",
  accentColor: "#166534",
  mobileScheme: "takos",
  oidcClientId: "takos-mobile",
};

test("mobile client controller connects, signs in, and loads home", async () => {
  const bridge = memoryBridge();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    loadHome: async (session) => ({
      title: session.hostUrl,
    }),
    homeLabel: "workspace",
  });

  controller.setConnectInput("host.example");
  await controller.connect();

  expect(controller.getState().discovery?.hostUrl).toBe("https://host.example");
  expect(controller.getState().status).toBe("Takos host found.");

  await controller.startSignIn();
  const authorizeUrl = bridge.opened.at(-1);
  expect(authorizeUrl).toContain("https://host.example/oauth/authorize");

  const state = new URL(authorizeUrl ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );

  expect(controller.getState().session?.accessToken).toBe("access-1");
  expect(controller.getState().home).toEqual({
    title: "https://host.example",
  });
  expect(controller.getState().homeStatus).toBe("Workspace ready.");
  expect(controller.getState().knownHosts[0]).toMatchObject({
    hostUrl: "https://host.example",
    product: "takos",
    oidcIssuer: "https://host.example",
  });
});

test("mobile client controller loads recent hosts and reconnects from them", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileKnownHostsStorageKey(adapter),
    JSON.stringify([
      {
        hostUrl: "https://known.example",
        product: "takos",
        oidcIssuer: "https://known.example",
        lastSeenAt: "2026-06-30T00:00:00.000Z",
      },
    ]),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
  });

  await controller.start();
  expect(controller.getState().knownHosts).toEqual([
    {
      hostUrl: "https://known.example",
      product: "takos",
      oidcIssuer: "https://known.example",
      lastSeenAt: "2026-06-30T00:00:00.000Z",
      label: undefined,
    },
  ]);

  await controller.connectKnownHost("https://known.example");
  expect(controller.getState().connectInput).toBe("https://known.example");
  expect(controller.getState().discovery?.hostUrl).toBe(
    "https://known.example",
  );
  expect(controller.getState().knownHosts[0]?.hostUrl).toBe(
    "https://known.example",
  );
});

test("mobile client controller restores session on start", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      accessToken: "stored-token",
      tokenType: "Bearer",
      createdAt: "2026-06-30T00:00:00.000Z",
    }),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    loadHome: async (session) => ({
      token: session.accessToken,
    }),
  });

  await controller.start();

  expect(controller.getState().session?.accessToken).toBe("stored-token");
  expect(controller.getState().home).toEqual({ token: "stored-token" });
  expect(controller.getState().status).toBe("Session restored.");
});

test("mobile client controller opens mobile route launch payloads on the current host", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      accessToken: "stored-token",
      tokenType: "Bearer",
      createdAt: "2026-06-30T00:00:00.000Z",
    }),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    loadHome: async () => ({ ready: true }),
  });

  await controller.start();
  await controller.handleLaunchPayload("takos://open?path=%2Fchat");

  expect(bridge.opened).toEqual(["https://host.example/chat"]);
  expect(controller.getState().pendingRoute).toBeUndefined();
  expect(controller.getState().status).toBe("Opened requested route.");
});

test("mobile client controller keeps mobile routes pending until sign-in", async () => {
  const bridge = memoryBridge();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    loadHome: async (session) => ({ title: session.hostUrl }),
  });

  await controller.handleLaunchPayload(
    "takos://open?host_url=https%3A%2F%2Fhost.example&path=%2Fapps",
  );

  expect(controller.getState().discovery?.hostUrl).toBe("https://host.example");
  expect(controller.getState().pendingRoute).toEqual({
    path: "/apps",
    hostUrl: "https://host.example",
    product: undefined,
  });
  expect(controller.getState().status).toBe(
    "Sign in to open the requested route.",
  );

  await controller.startSignIn();
  const authorizeUrl = bridge.opened.at(-1);
  const state = new URL(authorizeUrl ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );

  expect(controller.getState().session?.accessToken).toBe("access-1");
  expect(controller.getState().pendingRoute).toBeUndefined();
  expect(bridge.opened.at(-1)).toBe("https://host.example/apps");
  expect(controller.getState().status).toBe("Opened requested route.");
});

test("mobile client controller gates restored sessions behind biometric unlock", async () => {
  const bridge = memoryBridge({
    biometricAuth: true,
    pushRegistration: {
      token: "push-token",
    },
  });
  await bridge.storage?.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      accessToken: "stored-token",
      tokenType: "Bearer",
      createdAt: "2026-06-30T00:00:00.000Z",
    }),
  );
  const registered: unknown[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    loadHome: async (session) => ({
      token: session.accessToken,
    }),
    registerPush: async (input) => {
      registered.push(input);
    },
    sessionUnlock: {
      restoreMode: "if-available",
      prompt: (session) => ({
        message: `Unlock ${session.hostUrl}`,
        title: "Takos",
        allowDeviceCredential: true,
      }),
    },
  });

  await controller.start();

  expect(controller.getState().session).toBeUndefined();
  expect(controller.getState().lockedSession?.accessToken).toBe("stored-token");
  expect(controller.getState().home).toBeUndefined();
  expect(controller.getState().status).toBe(
    "Saved session is locked. Unlock to continue.",
  );

  await controller.unlockSession();

  expect(bridge.biometricPrompts).toEqual([
    {
      message: "Unlock https://host.example",
      title: "Takos",
      allowDeviceCredential: true,
    },
  ]);
  expect(controller.getState().lockedSession).toBeUndefined();
  expect(controller.getState().session?.accessToken).toBe("stored-token");
  expect(controller.getState().home).toEqual({ token: "stored-token" });
  expect(controller.getState().pushRegistration).toEqual({
    token: "push-token",
    environment: "takos",
  });
  expect(registered).toHaveLength(1);
});

test("mobile client controller skips if-available unlock when biometric is unavailable", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      accessToken: "stored-token",
      tokenType: "Bearer",
      createdAt: "2026-06-30T00:00:00.000Z",
    }),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    loadHome: async (session) => ({
      token: session.accessToken,
    }),
    sessionUnlock: {
      restoreMode: "if-available",
    },
  });

  await controller.start();

  expect(controller.getState().lockedSession).toBeUndefined();
  expect(controller.getState().session?.accessToken).toBe("stored-token");
  expect(controller.getState().home).toEqual({ token: "stored-token" });
});

test("mobile client controller refreshes an expired restored session", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      accessToken: "expired-token",
      tokenType: "Bearer",
      refreshToken: "refresh-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-06-30T00:30:00.000Z",
    }),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    loadHome: async (session) => ({
      token: session.accessToken,
      refreshToken: session.refreshToken,
    }),
  });

  await controller.start();

  expect(controller.getState().session?.accessToken).toBe("access-refreshed");
  expect(controller.getState().session?.refreshToken).toBe("refresh-2");
  expect(controller.getState().home).toEqual({
    token: "access-refreshed",
    refreshToken: "refresh-2",
  });
});

test("mobile client controller clears a restored session when refresh fails", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      accessToken: "expired-token",
      tokenType: "Bearer",
      refreshToken: "refresh-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-06-30T00:30:00.000Z",
    }),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: refreshFailsFetch(),
    loadHome: async (session) => ({ token: session.accessToken }),
  });

  await controller.start();

  expect(controller.getState().session).toBeUndefined();
  expect(controller.getState().home).toBeUndefined();
  expect(controller.getState().status).toBe(
    "Mobile session refresh failed: 400",
  );
  expect(
    await bridge.storage?.get(mobileSessionStorageKey(adapter)),
  ).toBeUndefined();
});

test("mobile client controller handles QR scan and launch payloads", async () => {
  const bridge = memoryBridge({
    launchPayload: "https://host.example",
    scanPayload: "https://qr.example",
  });
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
  });

  await controller.start();
  expect(controller.getState().discovery?.hostUrl).toBe("https://host.example");

  await controller.selectAction("qr");
  expect(controller.getState().connectInput).toBe("https://qr.example");
  expect(controller.getState().discovery?.hostUrl).toBe("https://qr.example");
});

test("mobile client controller keeps Host Center setup handoff state", async () => {
  const bridge = memoryBridge();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
  });

  await controller.connectWithInput(
    "takos://connect?host_url=https%3A%2F%2Fhost.example&product=takos&setup_ticket=ticket-1",
  );

  expect(controller.getState().connectPayload).toEqual({
    hostUrl: "https://host.example",
    product: "takos",
    setupTicket: "ticket-1",
  });
  expect(controller.getState().status).toBe(
    "Takos host found. Host Center handoff received.",
  );
});

test("mobile client controller registers push notifications through product callback", async () => {
  const bridge = memoryBridge({
    pushRegistration: {
      token: "push-token",
      environment: "test",
    },
  });
  const registered: unknown[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async (input) => {
      registered.push(input);
    },
  });

  await controller.connectWithInput("https://host.example");
  await controller.startSignIn();
  const state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );

  expect(controller.getState().pushRegistration).toEqual({
    token: "push-token",
    environment: "test",
  });
  expect(controller.getState().pushStatus).toBe("Push notifications ready.");
  expect(controller.getState().pushLoading).toBe(false);
  expect(registered).toEqual([
    {
      session: controller.getState().session,
      registration: {
        token: "push-token",
        environment: "test",
      },
    },
  ]);
});

test("mobile client controller handles push token refresh and notification events", async () => {
  const bridge = memoryBridge({
    pushRegistration: {
      token: "push-token",
      environment: "test",
    },
    pushEvents: true,
  });
  const registered: unknown[] = [];
  const notifications: unknown[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async (input) => {
      registered.push(input);
    },
    handlePushNotification: async (input) => {
      notifications.push(input);
    },
  });

  await controller.connectWithInput("https://host.example");
  await controller.startSignIn();
  const state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );

  expect(registered).toHaveLength(1);
  bridge.emitPushTokenRefresh({
    token: "rotated-token",
    environment: "test",
  });
  await settle();

  expect(controller.getState().pushRegistration).toEqual({
    token: "rotated-token",
    environment: "test",
  });
  expect(controller.getState().pushStatus).toBe(
    "Push notification token refreshed.",
  );
  expect(registered).toHaveLength(2);

  bridge.emitPushNotification("tapped", {
    title: "Chat",
    body: "Open chat",
    data: { path: "/chat" },
  });
  await settle();

  expect(controller.getState().lastPushNotification).toEqual({
    title: "Chat",
    body: "Open chat",
    data: { path: "/chat" },
  });
  expect(controller.getState().pushStatus).toBe("Push notification opened.");
  expect(notifications).toEqual([
    {
      session: controller.getState().session,
      kind: "tapped",
      notification: {
        title: "Chat",
        body: "Open chat",
        data: { path: "/chat" },
      },
    },
  ]);

  await controller.signOut();
  bridge.emitPushTokenRefresh({
    token: "stale-token",
    environment: "test",
  });
  await settle();
  expect(registered).toHaveLength(2);
});

test("mobile client controller keeps sign-in usable when push is unavailable", async () => {
  const bridge = memoryBridge();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async () => {
      throw new Error("should not be called");
    },
  });

  await controller.connectWithInput("https://host.example");
  await controller.startSignIn();
  const state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );

  expect(controller.getState().session?.accessToken).toBe("access-1");
  expect(controller.getState().pushRegistration).toBeUndefined();
  expect(controller.getState().pushStatus).toBe(
    "Push notifications are not available on this device.",
  );
  expect(controller.getState().pushLoading).toBe(false);
});

test("mobile client controller clears discovered state on sign out", async () => {
  const bridge = memoryBridge({
    pushRegistration: {
      token: "push-token",
      environment: "test",
    },
  });
  const unregistered: unknown[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async () => {},
    unregisterPush: async (input) => {
      unregistered.push(input);
    },
  });

  await controller.connectWithInput("https://host.example");
  await bridge.storage?.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      accessToken: "stored-token",
      tokenType: "Bearer",
      createdAt: "2026-06-30T00:00:00.000Z",
    }),
  );
  await controller.start();
  expect(controller.getState().pushRegistration).toEqual({
    token: "push-token",
    environment: "test",
  });
  await controller.signOut();

  expect(controller.getState().session).toBeUndefined();
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().connectPayload).toBeUndefined();
  expect(controller.getState().pushRegistration).toBeUndefined();
  expect(unregistered).toEqual([
    {
      session: {
        hostUrl: "https://host.example",
        product: "takos",
        oidcIssuer: "https://host.example",
        accessToken: "stored-token",
        tokenType: "Bearer",
        createdAt: "2026-06-30T00:00:00.000Z",
      },
      registration: {
        token: "push-token",
        environment: "test",
      },
    },
  ]);
});

test("mobile client controller asks UI to focus when sign-in needs a host", async () => {
  const controller = createMobileClientController({
    adapter,
    nativeBridge: memoryBridge(),
    fetch: fixtureFetch(),
  });

  const result = await controller.startSignIn();

  expect(result.focusInput).toBe(true);
  expect(controller.getState().status).toBe("Connect to a Takos host first.");
});

function fixtureFetch(): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takos")) {
      return json({
        product: "takos",
        issuer: new URL(url).origin,
      });
    }
    if (url.endsWith("/.well-known/openid-configuration")) {
      const origin = new URL(url).origin;
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
      });
    }
    if (url.endsWith("/oauth/token") && init?.method === "POST") {
      const body = String(init.body ?? "");
      if (body.includes("grant_type=refresh_token")) {
        return json({
          access_token: "access-refreshed",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-2",
        });
      }
      return json({
        access_token: "access-1",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return new Response("", { status: 404 });
  };
}

function refreshFailsFetch(): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      const origin = new URL(url).origin;
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
      });
    }
    if (url.endsWith("/oauth/token") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function memoryBridge(
  options: {
    readonly launchPayload?: string;
    readonly scanPayload?: string;
    readonly biometricAuth?: boolean;
    readonly biometricResult?: boolean;
    readonly pushRegistration?: {
      readonly token: string;
      readonly environment?: string;
    };
    readonly pushEvents?: boolean;
  } = {},
): NativeBridge & {
  readonly opened: string[];
  readonly biometricPrompts: unknown[];
  readonly emitPushNotification: (
    kind: "received" | "tapped",
    notification: {
      readonly title?: string;
      readonly body?: string;
      readonly data: Record<string, unknown>;
    },
  ) => void;
  readonly emitPushTokenRefresh: (registration: {
    readonly token: string;
    readonly environment?: string;
  }) => void;
} {
  const storage = new Map<string, string>();
  const opened: string[] = [];
  const biometricPrompts: unknown[] = [];
  const receivedHandlers = new Set<
    (notification: {
      readonly title?: string;
      readonly body?: string;
      readonly data: Record<string, unknown>;
    }) => void
  >();
  const tappedHandlers = new Set<
    (notification: {
      readonly title?: string;
      readonly body?: string;
      readonly data: Record<string, unknown>;
    }) => void
  >();
  const tokenRefreshHandlers = new Set<
    (registration: {
      readonly token: string;
      readonly environment?: string;
    }) => void
  >();
  return {
    opened,
    biometricPrompts,
    emitPushNotification(kind, notification) {
      const handlers = kind === "received" ? receivedHandlers : tappedHandlers;
      for (const handler of handlers) handler(notification);
    },
    emitPushTokenRefresh(registration) {
      for (const handler of tokenRefreshHandlers) handler(registration);
    },
    capabilities: {
      launchPayload: Boolean(options.launchPayload),
      launchPayloadEvents: false,
      externalBrowser: true,
      inAppBrowser: false,
      qrScanner: Boolean(options.scanPayload),
      localNotifications: false,
      pushNotifications: Boolean(options.pushRegistration),
      biometricAuth: Boolean(options.biometricAuth),
      callIntent: false,
      secureStorage: true,
      persistentStorage: true,
    },
    storage: {
      kind: "device-persistent",
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
      return options.launchPayload;
    },
    async openExternalUrl(url) {
      opened.push(url);
    },
    authenticateBiometric: options.biometricAuth
      ? async (prompt) => {
          biometricPrompts.push(prompt);
          return options.biometricResult ?? true;
        }
      : undefined,
    scanConnectionPayload: options.scanPayload
      ? async () => options.scanPayload
      : undefined,
    registerPushNotifications: options.pushRegistration
      ? async (input) => ({
          ...options.pushRegistration!,
          environment: options.pushRegistration!.environment ?? input.product,
        })
      : undefined,
    onPushNotificationReceived: options.pushEvents
      ? async (handler) => {
          receivedHandlers.add(handler);
          return () => {
            receivedHandlers.delete(handler);
          };
        }
      : undefined,
    onPushNotificationTapped: options.pushEvents
      ? async (handler) => {
          tappedHandlers.add(handler);
          return () => {
            tappedHandlers.delete(handler);
          };
        }
      : undefined,
    onPushTokenRefresh: options.pushEvents
      ? async (_input, handler) => {
          tokenRefreshHandlers.add(handler);
          return () => {
            tokenRefreshHandlers.delete(handler);
          };
        }
      : undefined,
  };
}
