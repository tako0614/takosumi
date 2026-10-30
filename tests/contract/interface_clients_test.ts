import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";

import repositoryManifestV2_1Schema from "../../docs/public/schemas/repository-manifest-v2.1.schema.json" with { type: "json" };
import repositoryManifestV2_4Schema from "../../docs/public/schemas/repository-manifest-v2.4.schema.json" with { type: "json" };
import {
  DEFAULT_TRUSTED_NATIVE_CLIENTS,
  INTERFACE_CLIENT_BLOCKED_SCHEMES,
  INTERFACE_CLIENT_LINK_MAX_LENGTH,
  parseInterfaceClients,
  parseTrustedNativeClients,
  type TrustedNativeClient,
} from "../../contract/interface-clients.ts";
import {
  findForbiddenRepositoryManifestMaterial,
  parseRepositoryManifestText,
} from "../../contract/repository-manifest.ts";

const SURFACE = "https://notes.example.test/app";
const ORIGIN = "https%3A%2F%2Fnotes.example.test";
const URL_VALUE = "https%3A%2F%2Fnotes.example.test%2Fapp";
const VIEWER = "https://app.takosumi.test";
const OPTIONS = { surfaceUrl: SURFACE, viewerOrigin: VIEWER } as const;

/** An operator list with every optional feature, for verified-client tests. */
const NOTES_CLIENT = {
  id: "notes-mobile",
  name: "Notes",
  ios: {
    bundleId: "com.example.notes",
    appStoreId: "1234567890",
    testFlight: true,
    schemes: ["notes"],
    universalLinkHosts: ["open.notes.example"],
    templates: [
      "notes://connect?host_url={origin}",
      "https://open.notes.example/connect#host_url={origin}",
    ],
  },
  android: {
    package: "com.example.notes",
    schemes: ["notes"],
    appLinkHosts: ["open.notes.example"],
    templates: [
      "notes://connect?host_url={origin}",
      "https://open.notes.example/connect#host_url={origin}",
    ],
  },
};
const TRUSTED = parseTrustedNativeClients([NOTES_CLIENT]);
const WITH_NOTES = { ...OPTIONS, trustedClients: TRUSTED } as const;

/** The declaration of the design (§2) for yurucommu, with its bundle id. */
function yurucommuDeclaration(): Record<string, unknown> {
  return {
    preferred: "native",
    ios: {
      name: "Yurucommu",
      bundleId: "com.yurucommu",
      open: "yurucommu://connect?host_url={origin}&product=yurucommu",
    },
    android: {
      name: "Yurucommu",
      package: "com.yurucommu",
      open: "yurucommu://connect?host_url={origin}&product=yurucommu",
    },
  };
}

/** Unverified links: any app the operator does not trust. */
function iosOpen(open: unknown): string | undefined {
  return parseInterfaceClients({ ios: { open } }, OPTIONS)?.ios?.open;
}

function androidOpen(open: unknown): string | undefined {
  return parseInterfaceClients(
    { android: { package: "org.example.other", open } },
    OPTIONS,
  )?.android?.open;
}

function universalLink(link: unknown, options: Parameters<typeof parseInterfaceClients>[1] = OPTIONS): string | undefined {
  return parseInterfaceClients({ ios: { universalLink: link } }, options)?.ios
    ?.universalLink;
}

function appLink(link: unknown): string | undefined {
  return parseInterfaceClients(
    { android: { package: "org.example.other", appLink: link } },
    OPTIONS,
  )?.android?.appLink;
}

