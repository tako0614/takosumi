import { expect, test } from "bun:test";
import {
  clearMobileKnownHosts,
  loadMobileKnownHosts,
  mobileKnownHostsStorageKey,
  rememberMobileKnownHost,
  removeMobileKnownHost,
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
};

test("mobile known hosts load, dedupe, and sort product-local hosts", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileKnownHostsStorageKey(adapter),
    JSON.stringify([
      {
        hostUrl: "https://old.example",
        product: "takos",
        lastSeenAt: "2026-06-29T00:00:00.000Z",
      },
      {
        hostUrl: "https://new.example/path",
        product: "takos",
        oidcIssuer: "https://new.example",
        lastSeenAt: "2026-06-30T00:00:00.000Z",
      },
      {
        hostUrl: "https://new.example",
        product: "takos",
        lastSeenAt: "2026-06-28T00:00:00.000Z",
      },
      {
        hostUrl: "https://social.example",
        product: "yurucommu",
        lastSeenAt: "2026-06-30T00:00:00.000Z",
      },
    ]),
  );

  expect(await loadMobileKnownHosts({ adapter, nativeBridge: bridge })).toEqual(
    [
      {
        hostUrl: "https://new.example",
        product: "takos",
        oidcIssuer: "https://new.example",
        lastSeenAt: "2026-06-30T00:00:00.000Z",
        label: undefined,
      },
      {
        hostUrl: "https://old.example",
        product: "takos",
        oidcIssuer: undefined,
        lastSeenAt: "2026-06-29T00:00:00.000Z",
        label: undefined,
      },
    ],
  );
});

test("rememberMobileKnownHost keeps the latest eight hosts", async () => {
  const bridge = memoryBridge();
  for (let index = 0; index < 10; index += 1) {
    await rememberMobileKnownHost({
      adapter,
      nativeBridge: bridge,
      host: {
        hostUrl: `https://host-${index}.example`,
        product: "takos",
        oidcIssuer: `https://host-${index}.example`,
        lastSeenAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      },
    });
  }

  const hosts = await loadMobileKnownHosts({ adapter, nativeBridge: bridge });
  expect(hosts).toHaveLength(8);
  expect(hosts[0]?.hostUrl).toBe("https://host-9.example");
  expect(hosts.at(-1)?.hostUrl).toBe("https://host-2.example");
});

test("removeMobileKnownHost deletes one normalized host", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileKnownHostsStorageKey(adapter),
    JSON.stringify([
      {
        hostUrl: "https://keep.example",
        product: "takos",
        lastSeenAt: "2026-06-30T00:00:00.000Z",
      },
      {
        hostUrl: "https://remove.example/path",
        product: "takos",
        lastSeenAt: "2026-06-29T00:00:00.000Z",
      },
    ]),
  );

  expect(
    await removeMobileKnownHost({
      adapter,
      nativeBridge: bridge,
      hostUrl: "https://remove.example/other-path",
    }),
  ).toEqual([
    {
      hostUrl: "https://keep.example",
      product: "takos",
      oidcIssuer: undefined,
      lastSeenAt: "2026-06-30T00:00:00.000Z",
      label: undefined,
    },
  ]);
});

test("clearMobileKnownHosts clears product-local history", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(
    mobileKnownHostsStorageKey(adapter),
    JSON.stringify([
      {
        hostUrl: "https://host.example",
        product: "takos",
        lastSeenAt: "2026-06-30T00:00:00.000Z",
      },
    ]),
  );

  expect(
    await clearMobileKnownHosts({ adapter, nativeBridge: bridge }),
  ).toEqual([]);
  expect(
    await bridge.storage?.get(mobileKnownHostsStorageKey(adapter)),
  ).toBeUndefined();
});

test("loadMobileKnownHosts ignores corrupt storage", async () => {
  const bridge = memoryBridge();
  await bridge.storage?.set(mobileKnownHostsStorageKey(adapter), "{");
  expect(await loadMobileKnownHosts({ adapter, nativeBridge: bridge })).toEqual(
    [],
  );
});

function memoryBridge(): NativeBridge {
  const storage = new Map<string, string>();
  return {
    capabilities: {
      launchPayload: false,
      launchPayloadEvents: false,
      externalBrowser: true,
      inAppBrowser: false,
      qrScanner: false,
      localNotifications: false,
      pushNotifications: false,
      biometricAuth: false,
      callIntent: false,
      clipboardText: false,
      secureStorage: false,
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
      return undefined;
    },
    async openExternalUrl() {},
  };
}
