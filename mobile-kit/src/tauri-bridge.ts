import type {
  MobileCallIntent,
  MobileBiometricPrompt,
  MobileKeyValueStore,
  MobileLocalNotification,
  MobileProductAdapter,
  MobilePushNotification,
  MobilePushProvider,
  MobilePushRegistration,
  MobilePushRegistrationInput,
  MobileClipboardText,
  NativeBridge,
} from "./types.ts";
import { createBrowserNativeBridge } from "./native.ts";
import { requireMobileProductKey } from "./product-key.ts";

export interface TauriDeepLinkAdapter {
  readonly getCurrent: () => Promise<string[] | null>;
  readonly onOpenUrl: (
    handler: (urls: string[]) => void,
  ) => Promise<() => void>;
}

export interface TauriOpenerAdapter {
  readonly openUrl: (
    url: string | URL,
    openWith?: "inAppBrowser" | string,
  ) => Promise<void>;
}

export interface TauriStoreAdapter {
  readonly load: (path: string) => Promise<TauriStoreHandle>;
}

export interface TauriStoreHandle {
  readonly get: <T>(key: string) => Promise<T | undefined>;
  readonly set: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<boolean>;
  readonly save: () => Promise<void>;
}

export type TauriSecureStoreAdapter = MobileKeyValueStore;

export interface TauriStrongholdAdapter {
  readonly load: (
    path: string,
    password: string,
  ) => Promise<TauriStrongholdHandle>;
}

export interface TauriStrongholdHandle {
  readonly loadClient: (client: string) => Promise<TauriStrongholdClient>;
  readonly createClient: (client: string) => Promise<TauriStrongholdClient>;
  readonly save: () => Promise<void>;
}

export interface TauriStrongholdClient {
  readonly getStore: () => TauriStrongholdStore;
}

export interface TauriStrongholdStore {
  readonly get: (key: string) => Promise<Uint8Array | null>;
  readonly insert: (key: string, value: number[]) => Promise<void>;
  readonly remove: (key: string) => Promise<Uint8Array | null>;
}

export type TauriStrongholdPassword = string | (() => string | Promise<string>);

export interface CreateTauriStrongholdSecureStoreOptions {
  readonly stronghold: TauriStrongholdAdapter;
  readonly vaultPath: string | (() => Promise<string>);
  readonly password: TauriStrongholdPassword;
  readonly clientName: string;
}

export interface CreateTauriPersistentStrongholdPasswordOptions {
  readonly store: TauriStoreAdapter;
  readonly storePath: string;
  readonly key?: string;
  readonly prefix?: string;
  readonly byteLength?: number;
  readonly crypto?: Crypto;
}

export interface TauriKeystoreAdapter {
  readonly store: (
    service: string,
    user: string,
    value: string,
  ) => Promise<void>;
  readonly retrieve: (
    service: string,
    user: string,
  ) => Promise<string | null | undefined>;
  readonly remove: (service: string, user: string) => Promise<void>;
}

export interface TauriInvokeAdapter {
  readonly invoke: <T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
}

export interface CreateTauriInvokeKeystoreAdapterOptions {
  readonly invoke: TauriInvokeAdapter["invoke"];
}

export interface CreateTauriKeystoreStrongholdPasswordOptions {
  readonly keystore: TauriKeystoreAdapter;
  readonly service: string;
  readonly user: string;
  readonly fallback?: CreateTauriPersistentStrongholdPasswordOptions;
  readonly prefix?: string;
  readonly byteLength?: number;
  readonly crypto?: Crypto;
}

export interface TauriNotificationAdapter {
  readonly isPermissionGranted: () => Promise<boolean>;
  readonly requestPermission: () => Promise<NotificationPermission>;
  readonly sendNotification: (
    notification: MobileLocalNotification | string,
  ) => void;
}

export interface TauriBarcodeScannerAdapter {
  readonly scanConnectionPayload: () => Promise<string | undefined>;
}

export interface TauriBarcodeScannerModule<FormatValue = unknown> {
  readonly scan: (options?: {
    readonly formats?: FormatValue[];
  }) => Promise<{ readonly content: string }>;
  readonly qrCodeFormat: FormatValue;
}

