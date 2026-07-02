import { expect, test } from "bun:test";
import {
  createBrowserNativeBridge,
  type BrowserNativeWindow,
} from "../../../mobile-kit/src/index.ts";

test("browser native bridge reads launch payload from query params", async () => {
  const bridge = createBrowserNativeBridge({
    window: fakeWindow(
      "https://mobile.example/start?host_url=https%3A%2F%2Fhost.example&product=takos",
    ),
  });

  expect(await bridge.getLaunchPayload()).toBe(
    "https://mobile.example/start?host_url=https%3A%2F%2Fhost.example&product=takos",
  );
  expect(bridge.capabilities.qrScanner).toBe(false);
  expect(bridge.capabilities.secureStorage).toBe(false);
  expect(bridge.capabilities.persistentStorage).toBe(false);
});

test("browser native bridge reads OAuth callback launch payloads", async () => {
  const bridge = createBrowserNativeBridge({
    window: fakeWindow("https://mobile.example/oauth?code=c1&state=s1"),
  });

  expect(await bridge.getLaunchPayload()).toBe(
    "https://mobile.example/oauth?code=c1&state=s1",
  );
});

test("browser native bridge reads route handoff query payloads", async () => {
  const bridge = createBrowserNativeBridge({
    window: fakeWindow(
      "https://mobile.example/start?url=https%3A%2F%2Fhost.example%2Fchat%3Fthread%3D1",
    ),
  });

  expect(await bridge.getLaunchPayload()).toBe(
    "https://host.example/chat?thread=1",
  );
});

test("browser native bridge opens external URLs through the browser", async () => {
  const opened: string[] = [];
  const bridge = createBrowserNativeBridge({
    window: fakeWindow("https://mobile.example", (url) => {
      opened.push(String(url));
    }),
  });

  await bridge.openExternalUrl("https://app.takosumi.com/new?product=takos");

  expect(opened).toEqual(["https://app.takosumi.com/new?product=takos"]);
});

test("browser native bridge exposes local storage fallback", async () => {
  const bridge = createBrowserNativeBridge({
    window: fakeWindow("https://mobile.example", undefined, memoryStorage()),
  });

  expect(bridge.secureStore?.kind).toBe("browser-local");
  expect(bridge.storage?.kind).toBe("browser-local");
  await bridge.secureStore?.set("k", "v");
  expect(await bridge.secureStore?.get("k")).toBe("v");
  await bridge.secureStore?.delete("k");
  expect(await bridge.secureStore?.get("k")).toBeUndefined();
});

function fakeWindow(
  href: string,
  open?: BrowserNativeWindow["open"],
  localStorage?: BrowserNativeWindow["localStorage"],
): BrowserNativeWindow {
  return {
    location: { href },
    localStorage,
    open,
  };
}

function memoryStorage(): NonNullable<BrowserNativeWindow["localStorage"]> {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}