describe("verified clients", () => {
  test("the built-in list verifies the first-party apps and names them itself", () => {
    expect(parseInterfaceClients(yurucommuDeclaration(), OPTIONS)).toEqual({
      preferred: "native",
      ios: {
        verified: true,
        trustedClientId: "yurucommu-mobile",
        target: { scheme: "yurucommu" },
        name: "Yurucommu",
        bundleId: "com.yurucommu",
        open: `yurucommu://connect?host_url=${ORIGIN}&product=yurucommu`,
      },
      android: {
        verified: true,
        trustedClientId: "yurucommu-mobile",
        target: { package: "com.yurucommu", scheme: "yurucommu" },
        name: "Yurucommu",
        package: "com.yurucommu",
        open: `yurucommu://connect?host_url=${ORIGIN}&product=yurucommu`,
        storeUrl: "https://play.google.com/store/apps/details?id=com.yurucommu",
      },
    });
    for (const [identifier, open, id] of [
      ["com.yurumeet", "yurume://connect?host_url={origin}", "yurumeet-mobile"],
      ["com.yurumeet", "yurume://connect?host_url={origin}&product=yurumeet", "yurumeet-mobile"],
      ["jp.takos.mobile", "takos://connect?host_url={origin}", "takos-mobile"],
      ["jp.takos.mobile", "takos://connect?host_url={origin}&product=takos", "takos-mobile"],
      ["com.yurucommu", "yurucommu://connect?host_url={origin}", "yurucommu-mobile"],
    ] as const) {
      const clients = parseInterfaceClients(
        { ios: { bundleId: identifier, open }, android: { package: identifier, open } },
        OPTIONS,
      );
      expect(clients?.ios?.trustedClientId).toBe(id);
      expect(clients?.android?.trustedClientId).toBe(id);
    }
    expect(DEFAULT_TRUSTED_NATIVE_CLIENTS.map((entry) => entry.id)).toEqual([
      "yurucommu-mobile",
      "yurumeet-mobile",
      "takos-mobile",
    ]);
  });

  test("the declared name, App Store id and extra links of a trusted identity are not used", () => {
    const clients = parseInterfaceClients(
      {
        ios: {
          name: "Pay here",
          bundleId: "com.example.notes",
          appStoreId: "999",
          open: "notes://connect?host_url={origin}",
          universalLink: "https://open.notes.example/connect#host_url={origin}",
        },
      },
      WITH_NOTES,
    );
    expect(clients?.ios).toEqual({
      verified: true,
      trustedClientId: "notes-mobile",
      target: { scheme: "notes", host: "open.notes.example" },
      name: "Notes",
      appStoreId: "1234567890",
      bundleId: "com.example.notes",
      open: `notes://connect?host_url=${ORIGIN}`,
      universalLink: `https://open.notes.example/connect#host_url=${ORIGIN}`,
      storeUrl: "https://apps.apple.com/app/id1234567890",
    });
  });

  test("templates match after normalising scheme and host case and the default port", () => {
    const clients = parseInterfaceClients(
      {
        android: {
          package: "com.example.notes",
          appLink: "https://OPEN.notes.example:443/connect#host_url={origin}",
        },
      },
      WITH_NOTES,
    );
    expect(clients?.android?.verified).toBe(true);
    expect(clients?.android?.appLink).toBe(
      `https://open.notes.example/connect#host_url=${ORIGIN}`,
    );
  });

  test("a trusted identity with any other link loses it, and with no allowed link loses the platform", () => {
    for (const open of [
      "yurucommu://connect?host_url=https%3A%2F%2Fevil.example",
      "yurucommu://connect?host_url={origin}&setup_ticket=attacker",
      "yurucommu://connect?host_url={url}",
      "yurucommu://connect?host_url={origin}&product=yurumeet",
      "yurucommu://open?path=/settings",
      "yurume://connect?host_url={origin}",
      "upi://pay?pa=attacker@ybl&am=5000",
    ]) {
      expect(
        parseInterfaceClients({ android: { package: "com.yurucommu", open } }, OPTIONS),
        open,
      ).toBeUndefined();
      expect(
        parseInterfaceClients({ ios: { bundleId: "com.yurucommu", open } }, OPTIONS),
        open,
      ).toBeUndefined();
    }
    const mixed = parseInterfaceClients(
      {
        ios: {
          bundleId: "com.example.notes",
          open: "notes://connect?host_url={origin}",
          universalLink: "https://www.paypal.com/paypalme/attacker/5000",
        },
      },
      WITH_NOTES,
    );
    expect(mixed?.ios?.verified).toBe(true);
    expect(mixed?.ios?.universalLink).toBeUndefined();
  });

  test("an empty trusted list verifies nothing", () => {
    const clients = parseInterfaceClients(
      {
        android: {
          package: "com.yurucommu",
          open: "yurucommu://connect?host_url={origin}",
        },
      },
      { ...OPTIONS, trustedClients: [] },
    );
    expect(clients?.android?.verified).toBe(false);
  });
});