export interface TauriPushNotificationsAdapter {
  readonly register: (
    input: MobilePushRegistrationInput,
  ) => Promise<MobilePushRegistration | undefined>;
  readonly unregister?: () => Promise<void>;
  readonly onNotificationReceived?: (
    handler: (notification: MobilePushNotification) => void,
  ) => Promise<() => void>;
  readonly onNotificationTapped?: (
    handler: (notification: MobilePushNotification) => void,
  ) => Promise<() => void>;
  readonly onTokenRefresh?: (
    input: MobilePushRegistrationInput,
    handler: (registration: MobilePushRegistration) => void,
  ) => Promise<() => void>;
}

export interface TauriPushToken {
  readonly token: string;
  readonly provider?: MobilePushProvider;
  readonly environment?: string;
}

export type TauriPushTokenResult = string | TauriPushToken;

export interface TauriPushTokenSource {
  readonly requestToken: (
    input: MobilePushRegistrationInput,
  ) => Promise<TauriPushTokenResult | undefined>;
}

export interface CreateTauriPushNotificationsAdapterOptions {
  readonly tokenSource: TauriPushTokenSource;
  readonly environment?:
    string | ((input: MobilePushRegistrationInput) => string | undefined);
}

export type TauriMobilePushPermission =
  | boolean
  | NotificationPermission
  | {
      readonly granted?: boolean;
      readonly permission?: NotificationPermission;
    };

export interface TauriMobilePushNotification {
  readonly title?: string;
  readonly body?: string;
  readonly data: Record<string, unknown>;
  readonly badge?: number;
  readonly sound?: string;
}

export interface TauriMobilePushTokenRefresh {
  readonly token: string;
  readonly provider?: MobilePushProvider;
  readonly environment?: string;
}

export interface TauriPluginListener {
  readonly unregister: () => void | Promise<void>;
}

export interface TauriMobilePushPluginModule {
  readonly requestPermission: () => Promise<TauriMobilePushPermission>;
  readonly getToken: () => Promise<string | TauriPushToken | undefined>;
  readonly unregister?: () => Promise<void>;
  readonly onNotificationReceived?: (
    handler: (notification: TauriMobilePushNotification) => void,
  ) => Promise<TauriPluginListener>;
  readonly onNotificationTapped?: (
    handler: (notification: TauriMobilePushNotification) => void,
  ) => Promise<TauriPluginListener>;
  readonly onTokenRefresh?: (
    handler: (payload: TauriMobilePushTokenRefresh) => void,
  ) => Promise<TauriPluginListener>;
}

export interface CreateTauriMobilePushPluginAdapterOptions {
  readonly mobilePush: TauriMobilePushPluginModule;
  readonly environment?:
    string | ((input: MobilePushRegistrationInput) => string | undefined);
}

export interface TauriCallIntentAdapter {
  readonly requestCall: (input: MobileCallIntent) => Promise<void>;
}

export interface TauriClipboardTextAdapter {
  readonly writeText: (
    text: string,
    options?: { readonly label?: string },
  ) => Promise<void>;
}

export interface TauriBiometricAuthOptions {
  readonly allowDeviceCredential?: boolean;
  readonly cancelTitle?: string;
  readonly fallbackTitle?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly confirmationRequired?: boolean;
}

export interface TauriBiometricAdapter {
  readonly authenticate: (
    message: string,
    options?: TauriBiometricAuthOptions,
  ) => Promise<void>;
}

export type TauriPlatform =
  | "android"
  | "dragonfly"
  | "freebsd"
  | "ios"
  | "linux"
  | "macos"
  | "netbsd"
  | "openbsd"
  | "solaris"
  | "windows"
  | string;

export interface TauriPlatformAdapter {
  readonly platform: () => TauriPlatform;
}

export interface CreateTauriOpenerCallIntentAdapterOptions {
  readonly opener: TauriOpenerAdapter;
  readonly openWith?: "inAppBrowser" | string;
}

