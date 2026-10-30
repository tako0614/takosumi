import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";

import repositoryManifestV2_1Schema from "../../docs/public/schemas/repository-manifest-v2.1.schema.json" with { type: "json" };
import repositoryManifestV2_4Schema from "../../docs/public/schemas/repository-manifest-v2.4.schema.json" with { type: "json" };
import {
  INTERFACE_CLIENT_BLOCKED_SCHEMES,
  INTERFACE_CLIENT_LINK_MAX_LENGTH,
  parseInterfaceClients,
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

/** The declaration from the TASK-0119 design (§2). */
function designDeclaration(): Record<string, unknown> {
  return {
    preferred: "native",
    ios: {
      name: "Yurucommu",
      appStoreId: "1234567890",
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

function iosOpen(open: unknown): string | undefined {
  return parseInterfaceClients({ ios: { open } }, OPTIONS)?.ios?.open;
}

function androidOpen(open: unknown): string | undefined {
  return parseInterfaceClients(
    { android: { package: "com.example.notes", open } },
    OPTIONS,
  )?.android?.open;
}

function universalLink(link: unknown): string | undefined {
  return parseInterfaceClients({ ios: { universalLink: link } }, OPTIONS)?.ios
    ?.universalLink;
}

function appLink(link: unknown): string | undefined {
  return parseInterfaceClients(
    { android: { package: "com.example.notes", appLink: link } },
    OPTIONS,
  )?.android?.appLink;
}

describe("parseInterfaceClients: valid declarations", () => {
  test("the design's declaration fills the screen origin into every link", () => {
    expect(parseInterfaceClients(designDeclaration(), OPTIONS)).toEqual({
      preferred: "native",
      ios: {
        name: "Yurucommu",
        appStoreId: "1234567890",
        open: `yurucommu://connect?host_url=${ORIGIN}&product=yurucommu`,
        universalLink: `https://open.yurucommu.example/connect#host_url=${ORIGIN}`,
        storeUrl: "https://apps.apple.com/app/id1234567890",
      },
      android: {
        name: "Yurucommu",
        package: "com.yurucommu",
        open: `yurucommu://connect?host_url=${ORIGIN}&product=yurucommu`,
        appLink: `https://open.yurucommu.example/connect#host_url=${ORIGIN}`,
        storeUrl: "https://play.google.com/store/apps/details?id=com.yurucommu",
      },
    });
  });

  test("preferred defaults to native and accepts only native or web", () => {
    const declaration = designDeclaration();
    delete declaration.preferred;
    expect(parseInterfaceClients(declaration, OPTIONS)?.preferred).toBe(
      "native",
    );
    expect(
      parseInterfaceClients({ ...declaration, preferred: "web" }, OPTIONS)
        ?.preferred,
    ).toBe("web");
    for (const preferred of ["in_app", "WEB", 1, null, true]) {
      expect(
        parseInterfaceClients({ ...declaration, preferred }, OPTIONS)
          ?.preferred,
      ).toBe("native");
    }
  });

  test("one platform is enough; the other stays absent", () => {
    expect(
      parseInterfaceClients(
        { ios: { open: "notes://open?server={origin}" } },
        OPTIONS,
      ),
    ).toEqual({
      preferred: "native",
      ios: { open: `notes://open?server=${ORIGIN}` },
    });
    expect(
      parseInterfaceClients(
        { android: { package: "com.example.notes", appLink: "https://open.notes.example/x" } },
        OPTIONS,
      ),
    ).toEqual({
      preferred: "native",
      android: {
        package: "com.example.notes",
        appLink: "https://open.notes.example/x",
        storeUrl:
          "https://play.google.com/store/apps/details?id=com.example.notes",
      },
    });
  });

  test("optional identifiers and explicit store links are kept when valid", () => {
    const clients = parseInterfaceClients(
      {
        ios: {
          open: "notes://open",
          bundleId: "com.example.Notes-App",
          appStoreId: 1234567890,
          storeUrl: "https://testflight.apple.com/join/AbCdEf",
        },
        android: {
          package: "org.example.notes_app",
          open: "notes://open",
          storeUrl: "https://f-droid.org/packages/org.example.notes_app/",
        },
      },
      OPTIONS,
    );
    expect(clients?.ios).toEqual({
      appStoreId: "1234567890",
      bundleId: "com.example.Notes-App",
      open: "notes://open",
      storeUrl: "https://testflight.apple.com/join/AbCdEf",
    });
    expect(clients?.android?.storeUrl).toBe(
      "https://f-droid.org/packages/org.example.notes_app/",
    );
  });

  test("an http screen still yields its origin, and custom schemes may omit the host", () => {
    expect(
      parseInterfaceClients(
        { ios: { open: "notes:///connect?server={origin}" } },
        { surfaceUrl: "http://notes.localhost:8787/" },
      )?.ios?.open,
    ).toBe("notes:///connect?server=http%3A%2F%2Fnotes.localhost%3A8787");
    expect(iosOpen("notes:{url}")).toBe(`notes:${URL_VALUE}`);
  });
});

describe("parseInterfaceClients: placeholders", () => {
  test("{origin} and {url} are URL-encoded, may repeat, and are optional", () => {
    expect(iosOpen("notes://open?o={origin}&u={url}&again={origin}")).toBe(
      `notes://open?o=${ORIGIN}&u=${URL_VALUE}&again=${ORIGIN}`,
    );
    expect(iosOpen("notes://home")).toBe("notes://home");
    const withQuery = parseInterfaceClients(
      { ios: { open: "notes://open?u={url}" } },
      { surfaceUrl: "https://notes.example.test/a b?x=1&y=2" },
    )?.ios?.open;
    expect(withQuery).toBe(
      `notes://open?u=${encodeURIComponent("https://notes.example.test/a%20b?x=1&y=2")}`,
    );
  });

  test("any other {...}, stray brace, or differently cased placeholder refuses the link", () => {
    for (const template of [
      "notes://open?server={host}",
      "notes://open?server={origin}&id={accountId}",
      "notes://open?server={ORIGIN}",
      "notes://open?server={ origin }",
      "notes://open?server={{origin}}",
      "notes://open?server={ori{url}gin}",
      "notes://open?server={origin",
      "notes://open?server=origin}",
      "notes://open?server={}",
    ]) {
      expect(iosOpen(template)).toBeUndefined();
    }
  });

  test("a placeholder may not choose the host", () => {
    expect(iosOpen("notes://{origin}/open")).toBeUndefined();
    expect(iosOpen("notes://x{url}/open")).toBeUndefined();
    expect(universalLink("https://{origin}/connect")).toBeUndefined();
    expect(universalLink("https://open.notes.example{origin}/x")).toBeUndefined();
    expect(universalLink("https://open.notes.example:{origin}/x")).toBeUndefined();
    expect(universalLink("https://{url}")).toBeUndefined();
  });
});

describe("parseInterfaceClients: custom schemes", () => {
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
      "JAVASCRIPT:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "blob:https://notes.example.test/uuid",
      "about:blank",
      "takosumi://app?url={url}",
      "tel:+819012345678",
      "sms:+819012345678",
      "mailto:someone@example.test",
      "itms-apps://apps.apple.com/app/id1",
      "itms-services://?action=download-manifest&url=https://evil.example/m.plist",
      "market://details?id=com.evil",
      "app-settings:",
      "prefs:root=General",
      "shortcuts://run-shortcut?name=x",
      "http://notes.example.test/",
      "https://notes.example.test/",
    ]) {
      expect(iosOpen(template)).toBeUndefined();
    }
  });

  test("intent: is never declared; the dashboard builds it for Android", () => {
    const intent =
      "intent://connect?host_url={origin}#Intent;scheme=notes;package=com.example.notes;end";
    expect(androidOpen(intent)).toBeUndefined();
    expect(androidOpen("android-app://com.example.notes/notes/connect")).toBeUndefined();
    expect(androidOpen("INTENT://connect#Intent;end")).toBeUndefined();
    // A fragment would follow the dashboard-built `#Intent;...;end` and could
    // add extras such as a component or a fallback URL.
    expect(
      androidOpen(
        "notes://connect?host_url={origin}#Intent;component=com.evil/.Main;S.browser_fallback_url=javascript:alert(1);end",
      ),
    ).toBeUndefined();
    expect(androidOpen("notes://connect#x")).toBeUndefined();
  });

  test("the scheme must be 2-32 lowercase characters before a non-empty rest", () => {
    expect(iosOpen("c:/windows")).toBeUndefined();
    expect(iosOpen("Notes://open")).toBeUndefined();
    expect(iosOpen("1notes://open")).toBeUndefined();
    expect(iosOpen("no_tes://open")).toBeUndefined();
    expect(iosOpen(`${"a".repeat(33)}://open`)).toBeUndefined();
    expect(iosOpen(`${"a".repeat(32)}://open`)).toBe(`${"a".repeat(32)}://open`);
    expect(iosOpen("notes:")).toBeUndefined();
    expect(iosOpen("notes")).toBeUndefined();
    expect(iosOpen("com.example.notes+x-1:open")).toBe("com.example.notes+x-1:open");
  });

  test("userinfo, credential-named parameters and invalid characters refuse the link", () => {
    for (const template of [
      "notes://user:pass@open",
      "notes://user@open",
      "notes://open?token=abc",
      "notes://open?access_token={origin}",
      "notes://open?client_secret=x",
      "notes://open?server={origin} ",
      "notes://open?q=a b",
      "notes://open?q=\"x\"",
      "notes://open?q=<x>",
      "notes://open\\x",
      "notes://open?q=`x`",
      "notes://open?q=ä",
      "notes://open?q=\u0000",
    ]) {
      expect(iosOpen(template)).toBeUndefined();
    }
  });
});