describe("unverified clients", () => {
  test("any other declaration is returned unverified with its real destination", () => {
    for (const [android, target] of [
      [{ package: "com.evil.pay", open: "upi://pay?pa=attacker@ybl&am=5000" }, { package: "com.evil.pay", scheme: "upi" }],
      [{ package: "com.evil.wallet", open: "bitcoin:bc1qattacker?amount=1" }, { package: "com.evil.wallet", scheme: "bitcoin" }],
      [{ package: "com.whatsapp", open: "whatsapp://send?text=hello" }, { package: "com.whatsapp", scheme: "whatsapp" }],
      [{ package: "com.paypal.android.p2pmobile", appLink: "https://www.paypal.com/paypalme/attacker/5000" }, { package: "com.paypal.android.p2pmobile", host: "www.paypal.com" }],
    ] as const) {
      const clients = parseInterfaceClients({ preferred: "native", android }, OPTIONS);
      expect(clients?.android?.verified).toBe(false);
      expect(clients?.android?.trustedClientId).toBeUndefined();
      expect(clients?.android?.target).toEqual(target);
    }
    const ios = parseInterfaceClients(
      { ios: { name: "Wallet", open: "bitcoin:bc1qattacker?amount=1" } },
      OPTIONS,
    )?.ios;
    expect(ios).toEqual({
      verified: false,
      target: { scheme: "bitcoin" },
      name: "Wallet",
      open: "bitcoin:bc1qattacker?amount=1",
    });
  });

  test("an unverified declaration may not use a trusted client's scheme or link host", () => {
    for (const open of [
      "yurucommu://connect?host_url=https%3A%2F%2Fevil.example",
      "yurucommu://connect?host_url={origin}",
      "yurume://connect?host_url={origin}",
      "takos://connect?host_url={origin}",
    ]) {
      expect(iosOpen(open), open).toBeUndefined();
      expect(androidOpen(open), open).toBeUndefined();
    }
    expect(
      parseInterfaceClients(
        { ios: { universalLink: "https://open.notes.example/connect#host_url={origin}" } },
        WITH_NOTES,
      ),
    ).toBeUndefined();
    expect(
      parseInterfaceClients(
        { android: { package: "org.example.other", appLink: "https://open.notes.example/x" } },
        WITH_NOTES,
      ),
    ).toBeUndefined();
  });

  test("an unverified name may not imitate Takosumi or a trusted client", () => {
    const named = (name: string) =>
      parseInterfaceClients({ ios: { name, open: "other://open" } }, WITH_NOTES)?.ios?.name;
    for (const name of ["Takosumi", "Takosumi Pay", "T4kosumi", "Notes", "N0tes Pro", "Ｎｏｔｅｓ"]) {
      expect(named(name), name).toBeUndefined();
    }
    expect(named("Other app")).toBe("Other app");
  });
});

describe("Takosumi's own identities", () => {
  test("Takosumi Mobile's bundle id and applicationId refuse the platform", () => {
    for (const identifier of ["com.takosumi", "com.takosumi.beta", "COM.TAKOSUMI"]) {
      expect(
        parseInterfaceClients({ android: { package: identifier, open: "other://open" } }, OPTIONS),
      ).toBeUndefined();
      expect(
        parseInterfaceClients({ ios: { bundleId: identifier, open: "other://open" } }, OPTIONS),
      ).toBeUndefined();
    }
  });

  test("Takosumi-owned, dashboard and issuer hosts are refused in links", () => {
    expect(universalLink("https://takosumi.com/x?h={origin}")).toBeUndefined();
    expect(universalLink("https://app.takosumi.com/runs?h={origin}")).toBeUndefined();
    expect(universalLink(`${VIEWER}/oauth/authorize?x={origin}`)).toBeUndefined();
    expect(universalLink("https://app.takosumi.test:8443/x")).toBeUndefined();
    expect(
      universalLink("https://accounts.example.org/x", { ...OPTIONS, reservedHosts: ["accounts.example.org"] }),
    ).toBeUndefined();
    expect(universalLink("https://open.other.example/x")).toBe("https://open.other.example/x");
  });

  test("the takosumi scheme is blocked", () => {
    expect(iosOpen("takosumi://app?url={url}")).toBeUndefined();
  });
});