export interface CreateTauriPluginNativeBridgeOptions {
  readonly appName: string;
  readonly storePath: string;
  readonly deepLink: TauriDeepLinkAdapter;
  readonly opener: TauriOpenerAdapter;
  readonly store: TauriStoreAdapter;
  readonly secureStore?: TauriSecureStoreAdapter;
  readonly platform?: TauriPlatformAdapter;
  readonly notification?: TauriNotificationAdapter;
  readonly barcodeScanner?: TauriBarcodeScannerAdapter;
  readonly pushNotifications?: TauriPushNotificationsAdapter;
  readonly biometric?: TauriBiometricAdapter;
  readonly callIntent?: TauriCallIntentAdapter;
  readonly clipboard?: TauriClipboardTextAdapter;
  readonly preferInAppBrowser?: boolean;
  readonly isTauriRuntime?: () => boolean;
  readonly browserFallback?: NativeBridge;
}

export interface TauriPathAdapter {
  readonly appDataDir: () => Promise<string>;
  readonly join: (...paths: string[]) => Promise<string>;
}

export interface TauriMobileProductStorageNames {
  readonly storePath: string;
  readonly strongholdVaultFileName: string;
  readonly strongholdClientName: string;
  readonly strongholdPasswordKey: string;
  readonly strongholdPasswordPrefix: string;
}

export interface CreateTauriMobileProductStorageNamesOptions {
  readonly storePath?: string;
  readonly strongholdVaultFileName?: string;
  readonly strongholdClientName?: string;
  readonly strongholdPasswordKey?: string;
  readonly strongholdPasswordPrefix?: string;
}

export interface CreateTauriMobileProductBridgeOptions<
  BarcodeFormat = unknown,
> {
  readonly appName: string;
  readonly storePath: string;
  readonly strongholdVaultFileName: string;
  readonly strongholdPassword: TauriStrongholdPassword;
  readonly strongholdClientName: string;
  readonly path: TauriPathAdapter;
  readonly deepLink: TauriDeepLinkAdapter;
  readonly opener: TauriOpenerAdapter;
  readonly store: TauriStoreAdapter;
  readonly stronghold: TauriStrongholdAdapter;
  readonly platform?: TauriPlatformAdapter;
  readonly notification?: TauriNotificationAdapter;
  readonly barcodeScanner?: TauriBarcodeScannerModule<BarcodeFormat>;
  readonly pushNotifications?: TauriPushNotificationsAdapter;
  readonly biometric?: TauriBiometricAdapter;
  readonly callIntent?: TauriCallIntentAdapter;
  readonly clipboard?: TauriClipboardTextAdapter;
  readonly preferInAppBrowser?: boolean;
  readonly isTauriRuntime?: () => boolean;
  readonly browserFallback?: NativeBridge;
}

export interface CreateTauriMobileDefaultProductBridgeOptions<
  BarcodeFormat = unknown,
> {
  readonly productAdapter: Pick<MobileProductAdapter, "product" | "appName">;
  readonly keychainService: string;
  readonly keychainUser?: string;
  readonly invoke: TauriInvokeAdapter["invoke"];
  readonly path: TauriPathAdapter;
  readonly deepLink: TauriDeepLinkAdapter;
  readonly opener: TauriOpenerAdapter;
  readonly store: TauriStoreAdapter;
  readonly stronghold: TauriStrongholdAdapter;
  readonly platform?: TauriPlatformAdapter;
  readonly notification?: TauriNotificationAdapter;
  readonly barcodeScanner?: TauriBarcodeScannerModule<BarcodeFormat>;
  readonly pushNotifications?: TauriPushNotificationsAdapter;
  readonly mobilePush?: TauriMobilePushPluginModule;
  readonly biometric?: TauriBiometricAdapter;
  readonly callIntent?: TauriCallIntentAdapter;
  readonly clipboard?: TauriClipboardTextAdapter;
  readonly preferInAppBrowser?: boolean;
  readonly isTauriRuntime?: () => boolean;
  readonly browserFallback?: NativeBridge;
}

export function createTauriMobileProductStorageNames(
  adapter: Pick<MobileProductAdapter, "product">,
  options: CreateTauriMobileProductStorageNamesOptions = {},
): TauriMobileProductStorageNames {
  const product = requireMobileProductKey(adapter.product);
  const strongholdPasswordPrefix =
    options.strongholdPasswordPrefix ?? `${product}-mobile-stronghold`;
  return {
    storePath: options.storePath ?? `${product}-mobile-session.json`,
    strongholdVaultFileName:
      options.strongholdVaultFileName ?? `${product}-mobile.hold`,
    strongholdClientName: options.strongholdClientName ?? `${product}-mobile`,
    strongholdPasswordKey:
      options.strongholdPasswordKey ?? `${product}.mobile.stronghold.password`,
    strongholdPasswordPrefix,
  };
}

