import { describe, expect, test } from "bun:test";

import {
  parseInterfaceDisplay,
  resolveDisplayIcon,
} from "../../contract/interface-display.ts";

const SURFACE = "https://app.example.test/launch";

describe("resolveDisplayIcon", () => {
  test("accepts a credential-free absolute HTTPS URL", () => {
    expect(resolveDisplayIcon("https://cdn.example.test/icon.svg")).toEqual({
      kind: "image",
      url: "https://cdn.example.test/icon.svg",
    });
  });

  test("rejects http, data, javascript, and protocol-relative values", () => {
    expect(resolveDisplayIcon("http://cdn.example.test/icon.svg")).toBeNull();
    expect(resolveDisplayIcon("data:image/svg+xml,<svg/>")).toBeNull();
    expect(resolveDisplayIcon("javascript:alert(1)")).toBeNull();
    expect(resolveDisplayIcon("//evil.example/icon.svg", SURFACE)).toBeNull();
  });

  test("rejects credentials, credential queries, and fragments", () => {
    expect(resolveDisplayIcon("https://u:p@example.test/i.svg")).toBeNull();
    expect(
      resolveDisplayIcon("https://example.test/i.svg?token=abc"),
    ).toBeNull();
    expect(
      resolveDisplayIcon("https://example.test/i.svg?client_secret=abc"),
    ).toBeNull();
    expect(
      resolveDisplayIcon("https://example.test/i.svg?proxy-authorization=x"),
    ).toBeNull();
    expect(resolveDisplayIcon("https://example.test/i.svg#x")).toBeNull();
  });

  test("resolves a root-relative path against the surface origin", () => {
    expect(resolveDisplayIcon("/icons/app.svg", SURFACE)).toEqual({
      kind: "image",
      url: "https://app.example.test/icons/app.svg",
    });
  });

  test("root-relative without a surface URL fails closed", () => {
    expect(resolveDisplayIcon("/icons/app.svg")).toBeNull();
  });

  test("rejects an icon that points back at the viewer's own origin", () => {
    const VIEWER = "https://app.takosumi.example";
    // `<img src>` on the dashboard sends the account session cookie, and
    // /oauth/authorize answers a credentialed GET with a code redirect.
    expect(
      resolveDisplayIcon(
        `${VIEWER}/oauth/authorize?response_type=code&client_id=toc_x&redirect_uri=https%3A%2F%2Fattacker.example%2Fcb&code_challenge=x&code_challenge_method=S256`,
        SURFACE,
        VIEWER,
      ),
    ).toBeNull();
    expect(
      resolveDisplayIcon(`${VIEWER}/icons/app.svg`, SURFACE, VIEWER),
    ).toBeNull();
    expect(
      parseInterfaceDisplay(
        { icon: `${VIEWER}/oauth/authorize?response_type=code` },
        { surfaceUrl: SURFACE, viewerOrigin: VIEWER },
      ).icon,
    ).toBeUndefined();
    // A third-party icon is unaffected.
    expect(
      resolveDisplayIcon("https://cdn.example.test/icon.svg", SURFACE, VIEWER),
    ).toEqual({ kind: "image", url: "https://cdn.example.test/icon.svg" });
  });

  test("accepts a short emoji glyph and rejects long or path-like text", () => {
    expect(resolveDisplayIcon("🐙")).toEqual({ kind: "glyph", glyph: "🐙" });
    expect(resolveDisplayIcon("icons/app.svg", SURFACE)).toBeNull();
    expect(resolveDisplayIcon("a".repeat(17))).toBeNull();
  });
});

describe("parseInterfaceDisplay", () => {
  test("parses the canonical display keys with bounds", () => {
    expect(
      parseInterfaceDisplay(
        {
          title: "Office",
          description: "Documents",
          icon: "/icon.svg",
          category: "productivity",
          sortOrder: 7,
          unknown: "ignored",
        },
        { surfaceUrl: SURFACE },
      ),
    ).toEqual({
      title: "Office",
      description: "Documents",
      icon: { kind: "image", url: "https://app.example.test/icon.svg" },
      category: "productivity",
      sortOrder: 7,
    });
  });

  test("invalid values degrade to absence, never to an error", () => {
    expect(
      parseInterfaceDisplay({
        title: "x".repeat(300),
        icon: "javascript:alert(1)",
        sortOrder: Number.NaN,
      }),
    ).toEqual({});
    expect(parseInterfaceDisplay(null)).toEqual({});
    expect(parseInterfaceDisplay([1, 2])).toEqual({});
  });
});
