import { expect, test } from "bun:test";
import {
  authenticateBiometric,
  createTauriInvokeKeystoreAdapter,
  createTauriKeystoreStrongholdPassword,
  createTauriMobileDefaultProductBridge,
  createTauriMobilePushPluginAdapter,
  createTauriOpenerCallIntentAdapter,
  createTauriMobileProductBridge,
  createTauriMobileProductStorageNames,
  createTauriPluginNativeBridge,
  createTauriPersistentStrongholdPassword,
  createTauriPushNotificationsAdapter,
  createTauriStrongholdSecureStore,
  isTauriMobilePlatform,
  type TauriStoreHandle,
} from "../../../mobile-kit/src/index.ts";

test("tauri plugin bridge maps typed native plugins to NativeBridge", async () => {
  const opened: Array<[string | URL, string | undefined]> = [];
  const notifications: unknown[] = [];
  const pushes: unknown[] = [];
  const receivedPushes: unknown[] = [];
  const tappedPushes: unknown[] = [];
  const refreshedPushTokens: unknown[] = [];
  let pushUnregistrations = 0;
  const biometrics: unknown[] = [];
  const calls: unknown[] = [];
  const clips: unknown[] = [];
  let openHandler: ((urls: string[]) => void) | undefined;
  let receivedPushHandler:
    | ((notification: {
        readonly title?: string;
        readonly body?: string;
        readonly data: Record<string, unknown>;
      }) => void)
    | undefined;
  let tappedPushHandler: typeof receivedPushHandler;
  let refreshedPushTokenHandler:
    | ((registration: {
        readonly token: string;
        readonly environment?: string;
      }) => void)
    | undefined;
  const bridge = createTauriPluginNativeBridge({
    appName: "Takos",
    storePath: "session.json",
    isTauriRuntime: () => true,
    deepLink: {
      async getCurrent() {
        return ["takos://connect?host_url=https%3A%2F%2Fhost.example"];
      },
      async onOpenUrl(handler) {
        openHandler = handler;
        return () => {
          openHandler = undefined;
        };
      },
    },
    opener: {
      async openUrl(url, openWith) {
        opened.push([url, openWith]);
      },
    },
    store: {
      async load() {
        return memoryStore();
      },
    },
    platform: {
      platform: () => "ios",
    },
    secureStore: memorySecureStore(),
    notification: {
      async isPermissionGranted() {
        return false;
      },
      async requestPermission() {
        return "granted";
      },
      sendNotification(notification) {
        notifications.push(notification);
      },
    },
    barcodeScanner: {
      async scanConnectionPayload() {
        return "https://host.example";
      },
    },
    pushNotifications: {
      async register(input) {
        pushes.push(input);
        return { token: "push-token", environment: "test" };
      },
      async unregister() {
        pushUnregistrations += 1;
      },
      async onNotificationReceived(handler) {
        receivedPushHandler = handler;
        return () => {
          receivedPushHandler = undefined;
        };
      },
      async onNotificationTapped(handler) {
        tappedPushHandler = handler;
        return () => {
          tappedPushHandler = undefined;
        };
      },
      async onTokenRefresh(input, handler) {
        refreshedPushTokens.push(input);
        refreshedPushTokenHandler = handler;
        return () => {
          refreshedPushTokenHandler = undefined;
        };
      },
    },
    biometric: {
      async authenticate(message, options) {
        biometrics.push({ message, options });
      },
    },
    callIntent: {
      async requestCall(input) {
        calls.push(input);
      },
    },
    clipboard: {
      async writeText(text, options) {
        clips.push({ text, options });
      },
    },
  });

  expect(bridge.capabilities.launchPayloadEvents).toBe(true);
  expect(bridge.capabilities.localNotifications).toBe(true);
  expect(bridge.capabilities.pushNotifications).toBe(true);
  expect(bridge.capabilities.biometricAuth).toBe(true);
  expect(bridge.capabilities.callIntent).toBe(true);
  expect(bridge.capabilities.clipboardText).toBe(true);
  expect(bridge.capabilities.secureStorage).toBe(true);
  expect(bridge.storage?.kind).toBe("device-persistent");
  expect(bridge.secureStore?.kind).toBe("secure");

  expect(await bridge.getLaunchPayload()).toBe(
    "takos://connect?host_url=https%3A%2F%2Fhost.example",
  );
  await bridge.openExternalUrl("https://app.takosumi.com");
  expect(opened).toEqual([["https://app.takosumi.com", undefined]]);

  await bridge.storage?.set("session", "value");
  expect(await bridge.storage?.get("session")).toBe("value");
  await bridge.storage?.delete("session");
  expect(await bridge.storage?.get("session")).toBeUndefined();
  await bridge.secureStore?.set("session", "secret-value");
  expect(await bridge.secureStore?.get("session")).toBe("secret-value");
  await bridge.secureStore?.delete("session");
  expect(await bridge.secureStore?.get("session")).toBeUndefined();

  expect(await bridge.scanConnectionPayload?.()).toBe("https://host.example");
  expect(
    await bridge.registerPushNotifications?.({
      hostUrl: "https://host.example",
      product: "takos",
      accountId: "acct_1",
    }),
  ).toEqual({ token: "push-token", environment: "test" });
  expect(pushes).toEqual([
    {
      hostUrl: "https://host.example",
      product: "takos",
      accountId: "acct_1",
    },
  ]);
  await bridge.unregisterPushNotifications?.();
  expect(pushUnregistrations).toBe(1);
  const unlistenReceived = await bridge.onPushNotificationReceived?.(
    (notification) => {
      receivedPushes.push(notification);
    },
  );
  const unlistenTapped = await bridge.onPushNotificationTapped?.(
    (notification) => {
      tappedPushes.push(notification);
    },
  );
  const unlistenRefresh = await bridge.onPushTokenRefresh?.(
    {
      hostUrl: "https://host.example",
      product: "takos",
    },
    (registration) => {
      refreshedPushTokens.push(registration);
    },
  );
  receivedPushHandler?.({
    title: "Message",
    body: "Hello",
    data: { path: "/notifications" },
  });
  tappedPushHandler?.({
    title: "Opened",
    data: { path: "/chat" },
  });
  refreshedPushTokenHandler?.({
    token: "rotated-token",
    environment: "test",
  });
  expect(receivedPushes).toEqual([
    {
      title: "Message",
      body: "Hello",
      data: { path: "/notifications" },
      badge: undefined,
      sound: undefined,
    },
  ]);
  expect(tappedPushes).toEqual([
    {
      title: "Opened",
      body: undefined,
      data: { path: "/chat" },
      badge: undefined,
      sound: undefined,
    },
  ]);
  expect(refreshedPushTokens).toEqual([
    {
      hostUrl: "https://host.example",
      product: "takos",
    },
    {
      token: "rotated-token",
      environment: "test",
    },
  ]);
  await unlistenReceived?.();
  await unlistenTapped?.();
  await unlistenRefresh?.();
  expect(receivedPushHandler).toBeUndefined();
  expect(tappedPushHandler).toBeUndefined();
  expect(refreshedPushTokenHandler).toBeUndefined();
  await expect(
    bridge.authenticateBiometric?.({
      message: "Unlock Takos",
      allowDeviceCredential: true,
      title: "Takos",
    }),
  ).resolves.toBe(true);
  expect(biometrics).toEqual([
    {
      message: "Unlock Takos",
      options: {
        allowDeviceCredential: true,
        cancelTitle: undefined,
        fallbackTitle: undefined,
        title: "Takos",
        subtitle: undefined,
        confirmationRequired: undefined,
      },
    },
  ]);
  await bridge.requestCall?.({
    roomUrl: "https://host.example/calls/room-1",
    title: "Daily sync",
  });
  expect(calls).toEqual([
    {
      roomUrl: "https://host.example/calls/room-1",
      title: "Daily sync",
    },
  ]);
  await bridge.writeClipboardText?.({
    text: "https://host.example/stories/1",
    label: "Story URL",
  });
  expect(clips).toEqual([
    {
      text: "https://host.example/stories/1",
      options: { label: "Story URL" },
    },
  ]);
  expect(await bridge.requestLocalNotificationPermission?.()).toBe(true);
  await bridge.sendLocalNotification?.({ title: "Takos", body: "Connected" });
  expect(notifications).toEqual([{ title: "Takos", body: "Connected" }]);

  const payloads: string[] = [];
  const unlisten = await bridge.onLaunchPayload?.((payload) => {
    payloads.push(payload);
  });
  openHandler?.(["takos://oauth/callback?code=c&state=s"]);
  expect(payloads).toEqual(["takos://oauth/callback?code=c&state=s"]);
  unlisten?.();
  expect(openHandler).toBeUndefined();
});

