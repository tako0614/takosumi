/**
 * How the dashboard opens a screen on this device (TASK-0119 step 4): the
 * platform, the links that hand a screen to its native app, what a device
 * remembers, and the order those decide in.
 */
import { describe, expect, test } from "bun:test";
import { parseInterfaceClients } from "takosumi-contract";
import {
  androidIntentUrl,
  appOpenChooserPath,
  chosenNativeHref,
  declaredPhoneClients,
  detectOpenPlatform,
  forgetOpenChoice,
  iosNativeHref,
  type OpenChoiceStorage,
  openChoiceStorageKey,
  openChoiceStorageWorks,
  type OpenRouteInput,
  parseOpenChooserQuery,
  phoneClient,
  readOpenChoice,
  rememberableChoice,
  resolveOpenRoute,
  storeDestination,
  storeKind,
  writeOpenChoice,
} from "../../../../dashboard/src/lib/open-routing.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const SCREEN = "https://yurucommu.example.com/";
const ORIGIN_ENCODED = "https%3A%2F%2Fyurucommu.example.com";
const OPEN = `yurucommu://connect?host_url=${ORIGIN_ENCODED}&product=yurucommu`;
const CHOOSER = "/apps/cap_a?open=if_a#phone";
const FALLBACK = "https://takosumi.example/apps/cap_a?open=if_a&missing=1#phone";

/** A verified screen's `clients` exactly as the server returns them. */
function verifiedClients(preferred: "native" | "web" = "native") {
  return {
    preferred,
    ios: {
      verified: true, trustedClientId: "yurucommu-mobile", target: { scheme: "yurucommu" },
      name: "Yurucommu", bundleId: "com.yurucommu", open: OPEN,
    },
    android: {
      verified: true, trustedClientId: "yurucommu-mobile", target: { package: "com.yurucommu", scheme: "yurucommu" },
      name: "Yurucommu", package: "com.yurucommu", open: OPEN,
      storeUrl: "https://play.google.com/store/apps/details?id=com.yurucommu",
    },
  };
}

/** An unverified declaration (`preferred` stays "native" only beside a verified platform). */
function unverifiedAndroid(name?: string) {
  return {
    preferred: "native",
    ios: verifiedClients().ios,
    android: {
      verified: false, target: { package: "com.example.notes", scheme: "notes" },
      ...(name ? { name } : {}), package: "com.example.notes",
      open: `notes://open?u=${ORIGIN_ENCODED}`,
      storeUrl: "https://play.google.com/store/apps/details?id=com.example.notes",
    },
  };
}

function route(input: Partial<OpenRouteInput> & Pick<OpenRouteInput, "platform">) {
  return resolveOpenRoute({ url: SCREEN, chooserHref: CHOOSER, fallbackUrl: FALLBACK, ...input });
}

function memoryStorage(): OpenChoiceStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const failing: OpenChoiceStorage = {
  getItem: () => { throw new DOMException("blocked", "SecurityError"); },
  setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
  removeItem: () => { throw new DOMException("blocked", "SecurityError"); },
};

describe("the platform", () => {
  test("iPhone, iPad (also its desktop-mode agent) and Android are phones; anything else is a computer", () => {
    expect(detectOpenPlatform({ userAgent: IPHONE })).toBe("ios");
    expect(detectOpenPlatform({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 })).toBe("ios");
    expect(detectOpenPlatform({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 })).toBe("desktop");
    expect(detectOpenPlatform({ userAgent: ANDROID })).toBe("android");
    expect(detectOpenPlatform({ userAgent: WINDOWS })).toBe("desktop");
    expect(detectOpenPlatform({})).toBe("desktop");
  });

  test("a Client Hint saying Android is enough; another hint leaves the agent to decide", () => {
    expect(detectOpenPlatform({ userAgent: WINDOWS, clientHintPlatform: "Android" })).toBe("android");
    expect(detectOpenPlatform({ userAgent: IPHONE, clientHintPlatform: "macOS" })).toBe("ios");
    expect(detectOpenPlatform({ userAgent: WINDOWS, clientHintPlatform: "Windows" })).toBe("desktop");
  });
});