describe("placeholders", () => {
  test("{origin} and {url} are URL-encoded, may repeat up to four times, and are optional", () => {
    expect(iosOpen("other://open?o={origin}&u={url}&again={origin}")).toBe(
      `other://open?o=${ORIGIN}&u=${URL_VALUE}&again=${ORIGIN}`,
    );
    expect(iosOpen("other://open?a={origin}&b={origin}&c={origin}&d={url}")).toBeDefined();
    expect(iosOpen("other://open?a={origin}&b={origin}&c={origin}&d={url}&e={url}")).toBeUndefined();
    expect(iosOpen("other://home")).toBe("other://home");
    const withQuery = parseInterfaceClients(
      { ios: { open: "other://open?u={url}" } },
      { surfaceUrl: "https://notes.example.test/a b?x=1&y=2" },
    )?.ios?.open;
    expect(withQuery).toBe(
      `other://open?u=${encodeURIComponent("https://notes.example.test/a%20b?x=1&y=2")}`,
    );
  });

  test("any other {...}, stray brace, or differently cased placeholder refuses the link", () => {
    for (const template of [
      "other://open?server={host}",
      "other://open?server={origin}&id={accountId}",
      "other://open?server={ORIGIN}",
      "other://open?server={ origin }",
      "other://open?server={{origin}}",
      "other://open?server={ori{url}gin}",
      "other://open?server={origin",
      "other://open?server=origin}",
      "other://open?server={}",
    ]) {
      expect(iosOpen(template), template).toBeUndefined();
    }
  });

  test("a placeholder may not choose the host", () => {
    expect(iosOpen("other://{origin}/open")).toBeUndefined();
    expect(iosOpen("other://x{url}/open")).toBeUndefined();
    expect(universalLink("https://{origin}/connect")).toBeUndefined();
    expect(universalLink("https://open.other.example{origin}/x")).toBeUndefined();
    expect(universalLink("https://open.other.example:{origin}/x")).toBeUndefined();
    expect(universalLink("https://{url}")).toBeUndefined();
  });
});

describe("custom schemes", () => {
  test("every blocked scheme is refused in open", () => {
    expect(INTERFACE_CLIENT_BLOCKED_SCHEMES.size).toBeGreaterThan(20);
    for (const scheme of INTERFACE_CLIENT_BLOCKED_SCHEMES) {
      expect(iosOpen(`${scheme}://open?server={origin}`)).toBeUndefined();
      expect(androidOpen(`${scheme}:open`)).toBeUndefined();
    }
  });

  test("script, data, file and system schemes are refused however they are spelled", () => {
    for (const template of [
      "javascript:alert(document.cookie)",
      "javascript://%0aalert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "blob:https://notes.example.test/uuid",
      "about:blank",
      "tel:+819012345678",
      "sms:+819012345678",
      "mailto:someone@example.test",
      "itms-apps://apps.apple.com/app/id1",
      "itms-services://?action=download-manifest&url=https://evil.example/m.plist",
      "market://details?id=com.evil",
      "prefs:root=General",
      "shortcuts://run-shortcut?name=x",
      "x-safari-https://evil.example/",
      "http://notes.example.test/",
      "https://notes.example.test/",
    ]) {
      expect(iosOpen(template), template).toBeUndefined();
    }
  });

  test("intent: is never declared; the dashboard builds it for Android", () => {
    expect(
      androidOpen("intent://connect?host_url={origin}#Intent;scheme=other;package=org.example.other;end"),
    ).toBeUndefined();
    expect(androidOpen("android-app://org.example.other/other/connect")).toBeUndefined();
    expect(androidOpen("INTENT://connect#Intent;end")).toBeUndefined();
    // A fragment would follow the dashboard-built `#Intent;...;end` and could
    // add extras such as a component or a fallback URL.
    expect(
      androidOpen(
        "other://connect?host_url={origin}#Intent;component=com.evil/.Main;S.browser_fallback_url=javascript:alert(1);end",
      ),
    ).toBeUndefined();
    expect(androidOpen("other://connect#x")).toBeUndefined();
  });

  test("the scheme must be 2-32 lowercase characters before a non-empty rest", () => {
    expect(iosOpen("c:/windows")).toBeUndefined();
    expect(iosOpen("Other://open")).toBeUndefined();
    expect(iosOpen("1other://open")).toBeUndefined();
    expect(iosOpen("ot_her://open")).toBeUndefined();
    expect(iosOpen(`${"a".repeat(33)}://open`)).toBeUndefined();
    expect(iosOpen(`${"a".repeat(32)}://open`)).toBe(`${"a".repeat(32)}://open`);
    expect(iosOpen("other:")).toBeUndefined();
    expect(iosOpen("other")).toBeUndefined();
    expect(iosOpen("com.example.other+x-1:open")).toBe("com.example.other+x-1:open");
    expect(iosOpen("other:///connect?server={origin}")).toBe(
      `other:///connect?server=${ORIGIN}`,
    );
  });

  test("userinfo, credential-named parameters and invalid characters refuse the link", () => {
    for (const template of [
      "other://user:pass@open",
      "other://user@open",
      "other://open?token=abc",
      "other://open?access_token={origin}",
      "other://open?client_secret=x",
      "other://open?server={origin} ",
      "other://open?q=a b",
      "other://open?q=\"x\"",
      "other://open?q=<x>",
      "other://open\\x",
      "other://open?q=`x`",
      "other://open?q=ä",
      "other://open?q=\u0000",
    ]) {
      expect(iosOpen(template), template).toBeUndefined();
    }
  });
});