export function createTauriPluginNativeBridge(
  options: CreateTauriPluginNativeBridgeOptions,
): NativeBridge {
  const fallback = options.browserFallback ?? createBrowserNativeBridge();
  const isTauriRuntime = options.isTauriRuntime ?? detectTauriRuntime;
  if (!isTauriRuntime()) return fallback;

  const storage = createTauriStore(options.store, options.storePath);
  const secureStore = options.secureStore;
  const mobileRuntime = isTauriMobileRuntime(options.platform);
  const notificationAdapter = options.notification;
  const pushAdapter = mobileRuntime ? options.pushNotifications : undefined;
  const barcodeScannerAdapter = mobileRuntime
    ? options.barcodeScanner
    : undefined;
  const biometricAdapter = mobileRuntime ? options.biometric : undefined;
  const callAdapter = options.callIntent;
  const clipboardAdapter = options.clipboard;

  return {
    capabilities: {
      launchPayload: true,
      launchPayloadEvents: true,
      externalBrowser: true,
      inAppBrowser: options.preferInAppBrowser ?? false,
      qrScanner: Boolean(barcodeScannerAdapter),
      localNotifications: Boolean(notificationAdapter),
      pushNotifications: Boolean(pushAdapter),
      biometricAuth: Boolean(biometricAdapter),
      callIntent: Boolean(callAdapter),
      clipboardText: Boolean(clipboardAdapter),
      secureStorage: Boolean(secureStore),
      persistentStorage: true,
    },
    storage,
    secureStore,
    async getLaunchPayload() {
      const urls = await options.deepLink.getCurrent();
      return urls?.[0];
    },
    async onLaunchPayload(handler) {
      return await options.deepLink.onOpenUrl((urls) => {
        for (const url of urls) handler(url);
      });
    },
    async openExternalUrl(url) {
      const openWith = shouldUseInAppBrowser(options.preferInAppBrowser)
        ? "inAppBrowser"
        : undefined;
      await options.opener.openUrl(url, openWith);
    },
    scanConnectionPayload: barcodeScannerAdapter
      ? async () => await barcodeScannerAdapter.scanConnectionPayload()
      : undefined,
    requestLocalNotificationPermission: notificationAdapter
      ? async () => await requestNotificationPermission(notificationAdapter)
      : undefined,
    sendLocalNotification: notificationAdapter
      ? async (notification) => {
          const granted =
            await requestNotificationPermission(notificationAdapter);
          if (granted) notificationAdapter.sendNotification(notification);
        }
      : undefined,
    registerPushNotifications: pushAdapter
      ? async (input) => await pushAdapter.register(input)
      : undefined,
    unregisterPushNotifications: pushAdapter?.unregister
      ? async () => await pushAdapter.unregister!()
      : undefined,
    onPushNotificationReceived: pushAdapter?.onNotificationReceived
      ? async (handler) => await pushAdapter.onNotificationReceived!(handler)
      : undefined,
    onPushNotificationTapped: pushAdapter?.onNotificationTapped
      ? async (handler) => await pushAdapter.onNotificationTapped!(handler)
      : undefined,
    onPushTokenRefresh: pushAdapter?.onTokenRefresh
      ? async (input, handler) =>
          await pushAdapter.onTokenRefresh!(input, handler)
      : undefined,
    authenticateBiometric: biometricAdapter
      ? async (prompt) => await authenticateBiometric(biometricAdapter, prompt)
      : undefined,
    requestCall: callAdapter
      ? async (input) => {
          await callAdapter.requestCall(input);
        }
      : undefined,
    writeClipboardText: clipboardAdapter
      ? async (input) => {
          await writeClipboardText(clipboardAdapter, input);
        }
      : undefined,
  };
}