describe("the native client of this phone", () => {
  test("is the server's verified declaration, with its destination read from the links it opens", () => {
    expect(phoneClient(verifiedClients(), "android")).toEqual({
      platform: "android", verified: true, trustedClientId: "yurucommu-mobile", name: "Yurucommu",
      target: { package: "com.yurucommu", scheme: "yurucommu" },
      open: OPEN, package: "com.yurucommu",
      storeUrl: "https://play.google.com/store/apps/details?id=com.yurucommu",
    });
    expect(phoneClient(verifiedClients(), "ios")?.verified).toBe(true);
    expect(phoneClient(verifiedClients(), "desktop")).toBeUndefined();
    expect(phoneClient(undefined, "android")).toBeUndefined();
    expect(phoneClient({ preferred: "native" }, "ios")).toBeUndefined();
  });

  test("verified needs the trusted client it was matched to; `verified: true` alone is not enough", () => {
    const { trustedClientId: _dropped, ...android } = verifiedClients().android;
    const client = phoneClient({ android }, "android");
    expect(client?.verified).toBe(false);
    expect(client?.trustedClientId).toBeUndefined();
    expect(phoneClient({ android: { ...verifiedClients().android, verified: "true" } }, "android")?.verified).toBe(false);
  });

  test("a link that could run script, carry a credential or add intent fields is dropped", () => {
    const android = (patch: Record<string, unknown>) => phoneClient({ android: { ...verifiedClients().android, ...patch } }, "android");
    for (const open of [
      "intent://x#Intent;package=com.other;end",
      "javascript:alert(1)",
      "market://details?id=com.other",
      "takosumi://open",
      "https://evil.example/",
      "yurucommu://connect#Intent;scheme=x;end",
      "yurucommu://user:pass@connect",
      "yurucommu://connect?access_token=abc",
      "yurucommu://connect?x=<script>",
      "Yurucommu://connect",
    ]) {
      expect({ open, client: android({ open }) }).toEqual({ open, client: undefined });
    }
    // Android pins the package; without a valid one there is nothing to open.
    expect(android({ package: "not a package" })).toBeUndefined();
    expect(android({ package: undefined })).toBeUndefined();
    // A store link elsewhere than the known stores is dropped, the client stays.
    expect(android({ storeUrl: "https://evil.example/app" })?.storeUrl).toBeUndefined();
  });

  test("universal links and App Links are https on a named host, without credentials even after #", () => {
    const ios = (universalLink: string) => phoneClient({ ios: { ...verifiedClients().ios, open: undefined, universalLink } }, "ios");
    expect(ios(`https://open.yurucommu.example/connect#host_url=${ORIGIN_ENCODED}`)?.link)
      .toBe(`https://open.yurucommu.example/connect#host_url=${ORIGIN_ENCODED}`);
    expect(ios("http://open.yurucommu.example/connect")).toBeUndefined();
    expect(ios("https://open.yurucommu.example:8443/connect")).toBeUndefined();
    expect(ios("https://localhost/connect")).toBeUndefined();
    expect(ios("https://open.yurucommu.example/connect#access_token=abc")).toBeUndefined();
    expect(ios("https://u:p@open.yurucommu.example/connect")).toBeUndefined();
  });

  test("a name with control or format characters is dropped; the label never falls back to anything else", () => {
    const client = phoneClient({ android: { ...unverifiedAndroid().android, name: "Notes‮ppa" } }, "android");
    expect(client?.name).toBeUndefined();
    expect(client?.verified).toBe(false);
  });

  test("on a computer every declared platform is listed", () => {
    expect(declaredPhoneClients(verifiedClients()).map((client) => client.platform)).toEqual(["ios", "android"]);
    expect(declaredPhoneClients(undefined)).toEqual([]);
  });
});