describe("universal links and App Links", () => {
  test("http and other non-https links are refused", () => {
    for (const link of [
      "http://open.other.example/connect#host_url={origin}",
      "HTTP://open.other.example/x",
      "HTTPS://open.other.example/x",
      "other://connect",
      "//open.other.example/x",
      "/connect",
      "javascript:alert(1)",
    ]) {
      expect(universalLink(link), link).toBeUndefined();
      expect(appLink(link), link).toBeUndefined();
    }
  });

  test("the publisher domain must be a plain named host on the default port", () => {
    for (const link of [
      "https://user@open.other.example/x",
      "https://user:pass@open.other.example/x",
      "https://open.other.example:8443/x",
      "https://192.0.2.10/x",
      "https://[2001:db8::1]/x",
      "https://localhost/x",
      "https://https:///x",
      "https:///x",
    ]) {
      expect(universalLink(link), link).toBeUndefined();
    }
    expect(universalLink("https://open.other.example:443/x")).toBe(
      "https://open.other.example/x",
    );
  });

  test("credential-named parameters are refused in the query and in a fragment", () => {
    expect(universalLink("https://open.other.example/x?token=abc")).toBeUndefined();
    expect(universalLink("https://open.other.example/x?refresh_token={origin}")).toBeUndefined();
    expect(universalLink("https://open.other.example/x#access_token={origin}")).toBeUndefined();
    expect(universalLink("https://open.other.example/x#session={url}")).toBeUndefined();
    expect(universalLink("https://open.other.example/x?u={url}")).toBe(
      `https://open.other.example/x?u=${URL_VALUE}`,
    );
  });
});

describe("store links", () => {
  const iosStore = (fields: Record<string, unknown>, options = OPTIONS) =>
    parseInterfaceClients({ ios: { open: "other://open", ...fields } }, options)?.ios;
  const androidStore = (storeUrl: unknown) =>
    parseInterfaceClients(
      { android: { package: "org.example.other", open: "other://open", storeUrl } },
      OPTIONS,
    )?.android?.storeUrl;
  const PLAY = "https://play.google.com/store/apps/details?id=org.example.other";

  test("an App Store link must be the page of the declared App Store id", () => {
    expect(iosStore({ appStoreId: "42", storeUrl: "https://apps.apple.com/jp/app/other/id42" })?.storeUrl)
      .toBe("https://apps.apple.com/jp/app/other/id42");
    expect(iosStore({ appStoreId: "42", storeUrl: "https://apps.apple.com/app/id43" })?.storeUrl)
      .toBe("https://apps.apple.com/app/id42");
    expect(iosStore({ storeUrl: "https://apps.apple.com/app/id43" })?.storeUrl).toBeUndefined();
    expect(iosStore({ appStoreId: 42 })?.storeUrl).toBe("https://apps.apple.com/app/id42");
  });

  test("TestFlight links are accepted only for a trusted client that allows them", () => {
    const join = "https://testflight.apple.com/join/AbCdEf12";
    expect(iosStore({ appStoreId: "42", storeUrl: join })?.storeUrl).toBe("https://apps.apple.com/app/id42");
    expect(
      parseInterfaceClients(
        { ios: { bundleId: "com.example.notes", open: "notes://connect?host_url={origin}", storeUrl: join } },
        WITH_NOTES,
      )?.ios?.storeUrl,
    ).toBe(join);
    const noTestFlight = parseTrustedNativeClients([{ ...NOTES_CLIENT, ios: { ...NOTES_CLIENT.ios, testFlight: false } }]);
    expect(
      parseInterfaceClients(
        { ios: { bundleId: "com.example.notes", open: "notes://connect?host_url={origin}", storeUrl: join } },
        { ...OPTIONS, trustedClients: noTestFlight },
      )?.ios?.storeUrl,
    ).toBe("https://apps.apple.com/app/id1234567890");
  });

  test("Google Play and F-Droid links must be the page of the declared package", () => {
    expect(androidStore(PLAY)).toBe(PLAY);
    expect(androidStore("https://f-droid.org/packages/org.example.other/")).toBe(
      "https://f-droid.org/packages/org.example.other/",
    );
    expect(androidStore("https://f-droid.org/en/packages/org.example.other/")).toBe(
      "https://f-droid.org/en/packages/org.example.other/",
    );
    for (const storeUrl of [
      "https://play.google.com/store/apps/details?id=com.evil",
      "https://play.google.com/store/apps/details?id=org.example.other&id=com.evil",
      "https://play.google.com/store/apps/dev?id=123",
      "https://f-droid.org/packages/com.evil/",
      "https://apps.apple.com/app/id1",
      "http://play.google.com/store/apps/details?id=org.example.other",
      "https://play.google.com.evil.example/store/apps/details?id=org.example.other",
      "https://user@play.google.com/store/apps/details?id=org.example.other",
      `${PLAY}&token=x`,
      `${PLAY}#x`,
    ]) {
      expect(androidStore(storeUrl), storeUrl).toBe(PLAY);
    }
  });
});