export function createTauriPushNotificationsAdapter(
  options: CreateTauriPushNotificationsAdapterOptions,
): TauriPushNotificationsAdapter {
  return {
    async register(input) {
      const result = await options.tokenSource.requestToken(input);
      const registration = normalizePushTokenResult(result);
      if (!registration) return undefined;
      return {
        token: registration.token,
        provider: registration.provider,
        environment:
          registration.environment ?? resolvePushEnvironment(options, input),
      };
    },
  };
}

export function createTauriMobilePushPluginAdapter(
  options: CreateTauriMobilePushPluginAdapterOptions,
): TauriPushNotificationsAdapter {
  const baseAdapter = createTauriPushNotificationsAdapter({
    environment: options.environment,
    tokenSource: {
      async requestToken() {
        const permission = await options.mobilePush.requestPermission();
        if (!isMobilePushPermissionGranted(permission)) return undefined;
        return await options.mobilePush.getToken();
      },
    },
  });
  return {
    ...baseAdapter,
    unregister: options.mobilePush.unregister
      ? async () => await options.mobilePush.unregister!()
      : undefined,
    onNotificationReceived: options.mobilePush.onNotificationReceived
      ? async (handler) =>
          createTauriPluginUnlisten(
            await options.mobilePush.onNotificationReceived!((notification) => {
              handler(normalizeTauriMobilePushNotification(notification));
            }),
          )
      : undefined,
    onNotificationTapped: options.mobilePush.onNotificationTapped
      ? async (handler) =>
          createTauriPluginUnlisten(
            await options.mobilePush.onNotificationTapped!((notification) => {
              handler(normalizeTauriMobilePushNotification(notification));
            }),
          )
      : undefined,
    onTokenRefresh: options.mobilePush.onTokenRefresh
      ? async (input, handler) =>
          createTauriPluginUnlisten(
            await options.mobilePush.onTokenRefresh!((payload) => {
              if (!payload.token) return;
              handler({
                token: payload.token,
                provider: normalizePushProvider(payload.provider),
                environment:
                  normalizePushEnvironment(payload.environment) ??
                  resolvePushEnvironment(options, input),
              });
            }),
          )
      : undefined,
  };
}

export function createTauriOpenerCallIntentAdapter(
  options: CreateTauriOpenerCallIntentAdapterOptions,
): TauriCallIntentAdapter {
  return {
    async requestCall(input) {
      await options.opener.openUrl(
        input.roomUrl,
        options.openWith ?? "inAppBrowser",
      );
    },
  };
}

async function writeClipboardText(
  clipboard: TauriClipboardTextAdapter,
  input: MobileClipboardText,
): Promise<void> {
  await clipboard.writeText(
    input.text,
    input.label ? { label: input.label } : undefined,
  );
}

export function createTauriMobileProductBridge<BarcodeFormat = unknown>(
  options: CreateTauriMobileProductBridgeOptions<BarcodeFormat>,
): NativeBridge {
  return createTauriPluginNativeBridge({
    appName: options.appName,
    storePath: options.storePath,
    deepLink: options.deepLink,
    opener: options.opener,
    store: options.store,
    secureStore: createTauriStrongholdSecureStore({
      stronghold: options.stronghold,
      vaultPath: async () =>
        await options.path.join(
          await options.path.appDataDir(),
          options.strongholdVaultFileName,
        ),
      password: options.strongholdPassword,
      clientName: options.strongholdClientName,
    }),
    platform: options.platform,
    notification: options.notification,
    barcodeScanner: options.barcodeScanner
      ? createQrScannerAdapter(options.barcodeScanner)
      : undefined,
    pushNotifications: options.pushNotifications,
    biometric: options.biometric,
    callIntent: options.callIntent,
    clipboard: options.clipboard,
    preferInAppBrowser: options.preferInAppBrowser ?? true,
    isTauriRuntime: options.isTauriRuntime,
    browserFallback: options.browserFallback ?? createBrowserNativeBridge(),
  });
}

