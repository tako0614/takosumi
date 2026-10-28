/**
 * The installed app's canonical URL and the older links that redirect to it
 * (TASK-0115 Phase 3a).
 */
import { describe, expect, test } from "bun:test";
import {
  APP_PAGE_SECTIONS,
  appPageHref,
  appPageSectionFromHash,
  legacyAppTabSection,
  legacyInstallLocatorCapsuleId,
  reinstallHref,
} from "../../../../dashboard/src/lib/app-links.ts";
import { parseInstallPrefill } from "../../../../dashboard/src/lib/install-link.ts";

describe("app page links", () => {
  test("an app's page is /apps/:id, its sections are fragments", () => {
    expect(appPageHref("cap_a")).toBe("/apps/cap_a");
    expect(appPageHref("cap a/b")).toBe("/apps/cap%20a%2Fb");
    expect(appPageHref("cap_a", "settings")).toBe("/apps/cap_a#settings");
    expect(appPageHref("cap_a", "danger")).toBe("/apps/cap_a#danger");
    for (const section of Object.keys(APP_PAGE_SECTIONS)) {
      expect(appPageSectionFromHash(`#${section}`)).toBe(section);
    }
    expect(appPageSectionFromHash("")).toBeUndefined();
    expect(appPageSectionFromHash("#constructor")).toBeUndefined();
    expect(appPageSectionFromHash("#app-settings")).toBeUndefined();
  });

  test("old tab routes keep landing on the part of the page they meant", () => {
    expect(legacyAppTabSection("settings")).toBe("settings");
    expect(legacyAppTabSection("history")).toBe("history");
    expect(legacyAppTabSection("danger")).toBe("danger");
    expect(legacyAppTabSection("deploys")).toBe("version");
    expect(legacyAppTabSection("connections")).toBe("connections");
    expect(legacyAppTabSection(undefined)).toBeUndefined();
    expect(legacyAppTabSection("overview")).toBeUndefined();
  });

  test("only a bare /new?capsule= locator opens the app page", () => {
    expect(legacyInstallLocatorCapsuleId("?capsule=cap_abc")).toBe("cap_abc");
    expect(legacyInstallLocatorCapsuleId("")).toBeUndefined();
    expect(legacyInstallLocatorCapsuleId("?capsule=cap_a&capsule=cap_b")).toBeUndefined();
    expect(legacyInstallLocatorCapsuleId("?capsule=https://evil.test")).toBeUndefined();
    expect(legacyInstallLocatorCapsuleId("?capsule=../secret")).toBeUndefined();
    // An app handoff or install prefill stays with the install page.
    expect(legacyInstallLocatorCapsuleId("?capsule=cap_a&product=takos&return_uri=https%3A%2F%2Fx.test")).toBeUndefined();
    expect(legacyInstallLocatorCapsuleId("?capsule=cap_a&git=https%3A%2F%2Fgithub.com%2Fo%2Fr")).toBeUndefined();
  });

  test("installing again pre-fills the repository on the install page and starts nothing", () => {
    const href = reinstallHref({ repositoryUrl: "https://github.com/example/office.git", ref: "main", name: "office" });
    expect(href.startsWith("/new?")).toBe(true);
    expect(parseInstallPrefill(href.slice("/new".length))).toEqual({
      git: "https://github.com/example/office.git",
      ref: "main",
      sourcePath: ".",
      path: "",
      name: "office",
    });
    expect(reinstallHref({})).toBe("/new");
    expect(reinstallHref({ repositoryUrl: "http://insecure.test/repo.git" })).toBe("/new");
  });
});