describe("lengths, names and identifiers", () => {
  test("templates longer than the limit are refused before and after filling", () => {
    const base = "other://open?pad=";
    const fits = base + "a".repeat(INTERFACE_CLIENT_LINK_MAX_LENGTH - base.length);
    expect(iosOpen(fits)).toBe(fits);
    expect(iosOpen(`${fits}a`)).toBeUndefined();

    const withUrl = `other://open?u={url}&pad=${"a".repeat(1_900)}`;
    expect(iosOpen(withUrl)).toBeDefined();
    const longSurface = `https://notes.example.test/${"p".repeat(200)}`;
    expect(
      parseInterfaceClients({ ios: { open: withUrl } }, { surfaceUrl: longSurface }),
    ).toBeUndefined();
  });

  test("an invalid name is dropped without dropping the platform", () => {
    const named = (name: unknown) =>
      parseInterfaceClients({ ios: { name, open: "other://open" } }, OPTIONS)?.ios;
    const plain = { verified: false, target: { scheme: "other" }, open: "other://open" };
    expect(named("  Other  ")?.name).toBe("Other");
    expect(named("📝".repeat(64))?.name).toBe("📝".repeat(64));
    for (const name of [
      "n".repeat(65),
      "   ",
      "Other\u202Eppa",
      "Other\u200Bapp",
      "Other\u2028app",
      "Other\u2029app",
      "Other\u00ADapp",
      "Other\nApp",
      42,
    ]) {
      expect(named(name), JSON.stringify(name)).toEqual(plain);
    }
  });

  test("store ids and bundle ids are checked", () => {
    const ios = (fields: Record<string, unknown>) =>
      parseInterfaceClients({ ios: { open: "other://open", ...fields } }, OPTIONS)?.ios;
    for (const appStoreId of ["1234567890123", "id123", "", "12.5", -1, 1.5, "١٢٣"]) {
      expect(ios({ appStoreId })?.appStoreId).toBeUndefined();
    }
    for (const bundleId of ["other", "com..other", "com.other!", `com.${"a".repeat(152)}`]) {
      expect(ios({ bundleId })?.bundleId).toBeUndefined();
    }
  });

  test("Android needs a valid package and both platforms need a way to open the app", () => {
    for (const packageName of [undefined, "other", "com.1other", "com.other-app", "com..other", 7]) {
      expect(
        parseInterfaceClients({ android: { package: packageName, open: "other://open" } }, OPTIONS),
      ).toBeUndefined();
    }
    expect(
      parseInterfaceClients({ android: { package: "org.example.other", appStoreId: "1" } }, OPTIONS),
    ).toBeUndefined();
    expect(
      parseInterfaceClients({ ios: { name: "Other", appStoreId: "1", open: "javascript:alert(1)" } }, OPTIONS),
    ).toBeUndefined();
    expect(
      parseInterfaceClients(
        { ios: { open: "other://open", universalLink: "http://open.other.example/" } },
        OPTIONS,
      )?.ios?.universalLink,
    ).toBeUndefined();
  });
});