export function createTauriMobileDefaultProductBridge<BarcodeFormat = unknown>(
  options: CreateTauriMobileDefaultProductBridgeOptions<BarcodeFormat>,
): NativeBridge {
  const storageNames = createTauriMobileProductStorageNames(
    options.productAdapter,
  );
  const storePath = storageNames.storePath;
  const pushNotifications =
    options.pushNotifications ??
    (options.mobilePush
      ? createTauriMobilePushPluginAdapter({ mobilePush: options.mobilePush })
      : undefined);

  return createTauriMobileProductBridge({
    appName: options.productAdapter.appName,
    storePath,
    strongholdVaultFileName: storageNames.strongholdVaultFileName,
    strongholdPassword: createTauriKeystoreStrongholdPassword({
      keystore: createTauriInvokeKeystoreAdapter({ invoke: options.invoke }),
      service: options.keychainService,
      user: options.keychainUser ?? "stronghold-password",
      fallback: {
        store: options.store,
        storePath,
        key: storageNames.strongholdPasswordKey,
        prefix: storageNames.strongholdPasswordPrefix,
      },
      prefix: storageNames.strongholdPasswordPrefix,
    }),
    strongholdClientName: storageNames.strongholdClientName,
    path: options.path,
    deepLink: options.deepLink,
    opener: options.opener,
    store: options.store,
    stronghold: options.stronghold,
    platform: options.platform,
    notification: options.notification,
    barcodeScanner: options.barcodeScanner,
    pushNotifications,
    biometric: options.biometric,
    callIntent:
      options.callIntent ??
      createTauriOpenerCallIntentAdapter({ opener: options.opener }),
    clipboard: options.clipboard,
    preferInAppBrowser: options.preferInAppBrowser,
    isTauriRuntime: options.isTauriRuntime,
    browserFallback: options.browserFallback,
  });
}

export async function authenticateBiometric(
  biometric: TauriBiometricAdapter,
  prompt: MobileBiometricPrompt,
): Promise<boolean> {
  try {
    await biometric.authenticate(prompt.message, {
      allowDeviceCredential: prompt.allowDeviceCredential,
      cancelTitle: prompt.cancelTitle,
      fallbackTitle: prompt.fallbackTitle,
      title: prompt.title,
      subtitle: prompt.subtitle,
      confirmationRequired: prompt.confirmationRequired,
    });
    return true;
  } catch {
    return false;
  }
}

