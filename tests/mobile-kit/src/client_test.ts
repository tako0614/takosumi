import { expect, test } from "bun:test";
import {
  createMobileClientController,
  mobileKnownHostsStorageKey,
  mobileSessionStorageKey,
  type FetchLike,
  type MobilePushRegistration,
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
  oidcScopes: ["openid", "profile", "offline_access"],
};

test("mobile client controller connects, signs in, and loads home", async () => {
  const bridge = memoryBridge();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    oidcScopes: ["openid", "profile", "spaces:read"],
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
  const authorize = new URL(authorizeUrl ?? "");
  expect(authorize.searchParams.get("client_id")).toBe(
    "takos-mobile-host-example",
  );
  expect(authorize.searchParams.get("scope")).toBe(
    "openid profile spaces:read",
  );

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

test("mobile client controller forgets and clears recent hosts", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileKnownHostsStorageKey(adapter),
    JSON.stringify([
      {
        hostUrl: "https://keep.example",
        product: "takos",
        oidcIssuer: "https://keep.example",
        lastSeenAt: "2026-06-30T00:00:00.000Z",
      },
      {
        hostUrl: "https://forget.example",
        product: "takos",
        oidcIssuer: "https://forget.example",
        lastSeenAt: "2026-06-29T00:00:00.000Z",
      },
    ]),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
  });

  await controller.start();
  await controller.forgetKnownHost("https://forget.example/path");

  expect(controller.getState().knownHosts).toEqual([
    {
      hostUrl: "https://keep.example",
      product: "takos",
      oidcIssuer: "https://keep.example",
      lastSeenAt: "2026-06-30T00:00:00.000Z",
      label: undefined,
    },
  ]);
  expect(controller.getState().status).toBe("Recent host removed.");

  await controller.clearKnownHosts();

  expect(controller.getState().knownHosts).toEqual([]);
  expect(controller.getState().status).toBe("Recent hosts cleared.");
  expect(
    await bridge.storage?.get(mobileKnownHostsStorageKey(adapter)),
  ).toBeUndefined();
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

test("mobile client does not restore stale home state after sign out", async () => {
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
  const homeStarted = deferred<void>();
  const releaseHome = deferred<void>();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    loadHome: async () => {
      homeStarted.resolve();
      await releaseHome.promise;
      return { stale: true };
    },
  });

  const starting = controller.start();
  await homeStarted.promise;
  await controller.signOut();
  releaseHome.resolve();
  await starting;

  expect(controller.getState().session).toBeUndefined();
  expect(controller.getState().home).toBeUndefined();
  expect(controller.getState().homeLoading).toBe(false);
  expect(controller.getState().status).toBe("Signed out.");
});

test("mobile client does not persist an OIDC completion that finishes after sign out", async () => {
  const bridge = memoryBridge();
  const tokenExchangeStarted = deferred<void>();
  const releaseTokenExchange = deferred<void>();
  const baseFetch = fixtureFetch();
  const fetch: FetchLike = async (input, init) => {
    if (String(input).endsWith("/oauth/token") && init?.method === "POST") {
      tokenExchangeStarted.resolve();
      await releaseTokenExchange.promise;
    }
    return await baseFetch(input, init);
  };
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
  });

  await controller.connectWithInput("https://host.example");
  await controller.startSignIn();
  const state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  const completion = controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );
  await tokenExchangeStarted.promise;
  await controller.signOut();
  releaseTokenExchange.resolve();
  await completion;

  expect(controller.getState().session).toBeUndefined();
  expect(
    await bridge.storage?.get(mobileSessionStorageKey(adapter)),
  ).toBeUndefined();
});

test("mobile client does not persist a token refresh that finishes after sign out", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://host.example",
      product: "takos",
      oidcIssuer: "https://host.example",
      oidcClientId: "takos-mobile-host-example",
      accessToken: "expired-token",
      tokenType: "Bearer",
      refreshToken: "refresh-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-06-30T00:00:01.000Z",
    }),
  );
  const refreshStarted = deferred<void>();
  const releaseRefresh = deferred<void>();
  const baseFetch = fixtureFetch();
  const fetch: FetchLike = async (input, init) => {
    if (
      String(input).endsWith("/oauth/token") &&
      String(init?.body ?? "").includes("grant_type=refresh_token")
    ) {
      refreshStarted.resolve();
      await releaseRefresh.promise;
    }
    return await baseFetch(input, init);
  };
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
  });

  const starting = controller.start();
  await refreshStarted.promise;
  await controller.signOut();
  releaseRefresh.resolve();
  await starting;

  expect(controller.getState().session).toBeUndefined();
  expect(
    await bridge.storage?.get(mobileSessionStorageKey(adapter)),
  ).toBeUndefined();
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