describe("the Android link", () => {
  const client = phoneClient(verifiedClients(), "android")!;

  test("is an intent: link pinned to the package, with Chrome's fallback back to the chooser", () => {
    const href = androidIntentUrl(client, FALLBACK)!;
    expect(href).toBe(
      `intent://connect?host_url=${ORIGIN_ENCODED}&product=yurucommu` +
        "#Intent;scheme=yurucommu;package=com.yurucommu;" +
        "S.browser_fallback_url=https%3A%2F%2Ftakosumi.example%2Fapps%2Fcap_a%3Fopen%3Dif_a%26missing%3D1%23phone;end",
    );
    // Exactly one fragment marker and exactly these three extras.
    expect(href.split("#Intent;").length).toBe(2);
    const extras = href.slice(href.indexOf("#Intent;") + "#Intent;".length).split(";");
    expect(extras).toEqual([
      "scheme=yurucommu",
      "package=com.yurucommu",
      `S.browser_fallback_url=${encodeURIComponent(FALLBACK)}`,
      "end",
    ]);
    // The fallback decodes back to the chooser, marked "did not open".
    expect(decodeURIComponent(extras[2]!.slice("S.browser_fallback_url=".length))).toBe(FALLBACK);
  });

  test("carries only the screen's public origin, as the server filled it in", () => {
    const href = androidIntentUrl(client, FALLBACK)!;
    expect(href).toContain(`host_url=${ORIGIN_ENCODED}`);
    expect(href).not.toMatch(/token|session|code=|account/iu);
  });

  test("without a custom scheme it uses the App Link, keeping its one fragment before #Intent;", () => {
    const appLinkOnly = phoneClient({
      android: {
        ...verifiedClients().android, open: undefined,
        appLink: `https://open.yurucommu.example/connect#host_url=${ORIGIN_ENCODED}`,
      },
    }, "android")!;
    expect(androidIntentUrl(appLinkOnly, FALLBACK)).toBe(
      `intent://open.yurucommu.example/connect#host_url=${ORIGIN_ENCODED}` +
        `#Intent;scheme=https;package=com.yurucommu;S.browser_fallback_url=${encodeURIComponent(FALLBACK)};end`,
    );
    const withSemicolon = phoneClient({
      android: { ...verifiedClients().android, open: undefined, appLink: "https://open.yurucommu.example/c#a;b" },
    }, "android")!;
    expect(androidIntentUrl(withSemicolon, FALLBACK)).toBeUndefined();
  });

  test("needs an absolute http(s) fallback and an Android client", () => {
    expect(androidIntentUrl(client, "javascript:alert(1)")).toBeUndefined();
    expect(androidIntentUrl(client, "/apps/cap_a")).toBeUndefined();
    expect(androidIntentUrl(client, "https://u:p@takosumi.example/apps/cap_a")).toBeUndefined();
    expect(androidIntentUrl(phoneClient(verifiedClients(), "ios")!, FALLBACK)).toBeUndefined();
    expect(chosenNativeHref(client, undefined)).toBeUndefined();
  });
});

describe("the iPhone link", () => {
  test("is the universal link; a custom scheme only once the person chose the app", () => {
    const scheme = phoneClient(verifiedClients(), "ios")!;
    expect(iosNativeHref(scheme, false)).toBeUndefined();
    expect(iosNativeHref(scheme, true)).toBe(OPEN);
    expect(chosenNativeHref(scheme, undefined)).toBe(OPEN);
    const universal = phoneClient({
      ios: { ...verifiedClients().ios, universalLink: "https://open.yurucommu.example/connect#host_url=x" },
    }, "ios")!;
    expect(iosNativeHref(universal, false)).toBe("https://open.yurucommu.example/connect#host_url=x");
  });
});