test("tauri mobile product bridge builds the shared product native bridge", async () => {
  const loadedStrongholds: Array<[string, string]> = [];
  const scannedOptions: unknown[] = [];
  const bridge = createTauriMobileProductBridge({
    appName: "Takos",
    storePath: "takos-mobile-session.json",
    strongholdVaultFileName: "takos-mobile.hold",
    strongholdPassword: async () => "vault-password",
    strongholdClientName: "takos-mobile",
    isTauriRuntime: () => true,
    path: {
      async appDataDir() {
        return "/data/app";
      },
      async join(...paths) {
        return paths.join("/");
      },
    },
    platform: {
      platform: () => "android",
    },
    deepLink: {
      async getCurrent() {
        return null;
      },
      async onOpenUrl() {
        return () => {};
      },
    },
    opener: {
      async openUrl() {},
    },
    store: {
      async load() {
        return memoryStore();
      },
    },
    stronghold: {
      async load(path, password) {
        loadedStrongholds.push([path, password]);
        return {
          async loadClient() {
            return {
              getStore() {
                return memoryStrongholdStore();
              },
            };
          },
          async createClient() {
            throw new Error("loadClient should be used");
          },
          async save() {},
        };
      },
    },
    barcodeScanner: {
      qrCodeFormat: "qr-code",
      async scan(options) {
        scannedOptions.push(options);
        return { content: "https://host.example" };
      },
    },
  });

  expect(bridge.capabilities.inAppBrowser).toBe(true);
  expect(bridge.capabilities.secureStorage).toBe(true);
  expect(bridge.capabilities.qrScanner).toBe(true);
  await bridge.secureStore?.set("session", "secret");
  expect(loadedStrongholds).toEqual([
    ["/data/app/takos-mobile.hold", "vault-password"],
  ]);
  expect(await bridge.scanConnectionPayload?.()).toBe("https://host.example");
  expect(scannedOptions).toEqual([{ formats: ["qr-code"] }]);
});