export function detectTauriRuntime(): boolean {
  const scope = globalThis as {
    readonly __TAURI__?: unknown;
    readonly __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(scope.__TAURI__ ?? scope.__TAURI_INTERNALS__);
}

export function isTauriMobilePlatform(
  platform: TauriPlatform | undefined,
): boolean {
  return platform === "android" || platform === "ios";
}

function isTauriMobileRuntime(
  platform: TauriPlatformAdapter | undefined,
): boolean {
  if (!platform) return true;
  return isTauriMobilePlatform(platform.platform());
}

export function createTauriStrongholdSecureStore(
  options: CreateTauriStrongholdSecureStoreOptions,
): TauriSecureStoreAdapter {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let storePromise:
    | Promise<{
        readonly stronghold: TauriStrongholdHandle;
        readonly store: TauriStrongholdStore;
      }>
    | undefined;

  const store = () => {
    storePromise ??= loadStrongholdStore(options);
    return storePromise;
  };

  return {
    kind: "secure",
    async get(key) {
      const value = await (await store()).store.get(key);
      return value ? decoder.decode(value) : undefined;
    },
    async set(key, value) {
      const current = await store();
      await current.store.insert(key, Array.from(encoder.encode(value)));
      await current.stronghold.save();
    },
    async delete(key) {
      const current = await store();
      await current.store.remove(key);
      await current.stronghold.save();
    },
  };
}

export function createTauriPersistentStrongholdPassword(
  options: CreateTauriPersistentStrongholdPasswordOptions,
): () => Promise<string> {
  let passwordPromise: Promise<string> | undefined;
  return async () => {
    passwordPromise ??= loadPersistentStrongholdPassword(options);
    return passwordPromise;
  };
}

export function createTauriKeystoreStrongholdPassword(
  options: CreateTauriKeystoreStrongholdPasswordOptions,
): () => Promise<string> {
  let passwordPromise: Promise<string> | undefined;
  return async () => {
    passwordPromise ??= loadKeystoreStrongholdPassword(options);
    return passwordPromise;
  };
}

export function createTauriInvokeKeystoreAdapter(
  options: CreateTauriInvokeKeystoreAdapterOptions,
): TauriKeystoreAdapter {
  return {
    async store(service, user, value) {
      await options.invoke("plugin:keystore|store", {
        payload: { service, user, value },
      });
    },
    async retrieve(service, user) {
      const result = await options.invoke<unknown>("plugin:keystore|retrieve", {
        payload: { service, user },
      });
      if (typeof result === "string") return result;
      if (isRecord(result)) {
        return typeof result.value === "string" ? result.value : null;
      }
      return null;
    },
    async remove(service, user) {
      await options.invoke("plugin:keystore|remove", {
        payload: { service, user },
      });
    },
  };
}

function createTauriStore(
  adapter: TauriStoreAdapter,
  path: string,
): MobileKeyValueStore {
  let storePromise: Promise<TauriStoreHandle> | undefined;
  const store = () => {
    storePromise ??= adapter.load(path);
    return storePromise;
  };

  return {
    kind: "device-persistent",
    async get(key) {
      const value = await (await store()).get<unknown>(key);
      return typeof value === "string" ? value : undefined;
    },
    async set(key, value) {
      const handle = await store();
      await handle.set(key, value);
      await handle.save();
    },
    async delete(key) {
      const handle = await store();
      await handle.delete(key);
      await handle.save();
    },
  };
}

function createQrScannerAdapter<BarcodeFormat>(
  barcodeScanner: TauriBarcodeScannerModule<BarcodeFormat>,
): TauriBarcodeScannerAdapter {
  return {
    async scanConnectionPayload() {
      return (
        await barcodeScanner.scan({
          formats: [barcodeScanner.qrCodeFormat],
        })
      ).content;
    },
  };
}

async function loadStrongholdStore(
  options: CreateTauriStrongholdSecureStoreOptions,
): Promise<{
  readonly stronghold: TauriStrongholdHandle;
  readonly store: TauriStrongholdStore;
}> {
  const vaultPath =
    typeof options.vaultPath === "function"
      ? await options.vaultPath()
      : options.vaultPath;
  const password = await resolveStrongholdPassword(options.password);
  const stronghold = await options.stronghold.load(vaultPath, password);
  let client: TauriStrongholdClient;
  try {
    client = await stronghold.loadClient(options.clientName);
  } catch {
    client = await stronghold.createClient(options.clientName);
  }
  return { stronghold, store: client.getStore() };
}

async function resolveStrongholdPassword(
  password: TauriStrongholdPassword,
): Promise<string> {
  const resolved = typeof password === "function" ? await password() : password;
  if (!resolved) throw new Error("Stronghold password is unavailable.");
  return resolved;
}

async function loadPersistentStrongholdPassword(
  options: CreateTauriPersistentStrongholdPasswordOptions,
): Promise<string> {
  const key = options.key ?? "takosumi.mobile.stronghold.password";
  const handle = await options.store.load(options.storePath);
  const existing = await handle.get<unknown>(key);
  if (isUsableStrongholdPassword(existing)) return existing;

  const password = `${options.prefix ?? "takosumi-mobile-stronghold"}.${randomHex(
    options.byteLength ?? 32,
    options.crypto,
  )}`;
  await handle.set(key, password);
  await handle.save();
  return password;
}

async function loadKeystoreStrongholdPassword(
  options: CreateTauriKeystoreStrongholdPasswordOptions,
): Promise<string> {
  const existing = await tryRetrieveKeystorePassword(options);
  if (isUsableStrongholdPassword(existing)) {
    await removeVerifiedStrongholdPasswordMigrationFallback(options, existing);
    return existing;
  }

  if (options.fallback) {
    const fallbackPassword = await loadExistingPersistentStrongholdPassword(
      options.fallback,
    );
    if (isUsableStrongholdPassword(fallbackPassword)) {
      await options.keystore.store(
        options.service,
        options.user,
        fallbackPassword,
      );
      // Keep the legacy value until a later app start reads the same value back
      // from native secure storage. This avoids losing an existing Stronghold
      // vault if a native store implementation reports success too early.
      return fallbackPassword;
    }
  }

  const password = `${options.prefix ?? "takosumi-mobile-stronghold"}.${randomHex(
    options.byteLength ?? 32,
    options.crypto,
  )}`;
  await options.keystore.store(options.service, options.user, password);
  return password;
}

async function loadExistingPersistentStrongholdPassword(
  options: CreateTauriPersistentStrongholdPasswordOptions,
): Promise<string | undefined> {
  const key = options.key ?? "takosumi.mobile.stronghold.password";
  const handle = await options.store.load(options.storePath);
  const existing = await handle.get<unknown>(key);
  return isUsableStrongholdPassword(existing) ? existing : undefined;
}

async function removeVerifiedStrongholdPasswordMigrationFallback(
  options: CreateTauriKeystoreStrongholdPasswordOptions,
  keystorePassword: string,
): Promise<void> {
  if (!options.fallback) return;
  const key = options.fallback.key ?? "takosumi.mobile.stronghold.password";
  const handle = await options.fallback.store.load(options.fallback.storePath);
  const fallbackPassword = await handle.get<unknown>(key);
  if (fallbackPassword === undefined || fallbackPassword === null) return;
  if (!isUsableStrongholdPassword(fallbackPassword)) {
    throw new Error("Legacy Stronghold password migration value is invalid.");
  }
  if (fallbackPassword !== keystorePassword) {
    throw new Error(
      "Native and legacy Stronghold password values do not match.",
    );
  }
  await handle.delete(key);
  await handle.save();
}

async function tryRetrieveKeystorePassword(
  options: CreateTauriKeystoreStrongholdPasswordOptions,
): Promise<string | null | undefined> {
  try {
    return await options.keystore.retrieve(options.service, options.user);
  } catch {
    return undefined;
  }
}

function isUsableStrongholdPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32;
}