test("mobile client controller treats hosted route URLs as route handoffs", async () => {
  const bridge = memoryBridge();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    loadHome: async (session) => ({ title: session.hostUrl }),
  });

  await controller.handleLaunchPayload("https://host.example/chat?thread=1");

  expect(controller.getState().discovery?.hostUrl).toBe("https://host.example");
  expect(controller.getState().pendingRoute).toEqual({
    path: "/chat?thread=1",
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
  expect(bridge.opened.at(-1)).toBe("https://host.example/chat?thread=1");
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
      oidcClientId: "takos-mobile-host-example",
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
      oidcClientId: "takos-mobile-host-example",
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

  await controller.handleLaunchPayload(
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

test("mobile client controller rejects cross-product Host Center handoffs", async () => {
  const bridge = memoryBridge();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
  });

  await controller.handleLaunchPayload(
    "takos://connect?host_url=https%3A%2F%2Fhost.example&product=yurucommu",
  );

  expect(controller.getState().connectPayload).toBeUndefined();
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().status).toBe(
    "Mobile connect payload product mismatch.",
  );
});

test("mobile client controller can accept any product payload when the adapter opts in", async () => {
  const bridge = memoryBridge();
  const controller = createMobileClientController({
    adapter: {
      ...adapter,
      product: "notes-app",
      appName: "Notes",
      hostNoun: "Notes host",
      hostCenterLabel: undefined,
      mobileScheme: "notesapp",
      strictDiscoveryProduct: false,
      acceptAnyConnectProduct: true,
    },
    nativeBridge: bridge,
    fetch: fixtureFetch(),
  });

  await controller.handleLaunchPayload(
    "notesapp://connect?host_url=https%3A%2F%2Fhost.example&product=yurucommu",
  );

  expect(controller.getState().connectPayload).toEqual({
    hostUrl: "https://host.example",
    product: "yurucommu",
    setupTicket: undefined,
  });
  expect(controller.getState().discovery?.hostUrl).toBe("https://host.example");
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

test("mobile client unregisters the previous host before activating push on a new host", async () => {
  const bridge = memoryBridge({
    pushRegistration: { token: "push-token", environment: "test" },
  });
  const lifecycle: string[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async ({ session }) => {
      lifecycle.push(`register:${session.hostUrl}`);
    },
    unregisterPush: async ({ session }) => {
      lifecycle.push(`unregister:${session.hostUrl}`);
    },
  });

  await controller.connectWithInput("https://first.example");
  await controller.startSignIn();
  let state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );

  await controller.connectWithInput("https://second.example");
  await controller.startSignIn();
  state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-2&state=${state}`,
  );

  expect(controller.getState().session?.hostUrl).toBe("https://second.example");
  expect(lifecycle).toEqual([
    "register:https://first.example",
    "unregister:https://first.example",
    "register:https://second.example",
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
  const unregistered: unknown[] = [];
  const pushLifecycle: string[] = [];
  const notifications: unknown[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async (input) => {
      registered.push(input);
      pushLifecycle.push(`register:${input.registration.token}`);
    },
    unregisterPush: async (input) => {
      unregistered.push(input);
      pushLifecycle.push(`unregister:${input.registration.token}`);
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
  expect(unregistered).toEqual([
    {
      session: controller.getState().session,
      registration: { token: "push-token", environment: "test" },
    },
  ]);
  expect(pushLifecycle).toEqual([
    "register:push-token",
    "register:rotated-token",
    "unregister:push-token",
  ]);

  bridge.emitPushTokenRefresh({
    token: "rotated-token",
    environment: "test",
  });
  await settle();
  expect(registered).toHaveLength(2);
  expect(unregistered).toHaveLength(1);

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

test("mobile client revokes a registration that finishes after sign out", async () => {
  const bridge = memoryBridge({
    pushRegistration: { token: "late-token", environment: "test" },
    pushEvents: true,
  });
  const registrationStarted = deferred<void>();
  const releaseRegistration = deferred<void>();
  const registered: MobilePushRegistration[] = [];
  const unregistered: MobilePushRegistration[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async ({ registration }) => {
      registered.push(registration);
      registrationStarted.resolve();
      await releaseRegistration.promise;
    },
    unregisterPush: async ({ registration }) => {
      unregistered.push(registration);
    },
  });

  await controller.connectWithInput("https://host.example");
  await controller.startSignIn();
  const state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  const completion = controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );
  await registrationStarted.promise;

  const signingOut = controller.signOut();
  await settle();
  expect(controller.getState().session).toBeUndefined();
  releaseRegistration.resolve();
  await signingOut;
  await completion;

  expect(registered).toEqual([{ token: "late-token", environment: "test" }]);
  expect(unregistered).toEqual([{ token: "late-token", environment: "test" }]);
  expect(controller.getState().session).toBeUndefined();
  expect(controller.getState().pushRegistration).toBeUndefined();
  expect(controller.getState().pushLoading).toBe(false);

  bridge.emitPushTokenRefresh({ token: "stale-token", environment: "test" });
  await settle();
  expect(registered).toHaveLength(1);
});

test("mobile client serializes refreshes so the newest token remains authoritative", async () => {
  const bridge = memoryBridge({
    pushRegistration: { token: "initial-token", environment: "test" },
    pushEvents: true,
  });
  const releaseSlowRefresh = deferred<void>();
  const refreshStarted = deferred<void>();
  const lifecycle: string[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async ({ registration }) => {
      lifecycle.push(`register:${registration.token}`);
      if (registration.token === "slow-token") {
        refreshStarted.resolve();
        await releaseSlowRefresh.promise;
      }
    },
    unregisterPush: async ({ registration }) => {
      lifecycle.push(`unregister:${registration.token}`);
    },
  });

  await controller.connectWithInput("https://host.example");
  await controller.startSignIn();
  const state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );

  bridge.emitPushTokenRefresh({ token: "slow-token", environment: "test" });
  await refreshStarted.promise;
  bridge.emitPushTokenRefresh({ token: "newest-token", environment: "test" });
  releaseSlowRefresh.resolve();
  await settle();
  await settle();

  expect(controller.getState().pushRegistration).toEqual({
    token: "newest-token",
    environment: "test",
  });
  expect(controller.getState().pushLoading).toBe(false);
  expect(lifecycle).toEqual([
    "register:initial-token",
    "register:slow-token",
    "unregister:initial-token",
    "register:newest-token",
    "unregister:slow-token",
  ]);
});

test("mobile client keeps the previous push token when refreshed registration fails", async () => {
  const bridge = memoryBridge({
    pushRegistration: { token: "push-token", environment: "test" },
    pushEvents: true,
  });
  const unregistered: MobilePushRegistration[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: fixtureFetch(),
    registerPush: async ({ registration }) => {
      if (registration.token === "rejected-token") {
        throw new Error("host rejected refreshed token");
      }
    },
    unregisterPush: async ({ registration }) => {
      unregistered.push(registration);
    },
  });

  await controller.connectWithInput("https://host.example");
  await controller.startSignIn();
  const state = new URL(bridge.opened.at(-1) ?? "").searchParams.get("state");
  await controller.completeSignIn(
    `takos://oauth/callback?code=code-1&state=${state}`,
  );

  bridge.emitPushTokenRefresh({
    token: "rejected-token",
    environment: "test",
  });
  await settle();

  expect(controller.getState().pushRegistration).toEqual({
    token: "push-token",
    environment: "test",
  });
  expect(controller.getState().pushStatus).toBe(
    "host rejected refreshed token",
  );
  expect(unregistered).toEqual([]);
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
  let nativeUnregisterCount = 0;
  const bridge = memoryBridge({
    pushRegistration: {
      token: "push-token",
      environment: "test",
    },
    unregisterPush: async () => {
      nativeUnregisterCount += 1;
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
  expect(nativeUnregisterCount).toBe(1);
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
    if (url.endsWith("/.well-known/takosumi")) {
      return json({ issuer: new URL(url).origin });
    }
    if (url.endsWith("/.well-known/takos")) {
      return json({
        product: "takos",
        issuer: new URL(url).origin,
        oidcClientId: "takos-mobile-host-example",
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
      expect(body).toContain("client_id=takos-mobile-host-example");
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    readonly unregisterPush?: () => Promise<void>;
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
  readonly emitPushTokenRefresh: (registration: MobilePushRegistration) => void;
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
    (registration: MobilePushRegistration) => void
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
      clipboardText: false,
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
    unregisterPushNotifications: options.unregisterPush,
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