describe("shape", () => {
  test("preferred defaults to native and accepts only native or web", () => {
    const declaration = yurucommuDeclaration();
    delete declaration.preferred;
    expect(parseInterfaceClients(declaration, OPTIONS)?.preferred).toBe("native");
    expect(parseInterfaceClients({ ...declaration, preferred: "web" }, OPTIONS)?.preferred).toBe("web");
    for (const preferred of ["in_app", "WEB", 1, null, true]) {
      expect(parseInterfaceClients({ ...declaration, preferred }, OPTIONS)?.preferred).toBe("native");
    }
  });

  test("unknown keys and platforms are ignored and never echoed", () => {
    const declaration = yurucommuDeclaration();
    const clients = parseInterfaceClients(
      {
        ...declaration,
        windows: { open: "other://open" },
        macos: { open: "other://open" },
        web: { url: "https://evil.example/" },
        ios: { ...(declaration.ios as object), extra: "x", accessToken: "y", verified: true },
        android: { ...(declaration.android as object), sha256CertFingerprints: ["AA"], target: "x" },
      },
      OPTIONS,
    );
    expect(clients).toEqual(parseInterfaceClients(yurucommuDeclaration(), OPTIONS));
    expect(JSON.stringify(clients)).not.toMatch(/windows|macos|evil|extra|accessToken|sha256/u);
  });

  test("a declaration cannot mark itself verified", () => {
    const clients = parseInterfaceClients(
      { android: { package: "org.example.other", open: "other://open", verified: true, trustedClientId: "yurucommu-mobile" } },
      OPTIONS,
    );
    expect(clients?.android?.verified).toBe(false);
    expect(clients?.android?.trustedClientId).toBeUndefined();
  });

  test("non-object values, unusable surfaces and empty declarations are absent", () => {
    for (const value of [undefined, null, "clients", 1, [], [yurucommuDeclaration()], {}]) {
      expect(parseInterfaceClients(value, OPTIONS)).toBeUndefined();
    }
    expect(parseInterfaceClients({ ios: [], android: "x", preferred: "web" }, OPTIONS)).toBeUndefined();
    for (const surfaceUrl of ["", "not a url", "other://open", "javascript:alert(1)", "https://u:p@notes.example.test/"]) {
      expect(parseInterfaceClients(yurucommuDeclaration(), { surfaceUrl })).toBeUndefined();
    }
  });

  test("handoff links carry only the screen's public origin", () => {
    const clients = parseInterfaceClients(yurucommuDeclaration(), {
      surfaceUrl: "https://notes.example.test/app?view=home",
      viewerOrigin: VIEWER,
    });
    for (const link of [clients?.ios?.open, clients?.android?.open]) {
      expect(link).toContain(ORIGIN);
      expect(link).not.toContain("view%3Dhome");
      expect(link).not.toContain("takosumi.test");
    }
  });
});

describe("parseTrustedNativeClients", () => {
  const entry = (patch: Record<string, unknown>): unknown => ({ ...NOTES_CLIENT, ...patch });
  const ios = (patch: Record<string, unknown>): unknown => entry({ ios: { ...NOTES_CLIENT.ios, ...patch } });
  const android = (patch: Record<string, unknown>): unknown =>
    entry({ android: { ...NOTES_CLIENT.android, ...patch } });

  test("accepts the documented format and freezes it", () => {
    expect(TRUSTED[0]?.ios?.templates).toEqual(NOTES_CLIENT.ios.templates);
    expect(Object.isFrozen(TRUSTED)).toBe(true);
    expect(Object.isFrozen(TRUSTED[0]?.android?.templates)).toBe(true);
    expect(parseTrustedNativeClients([])).toEqual([]);
    const androidOnly = parseTrustedNativeClients([{ id: "x", name: "X App", android: NOTES_CLIENT.android }]);
    expect(androidOnly[0]?.ios).toBeUndefined();
  });

  test("refuses anything malformed, reserved, ambiguous or unpinned", () => {
    const invalid: readonly unknown[] = [
      "[]",
      {},
      Array.from({ length: 33 }, (_, index) => ({ ...NOTES_CLIENT, id: `c${index}` })),
      [entry({ extra: true })],
      [entry({ id: "Notes" })],
      [entry({ id: "" })],
      [entry({ name: "Takosumi" })],
      [entry({ name: "Notes\u202E" })],
      [{ id: "x", name: "X" }],
      [ios({ bundleId: "com.takosumi" })],
      [android({ package: "com.takosumi.notes" })],
      [ios({ bundleId: "notes" })],
      [ios({ appStoreId: "abc" })],
      [ios({ testFlight: "yes" })],
      [ios({ unknown: 1 })],
      [ios({ schemes: ["javascript"] })],
      [ios({ schemes: ["takosumi"] })],
      [ios({ schemes: ["Notes"] })],
      [ios({ schemes: ["notes", "notes"] })],
      [ios({ universalLinkHosts: ["app.takosumi.com"] })],
      [ios({ universalLinkHosts: ["localhost"] })],
      [ios({ templates: [] })],
      [ios({ templates: ["notes://connect"] })],
      [ios({ templates: ["notes://connect?host_url={url}"] })],
      [ios({ templates: ["other://connect?host_url={origin}"] })],
      [ios({ templates: ["https://elsewhere.example/c#h={origin}"] })],
      [ios({ templates: ["notes://connect?host_url={origin}&token=x"] })],
      [ios({ templates: ["notes://connect?h={origin}&a={origin}&b={origin}&c={origin}&d={origin}"] })],
      [ios({ templates: ["notes://connect?host_url={origin}", "notes://connect?host_url={origin}"] })],
      [android({ appLinkHosts: undefined })],
      [NOTES_CLIENT, { ...NOTES_CLIENT, id: "copy" }],
      [NOTES_CLIENT, entry({ id: "other", android: undefined, ios: { ...NOTES_CLIENT.ios, bundleId: "com.example.other" } })],
      [NOTES_CLIENT, { ...NOTES_CLIENT }],
    ];
    for (const value of invalid) {
      expect(() => parseTrustedNativeClients(value), JSON.stringify(value).slice(0, 160)).toThrow(TypeError);
    }
  });

  test("the built-in list parses and claims no Takosumi identity", () => {
    const clients: readonly TrustedNativeClient[] = DEFAULT_TRUSTED_NATIVE_CLIENTS;
    for (const client of clients) {
      expect(client.ios?.templates.every((template) => template.includes("{origin}"))).toBe(true);
      expect(client.android?.package).not.toMatch(/takosumi/u);
    }
  });
});