describe("how one tap opens a screen", () => {
  test("a computer always opens the web in a new tab, whatever was declared or remembered", () => {
    expect(route({ platform: "desktop", clients: verifiedClients() })).toEqual({ kind: "web", href: SCREEN });
    expect(route({
      platform: "desktop", clients: verifiedClients(),
      remembered: { choice: "native", platform: "android", trustedClientId: "yurucommu-mobile" },
    })).toEqual({ kind: "web", href: SCREEN });
  });

  test("without a declaration for this phone, or without a chooser to fall back to, it is the web", () => {
    expect(route({ platform: "android" })).toEqual({ kind: "web", href: SCREEN });
    expect(route({ platform: "android", clients: { ios: verifiedClients().ios, preferred: "native" } }))
      .toEqual({ kind: "web", href: SCREEN });
    expect(resolveOpenRoute({ platform: "android", url: SCREEN, clients: verifiedClients() }))
      .toEqual({ kind: "web", href: SCREEN });
  });

  test("Android: a verified app preferred by the declaration opens directly through the intent link", () => {
    const result = route({ platform: "android", clients: verifiedClients() });
    expect(result.kind).toBe("native");
    expect(result.href).toStartWith("intent://connect?");
    expect(result.href).toContain("package=com.yurucommu;");
    // Without a fallback there is no intent link; the chooser asks instead.
    expect(resolveOpenRoute({ platform: "android", url: SCREEN, clients: verifiedClients(), chooserHref: CHOOSER }))
      .toEqual({ kind: "choose", href: CHOOSER });
  });

  test("a declaration that prefers the web opens the web", () => {
    expect(route({ platform: "android", clients: verifiedClients("web") })).toEqual({ kind: "web", href: SCREEN });
    expect(route({ platform: "ios", clients: verifiedClients("web") })).toEqual({ kind: "web", href: SCREEN });
  });

  test("iPhone: a universal link opens directly; a custom scheme alone shows the chooser until chosen", () => {
    expect(route({ platform: "ios", clients: verifiedClients() })).toEqual({ kind: "choose", href: CHOOSER });
    const withUniversal = {
      ...verifiedClients(),
      ios: { ...verifiedClients().ios, universalLink: "https://open.yurucommu.example/connect#host_url=x" },
    };
    expect(route({ platform: "ios", clients: withUniversal })).toMatchObject({
      kind: "native", href: "https://open.yurucommu.example/connect#host_url=x",
    });
    expect(route({
      platform: "ios", clients: verifiedClients(),
      remembered: { choice: "native", platform: "ios", trustedClientId: "yurucommu-mobile" },
    })).toMatchObject({ kind: "native", href: OPEN });
  });

  test("a remembered choice comes first: web over a native default, native over a web default", () => {
    expect(route({ platform: "android", clients: verifiedClients(), remembered: { choice: "web" } }))
      .toEqual({ kind: "web", href: SCREEN });
    expect(route({
      platform: "android", clients: verifiedClients("web"),
      remembered: { choice: "native", platform: "android", trustedClientId: "yurucommu-mobile" },
    }).kind).toBe("native");
  });

  test("a remembered native app counts only for the same verified app on the same platform", () => {
    const otherApp = { choice: "native", platform: "android", trustedClientId: "takos-mobile" } as const;
    expect(route({ platform: "android", clients: verifiedClients("web"), remembered: otherApp }))
      .toEqual({ kind: "web", href: SCREEN });
    const otherPlatform = { choice: "native", platform: "ios", trustedClientId: "yurucommu-mobile" } as const;
    expect(route({ platform: "android", clients: verifiedClients("web"), remembered: otherPlatform }))
      .toEqual({ kind: "web", href: SCREEN });
  });

  test("an unverified app is never opened by a tap: not by default, not from a remembered choice", () => {
    expect(route({ platform: "android", clients: unverifiedAndroid() })).toEqual({ kind: "web", href: SCREEN });
    expect(route({
      platform: "android", clients: unverifiedAndroid(),
      remembered: { choice: "native", platform: "android", trustedClientId: "yurucommu-mobile" },
    })).toEqual({ kind: "web", href: SCREEN });
    // ... and it can never be remembered in the first place.
    const client = phoneClient(unverifiedAndroid("Notes"), "android");
    expect(client?.verified).toBe(false);
    expect(rememberableChoice("native", client, "android")).toBeUndefined();
  });
});