describe("parseInterfaceClients: universal links and App Links", () => {
  test("http and other non-https links are refused", () => {
    for (const link of [
      "http://open.notes.example/connect#host_url={origin}",
      "HTTP://open.notes.example/x",
      "HTTPS://open.notes.example/x",
      "notes://connect",
      "//open.notes.example/x",
      "/connect",
      "javascript:alert(1)",
    ]) {
      expect(universalLink(link)).toBeUndefined();
      expect(appLink(link)).toBeUndefined();
    }
  });

  test("the publisher domain must be a plain named host on the default port", () => {
    for (const link of [
      "https://user@open.notes.example/x",
      "https://user:pass@open.notes.example/x",
      "https://open.notes.example:8443/x",
      "https://192.0.2.10/x",
      "https://[2001:db8::1]/x",
      "https://localhost/x",
      "https://https:///x",
      "https:///x",
    ]) {
      expect(universalLink(link)).toBeUndefined();
    }
    expect(universalLink("https://open.notes.example:443/x")).toBe(
      "https://open.notes.example/x",
    );
  });

  test("credential-named parameters are refused in the query and in a fragment", () => {
    expect(universalLink("https://open.notes.example/x?token=abc")).toBeUndefined();
    expect(universalLink("https://open.notes.example/x?refresh_token={origin}")).toBeUndefined();
    expect(universalLink("https://open.notes.example/x#access_token={origin}")).toBeUndefined();
    expect(universalLink("https://open.notes.example/x#session={url}")).toBeUndefined();
    expect(universalLink("https://open.notes.example/x?u={url}")).toBe(
      `https://open.notes.example/x?u=${URL_VALUE}`,
    );
  });

  test("a link on Takosumi's own origin is refused", () => {
    expect(universalLink(`${VIEWER}/oauth/authorize?x={origin}`)).toBeUndefined();
    expect(
      parseInterfaceClients(
        { ios: { universalLink: `${VIEWER}/x` } },
        { surfaceUrl: SURFACE },
      )?.ios?.universalLink,
    ).toBe(`${VIEWER}/x`);
  });
});