test("tauri default product bridge assembles product storage, keystore, push, and call adapters", async () => {
  const password = "notes-mobile-stronghold.0123456789abcdef0123456789abcdef";
  const invocations: Array<[string, Record<string, unknown> | undefined]> = [];
  const loadedStrongholds: Array<[string, string]> = [];
  const opened: Array<[string | URL, string | undefined]> = [];
  const clips: unknown[] = [];
  let permissionRequested = false;
  let pushUnregistered = false;

  const bridge = createTauriMobileDefaultProductBridge({
    productAdapter: {
      product: "notes-app",
      appName: "Notes",
    },
    keychainService: "jp.takos.notes.mobile",
    invoke: async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      invocations.push([command, args]);
      if (command === "plugin:keystore|retrieve") {
        return { value: password } as T;
      }
      return undefined as T;
    },
    isTauriRuntime: () => true,
    path: {
      async appDataDir() {
        return "/data/app";
      },
      async join(...paths) {
        return paths.join("/");
      },
    },
    platform: {
      platform: () => "android",
    },
    deepLink: {
      async getCurrent() {
        return null;
      },
      async onOpenUrl() {
        return () => {};
      },
    },
    opener: {
      async openUrl(url, openWith) {
        opened.push([url, openWith]);
      },
    },
    store: {
      async load() {
        return memoryStore();
      },
    },
    stronghold: {
      async load(path, strongholdPassword) {
        loadedStrongholds.push([path, strongholdPassword]);
        return {
          async loadClient() {
            return {
              getStore() {
                return memoryStrongholdStore();
              },
            };
          },
          async createClient() {
            throw new Error("loadClient should be used");
          },
          async save() {},
        };
      },
    },
    mobilePush: {
      async requestPermission() {
        permissionRequested = true;
        return true;
      },
      async getToken() {
        return "push-token";
      },
      async unregister() {
        pushUnregistered = true;
      },
    },
    clipboard: {
      async writeText(text, options) {
        clips.push({ text, options });
      },
    },
  });

  expect(bridge.capabilities.secureStorage).toBe(true);
  expect(bridge.capabilities.pushNotifications).toBe(true);
  expect(bridge.capabilities.callIntent).toBe(true);
  expect(bridge.capabilities.clipboardText).toBe(true);

  await bridge.secureStore?.set("session", "secret");
  expect(invocations).toEqual([
    [
      "plugin:keystore|retrieve",
      {
        payload: {
          service: "jp.takos.notes.mobile",
          user: "stronghold-password",
        },
      },
    ],
  ]);
  expect(loadedStrongholds).toEqual([
    ["/data/app/notes-app-mobile.hold", password],
  ]);

  await expect(
    bridge.registerPushNotifications?.({
      hostUrl: "https://host.example",
      product: "notes-app",
    }),
  ).resolves.toEqual({
    token: "push-token",
    environment: undefined,
  });
  expect(permissionRequested).toBe(true);
  await bridge.unregisterPushNotifications?.();
  expect(pushUnregistered).toBe(true);

  await bridge.requestCall?.({
    roomUrl: "https://host.example/calls/room-1",
    title: "Daily sync",
  });
  expect(opened).toEqual([
    ["https://host.example/calls/room-1", "inAppBrowser"],
  ]);
  await bridge.writeClipboardText?.({
    text: "https://host.example/stories/1",
  });
  expect(clips).toEqual([
    {
      text: "https://host.example/stories/1",
      options: undefined,
    },
  ]);
});