function randomHex(byteLength: number, cryptoOverride: Crypto | undefined) {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new Error("Stronghold password byteLength must be at least 16.");
  }
  const random = cryptoOverride ?? globalThis.crypto;
  if (!random?.getRandomValues) {
    throw new Error("Stronghold password generation requires crypto.");
  }
  const bytes = new Uint8Array(byteLength);
  random.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function requestNotificationPermission(
  notification: TauriNotificationAdapter,
): Promise<boolean> {
  if (await notification.isPermissionGranted()) return true;
  return (await notification.requestPermission()) === "granted";
}

function shouldUseInAppBrowser(preferInAppBrowser: boolean | undefined) {
  if (!preferInAppBrowser) return false;
  if (typeof navigator === "undefined") return true;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function resolvePushEnvironment(
  options:
    | CreateTauriPushNotificationsAdapterOptions
    | CreateTauriMobilePushPluginAdapterOptions,
  input: MobilePushRegistrationInput,
): string | undefined {
  return normalizePushEnvironment(
    typeof options.environment === "function"
      ? options.environment(input)
      : options.environment,
  );
}

function normalizePushTokenResult(
  result: TauriPushTokenResult | undefined,
): MobilePushRegistration | undefined {
  if (typeof result === "string") {
    return result ? { token: result } : undefined;
  }
  if (!result?.token) return undefined;
  return {
    token: result.token,
    provider: normalizePushProvider(result.provider),
    environment: normalizePushEnvironment(result.environment),
  };
}

function normalizePushProvider(value: unknown): MobilePushProvider | undefined {
  return value === "apns" || value === "fcm" ? value : undefined;
}

function normalizePushEnvironment(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const environment = value.trim();
  if (!environment || environment.length > 64) return undefined;
  return /^[a-z0-9._:-]+$/i.test(environment) ? environment : undefined;
}

function isMobilePushPermissionGranted(
  permission: TauriMobilePushPermission,
): boolean {
  if (typeof permission === "boolean") return permission;
  if (typeof permission === "string") return permission === "granted";
  if (!isRecord(permission)) return false;
  if (typeof permission.granted === "boolean") return permission.granted;
  return permission.permission === "granted";
}

function normalizeTauriMobilePushNotification(
  notification: TauriMobilePushNotification,
): MobilePushNotification {
  return {
    title: notification.title,
    body: notification.body,
    data: isRecord(notification.data) ? notification.data : {},
    badge: notification.badge,
    sound: notification.sound,
  };
}

function createTauriPluginUnlisten(
  listener: TauriPluginListener,
): () => Promise<void> {
  return async () => {
    await listener.unregister();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
