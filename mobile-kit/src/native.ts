import type { NativeBridge, NativeBridgeCapabilities } from "./types.ts";

export interface BrowserNativeWindow {
  readonly location: {
    href: string;
  };
  readonly localStorage?: BrowserLocalStorage;
  readonly open?: (
    url?: string | URL,
    target?: string,
    features?: string,
  ) => unknown;
}

export interface BrowserNativeBridgeOptions {
  readonly window?: BrowserNativeWindow;
}

export interface BrowserLocalStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

const unsupportedCapabilities: NativeBridgeCapabilities = {
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
  secureStorage: false,
  persistentStorage: false,
};

export function createBrowserNativeBridge(
  options: BrowserNativeBridgeOptions = {},
): NativeBridge {
  const windowRef = options.window ?? readGlobalWindow();
  const browserStore = createBrowserLocalStore(windowRef?.localStorage);

  return {
    capabilities: {
      ...unsupportedCapabilities,
      launchPayload: Boolean(windowRef),
      externalBrowser: Boolean(windowRef),
      persistentStorage: Boolean(browserStore),
    },
    storage: browserStore,
    secureStore: browserStore,
    async getLaunchPayload() {
      if (!windowRef) return undefined;
      const url = new URL(windowRef.location.href);
      const directPayload =
        url.searchParams.get("connect") ??
        url.searchParams.get("payload") ??
        url.searchParams.get("route") ??
        url.searchParams.get("url") ??
        url.searchParams.get("href");
      if (directPayload) return directPayload;
      if (url.searchParams.has("code") || url.searchParams.has("error")) {
        return url.toString();
      }
      if (url.searchParams.has("host_url") || url.searchParams.has("hostUrl")) {
        return url.toString();
      }
      return undefined;
    },
    async openExternalUrl(url) {
      if (!windowRef) return;
      if (windowRef.open) {
        windowRef.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      windowRef.location.href = url;
    },
  };
}

function readGlobalWindow(): BrowserNativeWindow | undefined {
  if (typeof window === "undefined") return undefined;
  return window;
}

function createBrowserLocalStore(
  localStorage: BrowserLocalStorage | undefined,
): NativeBridge["secureStore"] {
  if (!localStorage) return undefined;
  return {
    kind: "browser-local",
    async get(key) {
      return localStorage.getItem(key) ?? undefined;
    },
    async set(key, value) {
      localStorage.setItem(key, value);
    },
    async delete(key) {
      localStorage.removeItem(key);
    },
  };
}