describe("parseInterfaceClients: lengths and identifiers", () => {
  test("templates longer than the limit are refused before and after filling", () => {
    const base = "notes://open?pad=";
    const fits = base + "a".repeat(INTERFACE_CLIENT_LINK_MAX_LENGTH - base.length);
    expect(iosOpen(fits)).toBe(fits);
    expect(iosOpen(`${fits}a`)).toBeUndefined();

    const withUrl = `notes://open?u={url}&pad=${"a".repeat(1_900)}`;
    expect(iosOpen(withUrl)).toBeDefined();
    const longSurface = `https://notes.example.test/${"p".repeat(200)}`;
    expect(
      parseInterfaceClients({ ios: { open: withUrl } }, { surfaceUrl: longSurface }),
    ).toBeUndefined();
  });

  test("an invalid name is dropped without dropping the platform", () => {
    const named = (name: unknown) =>
      parseInterfaceClients({ ios: { name, open: "notes://open" } }, OPTIONS)
        ?.ios;
    expect(named("  Notes  ")?.name).toBe("Notes");
    expect(named("📝".repeat(64))?.name).toBe("📝".repeat(64));
    expect(named("n".repeat(65))).toEqual({ open: "notes://open" });
    expect(named("   ")).toEqual({ open: "notes://open" });
    expect(named("Notes\u202Eppa")).toEqual({ open: "notes://open" });
    expect(named("Notes\nApp")).toEqual({ open: "notes://open" });
    expect(named(42)).toEqual({ open: "notes://open" });
  });

  test("store ids, bundle ids and store links are checked", () => {
    const ios = (fields: Record<string, unknown>) =>
      parseInterfaceClients({ ios: { open: "notes://open", ...fields } }, OPTIONS)
        ?.ios;
    for (const appStoreId of ["1234567890123", "id123", "", "12.5", -1, 1.5, "١٢٣"]) {
      expect(ios({ appStoreId })).toEqual({ open: "notes://open" });
    }
    expect(ios({ appStoreId: "1" })?.storeUrl).toBe("https://apps.apple.com/app/id1");
    for (const bundleId of ["notes", "com..notes", "com.notes!", `com.${"a".repeat(152)}`]) {
      expect(ios({ bundleId })).toEqual({ open: "notes://open" });
    }
    for (const storeUrl of [
      "https://play.google.com/store/apps/details?id=x",
      "http://apps.apple.com/app/id1",
      "https://apps.apple.com.evil.example/app/id1",
      "https://evil.example/apps.apple.com",
      "https://user@apps.apple.com/app/id1",
      "https://apps.apple.com:8443/app/id1",
      "https://apps.apple.com/app/id1?token=x",
      "https://apps.apple.com/app/{origin}",
    ]) {
      expect(ios({ storeUrl })).toEqual({ open: "notes://open" });
    }
    expect(
      parseInterfaceClients(
        {
          android: {
            package: "com.example.notes",
            open: "notes://open",
            storeUrl: "https://apps.apple.com/app/id1",
          },
        },
        OPTIONS,
      )?.android?.storeUrl,
    ).toBe("https://play.google.com/store/apps/details?id=com.example.notes");
  });

  test("Android needs a valid package and iOS and Android need a way to open the app", () => {
    for (const packageName of [undefined, "notes", "com.1notes", "com.notes-app", "com..notes", 7]) {
      expect(
        parseInterfaceClients(
          { android: { package: packageName, open: "notes://open" } },
          OPTIONS,
        ),
      ).toBeUndefined();
    }
    expect(
      parseInterfaceClients(
        { android: { package: "com.example.notes", appStoreId: "1" } },
        OPTIONS,
      ),
    ).toBeUndefined();
    expect(
      parseInterfaceClients(
        { ios: { name: "Notes", appStoreId: "1", open: "javascript:alert(1)" } },
        OPTIONS,
      ),
    ).toBeUndefined();
    // An invalid universal link does not hide a valid custom scheme.
    expect(
      parseInterfaceClients(
        { ios: { open: "notes://open", universalLink: "http://open.notes.example/" } },
        OPTIONS,
      )?.ios,
    ).toEqual({ open: "notes://open" });
  });
});