test("tauri mobile product storage names are derived from product keys", () => {
  expect(createTauriMobileProductStorageNames({ product: "takos" })).toEqual({
    storePath: "takos-mobile-session.json",
    strongholdVaultFileName: "takos-mobile.hold",
    strongholdClientName: "takos-mobile",
    strongholdPasswordKey: "takos.mobile.stronghold.password",
    strongholdPasswordPrefix: "takos-mobile-stronghold",
  });
  expect(
    createTauriMobileProductStorageNames({ product: "notes-app" }),
  ).toEqual({
    storePath: "notes-app-mobile-session.json",
    strongholdVaultFileName: "notes-app-mobile.hold",
    strongholdClientName: "notes-app-mobile",
    strongholdPasswordKey: "notes-app.mobile.stronghold.password",
    strongholdPasswordPrefix: "notes-app-mobile-stronghold",
  });
  expect(
    createTauriMobileProductStorageNames(
      { product: "notes-app" },
      {
        storePath: "custom.json",
        strongholdVaultFileName: "custom.hold",
        strongholdClientName: "custom-client",
        strongholdPasswordKey: "custom.password",
        strongholdPasswordPrefix: "custom-prefix",
      },
    ),
  ).toEqual({
    storePath: "custom.json",
    strongholdVaultFileName: "custom.hold",
    strongholdClientName: "custom-client",
    strongholdPasswordKey: "custom.password",
    strongholdPasswordPrefix: "custom-prefix",
  });
});

