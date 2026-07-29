/**
 * The launcher, the store grid and the add flow each had their own monogram
 * rule, so one service wore three faces: `photo-blog` came out "PB" on the
 * launcher and "PH" in the store. These lock the single rule and the icon
 * classification that decides whether there is a face to draw at all.
 */
import { describe, expect, test } from "bun:test";
import {
  appMonogram,
  resolveAppIcon,
} from "../../../../dashboard/src/lib/app-face.ts";

describe("appMonogram", () => {
  test("takes one letter per word so unrelated services stay distinguishable", () => {
    expect(appMonogram("photo-blog")).toBe("PB");
    expect(appMonogram("takos storage")).toBe("TS");
    expect(appMonogram("road_to_me")).toBe("RT");
    expect(appMonogram("takos.office")).toBe("TO");
  });

  test("a single word gives up two letters rather than one lonely initial", () => {
    expect(appMonogram("yurucommu")).toBe("YU");
    expect(appMonogram("x")).toBe("X");
  });

  test("never renders punctuation as an app's face", () => {
    expect(appMonogram("")).toBe("?");
    expect(appMonogram("   ")).toBe("?");
    expect(appMonogram("---")).toBe("?");
    expect(appMonogram("...")).toBe("?");
  });

  test("is stable across the screens that used to disagree", () => {
    for (const name of ["photo-blog", "yurucommu", "takos-git", "A"]) {
      expect(appMonogram(name)).toBe(appMonogram(name));
      expect(appMonogram(name).length).toBeLessThanOrEqual(2);
    }
  });
});

describe("resolveAppIcon", () => {
  test("a URL icon is an image", () => {
    expect(resolveAppIcon("https://example.com/i.svg")).toEqual({
      imageSrc: "https://example.com/i.svg",
    });
  });

  test("a path icon resolves against the app's own origin", () => {
    expect(
      resolveAppIcon("/icons/app.svg", "https://app.example.com/x"),
    ).toEqual({ imageSrc: "https://app.example.com/icons/app.svg" });
  });

  test("a path icon with no app URL is no icon — never emoji text", () => {
    // Rendering it as the emoji slot would paint "/icons/app.svg" across the
    // tile face.
    expect(resolveAppIcon("/icons/app.svg")).toEqual({});
    expect(resolveAppIcon("./a.png")).toEqual({});
  });

  test("a short glyph is an emoji", () => {
    expect(resolveAppIcon("🐙")).toEqual({ emoji: "🐙" });
  });

  test("no icon is no face", () => {
    expect(resolveAppIcon(undefined)).toEqual({});
    expect(resolveAppIcon("")).toEqual({});
  });

  test("an unparseable base URL degrades to no icon instead of throwing", () => {
    expect(resolveAppIcon("/i.svg", "not a url")).toEqual({});
  });
});