describe("parseInterfaceClients: shape", () => {
  test("unknown keys and platforms are ignored and never echoed", () => {
    const declaration = designDeclaration();
    const clients = parseInterfaceClients(
      {
        ...declaration,
        windows: { open: "notes://open" },
        macos: { open: "notes://open" },
        web: { url: "https://evil.example/" },
        ios: { ...(declaration.ios as object), extra: "x", accessToken: "y" },
        android: { ...(declaration.android as object), sha256CertFingerprints: ["AA"] },
      },
      OPTIONS,
    );
    expect(clients).toEqual(parseInterfaceClients(designDeclaration(), OPTIONS));
    expect(JSON.stringify(clients)).not.toMatch(/windows|macos|evil|extra|accessToken|sha256/u);
  });

  test("non-object values, unusable surfaces and empty declarations are absent", () => {
    for (const value of [undefined, null, "clients", 1, [], [designDeclaration()], {}]) {
      expect(parseInterfaceClients(value, OPTIONS)).toBeUndefined();
    }
    expect(parseInterfaceClients({ ios: [], android: "x", preferred: "web" }, OPTIONS)).toBeUndefined();
    for (const surfaceUrl of ["", "not a url", "notes://open", "javascript:alert(1)", "https://u:p@notes.example.test/"]) {
      expect(parseInterfaceClients(designDeclaration(), { surfaceUrl })).toBeUndefined();
    }
  });

  test("handoff links carry only the screen's public origin or URL", () => {
    const clients = parseInterfaceClients(designDeclaration(), {
      surfaceUrl: "https://notes.example.test/app?view=home",
      viewerOrigin: VIEWER,
    });
    const links = [
      clients?.ios?.open,
      clients?.ios?.universalLink,
      clients?.android?.open,
      clients?.android?.appLink,
    ];
    for (const link of links) {
      expect(link).toContain(ORIGIN);
      expect(link).not.toContain("view%3Dhome");
      expect(link).not.toContain("takosumi.test");
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