test("tauri bridge disables mobile-only native plugins on desktop platforms", async () => {
  const bridge = createTauriPluginNativeBridge({
    appName: "Takos",
    storePath: "session.json",
    isTauriRuntime: () => true,
    deepLink: {
      async getCurrent() {
        return null;
      },
      async onOpenUrl() {
        return () => {};
      },
    },
    opener: {
      async openUrl() {},
    },
    store: {
      async load() {
        return memoryStore();
      },
    },
    platform: {
      platform: () => "linux",
    },
    barcodeScanner: {
      async scanConnectionPayload() {
        return "https://host.example";
      },
    },
    pushNotifications: {
      async register() {
        throw new Error("desktop push should be disabled");
      },
    },
    biometric: {
      async authenticate() {
        throw new Error("desktop biometric should be disabled");
      },
    },
  });

  expect(isTauriMobilePlatform("android")).toBe(true);
  expect(isTauriMobilePlatform("ios")).toBe(true);
  expect(isTauriMobilePlatform("linux")).toBe(false);
  expect(bridge.capabilities.qrScanner).toBe(false);
  expect(bridge.capabilities.pushNotifications).toBe(false);
  expect(bridge.capabilities.biometricAuth).toBe(false);
  expect(bridge.scanConnectionPayload).toBeUndefined();
  expect(bridge.registerPushNotifications).toBeUndefined();
  expect(bridge.onPushNotificationReceived).toBeUndefined();
  expect(bridge.onPushNotificationTapped).toBeUndefined();
  expect(bridge.onPushTokenRefresh).toBeUndefined();
  expect(bridge.authenticateBiometric).toBeUndefined();
});

test("tauri helper adapters normalize push tokens and call intents", async () => {
  const tokenRequests: unknown[] = [];
  const push = createTauriPushNotificationsAdapter({
    environment: (input) => `${input.product}-dev`,
    tokenSource: {
      async requestToken(input) {
        tokenRequests.push(input);
        return "push-token";
      },
    },
  });

  await expect(
    push.register({
      hostUrl: "https://host.example",
      product: "takos",
    }),
  ).resolves.toEqual({
    token: "push-token",
    environment: "takos-dev",
  });
  expect(tokenRequests).toEqual([
    {
      hostUrl: "https://host.example",
      product: "takos",
    },
  ]);

  const objectPush = createTauriPushNotificationsAdapter({
    environment: "local",
    tokenSource: {
      async requestToken() {
        return {
          token: "ios-token",
          provider: "apns",
          environment: " simulator ",
        };
      },
    },
  });
  await expect(
    objectPush.register({
      hostUrl: "https://host.example",
      product: "takos",
    }),
  ).resolves.toEqual({
    token: "ios-token",
    provider: "apns",
    environment: "simulator",
  });

  const invalidEnvironmentPush = createTauriPushNotificationsAdapter({
    environment: "fallback-env",
    tokenSource: {
      async requestToken() {
        return {
          token: "android-token",
          environment: "prod env",
        };
      },
    },
  });
  await expect(
    invalidEnvironmentPush.register({
      hostUrl: "https://host.example",
      product: "takos",
    }),
  ).resolves.toEqual({
    token: "android-token",
    environment: "fallback-env",
  });

  const opened: Array<[string | URL, string | undefined]> = [];
  const calls = createTauriOpenerCallIntentAdapter({
    opener: {
      async openUrl(url, openWith) {
        opened.push([url, openWith]);
      },
    },
  });

  await calls.requestCall({
    roomUrl: "https://host.example/calls/room-1",
    title: "Daily sync",
  });
  expect(opened).toEqual([
    ["https://host.example/calls/room-1", "inAppBrowser"],
  ]);
});

test("tauri biometric helper returns false when native auth rejects", async () => {
  await expect(
    authenticateBiometric(
      {
        async authenticate() {
          throw new Error("cancelled");
        },
      },
      { message: "Unlock" },
    ),
  ).resolves.toBe(false);
});