describe("the app author guide", () => {
  test("lists exactly the blocked schemes, in Japanese and English", async () => {
    for (const [path, lead] of [
      ["../../docs/getting-started/home-launcher.md", "`open` で使えない scheme:"],
      ["../../docs/en/getting-started/home-launcher.md", "Schemes `open` cannot use:"],
    ] as const) {
      const text = await Bun.file(new URL(path, import.meta.url)).text();
      const start = text.indexOf(lead);
      expect(start, path).toBeGreaterThan(-1);
      const paragraph = text.slice(start + lead.length).split("\n\n")[0] ?? "";
      const listed = [...paragraph.matchAll(/`([a-z][a-z0-9+.-]*)`/gu)].map(
        (match) => match[1],
      );
      expect(new Set(listed).size, path).toBe(listed.length);
      expect(new Set(listed), path).toEqual(new Set(INTERFACE_CLIENT_BLOCKED_SCHEMES));
    }
  });
});

describe("clients inside a repository manifest", () => {
  function designDeclaration(): Record<string, unknown> {
    return {
      preferred: "native",
      ios: {
        name: "Yurucommu",
        appStoreId: "1234567890",
        bundleId: "com.yurucommu",
        open: "yurucommu://connect?host_url={origin}&product=yurucommu",
        universalLink: "https://open.yurucommu.example/connect#host_url={origin}",
      },
      android: {
        name: "Yurucommu",
        package: "com.yurucommu",
        open: "yurucommu://connect?host_url={origin}&product=yurucommu",
        appLink: "https://open.yurucommu.example/connect#host_url={origin}",
      },
    };
  }

  function manifest(clients: unknown): Record<string, unknown> {
    return {
      apiVersion: "takosumi.com/v2.4",
      kind: "Repository",
      install: {
        modules: {
          "deploy/opentofu": {
            inputs: [],
            interfaces: [
              {
                key: "launcher",
                name: "yurucommu.launcher",
                spec: {
                  type: "interface.ui.surface",
                  version: "1",
                  document: {
                    launcher: true,
                    display: { title: "Yurucommu", icon: "/icon.svg" },
                    clients,
                  },
                  inputs: {
                    url: { source: "output", outputName: "launch_url", outputType: "url" },
                  },
                  access: { visibility: "workspace" },
                },
                bindingRequests: [
                  {
                    key: "installer",
                    subject: { source: "installing_principal" },
                    permissions: ["ui.open"],
                    delivery: { type: "none" },
                  },
                ],
              },
            ],
          },
        },
      },
    };
  }

  test("the design's declaration needs no new manifest version and passes its checks", () => {
    const document = manifest(designDeclaration());
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addSchema(repositoryManifestV2_1Schema);
    const validate = ajv.compile(repositoryManifestV2_4Schema);
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    const parsed = parseRepositoryManifestText(JSON.stringify(document));
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;
    const declared = parsed.document.install.modules["deploy/opentofu"]
      ?.interfaces?.[0]?.spec.document as Record<string, unknown> | undefined;
    expect(declared?.clients).toEqual(designDeclaration());
    expect(findForbiddenRepositoryManifestMaterial(designDeclaration())).toBeUndefined();
  });

  test("a forbidden key inside clients still rejects the manifest", () => {
    for (const [key, value] of [
      ["authToken", "x"],
      ["hostId", "x"],
      ["accountRef", "x"],
      ["client_secret", "x"],
      ["workspace", "x"],
    ] as const) {
      const declaration = designDeclaration();
      (declaration.ios as Record<string, unknown>)[key] = value;
      const parsed = parseRepositoryManifestText(JSON.stringify(manifest(declaration)));
      expect(parsed.ok).toBe(false);
    }
  });
});