describe("what this device remembers", () => {
  test("one choice per app and screen, kept in browser storage and read back", () => {
    const storage = memoryStorage();
    expect(openChoiceStorageKey("cap_a", "if_a")).toBe("takosumi.openChoice.v1:cap_a:if_a");
    expect(openChoiceStorageKey("cap a", "if:b")).toBe("takosumi.openChoice.v1:cap%20a:if%3Ab");
    const native = rememberableChoice("native", phoneClient(verifiedClients(), "android"), "android")!;
    expect(native).toEqual({ choice: "native", platform: "android", trustedClientId: "yurucommu-mobile" });
    expect(writeOpenChoice(storage, "cap_a", "if_a", native)).toBe(true);
    expect(writeOpenChoice(storage, "cap_a", "if_b", { choice: "web" })).toBe(true);
    expect(readOpenChoice(storage, "cap_a", "if_a")).toEqual(native);
    expect(readOpenChoice(storage, "cap_a", "if_b")).toEqual({ choice: "web" });
    expect(readOpenChoice(storage, "cap_b", "if_a")).toBeUndefined();
    expect(forgetOpenChoice(storage, "cap_a", "if_a")).toBe(true);
    expect(readOpenChoice(storage, "cap_a", "if_a")).toBeUndefined();
    expect(openChoiceStorageWorks(storage)).toBe(true);
    // The probe leaves nothing behind.
    expect([...storage.map.keys()]).toEqual([openChoiceStorageKey("cap_a", "if_b")]);
  });

  test("a computer remembers nothing; the web can always be remembered on a phone", () => {
    expect(rememberableChoice("web", undefined, "desktop")).toBeUndefined();
    expect(rememberableChoice("web", undefined, "ios")).toEqual({ choice: "web" });
    expect(rememberableChoice("native", phoneClient(verifiedClients(), "ios"), "android")).toBeUndefined();
  });

  test("a stored value that is not a choice is ignored", () => {
    const storage = memoryStorage();
    const key = openChoiceStorageKey("cap_a", "if_a");
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ choice: "inside" }),
      JSON.stringify({ choice: "native", platform: "android" }),
      JSON.stringify({ choice: "native", platform: "windows", trustedClientId: "x" }),
      JSON.stringify({ choice: "native", platform: "ios", trustedClientId: "Not An Id" }),
      JSON.stringify({ choice: "web", pad: "x".repeat(600) }),
    ]) {
      storage.map.set(key, raw);
      expect({ raw, read: readOpenChoice(storage, "cap_a", "if_a") }).toEqual({ raw, read: undefined });
    }
  });

  test("without storage, or when it throws, nothing is remembered and nothing throws: the default opens", () => {
    expect(readOpenChoice(undefined, "cap_a", "if_a")).toBeUndefined();
    expect(writeOpenChoice(undefined, "cap_a", "if_a", { choice: "web" })).toBe(false);
    expect(forgetOpenChoice(undefined, "cap_a", "if_a")).toBe(false);
    expect(openChoiceStorageWorks(undefined)).toBe(false);
    expect(readOpenChoice(failing, "cap_a", "if_a")).toBeUndefined();
    expect(writeOpenChoice(failing, "cap_a", "if_a", { choice: "web" })).toBe(false);
    expect(forgetOpenChoice(failing, "cap_a", "if_a")).toBe(false);
    expect(openChoiceStorageWorks(failing)).toBe(false);
    // The route is then decided by the declaration alone.
    const remembered = readOpenChoice(failing, "cap_a", "if_a");
    expect(route({ platform: "android", clients: verifiedClients(), ...(remembered ? { remembered } : {}) }).kind)
      .toBe("native");
    expect(route({ platform: "ios", clients: verifiedClients(), ...(remembered ? { remembered } : {}) }).kind)
      .toBe("choose");
  });
});