test("tauri mobile-push plugin adapter requests permission and normalizes tokens", async () => {
  const calls: string[] = [];
  let receivedHandler:
    | ((notification: {
        readonly title?: string;
        readonly data: Record<string, unknown>;
      }) => void)
    | undefined;
  let tappedHandler: typeof receivedHandler;
  let refreshHandler:
    | ((payload: {
        readonly token: string;
        readonly provider?: "apns" | "fcm";
        readonly environment?: string;
      }) => void)
    | undefined;
  const notifications: unknown[] = [];
  const taps: unknown[] = [];
  const refreshes: unknown[] = [];
  let unregisters = 0;
  const push = createTauriMobilePushPluginAdapter({
    environment: "device",
    mobilePush: {
      async requestPermission() {
        calls.push("permission");
        return { granted: true };
      },
      async getToken() {
        calls.push("token");
        return "device-token";
      },
      async onNotificationReceived(handler) {
        receivedHandler = handler;
        return {
          unregister() {
            unregisters += 1;
          },
        };
      },
      async onNotificationTapped(handler) {
        tappedHandler = handler;
        return {
          unregister() {
            unregisters += 1;
          },
        };
      },
      async onTokenRefresh(handler) {
        refreshHandler = handler;
        return {
          unregister() {
            unregisters += 1;
          },
        };
      },
    },
  });

  await expect(
    push.register({
      hostUrl: "https://host.example",
      product: "takos",
    }),
  ).resolves.toEqual({
    token: "device-token",
    environment: "device",
  });
  expect(calls).toEqual(["permission", "token"]);

  const receivedUnlisten = await push.onNotificationReceived?.(
    (notification) => {
      notifications.push(notification);
    },
  );
  const tappedUnlisten = await push.onNotificationTapped?.((notification) => {
    taps.push(notification);
  });
  const refreshUnlisten = await push.onTokenRefresh?.(
    {
      hostUrl: "https://host.example",
      product: "takos",
    },
    (registration) => {
      refreshes.push(registration);
    },
  );
  receivedHandler?.({ title: "Incoming", data: { path: "/notifications" } });
  tappedHandler?.({ title: "Open", data: { route: "/chat" } });
  refreshHandler?.({
    token: "rotated-token",
    provider: "fcm",
    environment: "production",
  });
  expect(notifications).toEqual([
    {
      title: "Incoming",
      body: undefined,
      data: { path: "/notifications" },
      badge: undefined,
      sound: undefined,
    },
  ]);
  expect(taps).toEqual([
    {
      title: "Open",
      body: undefined,
      data: { route: "/chat" },
      badge: undefined,
      sound: undefined,
    },
  ]);
  expect(refreshes).toEqual([
    {
      token: "rotated-token",
      provider: "fcm",
      environment: "production",
    },
  ]);
  await receivedUnlisten?.();
  await tappedUnlisten?.();
  await refreshUnlisten?.();
  expect(unregisters).toBe(3);
});

test("tauri mobile-push plugin adapter skips host registration when denied", async () => {
  const calls: string[] = [];
  const push = createTauriMobilePushPluginAdapter({
    mobilePush: {
      async requestPermission() {
        calls.push("permission");
        return "denied";
      },
      async getToken() {
        calls.push("token");
        return "device-token";
      },
    },
  });

  await expect(
    push.register({
      hostUrl: "https://host.example",
      product: "yurucommu",
    }),
  ).resolves.toBeUndefined();
  expect(calls).toEqual(["permission"]);
});

test("tauri mobile-push plugin adapter treats malformed permission as denied", async () => {
  const calls: string[] = [];
  const push = createTauriMobilePushPluginAdapter({
    mobilePush: {
      async requestPermission() {
        calls.push("permission");
        return undefined as unknown as { readonly granted: boolean };
      },
      async getToken() {
        calls.push("token");
        return "device-token";
      },
    },
  });

  await expect(
    push.register({
      hostUrl: "https://host.example",
      product: "takos",
    }),
  ).resolves.toBeUndefined();
  expect(calls).toEqual(["permission"]);
});

test("tauri persistent Stronghold password helper generates and reuses product-local seed", async () => {
  const handle = memoryStore();
  const crypto = {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array instanceof Uint8Array) {
        for (let index = 0; index < array.length; index += 1) {
          array[index] = index + 1;
        }
      }
      return array;
    },
  } as Crypto;
  const passwordSource = createTauriPersistentStrongholdPassword({
    store: {
      async load(path) {
        expect(path).toBe("takos-mobile-session.json");
        return handle;
      },
    },
    storePath: "takos-mobile-session.json",
    key: "takos.mobile.stronghold.password",
    prefix: "takos-mobile-stronghold",
    byteLength: 16,
    crypto,
  });

  const first = await passwordSource();
  const second = await passwordSource();
  expect(first).toBe(
    "takos-mobile-stronghold.0102030405060708090a0b0c0d0e0f10",
  );
  expect(second).toBe(first);
  expect(await handle.get<string>("takos.mobile.stronghold.password")).toBe(
    first,
  );

  const reloadedPasswordSource = createTauriPersistentStrongholdPassword({
    store: {
      async load() {
        return handle;
      },
    },
    storePath: "takos-mobile-session.json",
    key: "takos.mobile.stronghold.password",
    prefix: "takos-mobile-stronghold",
    crypto,
  });
  expect(await reloadedPasswordSource()).toBe(first);
});

test("tauri keystore Stronghold password helper reads an existing keystore seed", async () => {
  const stores: string[] = [];
  const passwordSource = createTauriKeystoreStrongholdPassword({
    keystore: {
      async store(_service, _user, value) {
        stores.push(value);
      },
      async retrieve(service, user) {
        expect(service).toBe("jp.takos.mobile");
        expect(user).toBe("stronghold-password");
        return "takos-mobile-stronghold.from-keystore-value";
      },
      async remove() {},
    },
    service: "jp.takos.mobile",
    user: "stronghold-password",
  });

  expect(await passwordSource()).toBe(
    "takos-mobile-stronghold.from-keystore-value",
  );
  expect(await passwordSource()).toBe(
    "takos-mobile-stronghold.from-keystore-value",
  );
  expect(stores).toEqual([]);
});

test("tauri keystore Stronghold password helper migrates the Store fallback", async () => {
  const handle = memoryStore();
  await handle.set(
    "takos.mobile.stronghold.password",
    "takos-mobile-stronghold.from-store-fallback",
  );
  const stores: string[] = [];
  const passwordSource = createTauriKeystoreStrongholdPassword({
    keystore: {
      async store(service, user, value) {
        expect(service).toBe("jp.takos.mobile");
        expect(user).toBe("stronghold-password");
        stores.push(value);
      },
      async retrieve() {
        return null;
      },
      async remove() {},
    },
    service: "jp.takos.mobile",
    user: "stronghold-password",
    fallback: {
      store: {
        async load() {
          return handle;
        },
      },
      storePath: "takos-mobile-session.json",
      key: "takos.mobile.stronghold.password",
      prefix: "takos-mobile-stronghold",
    },
  });

  expect(await passwordSource()).toBe(
    "takos-mobile-stronghold.from-store-fallback",
  );
  expect(stores).toEqual(["takos-mobile-stronghold.from-store-fallback"]);
  expect(await handle.get<string>("takos.mobile.stronghold.password")).toBe(
    "takos-mobile-stronghold.from-store-fallback",
  );

  const verifiedPasswordSource = createTauriKeystoreStrongholdPassword({
    keystore: {
      async store() {
        throw new Error("verified migration must not store again");
      },
      async retrieve() {
        return "takos-mobile-stronghold.from-store-fallback";
      },
      async remove() {},
    },
    service: "jp.takos.mobile",
    user: "stronghold-password",
    fallback: {
      store: {
        async load() {
          return handle;
        },
      },
      storePath: "takos-mobile-session.json",
      key: "takos.mobile.stronghold.password",
    },
  });
  expect(await verifiedPasswordSource()).toBe(
    "takos-mobile-stronghold.from-store-fallback",
  );
  expect(
    await handle.get<string>("takos.mobile.stronghold.password"),
  ).toBeUndefined();
});

test("tauri keystore Stronghold password helper never silently uses plaintext after secure store failure", async () => {
  const handle = memoryStore();
  await handle.set(
    "takos.mobile.stronghold.password",
    "takos-mobile-stronghold.from-store-fallback",
  );
  const passwordSource = createTauriKeystoreStrongholdPassword({
    keystore: {
      async store() {
        throw new Error("native storage unavailable");
      },
      async retrieve() {
        return null;
      },
      async remove() {},
    },
    service: "jp.takos.mobile",
    user: "stronghold-password",
    fallback: {
      store: {
        async load() {
          return handle;
        },
      },
      storePath: "takos-mobile-session.json",
      key: "takos.mobile.stronghold.password",
    },
  });

  await expect(passwordSource()).rejects.toThrow("native storage unavailable");
  expect(await handle.get<string>("takos.mobile.stronghold.password")).toBe(
    "takos-mobile-stronghold.from-store-fallback",
  );
});