describe("the chooser on the app page", () => {
  test("is the app page at one screen's chooser; Android's fallback marks that the app did not open", () => {
    expect(appOpenChooserPath("cap_a", "if_a")).toBe("/apps/cap_a?open=if_a#phone");
    expect(appOpenChooserPath("cap_a", "if_a", { missing: true })).toBe("/apps/cap_a?open=if_a&missing=1#phone");
    expect(appOpenChooserPath("cap a/b", "if&x")).toBe("/apps/cap%20a%2Fb?open=if%26x#phone");
    expect(parseOpenChooserQuery("?open=if_a&missing=1")).toEqual({ interfaceId: "if_a", missing: true });
    expect(parseOpenChooserQuery("?open=if_a")).toEqual({ interfaceId: "if_a", missing: false });
    expect(parseOpenChooserQuery("")).toEqual({ missing: false });
    expect(parseOpenChooserQuery("?open=%3Cscript%3E")).toEqual({ missing: false });
    expect(parseOpenChooserQuery(`?open=${"a".repeat(129)}`)).toEqual({ missing: false });
  });

  test("store links are labelled by their store and shown by host and path before following them", () => {
    expect(storeKind("https://apps.apple.com/app/id1234567890")).toBe("appStore");
    expect(storeKind("https://testflight.apple.com/join/AbC123")).toBe("testFlight");
    expect(storeKind("https://play.google.com/store/apps/details?id=com.yurucommu")).toBe("googlePlay");
    expect(storeKind("https://f-droid.org/packages/com.yurucommu/")).toBe("fDroid");
    expect(storeKind("https://evil.example/")).toBeUndefined();
    expect(storeDestination("https://play.google.com/store/apps/details?id=com.example.notes&hl=ja"))
      .toBe("play.google.com/store/apps/details?id=com.example.notes");
    expect(storeDestination("https://apps.apple.com/app/id1234567890")).toBe("apps.apple.com/app/id1234567890");
  });
});

describe("with the server's own parser", () => {
  const surfaceUrl = "https://yurucommu.example.com/home";

  test("a declaration of a trusted app opens on Android through the intent link with the screen's origin", () => {
    const clients = parseInterfaceClients({
      preferred: "native",
      ios: { bundleId: "com.yurucommu", open: "yurucommu://connect?host_url={origin}&product=yurucommu" },
      android: { package: "com.yurucommu", open: "yurucommu://connect?host_url={origin}&product=yurucommu" },
    }, { surfaceUrl });
    expect(clients?.android?.verified).toBe(true);
    const android = route({ platform: "android", url: surfaceUrl, clients });
    expect(android).toMatchObject({ kind: "native" });
    expect(android.href).toBe(
      `intent://connect?host_url=${ORIGIN_ENCODED}&product=yurucommu` +
        `#Intent;scheme=yurucommu;package=com.yurucommu;S.browser_fallback_url=${encodeURIComponent(FALLBACK)};end`,
    );
    expect(route({ platform: "ios", url: surfaceUrl, clients })).toEqual({ kind: "choose", href: CHOOSER });
  });

  test("an unknown app's declaration stays unverified, opens the web, and shows where it goes", () => {
    const clients = parseInterfaceClients({
      preferred: "native",
      android: { package: "com.example.notes", name: "Notes", open: "notes://open?u={origin}" },
    }, { surfaceUrl });
    expect(clients?.preferred).toBe("web");
    expect(route({ platform: "android", url: surfaceUrl, clients })).toEqual({ kind: "web", href: surfaceUrl });
    expect(phoneClient(clients, "android")).toMatchObject({
      verified: false, name: "Notes", target: { package: "com.example.notes", scheme: "notes" },
    });
  });
});