test("tauri keystore Stronghold password helper rejects mismatched migration values", async () => {
  const handle = memoryStore();
  await handle.set(
    "takos.mobile.stronghold.password",
    "takos-mobile-stronghold.legacy-password-value",
  );
  const passwordSource = createTauriKeystoreStrongholdPassword({
    keystore: {
      async store() {},
      async retrieve() {
        return "takos-mobile-stronghold.native-password-value";
      },
      async remove() {},
    },
    service: "jp.takos.mobile",
    user: "stronghold-password",
    fallback: {
      store: {
        async load() {
          return handle;
        },
      },
      storePath: "takos-mobile-session.json",
      key: "takos.mobile.stronghold.password",
    },
  });

  await expect(passwordSource()).rejects.toThrow(
    "Native and legacy Stronghold password values do not match.",
  );
  expect(await handle.get<string>("takos.mobile.stronghold.password")).toBe(
    "takos-mobile-stronghold.legacy-password-value",
  );
});

test("tauri invoke keystore adapter calls the plugin commands", async () => {
  const calls: Array<{
    readonly command: string;
    readonly args?: Record<string, unknown>;
  }> = [];
  const keystore = createTauriInvokeKeystoreAdapter({
    async invoke<T = unknown>(command: string, args?: Record<string, unknown>) {
      calls.push({ command, args });
      if (command === "plugin:keystore|retrieve") {
        return { value: "stored-secret" } as T;
      }
      return undefined as T;
    },
  });

  await keystore.store(
    "jp.takos.mobile",
    "stronghold-password",
    "stored-secret",
  );
  await expect(
    keystore.retrieve("jp.takos.mobile", "stronghold-password"),
  ).resolves.toBe("stored-secret");
  await keystore.remove("jp.takos.mobile", "stronghold-password");
  expect(calls).toEqual([
    {
      command: "plugin:keystore|store",
      args: {
        payload: {
          service: "jp.takos.mobile",
          user: "stronghold-password",
          value: "stored-secret",
        },
      },
    },
    {
      command: "plugin:keystore|retrieve",
      args: {
        payload: {
          service: "jp.takos.mobile",
          user: "stronghold-password",
        },
      },
    },
    {
      command: "plugin:keystore|remove",
      args: {
        payload: {
          service: "jp.takos.mobile",
          user: "stronghold-password",
        },
      },
    },
  ]);
});

test("stronghold secure store adapter reads, writes, deletes, and saves", async () => {
  const saves: string[] = [];
  const values = new Map<string, Uint8Array>();
  const secureStore = createTauriStrongholdSecureStore({
    stronghold: {
      async load(path, password) {
        expect(path).toBe("/tmp/takos.hold");
        expect(password).toBe("vault-password");
        return {
          async loadClient() {
            throw new Error("client not found");
          },
          async createClient(client) {
            expect(client).toBe("takos-mobile");
            return {
              getStore() {
                return {
                  async get(key) {
                    return values.get(key) ?? null;
                  },
                  async insert(key, value) {
                    values.set(key, new Uint8Array(value));
                  },
                  async remove(key) {
                    const current = values.get(key) ?? null;
                    values.delete(key);
                    return current;
                  },
                };
              },
            };
          },
          async save() {
            saves.push("saved");
          },
        };
      },
    },
    vaultPath: async () => "/tmp/takos.hold",
    password: "vault-password",
    clientName: "takos-mobile",
  });

  await secureStore.set("session", "secret-value");
  expect(await secureStore.get("session")).toBe("secret-value");
  await secureStore.delete("session");
  expect(await secureStore.get("session")).toBeUndefined();
  expect(saves).toEqual(["saved", "saved"]);
});

function memoryStore(): TauriStoreHandle {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
    async save() {},
  };
}

function memorySecureStore() {
  const values = new Map<string, string>();
  return {
    kind: "secure" as const,
    async get(key: string) {
      return values.get(key);
    },
    async set(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

function memoryStrongholdStore() {
  const values = new Map<string, Uint8Array>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async insert(key: string, value: number[]) {
      values.set(key, new Uint8Array(value));
    },
    async remove(key: string) {
      const current = values.get(key) ?? null;
      values.delete(key);
      return current;
    },
  };
}
